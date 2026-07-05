import React from 'react';

export const ThemeContext = React.createContext<{ theme: string; toggleTheme: () => void }>({
  theme: 'dark',
  toggleTheme: () => {},
});
