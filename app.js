/*
 * Telewizja — moduł TizenBrew: obsługa pilotem dla serwisu z telewizją w przeglądarce (adres w package.json)
 * Ten plik ładuje userScript.js (ładowarka) przy każdym uruchomieniu aplikacji.
 *
 * Co robi:
 *  - nawigacja po całej stronie strzałkami pilota (żółta ramka pokazuje, co jest zaznaczone),
 *  - tryb telewizora: obraz na pełnym ekranie, CH+/CH− (oraz ▲▼) zmienia kanał,
 *    cyfry wybierają kanał po numerze, OK otwiera listę kanałów, pasek informacji o programie,
 *  - Wstecz: z telewizji do menu serwisu i z powrotem; przytrzymanie Wstecz zamyka aplikację,
 *  - kolorowe przyciski: czerwony = strona główna, zielony = EPG, żółty = VOD, niebieski = telewizja,
 *  - zapamiętuje ostatni kanał i startuje od razu na nim.
 *
 * Kod celowo w starszym JavaScripcie (bez ?. i ??), bo przeglądarka w telewizorach Samsung z 2020 r. jest starsza.
 */
(function () {
  'use strict';
  if (window.__tvNav) return;
  window.__tvNav = { version: '1.0.7-test' };

  // Przeglądarka aplikacji na telewizorze przedstawia się bez słowa „Chrome”, więc strona bierze ją za Safari
  // i wybiera zabezpieczenie Apple (FairPlay), którego telewizor nie ma. Dopisujemy „Chrome/wersja”,
  // żeby strona wybrała Widevine, które telewizor obsługuje.
  (function fixUserAgent() {
    try {
      var ua = navigator.userAgent;
      if (/chrome|android/i.test(ua) || !/safari/i.test(ua)) return;
      var m = /(\d+\.\d+\.\d+\.\d+)/.exec(ua);
      var fixed = ua.replace(/ ((?:TV )?Safari\/)/, ' Chrome/' + (m ? m[1] : '94.0.0.0') + ' $1');
      if (fixed === ua) return;
      Object.defineProperty(navigator, 'userAgent', { get: function () { return fixed; }, configurable: true });
    } catch (e) { /* nie udało się — zostaje oryginalny */ }
  })();

  // ---------------------------------------------------------------- klawisze
  var K = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27,
    CH_UP: 427, CH_DOWN: 428, PAGE_UP: 33, PAGE_DOWN: 34,
    PREV_CH: 10190, INFO: 457,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413
  };
  function digitOf(e) {
    var c = e.keyCode;
    if (c >= 48 && c <= 57) return String(c - 48);
    if (c >= 96 && c <= 105) return String(c - 96); // klawiatura numeryczna (testy na komputerze)
    return null;
  }

  // ---------------------------------------------------------------- stan
  var state = {
    full: false,          // tryb telewizora (pełny ekran)
    overlay: null,        // otwarta lista kanałów
    focus: null,          // element zaznaczony ramką
    current: null,        // numer bieżącego kanału
    previous: null,       // numer poprzedniego kanału
    zapTarget: null, zapTimer: null,
    digits: '', digitTimer: null,
    pendingTune: null,
    tvEntered: false,
    session: false,
    userPaused: false, playTimer: null,
    toastTimer: null, osdTimer: null
  };
  var cache = { dirty: true, list: [] };
  var ui = {};
  var swallowed = {}; // klawisze obsłużone przy keydown — ich keypress/keyup też zatrzymujemy

  // ---------------------------------------------------------------- narzędzia
  function load(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* brak miejsca */ } }
  function hasSession() { try { return !!localStorage.getItem('dottv: sessionToken'); } catch (e) { return false; } }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function path() { return location.pathname.replace(/\/+$/, '') || '/'; }
  function isTvPage() { return path() === '/tv'; }
  function stop(e) {
    if (e.type === 'keydown') swallowed[e.keyCode] = true;
    e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  // Telewizor potrafi sam „kliknąć” element, który ma systemowe zaznaczenie (np. checkbox po kliknięciu),
  // nawet gdy żółta ramka jest już gdzie indziej. Dlatego:
  //  - zdejmujemy systemowe zaznaczenie przy każdym ruchu ramki i po każdym kliknięciu,
  //  - zatrzymujemy też keypress/keyup klawiszy, które obsłużyliśmy przy keydown.
  function releaseNativeFocus(keep) {
    var a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return;
    if (keep && (a === keep || keep.contains(a))) return;
    try { a.blur(); } catch (e) { /* ignorujemy */ }
  }
  function onKeyRest(e) {
    if (!swallowed[e.keyCode]) return;
    if (e.type === 'keyup') delete swallowed[e.keyCode];
    e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  function firstLine(el) { return ((el && el.innerText) || '').trim().split('\n')[0]; }

  function reactProps(el) {
    var ks = Object.keys(el);
    for (var i = 0; i < ks.length; i++) if (ks[i].indexOf('__reactProps') === 0) return el[ks[i]];
    return null;
  }
  function hasClick(el) {
    var p = reactProps(el);
    return !!(p && (typeof p.onClick === 'function' || typeof p.onMouseDown === 'function'));
  }
  function isEditable(el) {
    if (!el) return false;
    var t = el.tagName;
    if (t === 'TEXTAREA') return true;
    if (t === 'INPUT') return !/^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i.test(el.type || 'text');
    return !!el.isContentEditable;
  }

  // ---------------------------------------------------------------- wygląd
  var CSS = [
    '#tvnav-ring{position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;pointer-events:none;z-index:2147483600;',
    'border:4px solid #ffc400;border-radius:12px;box-shadow:0 0 0 3px rgba(0,0,0,.55),0 0 26px rgba(255,196,0,.65);display:none;',
    'transition:left .12s ease-out,top .12s ease-out,width .12s ease-out,height .12s ease-out;}',

    'html.tvnav-full,html.tvnav-full body{overflow:hidden!important;background:#000!important;}',
    'html.tvnav-full .tvnav-raise{z-index:2147483000!important;}',
    'html.tvnav-full .tvnav-player{position:fixed!important;left:0!important;top:0!important;right:auto!important;bottom:auto!important;',
    'width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;',
    'z-index:2147483000!important;background:#000!important;}',
    'html.tvnav-full .tvnav-player video{width:100%!important;height:100%!important;object-fit:contain!important;}',

    '#tvnav-osd{position:fixed;left:4vw;right:4vw;bottom:5vh;z-index:2147483500;display:none;align-items:center;',
    'padding:2.2vh 2vw;border-radius:16px;background:rgba(10,12,18,.9);color:#fff;font-family:Arial,Helvetica,sans-serif;',
    'box-shadow:0 10px 40px rgba(0,0,0,.5);}',
    '#tvnav-osd .tv-num{font-size:7vh;font-weight:700;min-width:9vw;text-align:center;color:#ffc400;margin-right:1.5vw;}',
    '#tvnav-osd .tv-logo{width:12vw;height:10vh;margin-right:2vw;display:flex;align-items:center;justify-content:center;}',
    '#tvnav-osd .tv-logo img{max-width:100%;max-height:100%;}',
    '#tvnav-osd .tv-info{flex:1;min-width:0;}',
    '#tvnav-osd .tv-name{font-size:4.2vh;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#tvnav-osd .tv-prog{font-size:3.2vh;margin-top:.6vh;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#tvnav-osd .tv-bar{height:.8vh;background:rgba(255,255,255,.2);border-radius:1vh;margin-top:1.4vh;overflow:hidden;}',
    '#tvnav-osd .tv-bar i{display:block;height:100%;width:0;background:#ffc400;}',
    '#tvnav-osd .tv-time{font-size:2.6vh;margin-top:.8vh;opacity:.75;}',

    '#tvnav-digits{position:fixed;top:5vh;right:4vw;z-index:2147483550;display:none;padding:1.5vh 2vw;border-radius:14px;',
    'background:rgba(10,12,18,.92);color:#ffc400;font:700 9vh Arial,Helvetica,sans-serif;letter-spacing:.5vw;}',

    '#tvnav-toast{position:fixed;top:5vh;left:50%;transform:translateX(-50%);z-index:2147483550;display:none;',
    'padding:1.4vh 2.4vw;border-radius:12px;background:rgba(10,12,18,.92);color:#fff;font:400 3vh Arial,Helvetica,sans-serif;',
    'max-width:80vw;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,.45);}',

    '#tvnav-list{position:fixed;left:0;top:0;bottom:0;width:40vw;z-index:2147483400;background:rgba(8,10,16,.95);color:#fff;',
    'font-family:Arial,Helvetica,sans-serif;box-shadow:10px 0 40px rgba(0,0,0,.6);display:flex;flex-direction:column;}',
    '#tvnav-list .tv-hdr{font-size:3.8vh;font-weight:700;padding:3vh 2vw 1vh;color:#ffc400;}',
    '#tvnav-list .tv-hint{font-size:2.2vh;opacity:.7;padding:0 2vw 1.5vh;}',
    '#tvnav-list .tv-rows{flex:1;overflow:hidden;position:relative;}',
    '#tvnav-list .tv-row{display:flex;align-items:center;height:9vh;padding:0 2vw;border-left:6px solid transparent;}',
    '#tvnav-list .tv-row.on{background:rgba(255,196,0,.2);border-left-color:#ffc400;}',
    '#tvnav-list .tv-row.cur .tv-rn{color:#ffc400;}',
    '#tvnav-list .tv-rn{width:5vw;font-size:3vh;font-weight:700;}',
    '#tvnav-list .tv-rl{width:7vw;height:6vh;margin-right:1.2vw;display:flex;align-items:center;justify-content:center;}',
    '#tvnav-list .tv-rl img{max-width:100%;max-height:100%;}',
    '#tvnav-list .tv-rt{flex:1;min-width:0;}',
    '#tvnav-list .tv-rname{font-size:2.9vh;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#tvnav-list .tv-rprog{font-size:2.3vh;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.4vh;}',

    '#tvnav-diag{position:fixed;right:2vw;top:10vh;max-width:62vw;z-index:2147483580;display:none;pointer-events:none;',
    'background:rgba(0,0,0,.88);color:#fff;font:400 2.3vh/1.35 Arial,Helvetica,sans-serif;padding:1.6vh 1.6vw;',
    'border:3px solid #ffc400;border-radius:12px;word-wrap:break-word;}',
    '#tvnav-diag b{color:#ffc400;}'
  ].join('');

  function buildUi() {
    var st = document.createElement('style');
    st.id = 'tvnav-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);

    ui.ring = document.createElement('div'); ui.ring.id = 'tvnav-ring';
    ui.osd = document.createElement('div'); ui.osd.id = 'tvnav-osd';
    ui.osd.innerHTML = '<div class="tv-num"></div><div class="tv-logo"><img alt=""></div>' +
      '<div class="tv-info"><div class="tv-name"></div><div class="tv-prog"></div><div class="tv-bar"><i></i></div><div class="tv-time"></div></div>';
    ui.digits = document.createElement('div'); ui.digits.id = 'tvnav-digits';
    ui.toast = document.createElement('div'); ui.toast.id = 'tvnav-toast';
    ui.diag = document.createElement('div'); ui.diag.id = 'tvnav-diag';
    document.body.appendChild(ui.ring);
    document.body.appendChild(ui.osd);
    document.body.appendChild(ui.digits);
    document.body.appendChild(ui.toast);
    document.body.appendChild(ui.diag);
  }

  function toast(msg, ms) {
    ui.toast.textContent = msg;
    ui.toast.style.display = 'block';
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { ui.toast.style.display = 'none'; }, ms || 2500);
  }

  // ---------------------------------------------------------------- TEST: czy telewizor pozwala odtwarzać treści z DRM
  // Wersja testowa: na stronie telewizji pokazuje w prawym górnym rogu, co telewizor odpowiada na pytania o DRM.
  var diag = { probes: {}, order: [], calls: [], mcap: {}, net: [], errors: [], encrypted: '', orig: null };
  function dShort(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function dErr(e) { return e ? ((e.name || 'Błąd') + (e.message ? ': ' + e.message : '')) : 'błąd'; }
  function dFlat(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function renderDiag() {
    if (!ui.diag) return;
    var h = '<b>TEST DRM</b> (tv-pilot ' + esc(window.__tvNav.version) + (window.__tvNavFrom ? ', ' + esc(window.__tvNavFrom) : '') + ')<br>';
    h += 'Telewizor: ' + diag.order.map(function (k) { return esc(k) + ' ' + esc(diag.probes[k]); }).join(' · ') + '<br>';
    if (diag.platform) h += 'Platforma dla serwera: ' + esc(diag.platform) + ' → ' + esc(PLATFORM) + '<br>';
    if (diag.chTotal !== undefined) h += 'Lista kanałów: ' + diag.chFixed + ' z ' + diag.chTotal + ' przepisane z Apple na Widevine' + (diag.origPl ? ' (pl=' + esc(diag.origPl) + ')' : '') + '<br>';
    if (diag.pbFixed) h += 'Odtwarzanie: przepisane z Apple na Widevine (' + diag.pbFixed + ')<br>';
    if (diag.encrypted) h += 'Obraz zaszyfrowany: tak (' + esc(diag.encrypted) + ')<br>';
    var asked = Object.keys(diag.mcap).map(function (k) { return esc(k) + ' → ' + esc(diag.mcap[k]); });
    diag.calls.forEach(function (c) { asked.push(esc(c.ks) + ' → ' + esc(c.res)); });
    if (asked.length) h += 'Strona pytała o DRM: ' + asked.join(' · ') + '<br>';
    if (diag.net.length) {
      h += 'Sieć:<br>';
      diag.net.forEach(function (s) { h += '&nbsp;• ' + esc(s) + '<br>'; });
    }
    diag.errors.forEach(function (s) { h += '! ' + esc(s) + '<br>'; });
    h += '<span style="opacity:.7;font-size:1.9vh">' + esc(dShort(navigator.userAgent, 160)) + '</span>';
    ui.diag.innerHTML = h;
  }
  function dNote(s) {
    s = dShort(dFlat(s), 170);
    if (diag.errors.indexOf(s) >= 0) return;
    diag.errors.push(s);
    if (diag.errors.length > 5) diag.errors.shift();
    renderDiag();
  }
  function netNote(s) {
    diag.net.push(dShort(dFlat(s), 170));
    if (diag.net.length > 6) diag.net.shift();
    renderDiag();
  }

  // opis błędu odtwarzacza Shaka razem z przyczyną (np. odpowiedź serwera licencji)
  function shakaErr(e) {
    var s = 'Shaka ' + e.code;
    var d = e.data || [];
    var inner = d[0];
    if (inner && typeof inner.code === 'number') {
      var id = inner.data || [];
      s += ' ← ' + inner.code;
      if (inner.code === 1001) s += ' HTTP ' + id[1] + ' ' + dShort(dFlat(id[2]), 90);
      else if (inner.code === 1002) s += ' błąd sieci: ' + dShort(dErr(id[1]), 70);
      else if (inner.code === 1003) s += ' brak odpowiedzi (czas minął)';
      else if (id.length) { try { s += ' ' + dShort(JSON.stringify(id), 80); } catch (er) { /* pomijamy */ } }
    } else if (d.length) {
      try { s += ' ' + dShort(JSON.stringify(d), 90); } catch (er) { /* pomijamy */ }
    }
    return s;
  }

  // adres bez parametrów (mogą w nich być tokeny) — sam serwer i ścieżka
  function shortUrl(url) {
    url = String(url || '');
    var host = '', p = url.split('?')[0];
    try { var u = new URL(url, location.href); host = u.host; p = u.pathname; } catch (e) { host = ''; }
    return host + dShort(p, 45);
  }
  function netTag(url, method, body) {
    url = String(url || '');
    method = String(method || 'GET').toUpperCase();
    // pomijamy kawałki obrazu i listy odtwarzania — rodzaj strumienia widać w odpowiedzi „playbackUrl”
    if (/\.(m4s|ts|mp4|m4a|m4v|aac|vtt|m3u8|mpd)(\?|$)/i.test(url.split('#')[0])) return '';
    var bin = body && typeof body !== 'string' && !(window.URLSearchParams && body instanceof URLSearchParams) &&
      !(window.FormData && body instanceof FormData);
    var preauth = /[?&]cid=[^&]*&type=/i.test(url);
    if (!(preauth || /playbackUrl|licen|drm|widevine|preauth/i.test(url) || (method === 'POST' && bin))) return '';
    return method + ' ' + shortUrl(url) + (preauth ? ' (przed licencją)' : '');
  }
  // co serwer przydzielił: rodzaj zabezpieczenia, adres licencji i rodzaj strumienia (bez tokenów)
  function playbackSummary(j) {
    var d = (j && j.drmInfo) || {};
    var uri = String((j && j.uri) || '').split('?')[0];
    var kind = /\.mpd$/i.test(uri) ? 'DASH' : /\.m3u8$/i.test(uri) ? 'HLS' : (uri ? '?' : '-');
    return 'drm=' + (d.drmType || '-') + ', licencja=' + (d.licenseProxyUri ? shortUrl(d.licenseProxyUri) : '-') + ', strumień=' + kind;
  }

  // Strona mówi serwerowi, na jakim systemie działa (nagłówek „Platform”), odczytując to z opisu przeglądarki.
  // Na telewizorze wychodzi „Unknown” i serwer daje wersję kanału dla Apple (FairPlay), której telewizor nie odtworzy.
  // Podajemy „Windows”, tak jak przeglądarka na komputerze, na którym kanały działają.
  var PLATFORM = 'Windows';
  function fixPlatformHeaders(h) {
    if (!h || typeof h !== 'object') return h;
    try {
      if (window.Headers && h instanceof Headers) {
        var v = h.get('Platform');
        if (v === null || v === PLATFORM) return h;
        if (!diag.platform) { diag.platform = v; renderDiag(); }
        var c = new Headers(h);
        c.set('Platform', PLATFORM);
        return c;
      }
      for (var k in h) {
        if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === 'platform' && h[k] !== PLATFORM) {
          if (!diag.platform) { diag.platform = String(h[k]); renderDiag(); }
          var o = {};
          for (var j in h) if (Object.prototype.hasOwnProperty.call(h, j)) o[j] = h[j];
          o[k] = PLATFORM;
          return o;
        }
      }
    } catch (e) { /* zostawiamy nagłówki strony */ }
    return h;
  }
  function bodySnippet(text) { return text ? ' ' + dShort(dFlat(text), 90) : ''; }
  function headerSnippet(get) {
    var out = [];
    ['x-error', 'x-error-message', 'x-reason', 'x-dt-error', 'x-axdrm-errormessage', 'x-drm-error', 'www-authenticate'].forEach(function (k) {
      var v = get(k);
      if (v) out.push(k + '=' + dShort(v, 50));
    });
    return out.length ? ' [' + out.join(', ') + ']' : '';
  }

  // ---------------------------------------------------------------- wersja kanałów dla Widevine zamiast Apple
  // Serwer rozpoznaje telewizor jako urządzenie Apple i w liście kanałów podaje adresy dla FairPlay
  // (licencja …/fairplay/…, strumień .m3u8). Telewizor ma Widevine, więc przepisujemy te adresy na
  // wersję, którą dostaje zwykła przeglądarka na komputerze (licencja bez /fairplay/, strumień manifest.mpd).
  function widevineUri(u) {
    u = String(u);
    var m = /[?&]pl=([^&#]*)/.exec(u);
    if (m && !diag.origPl) diag.origPl = m[1];
    return u.replace(/(\/drm\/[^\/?#]+\/)[^?#]*\.m3u8/i, '$1manifest.mpd').replace(/([?&]pl=)[^&#]*/, '$1web');
  }
  function toWidevine(c) {
    if (!c || typeof c !== 'object') return false;
    var lic = String(c.licenseProxyUri || '');
    if (!(c.drm === 3 || /\/fairplay\//i.test(lic))) return false;
    if (lic) c.licenseProxyUri = lic.replace(/\/fairplay\//i, '/');
    if (c.drm === 3) c.drm = 1;
    if (c.certificateUri) c.certificateUri = null;
    if (typeof c.uri === 'string') c.uri = widevineUri(c.uri);
    return true;
  }
  function jsonResponse(res, obj) {
    return new Response(JSON.stringify(obj), {
      status: res.status, statusText: res.statusText,
      headers: { 'Content-Type': (res.headers && res.headers.get('content-type')) || 'application/json' }
    });
  }
  function fixChannelsResponse(res) {
    if (!res || !res.ok || !window.Response) return res;
    return res.clone().text().then(function (txt) {
      var j;
      try { j = JSON.parse(txt); } catch (e) { return res; }
      var list = j && j.channels;
      if (!list || !list.length) return res;
      var n = 0;
      for (var i = 0; i < list.length; i++) if (toWidevine(list[i])) n++;
      diag.chTotal = list.length;
      diag.chFixed = n;
      renderDiag();
      return n ? jsonResponse(res, j) : res;
    }, function () { return res; });
  }
  function fixPlaybackResponse(res) {
    if (!res || !res.ok || !window.Response) return res;
    return res.clone().text().then(function (txt) {
      var j;
      try { j = JSON.parse(txt); } catch (e) { return res; }
      var d = j && j.drmInfo;
      if (!d || !(/\/fairplay\//i.test(String(d.licenseProxyUri || '')) || /fairplay/i.test(String(d.drmType)) || d.drmType === 3)) return res;
      d.licenseProxyUri = String(d.licenseProxyUri || '').replace(/\/fairplay\//i, '/');
      d.drmType = typeof d.drmType === 'number' ? 1 : 'widevine';
      d.certificateUri = '';
      if (typeof j.uri === 'string') j.uri = widevineUri(j.uri);
      diag.pbFixed = (diag.pbFixed || 0) + 1;
      renderDiag();
      return jsonResponse(res, j);
    }, function () { return res; });
  }

  // Strona trzyma listę kanałów w pamięci przeglądarki. Jeśli zapisała wersję dla Apple, czyścimy ją
  // i przeładowujemy stronę, żeby pobrała listę od nowa (już przepisaną). Najwyżej raz na 2 minuty.
  function openExistingDb(name, done) {
    // najpierw sprawdzamy, czy baza istnieje — nie wolno nam utworzyć pustej bazy za stronę
    if (indexedDB.databases) {
      indexedDB.databases().then(function (list) {
        for (var i = 0; i < list.length; i++) if (list[i].name === name) { openDbNow(name, done); return; }
        done(null);
      }, function () { openDbNow(name, done); });
      return;
    }
    openDbNow(name, done);
  }
  function openDbNow(name, done) {
    var rq;
    try { rq = indexedDB.open(name); } catch (e) { done(null); return; }
    rq.onupgradeneeded = function () { try { rq.transaction.abort(); } catch (e) { /* nie tworzymy nowej bazy */ } };
    rq.onsuccess = function () { done(rq.result); };
    rq.onerror = function () { done(null); };
    rq.onblocked = function () { done(null); };
  }
  function readAll(db, store, done) {
    if (!db || !db.objectStoreNames.contains(store)) { done(''); return; }
    try {
      var r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = function () { var s = ''; try { s = JSON.stringify(r.result); } catch (e) { s = ''; } done(s); };
      r.onerror = function () { done(''); };
    } catch (e) { done(''); }
  }
  function clearStore(db, store, key, done) {
    if (!db || !db.objectStoreNames.contains(store)) { done(); return; }
    try {
      var tx = db.transaction(store, 'readwrite');
      var os = tx.objectStore(store);
      if (key) os['delete'](key); else os.clear();
      tx.oncomplete = function () { done(); };
      tx.onerror = tx.onabort = function () { done(); };
    } catch (e) { done(); }
  }
  function purgeAppleChannelCache() {
    if (!window.indexedDB) return;
    var last = 0;
    try { last = Number(localStorage.getItem('tvnav:cachefix')) || 0; } catch (e) { return; }
    if (Date.now() - last < 120000) return;
    openExistingDb('dotTV-database', function (db1) {
      readAll(db1, 'datastore', function (s1) {
        openExistingDb('CacheDB', function (db2) {
          readAll(db2, 'CacheStore', function (s2) {
            if (s1.indexOf('/fairplay/') < 0 && s2.indexOf('/fairplay/') < 0) {
              if (db1) db1.close();
              if (db2) db2.close();
              return;
            }
            clearStore(db1, 'datastore', 'tv-storage', function () {
              clearStore(db2, 'CacheStore', null, function () {
                if (db1) db1.close();
                if (db2) db2.close();
                try {
                  localStorage.removeItem('isTVCacheChecked');
                  localStorage.setItem('tvnav:cachefix', String(Date.now()));
                } catch (e) { /* trudno */ }
                location.reload();
              });
            });
          });
        });
      });
    });
  }

  function watchNet() {
    var of = window.fetch;
    if (of && !of.__tvnav) {
      var wf = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
        var tag = '', args = arguments;
        try { tag = netTag(url, method, init && init.body); } catch (e) { tag = ''; }
        if (init && init.headers) {
          var nh = fixPlatformHeaders(init.headers);
          if (nh !== init.headers) {
            var ni = {};
            for (var k in init) ni[k] = init[k];
            ni.headers = nh;
            args = [input, ni];
          }
        }
        var p = of.apply(window, args);
        var bare = String(url).split('#')[0].split('?')[0];
        if (/\/channels$/.test(bare) && String(method).toUpperCase() === 'GET') p = p.then(fixChannelsResponse);
        else if (/playbackUrl$/i.test(bare)) p = p.then(fixPlaybackResponse);
        if (tag) {
          p.then(function (res) {
            var line = tag + ' → ' + res.status;
            var hs = headerSnippet(function (k) { try { return res.headers.get(k); } catch (e) { return null; } });
            if (res.ok && /playbackUrl/i.test(url)) {
              try {
                res.clone().json().then(function (j) { netNote(line + ': ' + playbackSummary(j)); }, function () { netNote(line + ' OK'); });
              } catch (e) { netNote(line + ' OK'); }
              return;
            }
            if (res.ok) { netNote(line + ' OK' + hs); return; }
            try {
              res.clone().text().then(function (t) { netNote(line + hs + bodySnippet(t)); }, function () { netNote(line + hs); });
            } catch (e) { netNote(line + hs); }
          }, function (e) { netNote(tag + ' → BŁĄD SIECI: ' + dShort(dErr(e), 60)); });
        }
        return p;
      };
      wf.__tvnav = true;
      try { window.fetch = wf; } catch (e) { /* nie da się podmienić */ }
    }
    var X = window.XMLHttpRequest && XMLHttpRequest.prototype;
    if (X && !X.open.__tvnav) {
      var xo = X.open, xs = X.send;
      X.open = function (m, u) { this.__tvm = m; this.__tvu = u; return xo.apply(this, arguments); };
      X.open.__tvnav = true;
      var xh = X.setRequestHeader;
      if (xh) {
        X.setRequestHeader = function (name, value) {
          if (String(name).toLowerCase() === 'platform' && value !== PLATFORM) {
            if (!diag.platform) diag.platform = String(value);
            return xh.call(this, name, PLATFORM);
          }
          return xh.apply(this, arguments);
        };
      }
      X.send = function (body) {
        var x = this, tag = '';
        try { tag = netTag(x.__tvu, x.__tvm, body); } catch (e) { tag = ''; }
        if (tag) {
          x.addEventListener('loadend', function () {
            if (!x.status) { netNote(tag + ' → BŁĄD SIECI (brak odpowiedzi)'); return; }
            var hs = headerSnippet(function (k) { try { return x.getResponseHeader(k); } catch (e) { return null; } });
            var t = '';
            try {
              if (!x.responseType || x.responseType === 'text') t = x.responseText;
              else if (x.responseType === 'arraybuffer' && x.response && window.TextDecoder) t = new TextDecoder().decode(new Uint8Array(x.response).subarray(0, 300));
            } catch (e) { t = ''; }
            netNote(tag + ' → ' + x.status + (x.status < 400 ? ' OK' + hs : hs + bodySnippet(t)));
          });
        }
        return xs.apply(this, arguments);
      };
    }
  }

  // Shaka pyta o DRM przez mediaCapabilities.decodingInfo — zapisujemy, o jaki system pyta i co słyszy
  function watchMcap() {
    var mc = navigator.mediaCapabilities;
    if (!mc || !mc.decodingInfo || mc.decodingInfo.__tvnav) return;
    var od = mc.decodingInfo;
    var w = function (cfg) {
      var p = od.apply(mc, arguments);
      var ks = cfg && cfg.keySystemConfiguration && cfg.keySystemConfiguration.keySystem;
      if (ks && p && p.then) {
        var name = String(ks).replace('com.', '').replace('.alpha', '');
        p.then(function (r) {
          if (r && r.supported) diag.mcap[name] = 'TAK';
          else if (diag.mcap[name] !== 'TAK') diag.mcap[name] = 'NIE';
          renderDiag();
        }, function (e) {
          if (diag.mcap[name] !== 'TAK') diag.mcap[name] = 'NIE: ' + dShort(dErr(e), 40);
          renderDiag();
        });
      }
      return p;
    };
    w.__tvnav = true;
    try { mc.decodingInfo = w; } catch (e) { /* nie da się podmienić */ }
  }
  // od razu, zanim strona zacznie odtwarzać (nie czekamy na zbudowanie strony)
  try { watchNet(); } catch (e) { /* bez zapisu sieci */ }
  try { watchMcap(); } catch (e) { /* bez zapisu pytań o DRM */ }
  try { purgeAppleChannelCache(); } catch (e) { /* bez czyszczenia */ }

  function probe(label, ks, cfg, withKeys) {
    diag.order.push(label);
    diag.probes[label] = '…';
    var fn = diag.orig || navigator.requestMediaKeySystemAccess;
    if (!fn) { diag.probes[label] = 'BRAK EME w przeglądarce'; renderDiag(); return; }
    var p;
    try { p = fn.call(navigator, ks, cfg); } catch (e) { diag.probes[label] = 'NIE: ' + dShort(dErr(e), 80); renderDiag(); return; }
    p.then(function (access) {
      diag.probes[label] = 'TAK';
      renderDiag();
      if (!withKeys) return;
      access.createMediaKeys().then(function () {
        diag.probes[label] = 'TAK (klucze też)';
        renderDiag();
      }, function (e) {
        diag.probes[label] = 'TAK, ale klucze NIE: ' + dShort(dErr(e), 70);
        renderDiag();
      });
    }, function (e) {
      diag.probes[label] = 'NIE: ' + dShort(dErr(e), 80);
      renderDiag();
    });
  }

  function runProbes() {
    var v = 'video/mp4; codecs="avc1.42E01E"', a = 'audio/mp4; codecs="mp4a.40.2"';
    probe('Widevine', 'com.widevine.alpha', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: v }] }], true);
    probe('Widevine (pełne)', 'com.widevine.alpha', [{
      initDataTypes: ['cenc'],
      audioCapabilities: [{ contentType: a, robustness: '' }],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.640028"', robustness: '' }],
      distinctiveIdentifier: 'optional', persistentState: 'optional', sessionTypes: ['temporary']
    }], false);
    probe('Widevine (trwały stan)', 'com.widevine.alpha', [{
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: v }],
      persistentState: 'required'
    }], false);
    probe('PlayReady', 'com.microsoft.playready', [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: v }] }], true);
    probe('ClearKey', 'org.w3.clearkey', [{ initDataTypes: ['cenc', 'keyids'], videoCapabilities: [{ contentType: v }] }], false);
  }

  // zapisujemy, o jaki DRM pyta sama strona i co odpowiada telewizor
  function watchDrm() {
    var orig = navigator.requestMediaKeySystemAccess;
    if (orig && !orig.__tvnav) {
      diag.orig = orig;
      var wrapped = function (ks, cfgs) {
        var rec = { ks: String(ks).replace('com.', '').replace('.alpha', ''), res: '…' };
        diag.calls.push(rec);
        if (diag.calls.length > 5) diag.calls.shift();
        renderDiag();
        var p = orig.apply(navigator, arguments);
        // gdy telewizor odmówi tylko z powodu „trwałego stanu”, pytamy jeszcze raz bez tego wymogu
        if (p && p.then && /widevine|playready/i.test(String(ks)) && cfgs && cfgs.length) {
          p = p.then(null, function (err) {
            var relaxed = [], changed = false;
            for (var i = 0; i < cfgs.length; i++) {
              var o = {}, c = cfgs[i];
              for (var k in c) o[k] = c[k];
              if (o.persistentState === 'required') { o.persistentState = 'optional'; changed = true; }
              if (o.distinctiveIdentifier === 'required') { o.distinctiveIdentifier = 'optional'; changed = true; }
              relaxed.push(o);
            }
            if (!changed) throw err;
            rec.retried = true;
            return orig.call(navigator, ks, relaxed);
          });
        }
        if (p && p.then) p.then(function () { rec.res = rec.retried ? 'TAK (po ponowieniu)' : 'TAK'; renderDiag(); }, function (e) { rec.res = 'NIE: ' + dShort(dErr(e), 60); renderDiag(); });
        return p;
      };
      wrapped.__tvnav = true;
      try { navigator.requestMediaKeySystemAccess = wrapped; } catch (e) { /* nie da się podmienić */ }
    }
    document.addEventListener('encrypted', function (e) { diag.encrypted = e.initDataType || '?'; renderDiag(); }, true);
    document.addEventListener('error', function (e) {
      var t = e.target;
      if (t && t.tagName === 'VIDEO') dNote('Odtwarzacz: błąd ' + (t.error ? t.error.code + ' ' + (t.error.message || '') : ''));
    }, true);
    ['error', 'warn'].forEach(function (m) {
      var o = console[m];
      if (!o || o.__tvnav) return;
      var w = function () {
        try {
          var s = Array.prototype.map.call(arguments, function (x) {
            if (x && typeof x === 'object' && typeof x.code === 'number' && x.data && x.data.length !== undefined) return shakaErr(x);
            if (x && x.detail && typeof x.detail.code === 'number' && x.detail.data) return shakaErr(x.detail);
            if (x && x.message) return x.message;
            if (x && typeof x === 'object') { try { return JSON.stringify(x).slice(0, 200); } catch (er) { return String(x); } }
            return String(x);
          }).join(' ');
          if (/drm|shaka|eme|key ?system|licen|widevine|decrypt|media|error code/i.test(s)) dNote(s);
        } catch (er) { /* ignorujemy */ }
        return o.apply(console, arguments);
      };
      w.__tvnav = true;
      console[m] = w;
    });
  }

  // ---------------------------------------------------------------- kanały (lista na stronie /tv)
  var CH_RE = /^(\d{1,4})\.\s+(.+)$/;

  function getChannels() {
    var out = [], seen = {};
    var divs = document.querySelectorAll('li div');
    for (var i = 0; i < divs.length; i++) {
      var d = divs[i];
      if (!hasClick(d)) continue;
      var lines = (d.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var m = lines.length ? CH_RE.exec(lines[0]) : null;
      if (!m) continue;
      var num = parseInt(m[1], 10);
      if (seen[num]) continue;
      seen[num] = true;
      var img = d.querySelector('img');
      out.push({ num: num, name: m[2], title: lines[1] || '', time: lines[2] || '', logo: img ? img.src : '', el: d });
    }
    return out;
  }
  function findCh(chs, num) {
    for (var i = 0; i < chs.length; i++) if (chs[i].num === num) return chs[i];
    return null;
  }
  // wybrany kanał ma na stronie inną klasę niż pozostałe — szukamy tej jedynej
  function selectedChannel(chs) {
    if (chs.length < 3) return null;
    var counts = {};
    chs.forEach(function (c) { counts[c.el.className] = (counts[c.el.className] || 0) + 1; });
    for (var i = 0; i < chs.length; i++) if (counts[chs[i].el.className] === 1) return chs[i];
    return null;
  }
  function currentChannel() {
    var chs = getChannels();
    return findCh(chs, state.current) || selectedChannel(chs);
  }

  function progress(time) {
    var m = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(time || '');
    if (!m) return -1;
    var now = new Date();
    var t = now.getHours() * 60 + now.getMinutes();
    var a = (+m[1]) * 60 + (+m[2]), b = (+m[3]) * 60 + (+m[4]);
    if (b <= a) b += 1440;
    if (t < a) t += 1440;
    return Math.max(0, Math.min(1, (t - a) / (b - a)));
  }

  function showOsd(ch, ms) {
    if (!ch) return;
    var o = ui.osd;
    o.querySelector('.tv-num').textContent = ch.num;
    var img = o.querySelector('.tv-logo img');
    if (ch.logo) { img.src = ch.logo; img.style.display = ''; } else { img.style.display = 'none'; }
    o.querySelector('.tv-name').textContent = ch.name;
    o.querySelector('.tv-prog').textContent = ch.title || '';
    o.querySelector('.tv-time').textContent = ch.time || '';
    var p = progress(ch.time);
    o.querySelector('.tv-bar').style.display = p < 0 ? 'none' : '';
    o.querySelector('.tv-bar i').style.width = Math.round(Math.max(p, 0) * 100) + '%';
    o.style.display = 'flex';
    clearTimeout(state.osdTimer);
    state.osdTimer = setTimeout(function () { o.style.display = 'none'; }, ms || 4500);
  }
  function hideOsd() { clearTimeout(state.osdTimer); ui.osd.style.display = 'none'; }

  function ensurePlaying() {
    state.userPaused = false;
    clearTimeout(state.playTimer);
    state.playTimer = setTimeout(function () {
      var v = document.querySelector('video');
      if (!v || !v.paused || state.userPaused) return;
      var p = v.play();
      if (p && p.catch) p.catch(function () {
        var b = document.querySelector('button[aria-label="Odtwórz"]');
        if (b) b.click();
      });
    }, 3500);
  }

  // odtwarzacz = element, w którym siedzi <video> (gdy kanał gra, Shaka dodaje mu własną klasę)
  function playerBox() {
    var v = document.querySelector('video');
    if (!v) return null;
    return v.closest('.shaka-video-container') || v.parentElement;
  }

  // komunikaty serwisu są zasłonięte przez obraz na pełnym ekranie, więc pokazujemy je sami
  function checkUnavailable(num) {
    setTimeout(function () {
      if (state.current !== num || !state.full) return;
      var t = document.body.innerText || '';
      if (/Aktywuj odpowiedni pakiet|dostępny dla posiadaczy/i.test(t)) toast('Tego kanału nie ma w Twoim pakiecie', 4000);
      else if (/kanał jest niedostępny/i.test(t)) toast('Ten kanał jest teraz niedostępny', 3500);
    }, 3000);
  }

  function tune(num) {
    var chs = getChannels();
    var ch = findCh(chs, num);
    if (!ch) { toast('Nie ma kanału o numerze ' + num); return false; }
    var sel = selectedChannel(chs);
    if (state.current !== null && state.current !== num) state.previous = state.current;
    state.current = num;
    save('tvnav:last', num);
    if (!sel || sel.num !== num) ch.el.click();
    if (!state.full) setFull(true);
    showOsd(ch);
    ensurePlaying();
    checkUnavailable(num);
    return true;
  }

  // szybkie przełączanie: pasek pokazuje się od razu, a kanał zmienia się po krótkiej przerwie
  function step(dir) {
    var chs = getChannels();
    if (!chs.length) return;
    var base = state.zapTarget !== null ? state.zapTarget : state.current;
    var idx = -1;
    for (var i = 0; i < chs.length; i++) if (chs[i].num === base) { idx = i; break; }
    if (idx < 0) { var s = selectedChannel(chs); idx = s ? chs.indexOf(s) : 0; }
    var next = chs[(idx + dir + chs.length) % chs.length];
    state.zapTarget = next.num;
    showOsd(next);
    clearTimeout(state.zapTimer);
    state.zapTimer = setTimeout(function () {
      var n = state.zapTarget;
      state.zapTarget = null;
      if (n !== null) tune(n);
    }, 450);
  }

  // ---------------------------------------------------------------- tryb telewizora
  function markRaise(on) {
    var old = document.querySelectorAll('.tvnav-raise,.tvnav-player');
    for (var i = 0; i < old.length; i++) old[i].classList.remove('tvnav-raise', 'tvnav-player');
    if (!on) return;
    var c = playerBox();
    if (!c) return;
    c.classList.add('tvnav-player');
    var p = c.parentElement;
    while (p && p !== document.body && p !== document.documentElement) { p.classList.add('tvnav-raise'); p = p.parentElement; }
  }

  function setFull(on) {
    on = !!on && isTvPage() && !!playerBox();
    var was = state.full;
    state.full = on;
    document.documentElement.classList.toggle('tvnav-full', on);
    markRaise(on);
    if (!on) { closeOverlay(); hideOsd(); }
    if (on && !was) {
      var shown = load('tvnav:help', 0);
      if (shown < 3) {
        save('tvnav:help', shown + 1);
        setTimeout(function () {
          toast('OK – lista kanałów   •   CH+/CH− lub ▲▼ – zmiana kanału   •   Wstecz – menu', 6000);
        }, 1200);
      }
    }
  }

  function infoOsd() {
    var ch = currentChannel();
    if (ch) showOsd(ch, 6000);
  }

  function playPause(c) {
    var v = document.querySelector('video');
    if (!v) return;
    if (c === K.STOP || c === K.PAUSE || (c === K.PLAY_PAUSE && !v.paused)) {
      v.pause();
      state.userPaused = true;
      toast('Pauza');
    } else {
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      state.userPaused = false;
      toast('Odtwarzanie');
    }
  }

  // ---------------------------------------------------------------- lista kanałów (OK w trybie telewizora)
  function openOverlay() {
    var chs = getChannels();
    if (!chs.length) { toast('Lista kanałów jeszcze się wczytuje…'); return; }
    closeOverlay();
    hideOsd();
    var box = document.createElement('div');
    box.id = 'tvnav-list';
    var h = '<div class="tv-hdr">Kanały</div>' +
      '<div class="tv-hint">▲▼ wybór  •  OK oglądaj  •  CH+/CH− szybkie przewijanie  •  Wstecz zamknij</div>' +
      '<div class="tv-rows">';
    for (var i = 0; i < chs.length; i++) {
      var c = chs[i];
      h += '<div class="tv-row' + (c.num === state.current ? ' cur' : '') + '">' +
        '<div class="tv-rn">' + c.num + '</div>' +
        '<div class="tv-rl">' + (c.logo ? '<img alt="" src="' + esc(c.logo) + '">' : '') + '</div>' +
        '<div class="tv-rt"><div class="tv-rname">' + esc(c.name) + '</div>' +
        '<div class="tv-rprog">' + esc(c.title + (c.time ? '   ' + c.time : '')) + '</div></div></div>';
    }
    box.innerHTML = h + '</div>';
    document.body.appendChild(box);
    var idx = 0;
    for (var j = 0; j < chs.length; j++) if (chs[j].num === state.current) { idx = j; break; }
    state.overlay = { el: box, rows: box.querySelectorAll('.tv-row'), wrap: box.querySelector('.tv-rows'), chs: chs, i: -1 };
    overlaySel(idx);
  }
  function overlaySel(i) {
    var o = state.overlay;
    if (!o) return;
    var n = o.rows.length;
    i = ((i % n) + n) % n;
    if (o.i >= 0 && o.rows[o.i]) o.rows[o.i].classList.remove('on');
    o.i = i;
    var row = o.rows[i];
    row.classList.add('on');
    o.wrap.scrollTop = row.offsetTop - o.wrap.clientHeight / 2 + row.offsetHeight / 2;
  }
  function closeOverlay() {
    if (state.overlay) {
      if (state.overlay.el.parentNode) state.overlay.el.parentNode.removeChild(state.overlay.el);
      state.overlay = null;
    }
  }

  // ---------------------------------------------------------------- wybór kanału cyframi
  function digit(d) {
    state.digits = (state.digits + d).slice(0, 3);
    ui.digits.textContent = state.digits;
    ui.digits.style.display = 'block';
    clearTimeout(state.digitTimer);
    if (state.digits.length >= 3) commitDigits();
    else state.digitTimer = setTimeout(commitDigits, 1600);
  }
  function commitDigits() {
    clearTimeout(state.digitTimer);
    var n = parseInt(state.digits, 10);
    state.digits = '';
    ui.digits.style.display = 'none';
    if (!n) return;
    if (isTvPage()) tune(n); else goTv(n);
  }

  // ---------------------------------------------------------------- przejścia między stronami
  function navLink(href) { return document.querySelector('a[href="' + href + '"]'); }

  function goTv(num) {
    state.pendingTune = num || null;
    if (isTvPage()) { onEnterTv(state.pendingTune); state.pendingTune = null; return; }
    if (state.full) setFull(false);
    var a = navLink('/tv');
    if (a) a.click(); else location.assign('/tv');
  }

  function goPage(href, label) {
    if (state.full) setFull(false);
    if (path() === href) return;
    var a = navLink(href);
    if (a) { a.click(); toast(label); }
  }

  function whenChannels(cb, tries) {
    tries = tries || 0;
    var chs = getChannels();
    if ((chs.length && playerBox()) || tries > 40) { cb(chs); return; }
    setTimeout(function () { whenChannels(cb, tries + 1); }, 500);
  }

  function onEnterTv(pendingNum) {
    var first = !state.tvEntered;
    state.tvEntered = true;
    whenChannels(function (chs) {
      if (!chs.length || !isTvPage()) return;
      var sel = selectedChannel(chs);
      var want = pendingNum || (first ? load('tvnav:last', null) : null);
      if (want && findCh(chs, want) && (!sel || sel.num !== want)) { tune(want); return; }
      var ch = sel || chs[0];
      if (state.current !== null && state.current !== ch.num) state.previous = state.current;
      state.current = ch.num;
      save('tvnav:last', ch.num);
      setFull(true);
      showOsd(ch);
      ensurePlaying();
      checkUnavailable(ch.num);
    });
  }

  // ---------------------------------------------------------------- nawigacja strzałkami po stronie
  var FOCUS_SEL = 'a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="link"],[tabindex]';

  function candidate(el) {
    if (el.disabled) return false;
    if (el.tagName === 'INPUT' && (el.type === 'hidden' || el.type === 'range')) return false; // głośność jest na pilocie
    if (el.matches(FOCUS_SEL)) {
      if (el.getAttribute('tabindex') === '-1' && el.tagName !== 'INPUT' && !hasClick(el)) return false;
      return true;
    }
    return hasClick(el);
  }

  // strzałki „‹ ›” przy karuzelach — pilot przewija karuzelę sam, więc je pomijamy
  function isCarouselArrow(el) {
    if (el.closest('.swiper')) return false;
    if (!el.querySelector('svg') || (el.innerText || '').trim()) return false;
    var p = el.parentElement, d = 0;
    while (p && d < 3) { if (p.querySelector('.swiper')) return true; p = p.parentElement; d++; }
    return false;
  }

  // na stronie telewizji sam obraz też da się zaznaczyć (OK = pełny ekran)
  function videoBox() {
    if (!isTvPage()) return null;
    var v = playerBox();
    if (!v) return null;
    var r = v.getBoundingClientRect();
    return r.width > 50 && r.height > 50 ? v : null;
  }

  function area(el) { var r = el.getBoundingClientRect(); return r.width * r.height; }

  function collect() {
    if (!cache.dirty) return cache.list;
    // na liście kanałów zaznaczamy cały wiersz kanału, bez małych ikonek w jego środku
    var chItems = new Set(), chLis = new Set();
    if (isTvPage()) {
      getChannels().forEach(function (c) {
        chItems.add(c.el);
        var li = c.el.closest('li');
        if (li) chLis.add(li);
      });
    }
    var all = document.body.getElementsByTagName('*');
    var raw = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue; // pomijamy ikony SVG
      if (el.id && el.id.indexOf('tvnav-') === 0) continue;
      if (chLis.size && !chItems.has(el)) {
        var li = el.closest('li');
        if (li && chLis.has(li)) continue;
      }
      if (candidate(el) && !isCarouselArrow(el)) raw.push(el);
    }
    var set = new Set(raw), areas = new Map();
    raw.forEach(function (el) { areas.set(el, area(el)); });
    var vp = window.innerWidth * window.innerHeight;
    var keep = [];
    raw.forEach(function (el) {
      var a = areas.get(el);
      if (a < 36) return;
      if (a > vp * 0.55 && el.tagName !== 'INPUT') return; // całe sekcje strony to nie przyciski
      // element w środku innego klikalnego elementu tej samej wielkości — wystarczy jeden
      var p = el.parentElement, d = 0;
      while (p && p !== document.body && d < 6) {
        if (set.has(p)) { if (areas.get(p) <= a * 1.6) return; break; }
        p = p.parentElement; d++;
      }
      keep.push(el);
    });
    // duże klikalne „kontenery” (całe sekcje), w których są mniejsze przyciski — pomijamy;
    // małe kafelki z ikonkami w środku zostają
    var containers = new Set();
    keep.forEach(function (el) {
      var a = areas.get(el), p = el.parentElement, d = 0;
      while (p && p !== document.body && d < 14) {
        if (set.has(p) && areas.get(p) > a * 1.6 && areas.get(p) > vp * 0.2) containers.add(p);
        p = p.parentElement; d++;
      }
    });
    cache.list = keep.filter(function (el) { return !containers.has(el); });
    var vb = videoBox();
    if (vb && cache.list.indexOf(vb) < 0) cache.list.unshift(vb);
    cache.dirty = false;
    return cache.list;
  }

  function topModal() {
    var ms = document.querySelectorAll('.MuiModal-root,.MuiDialog-root,.MuiPopover-root,.MuiMenu-root,.MuiDrawer-modal,[role="dialog"]');
    for (var i = ms.length - 1; i >= 0; i--) {
      var m = ms[i];
      if (m.classList.contains('MuiModal-hidden')) continue;
      var r = m.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(m).visibility !== 'hidden') return m;
    }
    return null;
  }

  function gap(a1, a2, b1, b2) { if (b2 < a1) return a1 - b2; if (b1 > a2) return b1 - a2; return 0; }

  function score(a, b, dir) {
    var acx = a.left + a.width / 2, acy = a.top + a.height / 2;
    var bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
    var main, g, cross;
    if (dir === 'down') {
      if (bcy <= acy + 2 || b.bottom <= a.bottom - 2) return Infinity;
      main = Math.max(0, b.top - a.bottom); g = gap(a.left, a.right, b.left, b.right); cross = Math.abs(bcx - acx);
    } else if (dir === 'up') {
      if (bcy >= acy - 2 || b.top >= a.top + 2) return Infinity;
      main = Math.max(0, a.top - b.bottom); g = gap(a.left, a.right, b.left, b.right); cross = Math.abs(bcx - acx);
    } else if (dir === 'right') {
      if (bcx <= acx + 2 || b.right <= a.right - 2) return Infinity;
      main = Math.max(0, b.left - a.right); g = gap(a.top, a.bottom, b.top, b.bottom); cross = Math.abs(bcy - acy);
    } else {
      if (bcx >= acx - 2 || b.left >= a.left + 2) return Infinity;
      main = Math.max(0, a.left - b.right); g = gap(a.top, a.bottom, b.top, b.bottom); cross = Math.abs(bcy - acy);
    }
    return main + g * 3 + cross * 0.2 + (g > 0 ? 40 : 0);
  }

  function scoped(list) {
    var m = topModal();
    if (!m) return list;
    var inside = list.filter(function (el) { return m.contains(el); });
    return inside.length ? inside : list;
  }

  function firstVisible(list) {
    var best = null, bs = Infinity, any = null, h = window.innerHeight, w = window.innerWidth;
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue;
      if (!any) any = list[i];
      if (r.top < 90) continue; // górne menu zostawiamy na później
      var s = r.top * 3 + r.left;
      if (s < bs) { bs = s; best = list[i]; }
    }
    return best || any;
  }

  function inList(container, list) {
    for (var i = 0; i < list.length; i++) if (container === list[i] || container.contains(list[i])) return list[i];
    return null;
  }

  function move(dir) {
    var list = scoped(collect());
    var f = state.focus;
    var cur = f && f.isConnected ? f.getBoundingClientRect() : null;
    if (!cur || cur.width < 2) {
      var rec = recoverFocus(list);
      if (!rec) { var first = firstVisible(list); if (first) focusEl(first); return; }
      focusEl(rec, true); // wracamy w to samo miejsce i dopiero stąd wykonujemy ruch
      f = rec;
      cur = rec.getBoundingClientRect();
    }

    // w karuzeli ◀ ▶ przechodzą po kolejnych kafelkach (także tych jeszcze niewidocznych)
    var slide = f.closest ? f.closest('.swiper-slide') : null;
    if (slide && (dir === 'left' || dir === 'right')) {
      var sib = slide;
      do { sib = dir === 'right' ? sib.nextElementSibling : sib.previousElementSibling; }
      while (sib && !(sib.classList.contains('swiper-slide') && inList(sib, list)));
      if (sib) focusEl(inList(sib, list));
      return; // na końcu karuzeli zostajemy w miejscu
    }

    // obraz na stronie telewizji: ▼ prowadzi do przycisków odtwarzacza, a z nich ▲ wraca do obrazu
    var vb = videoBox();
    if (vb && f === vb && dir === 'down') {
      var ctl = null, minLeft = Infinity;
      list.forEach(function (el) {
        if (el !== vb && vb.contains(el)) { var r = el.getBoundingClientRect(); if (r.width >= 6 && r.left < minLeft) { minLeft = r.left; ctl = el; } }
      });
      if (ctl) { focusEl(ctl); return; }
    }
    if (vb && f !== vb && vb.contains(f) && dir === 'up') { focusEl(vb); return; }

    var best = null, bs = Infinity, vw = window.innerWidth;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === f || !el.isConnected || el.contains(f) || f.contains(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      var s = score(cur, r, dir);
      if (s === Infinity) continue;
      if ((dir === 'up' || dir === 'down') && (r.right < 0 || r.left > vw)) s += 600;
      if (s < bs) { bs = s; best = el; }
    }
    if (best) focusEl(best);
  }

  function focusEl(el, noReveal) {
    state.focus = el;
    releaseNativeFocus(el);
    if (!noReveal) reveal(el);
    var r = el.getBoundingClientRect();
    state.focusMemo = { text: firstLine(el), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function focusLost() {
    var f = state.focus;
    return !f || !f.isConnected || f.getBoundingClientRect().width < 2;
  }

  // strona przebudowała listę (np. program TV) i zaznaczony element zniknął —
  // szukamy tego samego tytułu albo najbliższego elementu w tym samym miejscu ekranu
  function recoverFocus(list) {
    var m = state.focusMemo;
    if (!m) return null;
    var best = null, bd = Infinity;
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      var d = Math.abs(r.left + r.width / 2 - m.x) + Math.abs(r.top + r.height / 2 - m.y);
      if (d < 400 && m.text && firstLine(list[i]) === m.text) d -= 100000;
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best;
  }

  // przewija karuzelę (Swiper) tak, żeby zaznaczony kafelek był w całości widoczny.
  // Liczymy na pozycjach z układu karuzeli, a nie z ekranu, bo te w trakcie animacji się zmieniają.
  function showSlide(sw, slide) {
    var inst = sw && sw.swiper;
    if (!inst || typeof inst.slideTo !== 'function' || !inst.snapGrid || !inst.snapGrid.length) return;
    var idx = Array.prototype.indexOf.call(inst.slides, slide);
    var grid = inst.snapGrid, cur = -inst.translate, size = inst.size, pick = -1, i, left, right;
    if (idx >= 0 && inst.slidesGrid && inst.slidesSizesGrid && size) {
      left = inst.slidesGrid[idx];
      right = left + inst.slidesSizesGrid[idx];
    } else {
      var sr = sw.getBoundingClientRect(), r = slide.getBoundingClientRect();
      left = cur + (r.left - sr.left); right = cur + (r.right - sr.left); size = sr.width;
    }
    if (right > cur + size + 1) {
      var want = right - size;
      for (i = 0; i < grid.length; i++) if (grid[i] >= want - 1) { pick = i; break; }
      if (pick < 0) pick = grid.length - 1;
    } else if (left < cur - 1) {
      for (i = grid.length - 1; i >= 0; i--) if (grid[i] <= left + 1) { pick = i; break; }
      if (pick < 0) pick = 0;
    } else {
      return;
    }
    var spg = (inst.params && inst.params.slidesPerGroup) || 1; // karuzele przesuwają się grupami kafelków
    inst.slideTo(pick * spg, 250);
  }

  function reveal(el) {
    var slide = el.closest ? el.closest('.swiper-slide') : null;
    if (slide) showSlide(slide.closest('.swiper,.swiper-container'), slide);
    scrollAncestors(el);
  }

  function scrollAncestors(el) {
    var r = el.getBoundingClientRect();
    var p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      var canY = p.scrollHeight > p.clientHeight + 2, canX = p.scrollWidth > p.clientWidth + 2;
      if (canY || canX) {
        var cs = getComputedStyle(p), pr = p.getBoundingClientRect();
        if (canY && /(auto|scroll)/.test(cs.overflowY) && (r.top < pr.top + 20 || r.bottom > pr.bottom - 20)) {
          p.scrollTop += (r.top + r.height / 2) - (pr.top + pr.height / 2);
          r = el.getBoundingClientRect();
        }
        if (canX && /(auto|scroll)/.test(cs.overflowX) && (r.left < pr.left + 20 || r.right > pr.right - 20)) {
          p.scrollLeft += (r.left + r.width / 2) - (pr.left + pr.width / 2);
          r = el.getBoundingClientRect();
        }
      }
      p = p.parentElement;
    }
    var vh = window.innerHeight;
    if (r.top < 80 || r.bottom > vh - 40) window.scrollBy(0, (r.top + r.height / 2) - vh / 2);
  }

  function fire(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  function activate(el) {
    if (!el || !el.isConnected) return;
    if (isEditable(el)) { el.focus(); return; }
    if (el.tagName === 'SELECT') { el.focus(); return; }
    if ((el.getAttribute('aria-label') === 'Pełny ekran' || el === videoBox()) && isTvPage()) { setFull(true); showOsd(currentChannel()); return; }
    var a = el.tagName === 'A' ? el : (el.closest ? el.closest('a[href]') : null);
    if (a) {
      var href = a.getAttribute('href') || '';
      var external = a.target === '_blank' || (/^(https?:)?\/\//i.test(href) && a.host !== location.host);
      if (external) { toast('Ten link prowadzi poza serwis – na telewizorze go pomijam'); return; }
    }
    // checkbox/radio przełączamy bezpośrednio (nie przez etykietę), żeby nie dostał systemowego zaznaczenia
    var box = (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) ? el : el.querySelector('input[type="checkbox"],input[type="radio"]');
    if (box && !box.disabled) {
      box.click();
      cache.dirty = true;
      releaseNativeFocus(null);
      return;
    }
    var p = reactProps(el);
    if (p && typeof p.onClick !== 'function' && typeof p.onMouseDown === 'function') { fire(el, 'mousedown'); fire(el, 'mouseup'); }
    el.click();
    cache.dirty = true;
    // kliknięcie checkboxa (przez jego etykietę) daje mu systemowe zaznaczenie — od razu je zdejmujemy;
    // pole tekstowe otwarte przez kliknięcie (np. wyszukiwarka) zostawiamy
    if (!isEditable(document.activeElement)) releaseNativeFocus(null);
  }

  function closeModal() {
    var m = topModal();
    if (!m) return false;
    var target = m.querySelector('[tabindex]') || m;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    setTimeout(function () {
      if (topModal() === m) { var bd = m.querySelector('.MuiBackdrop-root'); if (bd) bd.click(); }
    }, 150);
    return true;
  }

  function back() {
    if (closeModal()) return;
    if (isTvPage()) { setFull(true); showOsd(currentChannel()); return; }
    if (path().split('/').length > 2) history.back(); // np. szczegóły filmu → lista
    else goTv();
  }

  function focusCurrentInList() {
    cache.dirty = true;
    var ch = currentChannel();
    if (ch) focusEl(ch.el); else autoFocus();
  }

  function autoFocus() {
    if (state.full || state.overlay || !focusLost()) return;
    var list = scoped(collect());
    var f = recoverFocus(list) || firstVisible(list);
    if (f) focusEl(f, true);
  }

  // ramka podąża za zaznaczonym elementem (także gdy strona się przewija)
  var lastBox = '';
  function ringLoop() {
    var el = state.focus, s = ui.ring.style;
    var show = el && el.isConnected && !state.full && !state.overlay;
    var r = show ? el.getBoundingClientRect() : null;
    if (!r || r.width < 2) {
      if (s.display !== 'none') s.display = 'none';
    } else {
      var box = Math.round(r.left - 6) + ',' + Math.round(r.top - 6) + ',' + Math.round(r.width + 12) + ',' + Math.round(r.height + 12);
      if (box !== lastBox || s.display !== 'block') {
        var v = box.split(',');
        s.left = v[0] + 'px'; s.top = v[1] + 'px'; s.width = v[2] + 'px'; s.height = v[3] + 'px';
        s.display = 'block';
        lastBox = box;
      }
    }
    window.requestAnimationFrame(ringLoop);
  }

  // ---------------------------------------------------------------- obsługa pilota
  function colorKey(c) {
    if (c === K.RED) goPage('/', 'Strona główna');
    else if (c === K.GREEN) goPage('/epg', 'Program TV');
    else if (c === K.YELLOW) goPage('/vod', 'Wideo na życzenie');
    else if (c === K.BLUE) goTv();
  }

  function overlayKey(e, c, d) {
    var o = state.overlay;
    if (d !== null) { closeOverlay(); digit(d); stop(e); return; }
    switch (c) {
      case K.UP: overlaySel(o.i - 1); break;
      case K.DOWN: overlaySel(o.i + 1); break;
      case K.CH_UP: case K.PAGE_UP: overlaySel(o.i - 8); break;
      case K.CH_DOWN: case K.PAGE_DOWN: overlaySel(o.i + 8); break;
      case K.ENTER: var ch = o.chs[o.i]; closeOverlay(); tune(ch.num); break;
      case K.BACK: case K.ESC: case K.LEFT: closeOverlay(); break;
      case K.RIGHT: break;
      default: return;
    }
    stop(e);
  }

  function fullKey(e, c) {
    switch (c) {
      case K.CH_UP: case K.PAGE_UP: case K.UP: step(1); break;
      case K.CH_DOWN: case K.PAGE_DOWN: case K.DOWN: step(-1); break;
      case K.ENTER: case K.LEFT: openOverlay(); break;
      case K.RIGHT: case K.INFO: infoOsd(); break;
      case K.PREV_CH: if (state.previous !== null) tune(state.previous); break;
      case K.BACK: case K.ESC:
        setFull(false);
        focusCurrentInList();
        toast('Menu  •  Wstecz – powrót do telewizji');
        break;
      case K.PLAY_PAUSE: case K.PLAY: case K.PAUSE: case K.STOP: playPause(c); break;
      case K.RED: case K.GREEN: case K.YELLOW: case K.BLUE: colorKey(c); break;
      default: return; // np. głośność zostawiamy telewizorowi
    }
    stop(e);
  }

  function pageKey(e, c) {
    switch (c) {
      case K.UP: move('up'); break;
      case K.DOWN: move('down'); break;
      case K.LEFT: move('left'); break;
      case K.RIGHT: move('right'); break;
      case K.ENTER:
        var f = state.focus;
        if (f && f.isConnected) {
          var m = isTvPage() ? CH_RE.exec(firstLine(f)) : null;
          if (m) tune(parseInt(m[1], 10)); else activate(f);
        } else {
          autoFocus();
        }
        break;
      case K.BACK: case K.ESC: back(); break;
      case K.CH_UP: case K.PAGE_UP: if (isTvPage()) step(1); else goTv(); break;
      case K.CH_DOWN: case K.PAGE_DOWN: if (isTvPage()) step(-1); else goTv(); break;
      case K.PLAY_PAUSE: case K.PLAY: case K.PAUSE: case K.STOP: playPause(c); break;
      case K.RED: case K.GREEN: case K.YELLOW: case K.BLUE: colorKey(c); break;
      default: return;
    }
    stop(e);
  }

  function onKey(e) {
    if (!e.isTrusted) return; // zdarzenia wysyłane przez sam skrypt przepuszczamy
    var c = e.keyCode, d = digitOf(e);
    var active = document.activeElement;

    if (isEditable(active)) {
      if (c === K.BACK || c === K.ESC) { active.blur(); stop(e); return; }
      if (c === K.UP || c === K.DOWN) { active.blur(); stop(e); move(c === K.UP ? 'up' : 'down'); return; }
      return; // pozostałe klawisze trafiają do pola tekstowego
    }
    if (state.digits && c === K.ENTER) { commitDigits(); stop(e); return; }
    if (state.overlay) { overlayKey(e, c, d); return; }
    if (d !== null) { digit(d); stop(e); return; }
    if (state.full) { fullKey(e, c); return; }
    pageKey(e, c);
  }

  // ---------------------------------------------------------------- start
  var lastPath = null;
  function tick() {
    var p = path();
    if (p !== lastPath) {
      var first = lastPath === null;
      lastPath = p;
      cache.dirty = true;
      state.focus = null;
      state.focusMemo = null;
      closeOverlay();
      if (p === '/tv') {
        onEnterTv(state.pendingTune);
      } else {
        if (state.full) setFull(false);
        if (first && hasSession()) goTv(); // aplikacja zawsze startuje na telewizji
        else setTimeout(autoFocus, 700);
      }
      state.pendingTune = null;
    }
    var s = hasSession();
    if (s && !state.session) setTimeout(function () { goTv(); }, 1500); // zaraz po zalogowaniu
    state.session = s;
    if (state.full) {
      var pb = playerBox(); // React potrafi podmienić odtwarzacz przy zmianie kanału
      if (pb && !pb.classList.contains('tvnav-player')) markRaise(true);
    }
    if (!state.full && !state.overlay && !isEditable(document.activeElement) && focusLost()) {
      if (!state.autoTimer) state.autoTimer = setTimeout(function () { state.autoTimer = null; autoFocus(); }, 900);
    }
    if (ui.diag) {
      var showDiag = isTvPage() ? 'block' : 'none';
      if (ui.diag.style.display !== showDiag) ui.diag.style.display = showDiag;
    }
  }

  function init() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init); return; }
    buildUi();
    watchDrm();
    renderDiag();
    setTimeout(runProbes, 1500);
    new MutationObserver(function () { cache.dirty = true; }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keypress', onKeyRest, true);
    window.addEventListener('keyup', onKeyRest, true);
    window.requestAnimationFrame(ringLoop);
    state.session = hasSession();
    tick();
    setInterval(tick, 400);
    window.__tvNav.state = state;
  }

  init();
})();
