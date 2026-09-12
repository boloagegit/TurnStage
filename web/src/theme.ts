import type { WebThemePreference } from './storage';

export type ResolvedWebTheme = 'dark' | 'light';

export function resolveWebTheme(preference: WebThemePreference, prefersLight: boolean): ResolvedWebTheme {
  return preference === 'system' ? prefersLight ? 'light' : 'dark' : preference;
}

export function applyWebAppearance(preference: WebThemePreference, target: Document = document, media: Pick<MediaQueryList, 'matches'> = matchMedia('(prefers-color-scheme: light)')): ResolvedWebTheme {
  const resolved = resolveWebTheme(preference, media.matches);
  target.documentElement.dataset.theme = resolved;
  target.documentElement.style.colorScheme = resolved;
  target.body.classList.toggle('vscode-light', resolved === 'light');
  target.body.classList.toggle('vscode-dark', resolved === 'dark');
  target.body.classList.remove('vscode-high-contrast', 'vscode-high-contrast-light');
  return resolved;
}

export function bindSystemAppearance(getPreference: () => WebThemePreference, target: Document = document): () => void {
  const color = matchMedia('(prefers-color-scheme: light)');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const updateColor = () => applyWebAppearance(getPreference(), target, color);
  const updateMotion = () => target.body.classList.toggle('vscode-reduce-motion', motion.matches);
  color.addEventListener('change', updateColor);
  motion.addEventListener('change', updateMotion);
  updateColor();
  updateMotion();
  return () => {
    color.removeEventListener('change', updateColor);
    motion.removeEventListener('change', updateMotion);
  };
}
