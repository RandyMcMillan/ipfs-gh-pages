// Restore the chosen theme before first paint (default: light).
// External file so the CSP `script-src 'self'` holds (docs/markdown-rendering.md).
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) {}
  if (t === 'dark' || t === 'light') {
    document.documentElement.setAttribute('data-color-mode', t);
  }
})();
