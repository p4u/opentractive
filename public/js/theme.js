// Classic script in <head>: applies the saved theme before the first paint (absent means follow the device).
try {
  var saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch (e) { /* storage blocked: follow the device */ }

// The browser and status bar take the canvas colour of the theme in use, also when it is chosen by hand.
function syncThemeColor() {
  var forced = document.documentElement.dataset.theme;
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    var dark = forced ? forced === 'dark' : /dark/.test(metas[i].media);
    metas[i].content = dark ? '#0c0a09' : '#f5f5f5'; // tokens.css --canvas
  }
}
syncThemeColor();
document.addEventListener('themechange', syncThemeColor);
