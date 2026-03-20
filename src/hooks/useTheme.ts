/**
 * Theme Hook
 *
 * Manages dark/light mode with localStorage persistence and
 * system preference detection via prefers-color-scheme.
 *
 * Applies the 'dark' class to the document root element.
 *
 * @see MVP-12
 */

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'arkova-theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // localStorage unavailable in test environments
  }
  // Default to dark to match marketing site aesthetic
  return 'dark';
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  try {
    const resolved = theme === 'system' ? getSystemTheme() : theme;
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  } catch {
    // Test environment safety
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    try { localStorage.setItem(STORAGE_KEY, newTheme); } catch { /* test env */ }
    applyTheme(newTheme);
  }, []);

  // Apply on mount
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for system preference changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } catch {
      // matchMedia unavailable in test environments
    }
  }, [theme]);

  const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;

  return { theme, resolvedTheme, setTheme };
}
