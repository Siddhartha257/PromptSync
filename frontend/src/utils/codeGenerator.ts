function getRefName(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1];
}

function getTsType(val: any): string {
  if (val.$ref) return getRefName(val.$ref);
  if (val.anyOf) {
    return val.anyOf.map((v: any) => getTsType(v)).join(' | ');
  }
  if (val.type === 'string') {
    return val.enum ? val.enum.map((e: any) => `'${e}'`).join(' | ') : 'string';
  }
  if (val.type === 'integer' || val.type === 'number') return 'number';
  if (val.type === 'boolean') return 'boolean';
  if (val.type === 'null') return 'null';
  if (val.type === 'array') {
    if (val.items) {
      const itemType = getTsType(val.items);
      return itemType.includes('|') ? `(${itemType})[]` : `${itemType}[]`;
    }
    return 'any[]';
  }
  if (val.type === 'object') {
     return 'Record<string, any>'; // Fallback for inline objects without explicit properties
  }
  return 'any';
}

function generateTsInterface(name: string, schema: any): string {
  let out = `export interface ${name} {\n`;
  if (schema.properties) {
    for (const [key, val] of Object.entries<any>(schema.properties)) {
      const isRequired = schema.required?.includes(key);
      const tsType = getTsType(val);
      if (val.description) {
        out += `  /** ${val.description} */\n`;
      }
      out += `  ${key}${isRequired ? '' : '?'}: ${tsType};\n`;
    }
  }
  out += '}\n\n';
  return out;
}

export function generateTypeScript(schemaStr: string): string {
  try {
    const schema = JSON.parse(schemaStr);
    let out = '';
    
    // Parse definitions first so they appear at the top
    const defs = schema.$defs || schema.definitions || {};
    for (const [defName, defSchema] of Object.entries(defs)) {
      out += generateTsInterface(defName, defSchema);
    }
    
    // Parse root model
    out += generateTsInterface(schema.title || 'OutputModel', schema);
    return out.trim() + '\n';
  } catch (e) {
    return '// Error parsing JSON schema\n';
  }
}

function getPyType(val: any): string {
  if (val.$ref) return getRefName(val.$ref);
  if (val.anyOf) {
    const types = val.anyOf.map((v: any) => getPyType(v));
    const nonNull = types.filter((t: string) => t !== 'None');
    if (types.includes('None')) {
      if (nonNull.length === 1) return `Optional[${nonNull[0]}]`;
      return `Optional[Union[${nonNull.join(', ')}]]`;
    }
    return `Union[${types.join(', ')}]`;
  }
  if (val.enum) {
    const literals = val.enum.map((e: any) => typeof e === 'string' ? `'${e}'` : e).join(', ');
    return `Literal[${literals}]`;
  }
  if (val.type === 'string') return 'str';
  if (val.type === 'integer') return 'int';
  if (val.type === 'number') return 'float';
  if (val.type === 'boolean') return 'bool';
  if (val.type === 'null') return 'None';
  if (val.type === 'array') {
    if (val.items) {
      return `List[${getPyType(val.items)}]`;
    }
    return 'List[Any]';
  }
  if (val.type === 'object') {
     return 'Dict[str, Any]';
  }
  return 'Any';
}

function generatePyClass(name: string, schema: any): string {
  let out = `class ${name}(BaseModel):\n`;
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    out += '    pass\n\n';
    return out;
  }
  
  for (const [key, val] of Object.entries<any>(schema.properties)) {
    const isRequired = schema.required?.includes(key);
    const hasDefault = val.default !== undefined;
    let pyType = getPyType(val);
    
    if (!isRequired && !hasDefault && !pyType.startsWith('Optional[')) {
       pyType = `Optional[${pyType}]`;
    }
    
    const fieldDesc = val.description ? `description="${val.description.replace(/"/g, "'")}"` : '';
    let fieldArgs = fieldDesc;
    
    if (hasDefault) {
       let defVal = typeof val.default === 'string' && val.default !== 'None' ? `"${val.default}"` : val.default;
       if (val.default === 'None') defVal = 'None';
       fieldArgs = `default=${defVal}` + (fieldArgs ? `, ${fieldArgs}` : '');
    } else if (!isRequired) {
       fieldArgs = `default=None` + (fieldArgs ? `, ${fieldArgs}` : '');
    } else {
       fieldArgs = `...` + (fieldArgs ? `, ${fieldArgs}` : '');
    }
    
    out += `    ${key}: ${pyType} = Field(${fieldArgs})\n`;
  }
  out += '\n';
  return out;
}

export function generatePydantic(schemaStr: string): string {
  try {
    const schema = JSON.parse(schemaStr);
    let out = 'from pydantic import BaseModel, Field\nfrom typing import List, Optional, Any, Union, Dict, Literal\n\n';
    
    // Parse definitions first so Pydantic classes can reference them below
    const defs = schema.$defs || schema.definitions || {};
    for (const [defName, defSchema] of Object.entries(defs)) {
      out += generatePyClass(defName, defSchema);
    }
    
    // Parse root model
    out += generatePyClass(schema.title || 'OutputModel', schema);
    return out.trim() + '\n';
  } catch (e) {
    return '# Error parsing JSON schema\n';
  }
}
