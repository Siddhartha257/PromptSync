import json
import logging
import asyncio
from typing import TypedDict, List, Dict, Any, Optional
from pydantic import BaseModel, Field

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import interrupt

from langchain_core.messages import SystemMessage, HumanMessage
from app.core.llm import LLMCaller, init_chat_model, structured_output_kwargs_for_provider
from app.models.schemas import OptimizationPlanModel
from app.utils.patcher import apply_llm_edits, format_retry_context
from app.utils.json_patcher import JsonSchemaPatchEngine, format_retry_context as format_schema_retry_context
from app.utils.schema_sanitizer import prepare_schema_for_provider
from app.agents.generators import PromptUpdaterAgent, SchemaUpdaterAgent
from app.prompts.optimizer_prompts import (
    EVALUATOR_SYSTEM_PROMPT,
    PROMPT_OPTIMIZER_SYSTEM_PROMPT
)

logger = logging.getLogger('optimization_lab')

MAX_OPTIMIZER_PATCH_ATTEMPTS = 2  # 1 initial generation + 1 LLM self-correction retry on failed patch application

class OptimizationState(TypedDict):
    session_id: str
    base_prompt: str
    candidate_prompt: str
    json_schema: str
    kb_text: str
    acceptance_criteria: List[str]
    test_queries: List[Dict[str, Any]]
    eval_mode: str
    iteration: int
    max_iterations: int
    pass_threshold: int
    query_results: List[Dict[str, Any]]
    score: int
    critique: str
    is_passed: bool
    user_action: str
    proposed_prompt: Optional[str]
    proposed_schema: Optional[str]
    prompt_instruction: Optional[str]
    schema_instruction: Optional[str]
    history: List[Dict[str, Any]]
    report_markdown: str

class CriterionEvalResult(BaseModel):
    criterion: str
    passed: bool
    reason: str

class QueryEvalResult(BaseModel):
    query: str
    passed: bool
    feedback: str = Field(default='', description='Specific diagnostic feedback for this query')
    criteria_checks: List[CriterionEvalResult] = Field(default_factory=list)

class SuiteEvaluationResult(BaseModel):
    score: int = Field(description='Overall percentage score from 0 to 100')
    is_passed: bool = Field(description='True if 100% of criteria pass for all queries')
    critique: str = Field(description='Actionable diagnostic critique explaining root causes of any failures')
    evaluations: List[QueryEvalResult]

class OptimizationLabEngine:
    def __init__(
        self,
        llm_caller: Optional[LLMCaller] = None,
        evaluator_caller: Optional[LLMCaller] = None,
        optimizer_caller: Optional[LLMCaller] = None,
    ):
        self.llm_caller = llm_caller or LLMCaller()
        # Evaluator uses its own caller if provided, otherwise falls back to default
        eval_caller = evaluator_caller or self.llm_caller
        opt_caller = optimizer_caller or self.llm_caller

        # Shared model for report_generator and run_query_suite
        self.chat_model = init_chat_model(
            self.llm_caller.model_name,
            model_provider=self.llm_caller.provider,
            api_key=self.llm_caller.api_key,
            thinking_level=self.llm_caller.thinking_level,
            temperature=self.llm_caller.temperature,
            max_retries=self.llm_caller.max_retries,
            retry_delay=self.llm_caller.retry_delay,
            fallback_model=self.llm_caller.fallback_model,
            supports_reasoning=self.llm_caller.supports_reasoning
        )
        # Evaluator model (may differ)
        self.evaluator_model = init_chat_model(
            eval_caller.model_name,
            model_provider=eval_caller.provider,
            api_key=eval_caller.api_key,
            thinking_level=eval_caller.thinking_level,
            temperature=eval_caller.temperature,
            max_retries=eval_caller.max_retries,
            retry_delay=eval_caller.retry_delay,
            fallback_model=eval_caller.fallback_model,
            supports_reasoning=eval_caller.supports_reasoning
        )
        # Optimizer model (may differ)
        self.optimizer_model = init_chat_model(
            opt_caller.model_name,
            model_provider=opt_caller.provider,
            api_key=opt_caller.api_key,
            thinking_level=opt_caller.thinking_level,
            temperature=opt_caller.temperature,
            max_retries=opt_caller.max_retries,
            retry_delay=opt_caller.retry_delay,
            fallback_model=opt_caller.fallback_model,
            supports_reasoning=opt_caller.supports_reasoning
        )
        self.eval_caller = eval_caller
        self.opt_caller = opt_caller
        self.json_patch_engine = JsonSchemaPatchEngine()
        self.checkpointer = InMemorySaver()
        self.graph = self._build_graph()

    def _build_graph(self):
        builder = StateGraph(OptimizationState)
        builder.add_node('run_query_suite', self.run_query_suite_node)
        builder.add_node('evaluator', self.evaluator_node)
        builder.add_node('optimizer', self.optimizer_node)
        builder.add_node('human_review', self.human_review_node)
        builder.add_node('apply_autonomous', self.apply_autonomous_node)
        builder.add_node('report_generator', self.report_generator_node)

        builder.add_edge(START, 'run_query_suite')
        builder.add_edge('run_query_suite', 'evaluator')

        builder.add_conditional_edges(
            'evaluator',
            self.route_after_eval,
            {
                'optimizer': 'optimizer',
                'report_generator': 'report_generator'
            }
        )
        builder.add_conditional_edges(
            'optimizer',
            self.route_after_optimizer,
            {
                'human_review': 'human_review',
                'apply_autonomous': 'apply_autonomous'
            }
        )
        builder.add_conditional_edges(
            'human_review',
            self.route_after_human_review,
            {
                'run_query_suite': 'run_query_suite',
                'report_generator': 'report_generator'
            }
        )
        builder.add_edge('apply_autonomous', 'run_query_suite')
        builder.add_edge('report_generator', END)
        return builder.compile(checkpointer=self.checkpointer)

    async def run_single_query(self, candidate_prompt: str, kb_text: str, json_schema: str, q_item: Dict[str, Any]) -> Dict[str, Any]:
        q_text = q_item.get('query', '')
        level = q_item.get('level', 'L1')
        name = q_item.get('name', 'Test Case')
        input_text = ''
        if kb_text.strip():
            input_text += 'Knowledge Base:\n' + kb_text + '\n\n'
        input_text += 'Query:\n' + q_text
        try:
            schema_dict = json.loads(json_schema) if json_schema.strip() else None
            if schema_dict:
                schema_dict = prepare_schema_for_provider(schema_dict, self.llm_caller.provider)
        except Exception:
            schema_dict = None
        try:
            messages = []
            if candidate_prompt:
                messages.append(SystemMessage(content=candidate_prompt))
            messages.append(HumanMessage(content=input_text))

            if schema_dict:
                structured_model = self.chat_model.with_structured_output(
                    schema_dict, **structured_output_kwargs_for_provider(self.llm_caller.provider)
                )
                resp = await structured_model.ainvoke(messages)
                out = json.dumps(resp) if isinstance(resp, (dict, list)) else str(resp)
            else:
                resp = await self.chat_model.ainvoke(messages)
                out = str(resp.content)
        except Exception as e:
            out = f'[Execution Error: {str(e)}]'
        return {'level': level, 'name': name, 'query': q_text, 'output': out}

    async def run_query_suite_node(self, state: OptimizationState) -> Dict[str, Any]:
        candidate_prompt = state['candidate_prompt']
        kb_text = state.get('kb_text', '')
        json_schema = state.get('json_schema', '')
        queries = state.get('test_queries', [])
        iteration = state.get('iteration', 1)
        logger.info(f'Lab: Running {len(queries)} queries for iteration {iteration}...')
        tasks = [self.run_single_query(candidate_prompt, kb_text, json_schema, q) for q in queries]
        results = await asyncio.gather(*tasks)
        return {'query_results': results}

    async def evaluator_node(self, state: OptimizationState) -> Dict[str, Any]:
        results = [dict(r) for r in state.get('query_results', [])]
        criteria = state['acceptance_criteria']
        kb_text = state.get('kb_text', '')
        iteration = state.get('iteration', 1)
        eval_cases = ['--- QUERY ' + str(idx) + ' (' + str(r.get('level')) + ' - ' + str(r.get('name')) + ') ---\nQuery: ' + str(r.get('query', '')) + '\nOutput:\n' + str(r.get('output', '')) for idx, r in enumerate(results, start=1)]
        criteria_str = '\n'.join(f'{i+1}. {c}' for i, c in enumerate(criteria))
        cases_str = '\n\n'.join(eval_cases)
        # EVALUATOR_SYSTEM_PROMPT's grounding rule (#2) requires checking every claim against the
        # actual KB content — without it here, the evaluator was judging fluency/plausibility, not
        # actual factual grounding, and could never catch a confident-sounding hallucination.
        kb_section = f"\n\nKNOWLEDGE BASE CONTEXT (ground every factual claim in the outputs against this):\n{kb_text}" if kb_text.strip() else ""
        eval_input = 'ACCEPTANCE CRITERIA:\n' + criteria_str + kb_section + '\n\nTEST QUERY OUTPUTS TO EVALUATE:\n' + cases_str
        logger.info(f'Lab: Evaluating iteration {iteration} against {len(criteria)} criteria...')
        try:
            eval_model = self.evaluator_model.with_structured_output(
                SuiteEvaluationResult, **structured_output_kwargs_for_provider(self.eval_caller.provider)
            )
            data: SuiteEvaluationResult = await eval_model.ainvoke([
                SystemMessage(content=EVALUATOR_SYSTEM_PROMPT),
                HumanMessage(content=eval_input)
            ])
            pass_threshold = state.get('pass_threshold', 100)
            score = data.score
            is_passed = (score >= pass_threshold)
            critique = data.critique

            # Map individual query evaluations back into results
            if getattr(data, 'evaluations', None):
                for idx, ev in enumerate(data.evaluations):
                    if idx < len(results):
                        results[idx]['passed'] = bool(ev.passed)
                        results[idx]['feedback'] = getattr(ev, 'feedback', '') or ''
                        checks = getattr(ev, 'criteria_checks', [])
                        results[idx]['criteria_checks'] = [
                            c.model_dump() if hasattr(c, 'model_dump') else dict(c) for c in checks
                        ]

            # Fallback: if suite passed the configured threshold, ensure all queries are marked passed.
            # Every result also gets its OWN feedback/criteria_checks here if the evaluator's
            # `evaluations` list didn't cover it (count mismatch) or returned an empty string for
            # it — leaving these unset meant the frontend fell back to the single suite-level
            # `critique` for every such query, making genuinely independent queries display
            # identical feedback text.
            if is_passed:
                for r in results:
                    r['passed'] = True
                    if not r.get('feedback'):
                        r['feedback'] = 'All criteria passed cleanly.'
                    r.setdefault('criteria_checks', [])
            else:
                for r in results:
                    if 'passed' not in r:
                        r['passed'] = is_passed
                    if not r.get('feedback'):
                        r['feedback'] = 'No specific per-query feedback was returned for this query.'
                    r.setdefault('criteria_checks', [])
        except Exception as e:
            logger.error(f'Evaluation parsing failed: {e}')
            score = 50
            is_passed = False
            critique = f'Automated scoring encountered error: {str(e)}. Review outputs manually.'
            for r in results:
                r['passed'] = False
                r['feedback'] = f'Scoring error: {str(e)}'
        history_entry = {'iteration': iteration, 'score': score, 'is_passed': is_passed, 'critique': critique, 'results': results}
        current_history = list(state.get('history', []))
        current_history.append(history_entry)
        return {'score': score, 'is_passed': is_passed, 'critique': critique, 'query_results': results, 'history': current_history}

    def route_after_eval(self, state: OptimizationState) -> str:
        # is_passed is computed in evaluator_node against state['pass_threshold'] (default 100);
        # kept here too as a defensive re-check in case a future node ever sets score without is_passed.
        threshold = state.get('pass_threshold', 100)
        if state['is_passed'] or state['score'] >= threshold or state['iteration'] >= state['max_iterations']:
            return 'report_generator'
        return 'optimizer'

    async def optimizer_node(self, state: OptimizationState) -> Dict[str, Any]:
        candidate_prompt = state['candidate_prompt']
        critique = state['critique']
        results = state['query_results']
        iteration = state['iteration']
        json_schema = state.get('json_schema', '')

        case_summaries = []
        for idx, r in enumerate(results, start=1):
            q_line = f"[Query {idx} ({r.get('level', 'L1')}) - {'PASSED' if r.get('passed') else 'FAILED'}]\n"
            q_line += f"Input: {r.get('query', '')}\n"
            q_line += f"Output: {str(r.get('output', ''))[:300].replace(chr(10), ' ')}\n"
            if r.get('feedback'):
                q_line += f"Query Feedback: {r.get('feedback')}\n"
            case_summaries.append(q_line)
        summaries_str = '\n\n'.join(case_summaries)

        input_text = (
            f"CANDIDATE PROMPT (reference only — you are not editing this directly):\n{candidate_prompt}\n\n"
            f"JSON SCHEMA (reference only — you are not editing this directly):\n{json_schema or '(none)'}\n\n"
            f"OVERALL EVALUATOR / USER CRITIQUE (Iteration {iteration}):\n{critique}\n\n"
            f"TEST CASES & PER-QUERY FEEDBACK:\n{summaries_str}"
        )

        # STAGE 1 — PLAN ONLY: the optimizer decides WHAT should change (prompt_instruction /
        # schema_instruction), same as the editor's own Orchestrator. It never emits literal edits
        # itself — this used to be a single LLM call doing both planning AND precise verbatim
        # text-matching at once, which meant a model confusing "the JSON schema shown for context"
        # with "the prompt I'm allowed to edit" would generate edits that could never apply, no
        # matter how capable the model was. Splitting these into two focused calls (plan, then
        # apply) mirrors the legacy Orchestrator -> PromptUpdaterAgent/SchemaUpdaterAgent flow used
        # by /api/apply_edits, where the updater agent's entire focus is verbatim-matching a given
        # instruction against a given document — nothing else.
        prompt_instruction = f'Refine prompt rules based on feedback: {critique}'
        schema_instruction = 'No schema adjustments needed.'
        try:
            structured_optimizer = self.optimizer_model.with_structured_output(
                OptimizationPlanModel, **structured_output_kwargs_for_provider(self.opt_caller.provider)
            )
            parsed_plan: OptimizationPlanModel = await structured_optimizer.ainvoke([
                SystemMessage(content=PROMPT_OPTIMIZER_SYSTEM_PROMPT),
                HumanMessage(content=input_text)
            ])
            prompt_instruction = parsed_plan.prompt_instruction
            schema_instruction = parsed_plan.schema_instruction
        except Exception as e:
            logger.error(f'Lab: Optimizer plan generation failed for iteration {iteration}: {e}')

        # STAGE 2 — APPLY THE PROMPT PLAN via the dedicated PromptUpdaterAgent (the same one
        # /api/apply_edits uses), with the same retry-on-failed-patch loop: one LLM self-correction
        # retry using the exact failed search snippet(s) before giving up and leaving it unchanged.
        new_candidate = candidate_prompt
        if prompt_instruction.strip():
            prompt_updater = PromptUpdaterAgent(llm_caller=self.opt_caller)
            retry_note = None
            for attempt in range(1, MAX_OPTIMIZER_PATCH_ATTEMPTS + 1):
                try:
                    edits = await prompt_updater.generate_edits_async(candidate_prompt, prompt_instruction, retry_note=retry_note)
                except Exception as e:
                    logger.error(f'Lab: PromptUpdaterAgent failed on attempt {attempt}/{MAX_OPTIMIZER_PATCH_ATTEMPTS} for iteration {iteration}: {e}')
                    break
                patch_result = apply_llm_edits(candidate_prompt, edits)
                if patch_result.success:
                    new_candidate = patch_result.updated_text
                    if attempt > 1:
                        logger.info(f'Lab: Prompt patch succeeded on retry attempt {attempt}/{MAX_OPTIMIZER_PATCH_ATTEMPTS} for iteration {iteration}.')
                    else:
                        logger.info(f'Lab: Successfully applied {len(edits)} prompt edit(s) for iteration {iteration}.')
                    break
                failed_count = sum(1 for r in patch_result.edit_results if not r.success)
                if attempt < MAX_OPTIMIZER_PATCH_ATTEMPTS:
                    logger.warning(
                        f'Lab: Prompt patch attempt {attempt}/{MAX_OPTIMIZER_PATCH_ATTEMPTS} failed '
                        f'({failed_count}/{len(edits)} edit(s)) for iteration {iteration}; retrying with an '
                        f'LLM self-correction call using the verbatim failed search snippet(s)...'
                    )
                    retry_note = format_retry_context(edits, patch_result)
                else:
                    logger.warning(
                        f'Lab: Prompt patch still failed after {MAX_OPTIMIZER_PATCH_ATTEMPTS} attempt(s) '
                        f'for iteration {iteration} ({failed_count}/{len(edits)} edit(s)) — prompt left '
                        f'unchanged this iteration.'
                    )

        # STAGE 3 — APPLY THE SCHEMA PLAN via SchemaUpdaterAgent + JsonSchemaPatchEngine, same
        # pattern. Skipped entirely (leaving json_schema untouched) when there's no schema to begin
        # with, or the optimizer decided no schema change is warranted — this is what keeps a
        # prompt-only run (no JSON schema configured at all) working exactly as before, with zero
        # schema-related overhead. This is also the fix for the schema never actually being
        # updated: previously schema_instruction was descriptive text shown to a human but never
        # fed to anything that could act on it.
        new_schema = json_schema
        no_schema_change = schema_instruction.strip().rstrip('.').lower() == 'no schema adjustments needed'
        if json_schema.strip() and schema_instruction.strip() and not no_schema_change:
            try:
                schema_dict = json.loads(json_schema)
            except Exception as e:
                logger.error(f'Lab: Could not parse current JSON schema for iteration {iteration}, skipping schema update: {e}')
                schema_dict = None
            if schema_dict is not None:
                schema_updater = SchemaUpdaterAgent(llm_caller=self.opt_caller)
                retry_note = None
                for attempt in range(1, MAX_OPTIMIZER_PATCH_ATTEMPTS + 1):
                    try:
                        patches = await schema_updater.generate_edits_async(json_schema, schema_instruction, retry_note=retry_note)
                    except Exception as e:
                        logger.error(f'Lab: SchemaUpdaterAgent failed on attempt {attempt}/{MAX_OPTIMIZER_PATCH_ATTEMPTS} for iteration {iteration}: {e}')
                        break
                    patch_result = self.json_patch_engine.apply(schema_dict, patches)
                    if patch_result.success:
                        new_schema = json.dumps(patch_result.updated_schema, indent=2)
                        if attempt > 1:
                            logger.info(f'Lab: Schema patch succeeded on retry attempt {attempt}/{MAX_OPTIMIZER_PATCH_ATTEMPTS} for iteration {iteration}.')
                        else:
                            logger.info(f'Lab: Successfully applied {len(patches)} schema patch(es) for iteration {iteration}.')
                        break
                    if attempt < MAX_OPTIMIZER_PATCH_ATTEMPTS:
                        logger.warning(
                            f'Lab: Schema patch attempt {attempt}/{MAX_OPTIMIZER_PATCH_ATTEMPTS} failed '
                            f'({patch_result.error}) for iteration {iteration}; retrying with an LLM '
                            f'self-correction call using the exact failing path(s)...'
                        )
                        retry_note = format_schema_retry_context(patches, patch_result)
                    else:
                        logger.warning(
                            f'Lab: Schema patch still failed after {MAX_OPTIMIZER_PATCH_ATTEMPTS} attempt(s) '
                            f'for iteration {iteration} ({patch_result.error}) — schema left unchanged this iteration.'
                        )

        return {
            'proposed_prompt': new_candidate,
            'proposed_schema': new_schema,
            'prompt_instruction': prompt_instruction,
            'schema_instruction': schema_instruction
        }

    def route_after_optimizer(self, state: OptimizationState) -> str:
        eval_mode = state.get('eval_mode', 'hybrid')
        if eval_mode == 'autonomous':
            return 'apply_autonomous'
        return 'human_review'

    async def apply_autonomous_node(self, state: OptimizationState) -> Dict[str, Any]:
        proposed_prompt = state.get('proposed_prompt') or state['candidate_prompt']
        proposed_schema = state.get('proposed_schema')
        iteration = state.get('iteration', 1)
        logger.info(f"Lab: Auto-applying proposed prompt for iteration {iteration + 1}...")
        update: Dict[str, Any] = {
            'candidate_prompt': proposed_prompt,
            'iteration': iteration + 1
        }
        if proposed_schema is not None:
            update['json_schema'] = proposed_schema
        return update

    async def human_review_node(self, state: OptimizationState) -> Dict[str, Any]:
        eval_mode = state.get('eval_mode', 'hybrid')
        iteration = state.get('iteration', 1)
        logger.info(f'Lab: Pausing execution for {eval_mode} human review with diff (Iteration {iteration})...')
        proposed_prompt = state.get('proposed_prompt') or state['candidate_prompt']
        current_schema = state.get('json_schema', '')
        proposed_schema = state.get('proposed_schema')
        payload = {
            'type': 'human_review_required',
            'iteration': iteration,
            'score': state['score'],
            'is_passed': state['is_passed'],
            'critique': state['critique'],
            'query_results': state['query_results'],
            'old_prompt': state['candidate_prompt'],
            'new_prompt': proposed_prompt,
            'old_schema': current_schema,
            'new_schema': proposed_schema if proposed_schema is not None else current_schema,
            'prompt_instruction': state.get('prompt_instruction', ''),
            'schema_instruction': state.get('schema_instruction', ''),
            'eval_mode': eval_mode
        }
        user_input = interrupt(payload)
        action = user_input.get('action', 'continue')
        logger.info(f"Lab: Resumed from human review with action: {action}")
        if action == 'continue':
            update: Dict[str, Any] = {
                'user_action': 'continue',
                'candidate_prompt': proposed_prompt,
                'iteration': iteration + 1
            }
            if proposed_schema is not None:
                update['json_schema'] = proposed_schema
            return update
        elif action in ('finish', 'stop'):
            apply_changes = user_input.get('apply', True)
            final_p = proposed_prompt if apply_changes else state['candidate_prompt']
            final_s = (proposed_schema if apply_changes and proposed_schema is not None else current_schema)
            return {
                'user_action': 'stop',
                'candidate_prompt': final_p,
                'json_schema': final_s
            }
        else:
            return {'user_action': 'stop'}

    def route_after_human_review(self, state: OptimizationState) -> str:
        if state.get('user_action') == 'stop':
            logger.info('Lab: User chose to conclude optimization.')
            return 'report_generator'
        return 'run_query_suite'

    async def report_generator_node(self, state: OptimizationState) -> Dict[str, Any]:
        base_prompt = state['base_prompt']
        candidate_prompt = state['candidate_prompt']
        history = state.get('history', [])
        criteria = state.get('acceptance_criteria', [])
        queries = state.get('test_queries', [])
        max_iters = state.get('max_iterations', 3)
        pass_threshold = state.get('pass_threshold', 100)
        final_score = state.get('score', 0)
        is_passed = state.get('is_passed', False)
        status_text = (
            f'Passed (Score >= {pass_threshold}% Threshold)' if is_passed
            else f'Completed Max Iterations (Best Score {final_score}% Below {pass_threshold}% Threshold)'
        )
        report_lines = [
            '# 🧪 Prompt Optimization Lab: Experiment Report',
            f'**Status:** {status_text}',
            f'**Final Score:** {final_score}% | **Iterations:** {len(history)} / {max_iters}',
            '',
            '---',
            '',
            '## 📊 Executive Scorecard',
            '',
            '| Iteration | Overall Score | Status | Key Diagnosis / Critique |',
            '| :---: | :---: | :---: | :--- |'
        ]
        for h in history:
            stat_icon = '✅ Passed' if h.get('is_passed') else '❌ Failed'
            crit = h.get('critique', '').replace('\n', ' ')[:100] + '...'
            report_lines.append(f'| **Iter {h.get("iteration")}** | {h.get("score")}% | {stat_icon} | {crit} |')
        report_lines.extend(['', '---', '', '## 🎯 Acceptance Criteria Evaluated'])
        for c in criteria:
            report_lines.append(f'- [x] {c}')
        report_lines.extend(['', '---', '', '## 🔬 Test Queries Suite'])
        for q in queries:
            report_lines.append(f'- **[{q.get("level", "L1")} - {q.get("name", "Test")}]**: {q.get("query", "")}')
        report_lines.extend(['', '---', '', '## 📝 Iteration Details & Output Snapshots'])
        for h in history:
            report_lines.append(f'### Iteration {h.get("iteration")}')
            report_lines.append(f'* **Score:** {h.get("score")}%')
            report_lines.append(f'* **Critique:** {h.get("critique")}')
            for res in h.get('results', []):
                out_snippet = res.get('output', '')[:200].replace('\n', ' ')
                report_lines.append(f'  - **[{res.get("level")}]:** {res.get("query")} ➔ {out_snippet}...')
            report_lines.append('')
        report_lines.extend(['', '---', '', '## 🔍 Final Prompt Changes Summary'])
        report_lines.append('')
        report_markdown = '\n'.join(report_lines)
        logger.info('Lab: Generated final experiment report.')
        return {'report_markdown': report_markdown}
