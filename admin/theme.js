// Внешний вид кабинета: тема, цвет акцента, фон, плотность, боковая панель. Подключается в <head>
// до стилей, чтобы страница сразу открывалась в своём виде без мигания. Настройки хранятся в профиле
// на сервере; здесь — их копия в браузере для мгновенного применения при следующем открытии.
(function () {
  var KEY = 'soroka-prefs';
  var OLD_KEY = 'soroka-theme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var root = document.documentElement;
  var current = {};

  function read() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
      if (!saved.theme) {
        var old = localStorage.getItem(OLD_KEY);
        if (old === 'light' || old === 'dark') saved.theme = old;
      }
      return saved;
    } catch (e) {
      return {};
    }
  }

  function remember(prefs) {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch (e) {
      /* без хранилища вид применится после входа */
    }
  }

  function applyTheme(pref) {
    var dark = pref === 'dark' || (pref !== 'light' && media && media.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePref = pref || 'system';
  }

  function apply(prefs) {
    current = prefs || {};
    applyTheme(current.theme);
    root.dataset.accent = current.accent || 'soroka';
    root.dataset.density = current.density || 'comfortable';
    root.dataset.sidebar = current.sidebar || 'full';
    var bg = current.background || 'none';
    var m = /^media:(\d+)$/.exec(bg);
    root.dataset.bg = m ? 'image' : bg;
    if (m) root.style.setProperty('--bg-image', 'url("/admin/api/media/' + m[1] + '")');
    else root.style.removeProperty('--bg-image');
  }

  window.sorokaTheme = {
    get: function () {
      return current.theme || 'system';
    },
    prefs: function () {
      return current;
    },
    /** Применить и запомнить в браузере (на сервер сохраняет admin.js). */
    apply: function (prefs) {
      apply(prefs);
      remember(current);
    },
    set: function (theme) {
      var next = Object.assign({}, current, { theme: theme });
      apply(next);
      remember(next);
    },
  };

  apply(read());
  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if ((current.theme || 'system') === 'system') applyTheme('system');
    });
  }
})();
