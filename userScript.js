/*
 * Telewizja — moduł TizenBrew (ładowarka).
 * Przy każdym uruchomieniu pobiera aktualną wersję dodatku (app.js) prosto z GitHuba,
 * więc poprawki działają po ponownym otwarciu aplikacji — bez restartu telewizora.
 * Gdy GitHub nie odpowiada, używa ostatniej pobranej wersji zapisanej w telewizorze.
 */
(function () {
  'use strict';
  if (window.__tvNavLoader) return;
  if (!/^https?:$/.test(location.protocol)) return;
  try { if (window.top !== window) return; } catch (e) { return; }
  window.__tvNavLoader = true;

  var SRC = 'https://raw.githubusercontent.com/ArkadiuszWalezak/tv-pilot/main/app.js';
  var KEY = 'tvnav:code';
  var code = '', from = '';

  // pobieramy synchronicznie, żeby dodatek zaczął działać, zanim strona uruchomi odtwarzacz
  try {
    var x = new XMLHttpRequest();
    x.open('GET', SRC + '?t=' + Date.now(), false);
    x.send();
    if (x.status === 200 && x.responseText.indexOf('__tvNav') >= 0) { code = x.responseText; from = 'GitHub'; }
  } catch (e) { /* brak sieci lub GitHub nie odpowiada */ }

  if (code) {
    try { localStorage.setItem(KEY, code); } catch (e) { /* brak miejsca — trudno */ }
  } else {
    try { code = localStorage.getItem(KEY) || ''; from = 'kopia w telewizorze'; } catch (e) { code = ''; }
  }
  if (!code) return;

  window.__tvNavFrom = from;
  try { (0, eval)(code + '\n//# sourceURL=tv-pilot-app.js'); } catch (e) { /* błąd w dodatku */ }
})();
