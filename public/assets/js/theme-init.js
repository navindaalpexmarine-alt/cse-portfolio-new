/* Runs synchronously in <head> so the correct theme is applied before first
   paint (prevents a dark→light flash). Saved choice wins, else the OS setting. */
(function () {
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('cse_theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
    else if (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) theme = 'light';
  } catch (e) { /* storage blocked – keep default */ }
  document.documentElement.setAttribute('data-theme', theme);
})();
