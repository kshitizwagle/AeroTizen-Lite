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
  var WEATHER_UNIT = 'C';       // 'C' or 'F'
  var WEATHER_EVERY_MS = 30 * 60 * 1000;

  var tz = window.tizen;
  var $ = function (id) { return document.getElementById(id); };
  var el = { grid: $('grid'), track: $('track'), ring: $('ring'), empty: $('empty'), tabs: document.querySelector('.tabs'),
    plate: $('tab-plate'), tabHome: $('tab-home'), tabApps: $('tab-apps'), menu: $('menu'), menuTitle: $('menu-title'),
    menuItems: $('menu-items'), exit: $('exit'), toast: $('toast'), time: $('time'), date: $('date'), weather: $('weather'),
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
  var onExit = false;                   // in the header: true when "Samsung Home" has focus
  var shown = [];                       // apps in the current grid
  var tiles = [];                       // tile elements, same order as shown
  var byId = {};
  var inputs = [];                      // HDMI ports and Live TV, shown on Home below the apps
  var layout = [];                      // {r, c} per shown item

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
  function pos(i) { var l = layout[i]; return { x: l.c * STEP, y: l.r * ROW_STEP }; }

  // ---- inputs (HDMI ports and the TV tuner) ------------------------------------------
  // Names the TV uses when nothing is plugged in or the device is unidentified.
  var PLACEHOLDER = /^(hdmi( ?\d+)?|source( hdmi)?( \d+)?|input( hdmi)?( \d+)?|unknown( device)?|unrecogni[sz]ed( device)?|no device|not connected|disconnected)$/i;
  var INPUT_PRESETS = { 'HDMI 1': { name: 'ViaTV', icon: 'assets/viatv.png' } }; // your set-top box
  var TV_VIEWER = 'org.tizen.tv-viewer';

  function portName(s) { return s.type === 'TV' ? 'Live TV' : s.type + ' ' + s.number; }
  function toInput(s, connected) {
    var port = portName(s), preset = INPUT_PRESETS[port] || {};
    var device = typeof s.editName === 'string' && s.editName.trim() && !PLACEHOLDER.test(s.editName.trim()) ? s.editName.trim() : '';
    return { kind: 'input', id: 'input:' + port, port: port, name: preset.name || device || port,
      icon: preset.icon || '', connected: connected || s.signal === true, raw: s };
  }

  function loadInputs() {
    if (!tz || !tz.systeminfo) {
      if (!inputs.length) {
        inputs = [{ type: 'TV', number: 1 }, { type: 'HDMI', number: 1 }, { type: 'HDMI', number: 2, editName: 'Xbox' },
          { type: 'HDMI', number: 3 }].map(function (s, i) { return toInput(s, i < 3); });
        render();
      }
      return;
    }
    try {
      tz.systeminfo.getPropertyValue('VIDEOSOURCE', function (info) {
        var byPort = {};
        function add(list, connected) {
          (list || []).forEach(function (s) {
            if (!s || s.type === 'MEDIA' || (s.type !== 'TV' && s.type !== 'HDMI')) { return; }
            var item = toInput(s, connected), prior = byPort[item.port];
            if (!prior || (!prior.connected && item.connected)) { byPort[item.port] = item; }
          });
        }
        add(info.connected, true);
        add(info.disconnected, false);
        // Fixed order (Live TV, then HDMI 1, 2, ...) so tiles never jump around.
        var next = Object.keys(byPort).map(function (k) { return byPort[k]; }).sort(function (a, b) {
          return (a.raw.type === 'TV' ? 0 : 1) - (b.raw.type === 'TV' ? 0 : 1) || a.raw.number - b.raw.number;
        });
        var key = function (l) { return l.map(function (i) { return i.port + i.name + i.connected; }).join('|'); };
        if (key(next) === key(inputs)) { return; }
        inputs = next;
        if (tab === 'home') { render(); }
      }, function () { /* keep what we have */ });
    } catch (e) { /* VIDEOSOURCE unsupported */ }
  }

  // Switch the TV to the input, then hand over to Samsung's own viewer, which owns the remote.
  function openInput(item) {
    if (!tz || !tz.application) { return toast('Would switch to ' + item.name); }
    function failed() { toast('Could not open ' + item.name); }
    function viewer() {
      try {
        tz.application.launch(TV_VIEWER, null, function () {
          try {
            tz.application.launchAppControl(new tz.ApplicationControl('http://tizen.org/appcontrol/operation/main'),
              TV_VIEWER, null, failed);
          } catch (e) { failed(); }
        });
      } catch (e) { failed(); }
    }
    if (!tz.tvwindow || !tz.tvwindow.setSource) { return viewer(); }
    try { tz.tvwindow.setSource(item.raw, viewer, failed, 'MAIN'); } catch (e) { failed(); }
  }

  function makeInputTile(item) {
    var t = document.createElement('div');
    t.className = 'tile input' + (item.connected ? '' : ' off');
    if (item.icon) {
      var img = new Image();
      img.decoding = 'async'; img.alt = ''; img.className = 'input-logo'; img.src = item.icon;
      t.appendChild(img);
    } else {
      var name = document.createElement('span');
      name.className = 'input-name';
      name.textContent = item.name;
      t.appendChild(name);
    }
    if (item.name !== item.port) {
      var port = document.createElement('span');
      port.className = 'input-port';
      port.textContent = item.port;
      t.appendChild(port);
    }
    return t;
  }

  // Samsung's own Home draws the artwork it caches per app under apps_icon/all/<id>/,
  // where <id> is the store ID (or, for some apps, the app ID). Try that first, as the old
  // launcher did, then the app's own icon, then a letter.
  var ART = '/opt/share/webappservice/apps_icon/';
  var STORE_IDS = { // apps whose icon path does not reveal their store ID
    '9Ur5IzDKqV.TizenYouTube': '111299001912', 'org.tizen.netflix-app': '3201907018807',
    'org.tizen.primevideo': '3201910019365', 'com.samsung.tv.aria-video': '3201807016597',
    'IkWsFHtOY9.Stremio': '3202306031311', 'MCmYXNxgcu.DisneyPlus': '3201901017640'
  };
  function artSources(app) {
    var out = [];
    function add(s) { if (s && out.indexOf(s) < 0) { out.push(s); } }
    var cached = (app.icon || '').match(/apps_icon\/(?:all|FirstScreen)\/([^/]+)\//);
    [STORE_IDS[app.id], cached && cached[1], app.id].forEach(function (id) {
      if (!id) { return; }
      add(ART + 'all/' + id + '/304x304.png');
      add(ART + 'FirstScreen/' + id + '/250x250.png');
    });
    add(app.icon);
    return out;
  }

  function makeTile(app) {
    if (app.kind === 'input') { return makeInputTile(app); }
    var t = document.createElement('div');
    t.className = 'tile';
    var sources = tz ? artSources(app) : [];
    if (!sources.length) { t.appendChild(letter(app)); return t; }
    var img = new Image(), i = 0;
    img.decoding = 'async';
    img.alt = '';
    img.onerror = function () {
      if (++i < sources.length) { img.src = sources[i]; return; }
      t.removeChild(img); t.appendChild(letter(app));
    };
    img.src = sources[0];
    t.appendChild(img);
    return t;
  }
  function letter(app) {
    var s = document.createElement('span');
    s.className = 'letter';
    s.textContent = (app.name || '?').charAt(0).toUpperCase();
    return s;
  }

  // Rows: apps fill rows of COLS; on Home the inputs start on their own row below.
  function buildLayout() {
    layout = [];
    var apps = 0;
    shown.forEach(function (item, i) {
      if (item.kind === 'input') {
        var first = Math.ceil(apps / COLS), k = i - apps;
        layout.push({ r: first + Math.floor(k / COLS), c: k % COLS });
      } else {
        layout.push({ r: Math.floor(apps / COLS), c: apps % COLS }); apps++;
      }
    });
  }

  function render() {
    ensureHome();
    shown = tab === 'home' ? (home || []).map(function (id) { return byId[id]; }).filter(Boolean).concat(inputs) : all.slice();
    buildLayout();
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
    if (zone !== 'tabs') { onExit = false; }
    var onTabs = zone === 'tabs' && !onExit;
    el.ring.classList.toggle('on', inGrid);
    el.ring.classList.toggle('move', moving >= 0);
    el.exit.classList.toggle('focused', zone === 'tabs' && onExit);
    el.tabs.classList.toggle('focused', onTabs);
    el.tabHome.classList.toggle('focused', onTabs && tab === 'home');
    el.tabApps.classList.toggle('focused', onTabs && tab === 'apps');
    if (!inGrid) { setScroll(0); return; }
    var p = pos(focus), row = layout[focus].r;
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
      if (zone === 'grid' && moving < 0 && shown[focus] && shown[focus].kind !== 'input') {
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
      if (k === KEY.LEFT) { if (tab === 'apps') { switchTab('home'); } else { onExit = true; } }
      else if (k === KEY.RIGHT) { if (onExit) { onExit = false; } else { switchTab('apps'); } }
      else if (k === KEY.DOWN && shown.length) { zone = 'grid'; focus = 0; }
      paintFocus();
      return;
    }
    var here = layout[focus], next = focus;
    if (k === KEY.LEFT && focus > 0 && layout[focus - 1].r === here.r) { next = focus - 1; }
    else if (k === KEY.RIGHT && focus + 1 < shown.length && layout[focus + 1].r === here.r) { next = focus + 1; }
    else if (k === KEY.DOWN || k === KEY.UP) {
      var target = inRow(here.r + (k === KEY.DOWN ? 1 : -1), here.c);
      if (target >= 0) { next = target; }
      else if (k === KEY.UP && moving < 0) { zone = 'tabs'; paintFocus(); return; }
    }
    if (next === focus) { return; }
    if (moving >= 0) {
      if (shown[next].kind === 'input') { return; } // inputs stay in their own row
      swapTiles(focus, next);
    }
    focus = next;
    paintFocus();
  });

  // The item in row r closest to column c, or -1 if the row does not exist.
  function inRow(r, c) {
    var best = -1;
    for (var i = 0; i < layout.length; i++) {
      if (layout[i].r === r && (best < 0 || Math.abs(layout[i].c - c) < Math.abs(layout[best].c - c))) { best = i; }
    }
    return best;
  }

  document.addEventListener('keyup', function (e) {
    if (e.keyCode !== KEY.ENTER) { return; }
    clearTimeout(longTimer);
    var held = enterDownAt; enterDownAt = 0;
    if (!held || longFired) { return; }
    if (zone === 'menu') { return chooseMenu(); }
    if (zone === 'tabs' && onExit) { return openSamsungHome(); }
    if (zone === 'tabs') { zone = shown.length ? 'grid' : 'tabs'; focus = 0; paintFocus(); return; }
    if (moving >= 0) { return endMove(true); }
    var item = shown[focus];
    if (item) { if (item.kind === 'input') { openInput(item); } else { launch(item); } }
  });

  // ---- launching ------------------------------------------------------------------
  function launch(app) {
    if (!tz || !tz.application) { return toast('Would open ' + app.name); }
    try { tz.application.launch(app.id, null, function () { toast('Could not open ' + app.name); }); }
    catch (e) { toast('Could not open ' + app.name); }
  }

  // Samsung's own Home (Smart Hub). AppControl is the fallback some firmware needs.
  var SAMSUNG_HOME = 'com.samsung.tv.csfs';
  function openSamsungHome() {
    if (!tz || !tz.application) { return toast('Would open Samsung Home'); }
    function failed() { toast('Could not open Samsung Home'); }
    function viaControl() {
      try {
        tz.application.launchAppControl(new tz.ApplicationControl('http://tizen.org/appcontrol/operation/main'),
          SAMSUNG_HOME, null, failed);
      } catch (e) { failed(); }
    }
    try { tz.application.launch(SAMSUNG_HOME, null, viaControl); } catch (e) { viaControl(); }
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
    if (keep) {
      home = shown.filter(function (a) { return a.kind !== 'input'; }).map(function (a) { return a.id; });
      save(STORE.home, home); moving = -1; render(); return;
    }
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
    if (cached && cached.unit === WEATHER_UNIT) { showWeather(cached); } // never flash the old unit
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
  requestAnimationFrame(function () { setTimeout(function () { startService(); refreshApps(); loadInputs(); refreshWeather(); }, 0); });

  // The Home watcher service (bundled, unchanged from AeroTizen) must be running for
  // `aerotizen home apply/restore`. It starts at boot; this covers fresh installs.
  function startService() {
    if (!tz || !tz.application || !tz.ApplicationControl) { return; }
    try {
      tz.application.launchAppControl(new tz.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
        'DclHome001.Watcher', null, null);
    } catch (e) { /* without it, Home stays on Samsung's screen */ }
  }
  setInterval(refreshWeather, WEATHER_EVERY_MS);
  // Plugging or unplugging a device updates the Inputs row.
  if (tz && tz.systeminfo && tz.systeminfo.addPropertyValueChangeListener) {
    try { tz.systeminfo.addPropertyValueChangeListener('VIDEOSOURCE', loadInputs); } catch (e) { /* unsupported */ }
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { refreshApps(); loadInputs(); refreshWeather(); }
  });
})();
