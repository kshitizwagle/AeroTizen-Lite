// AeroTizen Lite: a minimal, fast launcher. One file, no framework, no build step.
// Speed rules: build tile DOM only when the list changes; on key presses touch only the
// focus ring and the track, both via transform. Never read layout in the key path.
(function () {
  'use strict';

  var COLS = 6, TILE = 260, GAP = 32, STEP = TILE + GAP, ROW_STEP = STEP + 36; // + caption room
  var VISIBLE_ROWS = 2;          // rows fully visible below the header
  var LONG_PRESS_MS = 600;
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27 };
  var STORE_PACKAGE = /^[A-Za-z0-9]{10}$/;
  var PRELOADED = /^(org\.tizen\.netflix-app|org\.tizen\.primevideo|com\.samsung\.tv\.aria-video|org\.tizen\.apple\.)/;
  var HIDDEN = /service|emanual|companion|dummy|widget|DclHome001|AeroLite01/i;
  var DEFAULT_HOME = ['youtube', 'netflix', 'prime video', 'jellyfin', 'spotify'];
  var STORE = { apps: 'lite.apps.v1', home: 'lite.home.v1', weather: 'lite.weather.v1', tab: 'lite.tab.v1' };
  var WEATHER_UNIT = 'F';       // 'C' or 'F'
  var WEATHER_EVERY_MS = 30 * 60 * 1000;

  var tz = window.tizen;
  var $ = function (id) { return document.getElementById(id); };
  var el = { grid: $('grid'), track: $('track'), ring: $('ring'), empty: $('empty'), tabs: document.querySelector('.tabs'),
    plate: $('tab-plate'), tabHome: $('tab-home'), tabApps: $('tab-apps'), menu: $('menu'), menuTitle: $('menu-title'),
    menuItems: $('menu-items'), toast: $('toast'), time: $('time'), date: $('date'), weather: $('weather'),
    temp: $('temp'), city: $('city') };
  var caption = document.createElement('div');
  caption.className = 'caption';
  el.ring.appendChild(caption);

  // ---- storage --------------------------------------------------------------------
  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* optional */ } }

  // ---- state ----------------------------------------------------------------------
  var all = load(STORE.apps, []);       // [{id, name, icon}]
  var home = load(STORE.home, null);    // [id] or null before first run
  var tab = load(STORE.tab, 'home');    // 'home' | 'apps'
  var zone = 'grid';                    // 'tabs' | 'grid' | 'menu'
  var focus = 0, scrollRow = 0, moving = -1, parkedForEmpty = false;
  var shown = [];                       // apps in the current grid
  var tiles = [];                       // tile elements, same order as shown
  var byId = {};

  function index() { byId = {}; all.forEach(function (a) { byId[a.id] = a; }); }
  index();

  // ---- app list -------------------------------------------------------------------
  function refreshApps() {
    if (!tz || !tz.application) { if (!all.length) { all = demoApps(); index(); render(); } return; }
    try {
      tz.application.getAppsInfo(function (list) {
        var next = list.filter(function (a) {
          return a.show !== false && a.name && (STORE_PACKAGE.test(a.packageId || '') || PRELOADED.test(a.id)) &&
            !HIDDEN.test(a.id) && !HIDDEN.test(a.name);
        }).map(function (a) { return { id: a.id, name: a.name, icon: a.iconPath || '' }; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
        if (JSON.stringify(next) === JSON.stringify(all)) { return; } // nothing changed: no DOM work
        all = next; index(); save(STORE.apps, all);
        if (home) { var kept = home.filter(function (id) { return byId[id]; }); if (kept.length !== home.length) { home = kept; save(STORE.home, home); } }
        render();
      }, function () { /* keep the cached list */ });
    } catch (e) { /* keep the cached list */ }
  }

  function demoApps() {
    return ['YouTube', 'Netflix', 'Prime Video', 'Spotify - Music and Podcasts', 'Jellyfin', 'Moonlight', 'Apple Music',
      'Browser', 'Plex', 'Disney+', 'Twitch', 'Tubi', 'Crunchyroll', 'Max'].map(function (n, i) {
      return { id: 'demo' + i, name: n, icon: '' };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function ensureHome() {
    if (home || !all.length) { return; }
    home = [];
    DEFAULT_HOME.forEach(function (want) {
      all.forEach(function (a) { if (home.indexOf(a.id) < 0 && a.name.toLowerCase().indexOf(want) === 0) { home.push(a.id); } });
    });
    save(STORE.home, home);
  }

  // ---- rendering (only when the list or tab changes) -------------------------------
  function pos(i) { return { x: (i % COLS) * STEP, y: Math.floor(i / COLS) * ROW_STEP }; }

  function makeTile(app) {
    var t = document.createElement('div');
    t.className = 'tile';
    if (app.icon) {
      var img = new Image();
      img.decoding = 'async';
      img.alt = '';
      img.onerror = function () { t.removeChild(img); t.appendChild(letter(app)); };
      img.src = app.icon;
      t.appendChild(img);
    } else {
      t.appendChild(letter(app));
    }
    return t;
  }
  function letter(app) {
    var s = document.createElement('span');
    s.className = 'letter';
    s.textContent = (app.name || '?').charAt(0).toUpperCase();
    return s;
  }

  function render() {
    ensureHome();
    shown = tab === 'home' ? (home || []).map(function (id) { return byId[id]; }).filter(Boolean) : all.slice();
    var frag = document.createDocumentFragment();
    tiles = shown.map(function (app, i) {
      var t = makeTile(app), p = pos(i);
      t.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)';
      frag.appendChild(t);
      return t;
    });
    el.grid.textContent = '';
    el.grid.appendChild(frag);
    el.empty.hidden = shown.length > 0;
    el.empty.textContent = tab === 'home' ? 'Home is empty. Open All apps and hold OK on an app to add it.' : 'No apps found.';
    el.tabHome.classList.toggle('active', tab === 'home');
    el.tabApps.classList.toggle('active', tab === 'apps');
    el.plate.style.transform = 'translate3d(' + (tab === 'home' ? 0 : 166) + 'px,0,0)';
    if (focus >= shown.length) { focus = Math.max(0, shown.length - 1); }
    // An empty grid parks focus on the tabs; it returns once apps arrive (e.g. first run).
    if (!shown.length && zone === 'grid') { zone = 'tabs'; parkedForEmpty = true; }
    else if (shown.length && parkedForEmpty && zone === 'tabs') { zone = 'grid'; parkedForEmpty = false; }
    paintFocus();
  }

  // ---- focus: transform-only updates ----------------------------------------------
  function paintFocus() {
    var inGrid = zone === 'grid' && shown.length > 0;
    el.ring.classList.toggle('on', inGrid);
    el.ring.classList.toggle('move', moving >= 0);
    el.tabs.classList.toggle('focused', zone === 'tabs');
    el.tabHome.classList.toggle('focused', zone === 'tabs' && tab === 'home');
    el.tabApps.classList.toggle('focused', zone === 'tabs' && tab === 'apps');
    if (!inGrid) { setScroll(0); return; }
    var p = pos(focus), row = Math.floor(focus / COLS);
    el.ring.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)';
    caption.textContent = shown[focus] ? shown[focus].name : '';
    if (row < scrollRow) { setScroll(row); }
    else if (row > scrollRow + VISIBLE_ROWS - 1) { setScroll(row - VISIBLE_ROWS + 1); }
  }
  function setScroll(row) {
    if (row === scrollRow) { return; }
    scrollRow = row;
    el.track.style.transform = 'translate3d(0,' + (-row * ROW_STEP) + 'px,0)';
  }

  function switchTab(next) {
    if (next === tab) { return; }
    tab = next; save(STORE.tab, tab); focus = 0;
    scrollRow = 0; el.track.style.transform = 'translate3d(0,0,0)';
    render();
  }

  // ---- keys -----------------------------------------------------------------------
  var enterDownAt = 0, longTimer = null, longFired = false;

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (k === KEY.ENTER) {
      e.preventDefault();
      if (e.repeat || enterDownAt) { return; }
      enterDownAt = Date.now(); longFired = false;
      if (zone === 'grid' && moving < 0 && shown.length) {
        longTimer = setTimeout(function () { longFired = true; openMenu(); }, LONG_PRESS_MS);
      }
      return;
    }
    if (zone === 'menu') { return menuKey(k, e); }
    if (k === KEY.BACK || k === KEY.ESC) {
      e.preventDefault();
      if (moving >= 0) { endMove(false); }
      else if (tab === 'apps') { switchTab('home'); zone = shown.length ? 'grid' : 'tabs'; paintFocus(); }
      else if (zone === 'grid') { focus = 0; zone = 'tabs'; paintFocus(); }
      return; // a launcher never exits on Back
    }
    if (k < 37 || k > 40) { return; }
    e.preventDefault();
    if (zone === 'tabs') {
      if (k === KEY.LEFT) { switchTab('home'); }
      else if (k === KEY.RIGHT) { switchTab('apps'); }
      else if (k === KEY.DOWN && shown.length) { zone = 'grid'; focus = 0; }
      paintFocus();
      return;
    }
    var col = focus % COLS, next = focus;
    if (k === KEY.LEFT && col > 0) { next = focus - 1; }
    else if (k === KEY.RIGHT && col < COLS - 1 && focus + 1 < shown.length) { next = focus + 1; }
    else if (k === KEY.DOWN) {
      if (focus + COLS < shown.length) { next = focus + COLS; }
      else if (Math.floor(focus / COLS) < Math.floor((shown.length - 1) / COLS)) { next = shown.length - 1; }
    } else if (k === KEY.UP) {
      if (focus - COLS >= 0) { next = focus - COLS; }
      else if (moving < 0) { zone = 'tabs'; paintFocus(); return; }
    }
    if (next === focus) { return; }
    if (moving >= 0) { swapTiles(focus, next); }
    focus = next;
    paintFocus();
  });

  document.addEventListener('keyup', function (e) {
    if (e.keyCode !== KEY.ENTER) { return; }
    clearTimeout(longTimer);
    var held = enterDownAt; enterDownAt = 0;
    if (!held || longFired) { return; }
    if (zone === 'menu') { return chooseMenu(); }
    if (zone === 'tabs') { zone = shown.length ? 'grid' : 'tabs'; focus = 0; paintFocus(); return; }
    if (moving >= 0) { return endMove(true); }
    if (shown[focus]) { launch(shown[focus]); }
  });

  // ---- launching ------------------------------------------------------------------
  function launch(app) {
    if (!tz || !tz.application) { return toast('Would open ' + app.name); }
    try { tz.application.launch(app.id, null, function () { toast('Could not open ' + app.name); }); }
    catch (e) { toast('Could not open ' + app.name); }
  }

  // ---- tile menu and move mode ----------------------------------------------------
  var menuChoices = [], menuFocus = 0, menuItemEls = [];

  function openMenu() {
    var app = shown[focus];
    if (!app) { return; }
    var onHome = home.indexOf(app.id) >= 0;
    menuChoices = [];
    if (tab === 'home') { menuChoices.push({ id: 'move', label: 'Move' }); }
    menuChoices.push(onHome ? { id: 'remove', label: 'Remove from Home' } : { id: 'add', label: 'Add to Home' });
    menuChoices.push({ id: 'cancel', label: 'Cancel' });
    el.menuTitle.textContent = app.name;
    el.menuItems.textContent = '';
    menuItemEls = menuChoices.map(function (c) {
      var d = document.createElement('div');
      d.className = 'menu-item';
      d.textContent = c.label;
      el.menuItems.appendChild(d);
      return d;
    });
    menuFocus = 0; zone = 'menu'; el.menu.hidden = false; paintMenu();
  }
  function paintMenu() { menuItemEls.forEach(function (d, i) { d.classList.toggle('focused', i === menuFocus); }); }
  function closeMenu() { el.menu.hidden = true; zone = 'grid'; paintFocus(); }
  function menuKey(k, e) {
    if (k === KEY.UP || k === KEY.DOWN) {
      e.preventDefault();
      menuFocus = (menuFocus + (k === KEY.DOWN ? 1 : -1) + menuChoices.length) % menuChoices.length;
      paintMenu();
    } else if (k === KEY.BACK || k === KEY.ESC) { e.preventDefault(); closeMenu(); }
  }
  function chooseMenu() {
    var app = shown[focus], choice = menuChoices[menuFocus].id;
    closeMenu();
    if (choice === 'add') { home.push(app.id); save(STORE.home, home); toast('Added ' + app.name + ' to Home'); }
    else if (choice === 'remove') { home.splice(home.indexOf(app.id), 1); save(STORE.home, home); if (tab === 'home') { render(); } }
    else if (choice === 'move') { moving = focus; tiles[focus].classList.add('moving'); paintFocus(); }
  }

  function swapTiles(a, b) {
    var t = tiles[a]; tiles[a] = tiles[b]; tiles[b] = t;
    var s = shown[a]; shown[a] = shown[b]; shown[b] = s;
    [a, b].forEach(function (i) { var p = pos(i); tiles[i].style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)'; });
  }
  function endMove(keep) {
    if (keep) { home = shown.map(function (a) { return a.id; }); save(STORE.home, home); moving = -1; render(); return; }
    moving = -1; render(); // re-render from the saved order
  }

  // ---- toast ----------------------------------------------------------------------
  var toastTimer = null;
  function toast(text) {
    el.toast.textContent = text; el.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2200);
  }

  // ---- clock ----------------------------------------------------------------------
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function tick() {
    var d = tz && tz.time ? tz.time.getCurrentDateTime() : new Date();
    var h = d.getHours(), m = d.getMinutes();
    el.time.textContent = ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' AM' : ' PM');
    el.date.textContent = DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
    setTimeout(tick, (60 - d.getSeconds()) * 1000 + 50);
  }

  // ---- weather (Open-Meteo, approximate IP location) -------------------------------
  function getJSON(url, done) {
    var x = new XMLHttpRequest();
    x.open('GET', url); x.timeout = 8000;
    x.onload = function () { try { done(x.status === 200 ? JSON.parse(x.responseText) : null); } catch (e) { done(null); } };
    x.onerror = x.ontimeout = function () { done(null); };
    x.send();
  }
  function showWeather(w) {
    if (!w) { return; }
    el.temp.textContent = Math.round(w.temp) + '°';
    el.city.textContent = w.city || '';
    el.weather.hidden = false;
  }
  function refreshWeather() {
    var cached = load(STORE.weather, null);
    showWeather(cached);
    if (cached && cached.unit === WEATHER_UNIT && Date.now() - cached.at < WEATHER_EVERY_MS) { return; }
    getJSON('https://ipapi.co/json/', function (geo) {
      if (!geo || typeof geo.latitude !== 'number') { return; }
      getJSON('https://api.open-meteo.com/v1/forecast?latitude=' + geo.latitude + '&longitude=' + geo.longitude +
        '&current=temperature_2m' + (WEATHER_UNIT === 'F' ? '&temperature_unit=fahrenheit' : ''), function (m) {
        if (!m || !m.current || typeof m.current.temperature_2m !== 'number') { return; }
        var w = { temp: m.current.temperature_2m, city: geo.city || '', unit: WEATHER_UNIT, at: Date.now() };
        save(STORE.weather, w); showWeather(w);
      });
    });
  }

  // ---- start ----------------------------------------------------------------------
  zone = 'grid';
  render();                 // instant first paint from the cached list
  tick();
  // Load the live list and weather after the first frame so they never delay it.
  requestAnimationFrame(function () { setTimeout(function () { refreshApps(); refreshWeather(); }, 0); });
  setInterval(refreshWeather, WEATHER_EVERY_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { refreshApps(); refreshWeather(); }
  });
})();
