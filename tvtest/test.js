/* TV Test: sprawdza odtwarzanie filmów z zabezpieczeniem Widevine (cenc i cbcs)
 * w zwykłej aplikacji telewizora (nie w trybie debugowania).
 * Etap 1: odtwarzacz strony (MSE/EME, Shaka). Etap 2 (po restarcie TV): odtwarzacz telewizora (AVPlay). */
(function () {
  'use strict';
  var VER = 1;
  var KEY = 'tvtest:state';
  var SHAKA = 'https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.11.21/shaka-player.compiled.js';
  var CLEAR = 'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd';
  var CENC = 'https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd';
  var CENC_LIC = 'https://proxy.uat.widevine.com/proxy';
  var CBCS = 'https://livesim2.dashif.org/livesim2/drm_EZDRM-1-key-cbcs/testpic_2s/Manifest.mpd';
  var CBCS_LIC = 'https://widevine-dash.ezdrm.com/proxy?pX=3B0669';

  var MSE_TESTS = [
    { id: 'm1', name: 'Strona: film bez zabezpieczeń', uri: CLEAR, lic: null },
    { id: 'm2', name: 'Strona: Widevine cenc', uri: CENC, lic: CENC_LIC },
    { id: 'm3', name: 'Strona: Widevine cbcs, obraz + dźwięk (jak kanały)', uri: CBCS, lic: CBCS_LIC, key: true }
  ];
  var AV_TESTS = [
    { id: 'a1', name: 'Odtwarzacz TV: Widevine cenc', uri: CENC, lic: CENC_LIC },
    { id: 'a2', name: 'Odtwarzacz TV: Widevine cbcs (jak kanały)', uri: CBCS, lic: CBCS_LIC, key: true }
  ];

  var info = document.getElementById('info');
  var st = load();
  var env = [];
  var live = '';
  var busy = false;

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.ver === VER) return s;
    } catch (e) { /* od nowa */ }
    return { ver: VER, phase: 'mse', res: {}, runs: 0 };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* trudno */ } }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function errText(e) {
    if (!e) return 'nieznany błąd';
    if (typeof e.code === 'number' && e.category !== undefined) {
      var d = e.data && e.data.length ? ' (' + e.data.slice(0, 2).map(function (x) {
        if (x && typeof x === 'object') return x.code !== undefined ? 'kod ' + x.code : (x.message || '');
        return String(x).slice(0, 60);
      }).join(', ') + ')' : '';
      return 'Shaka ' + e.code + d;
    }
    return String(e.message || e.name || e).slice(0, 120);
  }

  function render() {
    var h = '<b class="y">TEST ODTWARZANIA — aplikacja TV Test v' + VER + '</b> (zwykłe uruchomienie, bez trybu debugowania)<br>';
    h += env.map(esc).join('<br>') + '<br><br>';
    var all = MSE_TESTS.concat(AV_TESTS);
    all.forEach(function (t, i) {
      var r = st.res[t.id];
      var txt = r ? (r.ok ? '<b class="g">DZIAŁA</b> ' + esc(r.note) : '<b class="r">NIE</b> ' + esc(r.note)) : '–';
      h += (i + 1) + ') ' + esc(t.name) + ': ' + txt + '<br>';
    });
    if (live) h += '<br><b class="y">Teraz:</b> ' + esc(live) + '<br>';
    h += '<br>' + verdict();
    info.innerHTML = h;
  }

  function verdict() {
    var r = st.res;
    if (st.phase === 'mse') return '<b class="y">Trwa etap 1 — nic nie naciskaj, aż pojawi się wynik.</b>';
    if (st.phase === 'restart') {
      return '<b class="y">Etap 1 skończony. Teraz WYŁĄCZ telewizor przytrzymując przycisk zasilania na pilocie (aż pojawi się logo Samsunga), ' +
        'potem otwórz TV Test jeszcze raz — sprawdzę drugi sposób odtwarzania.</b>';
    }
    if (st.phase === 'avplay') return '<b class="y">Trwa etap 2 — nic nie naciskaj, aż pojawi się wynik.</b>';
    var msg = '';
    if (r.m3 && r.m3.ok) msg = '<b class="g">WYNIK: w zwykłej aplikacji kanały z szyfrowaniem cbcs DZIAŁAJĄ (z dźwiękiem).</b> Winny jest sposób uruchamiania w TizenBrew.';
    else if (r.a2 && r.a2.ok) msg = '<b class="g">WYNIK: odtwarzacz telewizora (AVPlay) radzi sobie z cbcs.</b> Odtwarzacz strony — nie.';
    else msg = '<b class="r">WYNIK: cbcs nie działa ani w odtwarzaczu strony, ani w odtwarzaczu TV.</b>';
    return msg + '<br>Zrób zdjęcie tego ekranu. Wstecz = wyjście, OK = powtórz od początku.';
  }

  // ------------------------------------------------------------------ środowisko
  function probeEnv() {
    env.push('Opis przeglądarki: ' + navigator.userAgent);
    var model = '';
    try { model = webapis.productinfo.getRealModel() + ', oprogramowanie ' + webapis.productinfo.getFirmware(); } catch (e) { model = 'brak danych'; }
    env.push('Telewizor: ' + model);
    env.push('API: tizen ' + (typeof tizen) + ', webapis ' + (typeof webapis) + ', AVPlay ' +
      (typeof webapis !== 'undefined' && webapis.avplay ? 'tak' : 'nie'));
    if (!navigator.requestMediaKeySystemAccess) { env.push('Widevine: brak EME'); return Promise.resolve(); }
    function cfg(scheme) {
      var v = { contentType: 'video/mp4; codecs="avc1.4d401f"' }, a = { contentType: 'audio/mp4; codecs="mp4a.40.2"' };
      if (scheme) { v.encryptionScheme = scheme; a.encryptionScheme = scheme; }
      return [{ initDataTypes: ['cenc'], videoCapabilities: [v], audioCapabilities: [a] }];
    }
    function probe(scheme) {
      return navigator.requestMediaKeySystemAccess('com.widevine.alpha', cfg(scheme)).then(function (acc) {
        var c = acc.getConfiguration(), vs = c.videoCapabilities && c.videoCapabilities[0];
        return 'TAK' + (scheme ? ' (' + (vs && vs.encryptionScheme !== undefined ? vs.encryptionScheme : 'bez potwierdzenia') + ')' : '');
      }, function () { return 'NIE'; });
    }
    return Promise.all([probe(null), probe('cenc'), probe('cbcs')]).then(function (r) {
      env.push('Widevine: ' + r[0] + ', cenc: ' + r[1] + ', cbcs: ' + r[2]);
    });
  }

  // ------------------------------------------------------------------ etap 1: Shaka (MSE/EME)
  function loadShaka() {
    return new Promise(function (resolve, reject) {
      if (window.shaka) return resolve();
      var s = document.createElement('script');
      s.src = SHAKA;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('nie wczytał się odtwarzacz Shaka')); };
      setTimeout(function () { if (!window.shaka) reject(new Error('odtwarzacz Shaka nie wczytał się w 25 s (brak internetu?)')); }, 25000);
      document.head.appendChild(s);
    });
  }
  function frames(v) {
    try { var q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); if (q) return q.totalVideoFrames; } catch (e) { /* brak */ }
    return v.webkitDecodedFrameCount !== undefined ? v.webkitDecodedFrameCount : 0;
  }
  function runMse(t) {
    return new Promise(function (done) {
      var v = document.createElement('video');
      v.autoplay = true;
      document.body.insertBefore(v, info);
      var player = new shaka.Player();
      var err = '', prog = 0, lastT = null, t0 = Date.now(), finished = false;
      player.addEventListener('error', function (ev) { if (!err) err = errText(ev.detail); });
      v.addEventListener('error', function () { if (!err && v.error) err = 'błąd odtwarzacza ' + v.error.code + (v.error.code === 3 ? ' (dekoder)' : ''); });
      player.attach(v).then(function () {
        player.configure({ abr: { enabled: false }, drm: { servers: t.lic ? { 'com.widevine.alpha': t.lic } : {} } });
        return player.load(t.uri);
      }).then(function () {
        try {
          var tr = player.getVariantTracks().slice().sort(function (a, b) { return a.bandwidth - b.bandwidth; });
          if (tr.length) player.selectVariantTrack(tr[0], true);
        } catch (e) { /* zostaje domyślna */ }
        try { var p = v.play(); if (p && p['catch']) p['catch'](function () { /* trudno */ }); } catch (e) { /* trudno */ }
      }, function (e) { if (!err) err = errText(e); });
      var iv = setInterval(function () {
        if (finished) return;
        var ct = v.currentTime || 0;
        if (lastT !== null && !v.paused) { var d = ct - lastT; if (d > 0 && d < 3) prog += d; }
        lastT = ct;
        var fr = frames(v), secs = Math.round((Date.now() - t0) / 1000);
        var buf = '';
        try { if (v.buffered.length) buf = (v.buffered.end(v.buffered.length - 1) - ct).toFixed(1) + ' s'; } catch (e) { /* brak */ }
        live = t.name + ': ' + secs + ' s, gra +' + prog.toFixed(1) + ' s, klatki ' + fr + ', obraz ' + v.videoWidth + '×' + v.videoHeight +
          (buf ? ', bufor ' + buf : '') + (err ? ', ' + err : '');
        render();
        var ok = prog > 6 && fr > 60 && !err;
        if (ok || (err && Date.now() - t0 > 4000) || Date.now() - t0 > 35000) {
          finished = true;
          clearInterval(iv);
          var note = '(+' + prog.toFixed(1) + ' s, klatki ' + fr + ', ' + v.videoWidth + '×' + v.videoHeight + (err ? ', ' + err : '') + ')';
          var fin = function () {
            try { v.removeAttribute('src'); v.load(); } catch (e) { /* trudno */ }
            if (v.parentNode) v.parentNode.removeChild(v);
            live = '';
            setTimeout(function () { done({ ok: ok, note: note }); }, 1200);
          };
          try { player.destroy().then(fin, fin); } catch (e) { fin(); }
        }
      }, 500);
    });
  }
  function phaseMse() {
    return loadShaka().then(function () {
      shaka.polyfill.installAll();
      var i = 0;
      function next() {
        if (i >= MSE_TESTS.length) return Promise.resolve(true);
        var t = MSE_TESTS[i++];
        return runMse(t).then(function (r) {
          st.res[t.id] = r; save(); render();
          return r.ok ? next() : false;
        });
      }
      return next();
    }).then(function (allOk) {
      st.phase = allOk ? 'done' : 'restart';
      save(); render();
    }, function (e) {
      env.push('Błąd etapu 1: ' + errText(e));
      st.phase = 'restart'; save(); render();
    });
  }

  // ------------------------------------------------------------------ etap 2: AVPlay (odtwarzacz telewizora)
  function runAv(t) {
    return new Promise(function (done) {
      var av = webapis.avplay, first = null, last = 0, err = '', t0 = Date.now(), finished = false, state = 'otwieram';
      function fin(ok) {
        if (finished) return;
        finished = true;
        clearInterval(iv);
        try { av.stop(); } catch (e) { /* trudno */ }
        try { av.close(); } catch (e) { /* trudno */ }
        var adv = first === null ? 0 : (last - first) / 1000;
        live = '';
        setTimeout(function () { done({ ok: ok, note: '(+' + adv.toFixed(1) + ' s' + (err ? ', ' + err : '') + ')' }); }, 1500);
      }
      try {
        av.open(t.uri);
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setListener({
          oncurrentplaytime: function (ms) { if (first === null) first = ms; last = ms; },
          onerror: function (e) { if (!err) err = 'błąd ' + e; },
          ondrmevent: function (type, data) { state = 'licencja: ' + type; },
          onbufferingstart: function () { state = 'buforuje'; },
          onbufferingcomplete: function () { state = 'gra'; }
        });
        if (t.lic) av.setDrm('WIDEVINE_CDM', 'SetProperties', JSON.stringify({ LicenseServer: t.lic, DeleteLicenseAfterUse: true }));
        state = 'przygotowuję';
        av.prepareAsync(function () { state = 'gra'; try { av.play(); } catch (e) { err = errText(e); } },
          function (e) { if (!err) err = 'przygotowanie: ' + errText(e); });
      } catch (e) { err = errText(e); }
      var iv = setInterval(function () {
        var adv = first === null ? 0 : (last - first) / 1000;
        live = t.name + ': ' + Math.round((Date.now() - t0) / 1000) + ' s, ' + state + ', gra +' + adv.toFixed(1) + ' s' + (err ? ', ' + err : '');
        render();
        if (adv > 6 && !err) fin(true);
        else if ((err && Date.now() - t0 > 3000) || Date.now() - t0 > 40000) fin(false);
      }, 500);
    });
  }
  function phaseAv() {
    if (typeof webapis === 'undefined' || !webapis.avplay) {
      env.push('Odtwarzacz TV niedostępny w tej aplikacji');
      st.phase = 'done'; save(); render(); return Promise.resolve();
    }
    var i = 0;
    function next() {
      if (i >= AV_TESTS.length) return Promise.resolve();
      var t = AV_TESTS[i++];
      return runAv(t).then(function (r) { st.res[t.id] = r; save(); render(); return r.ok ? next() : null; });
    }
    return next().then(function () { st.phase = 'done'; save(); render(); });
  }

  // ------------------------------------------------------------------ sterowanie
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 10009 || e.keyCode === 27) {
      try { tizen.application.getCurrentApplication().exit(); } catch (x) { window.close(); }
    } else if (e.keyCode === 13 && st.phase === 'done' && !busy) {
      st = { ver: VER, phase: 'mse', res: {}, runs: 0 }; save(); start();
    }
  });

  function start() {
    busy = true;
    render();
    var go;
    if (st.phase === 'restart') { st.phase = 'avplay'; save(); go = phaseAv; }
    else if (st.phase === 'avplay') go = phaseAv;
    else if (st.phase === 'mse') go = phaseMse;
    else go = function () { return Promise.resolve(); };
    return go().then(function () { busy = false; render(); }, function () { busy = false; render(); });
  }

  probeEnv().then(start, start);
})();
