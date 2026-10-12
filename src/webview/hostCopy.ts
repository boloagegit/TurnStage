/** True inside TurnStage Web, where requests, templates, and storage live in the browser rather than an Extension Host. */
export function isWebHost(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.host === 'web';
}

/** Picks the message that matches where the current host actually does the work. */
export function hostText(vscode: string, web: string): string { return isWebHost() ? web : vscode; }
