// Тема оформления: светлая, тёмная или как в системе. Подключается в <head> до стилей страницы,
// чтобы страница сразу открывалась в нужной теме без мигания.
(function () {
  var KEY = 'soroka-theme';
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function apply(pref) {
    var root = document.documentElement;
    var dark = pref === 'dark' || (pref === 'system' && media && media.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePref = pref;
  }

  window.sorokaTheme = {
    get: read,
    set: function (pref) {
      try {
        if (pref === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
      } catch (e) {
        /* без хранилища тема действует до перезагрузки */
      }
      apply(pref);
    },
  };

  apply(read());
  if (media && media.addEventListener) {
    media.addEventListener('change', function () {
      if (document.documentElement.dataset.themePref === 'system') apply('system');
    });
  }
})();
