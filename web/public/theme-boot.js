// Applies the saved TurnStage Web theme before the first paint so a reload never
// flashes the wrong theme. Kept tiny and dependency-free; the app re-applies the
// same preference (and listens for system changes) once it starts.
(function () {
  try {
    var preference = JSON.parse(localStorage.getItem('turnstage.web.preferences.v1') || '{}').theme;
    var light = preference === 'light' || ((!preference || preference === 'system') && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    document.documentElement.style.colorScheme = light ? 'light' : 'dark';
  } catch (error) {
    /* Storage can be unavailable in private windows; the app applies the theme on start. */
  }
})();
