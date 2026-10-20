/*!
 * Квалификатор лидов Soroka Marketing — виджет для сайта.
 *
 * Подключение:
 *   <script src="https://ВАШ-СЕРВЕР/widget.js" defer
 *           data-button="Обсудить задачу"
 *           data-metrika="12345678"></script>
 *
 * Открыть из любой кнопки сайта: <a href="#kvalificator">…</a>, атрибут data-kval-open
 * или window.SorokaKval.open().
 */
(function () {
  'use strict';
  if (window.SorokaKval) return;

  var script = document.currentScript;
  var ds = (script && script.dataset) || {};
  var API = (ds.api || (script ? new URL(script.src).origin : '')).replace(/\/$/, '');
  var STORAGE_KEY = 'soroka-kval-v1';

  // brand:start — сгенерировано npm run brand:sync из brand/brand.config.json
  var BRAND = {"color":"#20252A","accent":"#12C9D6","accentText":"#0A7F89","onAccent":"#20252A","title":"Soroka Marketing"};
  // brand:end

  var opts = {
    title: ds.title || BRAND.title,
    subtitle: ds.subtitle || 'Давайте обсудим вашу задачу',
    button: ds.button || 'Обсудить задачу',
    color: ds.color || BRAND.color,
    accent: ds.accent || BRAND.accent,
    accentText: ds.accentText || BRAND.accentText,
    onAccent: ds.onAccent || BRAND.onAccent,
    position: ds.position === 'left' ? 'left' : 'right',
    metrika: ds.metrika || null,
    zIndex: ds.zIndex || '2147483000',
  };

  // ---------- хранилище (может быть недоступно: приватный режим, запрет cookies) ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; } catch (e) { return null; }
  }
  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* без сохранения */ }
  }
  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  function goal(name) {
    if (opts.metrika && typeof window.ym === 'function') {
      try { window.ym(Number(opts.metrika), 'reachGoal', name); } catch (e) { /* ignore */ }
    }
  }

  function api(method, path, body, token) {
    var headers = { 'content-type': 'application/json' };
    if (token) headers['x-session-token'] = token;
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function collectMeta() {
    var meta = { page: location.href.slice(0, 500) };
    if (document.referrer) meta.referrer = document.referrer.slice(0, 500);
    var utm = {};
    var params = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'yclid', 'gclid'].forEach(function (k) {
      var v = params.get(k);
      if (v) utm[k] = v.slice(0, 200);
    });
    if (Object.keys(utm).length) meta.utm = utm;
    // Тестовый опрос из админки (?kval_test=1): лид помечается и не уходит менеджерам
    if (params.get('kval_test') === '1' || ds.test === 'true') meta.test = true;
    return meta;
  }

  // ---------- DOM ----------
  var host = document.createElement('div');
  host.id = 'soroka-kval';
  host.style.cssText = 'position:fixed;z-index:' + opts.zIndex + ';' + opts.position + ':0;bottom:0;';
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML =
    '<style>' + css() + '</style>' +
    '<button class="launcher" type="button" aria-haspopup="dialog" aria-expanded="false">' +
      '<span class="launcher-icon" aria-hidden="true">' + iconChat() + '</span>' +
      '<span class="launcher-label"></span>' +
    '</button>' +
    '<section class="panel" role="dialog" aria-modal="false" aria-labelledby="kv-title" hidden>' +
      '<header class="head">' +
        '<div class="avatar" aria-hidden="true">' + iconChat() + '</div>' +
        '<div class="head-text"><img class="logo" alt="" hidden><h2 id="kv-title"></h2><p class="sub"></p></div>' +
        '<button class="restart" type="button" aria-label="Начать заново" title="Начать заново">' + iconRestart() + '</button>' +
        '<button class="close" type="button" aria-label="Закрыть">' + iconClose() + '</button>' +
      '</header>' +
      '<div class="progress" role="progressbar" aria-label="Прогресс" aria-valuemin="0" aria-valuemax="100"><span></span></div>' +
      '<div class="log" aria-live="polite"></div>' +
      '<div class="controls"></div>' +
      '<footer class="foot"></footer>' +
    '</section>';

  var $ = function (sel) { return root.querySelector(sel); };
  var launcher = $('.launcher');
  var panel = $('.panel');
  var log = $('.log');
  var controls = $('.controls');
  var foot = $('.foot');
  var progress = $('.progress');
  $('.launcher-label').textContent = opts.button;
  $('#kv-title').textContent = opts.title;
  $('.sub').textContent = opts.subtitle;
  host.style.setProperty('--kv-color', opts.color);
  host.style.setProperty('--kv-accent', opts.accent);
  host.style.setProperty('--kv-accent-text', opts.accentText);
  host.style.setProperty('--kv-on-accent', opts.onAccent);

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- состояние ----------
  var state = load() || { transcript: [] };
  var busy = false;
  var started = false;
  var dialogMode = false;
  var privacyUrl = null;

  function remember(from, text) {
    state.transcript.push({ from: from, text: text });
    if (state.transcript.length > 80) state.transcript.shift();
    save(state);
  }

  function bubble(from, text, extraClass) {
    var el = document.createElement('div');
    el.className = 'msg ' + from + (extraClass ? ' ' + extraClass : '');
    // **…** в сообщениях бота — жирным (суммы в смете); всё остальное — простым текстом, без HTML
    if (from === 'bot' && text && text.indexOf('**') >= 0) {
      text.split(/\*\*(.+?)\*\*/).forEach(function (part, i) {
        if (!part) return;
        if (i % 2) { var b = document.createElement('b'); b.textContent = part; el.appendChild(b); }
        else el.appendChild(document.createTextNode(part));
      });
    } else el.textContent = text;
    log.appendChild(el);
    scrollEnd();
    return el;
  }

  // Панель вариантов ответа уменьшает ленту — после её отрисовки снова прокручиваем вниз
  function scrollEnd() { log.scrollTop = log.scrollHeight; }
  // Новые сообщения не помещаются (длинная смета) — показываем их с начала, а не с конца:
  // иначе верх сметы уходит под шапку и кажется обрезанным
  function showNew(first) {
    if (first && log.scrollHeight - first.offsetTop > log.clientHeight) log.scrollTop = Math.max(0, first.offsetTop - 12);
    else scrollEnd();
  }

  function say(text, extraClass) {
    return new Promise(function (resolve) {
      if (reduceMotion) return resolve(bubble('bot', text, extraClass));
      var typing = bubble('bot', '', 'typing');
      typing.innerHTML = '<i></i><i></i><i></i>';
      typing.setAttribute('aria-hidden', 'true');
      setTimeout(function () {
        typing.remove();
        resolve(bubble('bot', text, extraClass));
      }, Math.min(900, 300 + text.length * 6));
    });
  }

  function setProgress(p) {
    // диалог с ИИ без фиксированного числа вопросов — полосы прогресса нет
    progress.hidden = p === null && !state.done && dialogMode;
    var pct = p ? Math.round(((p.index - 1) / p.total) * 100) : 100;
    progress.firstChild.style.width = pct + '%';
    progress.setAttribute('aria-valuenow', String(pct));
  }

  function renderFoot(handoff) {
    foot.textContent = '';
    var links = [];
    if (handoff && handoff.telegram) links.push(['Telegram', handoff.telegram]);
    if (handoff && handoff.max) links.push(['MAX', handoff.max]);
    if (!links.length) return;
    foot.appendChild(document.createTextNode('Удобнее в мессенджере? '));
    links.forEach(function (l, i) {
      if (i) foot.appendChild(document.createTextNode(' · '));
      var a = document.createElement('a');
      a.href = l[1];
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = l[0];
      a.addEventListener('click', function () { goal('kval_handoff'); });
      foot.appendChild(a);
    });
  }

  function clearControls() { controls.textContent = ''; }

  function renderQuestion(reply, opts2) {
    clearControls();
    if (reply.type === 'done') return renderDone(reply);
    var step = reply.step;
    dialogMode = reply.progress === null;
    setProgress(reply.progress);
    // сообщения перед вопросом (примерная смета) — отдельными пузырями
    var show = Promise.resolve();
    var firstNew = null;
    if (!(opts2 && opts2.silent)) {
      (step.before || []).concat([step.text]).forEach(function (t) {
        show = show.then(function () { return say(t); }).then(function (el) { if (!firstNew) firstNew = el; remember('bot', t); });
      });
    }
    return show.then(function () {
      if (step.type === 'choice') {
        renderOptions(step);
        // можно выбрать вариант или ответить своими словами
        if (step.allowText) renderInput(step);
      } else if (step.type === 'consent') renderConsent(step);
      else renderInput(step);
      if (!step.required) renderSkip(step);
      if (reply.canLeaveContact) renderLeaveContact();
      showNew(firstNew);
    });
  }

  function renderOptions(step) {
    var list = document.createElement('div');
    list.className = 'options';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', step.text);
    step.options.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'option';
      b.textContent = o.label;
      b.addEventListener('click', function () { send(step, o.value, o.label); });
      list.appendChild(b);
    });
    controls.appendChild(list);
    list.firstChild.focus({ preventScroll: true });
  }

  function renderConsent(step) {
    var box = document.createElement('div');
    box.className = 'consent';
    if (privacyUrl) {
      var p = document.createElement('p');
      p.appendChild(document.createTextNode('Нажимая кнопку, вы соглашаетесь с '));
      var a = document.createElement('a');
      a.href = privacyUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'политикой обработки персональных данных';
      p.appendChild(a);
      box.appendChild(p);
    }
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'primary';
    b.textContent = step.options[0].label;
    b.addEventListener('click', function () { send(step, step.options[0].value, step.options[0].label); });
    box.appendChild(b);
    controls.appendChild(box);
    b.focus({ preventScroll: true });
  }

  function renderInput(step) {
    var form = document.createElement('form');
    form.className = 'input';
    var multiline = step.type === 'text' && step.id !== 'name';
    var field = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) {
      field.type = 'text';
      if (step.type === 'contact') {
        field.setAttribute('autocomplete', 'tel');
        field.setAttribute('inputmode', 'tel');
      }
      if (step.id === 'name') field.setAttribute('autocomplete', 'given-name');
    } else {
      field.rows = 2;
    }
    field.maxLength = 2000;
    field.placeholder = step.placeholder || 'Ваш ответ';
    field.setAttribute('aria-label', step.text);
    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'send';
    btn.setAttribute('aria-label', 'Отправить');
    btn.innerHTML = iconSend();
    form.appendChild(field);
    form.appendChild(btn);
    if (step.type === 'contact') {
      // Переключатель подсказки: телефон или e-mail/Telegram
      field.addEventListener('input', function () {
        var v = field.value;
        field.setAttribute('inputmode', /[a-zа-я@]/i.test(v) ? 'email' : 'tel');
      });
    }
    // на компьютере Enter отправляет, Shift+Enter — новая строка; на телефоне Enter — новая строка,
    // отправка — кнопкой (как в мессенджерах)
    field.addEventListener('keydown', function (e) {
      if (multiline && !coarse && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    field.setAttribute('enterkeyhint', multiline && coarse ? 'enter' : 'send');
    if (multiline) {
      // поле растёт вместе с текстом — длинный ответ видно целиком (до ~6 строк)
      field.addEventListener('input', function () {
        field.style.height = 'auto';
        field.style.height = Math.min(field.scrollHeight + 3, 160) + 'px';
        scrollEnd();
      });
    }
    // контакт: под полем — галочка согласия и кнопка «Отправить» (без галочки не отправить)
    var agree = null;
    if (step.consent) {
      form.className = 'input with-consent';
      btn.className = 'primary';
      btn.removeAttribute('aria-label');
      btn.textContent = 'Отправить';
      btn.disabled = true;
      var lbl = document.createElement('label');
      lbl.className = 'agree';
      agree = document.createElement('input');
      agree.type = 'checkbox';
      agree.addEventListener('change', function () { btn.disabled = !agree.checked; });
      lbl.appendChild(agree);
      var span = document.createElement('span');
      span.appendChild(document.createTextNode(step.consent.label));
      if (privacyUrl) {
        span.appendChild(document.createTextNode(' ('));
        var a = document.createElement('a');
        a.href = privacyUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'политика';
        span.appendChild(a);
        span.appendChild(document.createTextNode(')'));
      }
      lbl.appendChild(span);
      form.insertBefore(lbl, btn);
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = field.value.trim();
      if (!v) { field.focus(); return; }
      if (agree && !agree.checked) { agree.focus(); return; }
      send(step, v, v);
    });
    controls.appendChild(form);
    field.focus({ preventScroll: true });
  }

  // «Оставить контакт» — на любом шаге диалога, не дожидаясь конца разговора
  function renderLeaveContact() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'skip';
    b.textContent = 'Оставить контакт и закончить';
    b.addEventListener('click', function () {
      if (busy) return;
      goal('kval_leave_contact');
      leaveContact();
    });
    controls.appendChild(b);
  }

  function leaveContact() {
    bubble('user', 'Оставить контакт');
    remember('user', 'Оставить контакт');
    request({ action: 'contact' }, leaveContact);
  }

  function renderSkip(step) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'skip';
    b.textContent = 'Пропустить';
    b.addEventListener('click', function () { send(step, null, 'Пропустить', true); });
    controls.appendChild(b);
  }

  function renderDone(reply) {
    setProgress(null);
    clearControls();
    renderFoot(null);
    var chain = say(reply.text).then(function () { remember('bot', reply.text); });
    if (reply.hint) chain = chain.then(function () { return say(reply.hint); }).then(function () { remember('bot', reply.hint); });
    return chain.then(function () {
      state.done = true;
      save(state);
      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'skip';
      again.textContent = 'Начать заново';
      again.addEventListener('click', restart);
      controls.appendChild(again);
      scrollEnd();
    });
  }

  function send(step, value, label, skip) {
    if (busy) return;
    busy = true;
    clearControls();
    bubble('user', label);
    remember('user', label);
    goal('kval_step_' + step.id);
    var body = skip ? { stepId: step.id, skip: true } : { stepId: step.id, value: String(value) };
    // контакт отправляется только с отмеченной галочкой согласия
    if (!skip && step.consent) body.consent = true;
    request(body, function () { send(step, value, label, skip); });
  }

  function request(body, retry) {
    busy = true;
    clearControls();
    // ответ с разбором ИИ занимает пару секунд — показываем, что собеседник «печатает»
    var typing = null;
    var typingTimer = setTimeout(function () {
      typing = bubble('bot', '', 'typing');
      typing.innerHTML = '<i></i><i></i><i></i>';
      typing.setAttribute('aria-hidden', 'true');
    }, 350);
    var stopTyping = function () { clearTimeout(typingTimer); if (typing) typing.remove(); };
    api('POST', '/api/sessions/' + state.sessionId + '/answer', body, state.token)
      .then(function (r) {
        stopTyping();
        busy = false;
        if (r.status === 200) {
          if (r.data.reply.type === 'done') goal('kval_lead');
          return renderQuestion(r.data.reply);
        }
        if (r.status === 422) {
          // Ответ не принят — объясняем и повторяем вопрос без повторного текста
          return say(r.data.error, 'error').then(function () { return renderQuestion(r.data.reply, { silent: true }); });
        }
        if (r.status === 404) return restart();
        throw new Error('HTTP ' + r.status);
      })
      .catch(function () {
        stopTyping();
        busy = false;
        showNetworkError(retry);
      });
  }

  function showNetworkError(retry) {
    say('Не удалось отправить ответ — проверьте соединение.', 'error').then(function () {
      clearControls();
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'primary';
      b.textContent = 'Повторить';
      b.addEventListener('click', function () {
        clearControls();
        // убираем дубль пузыря пользователя: повтор отрисует его снова
        var users = log.querySelectorAll('.msg.user');
        if (users.length) users[users.length - 1].remove();
        state.transcript.pop();
        retry();
      });
      controls.appendChild(b);
      b.focus({ preventScroll: true });
    });
  }

  function startNew() {
    busy = true;
    api('POST', '/api/sessions', { meta: collectMeta() })
      .then(function (r) {
        busy = false;
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        state = { sessionId: r.data.sessionId, token: r.data.token, transcript: [] };
        privacyUrl = r.data.privacyPolicyUrl;
        save(state);
        goal('kval_start');
        renderFoot(r.data.handoff);
        // в диалоге с ИИ отдельного вступления нет: приветствие — первый вопрос
        if (!r.data.reply.intro) return renderQuestion(r.data.reply);
        return say(r.data.reply.intro).then(function () {
          remember('bot', r.data.reply.intro);
          return renderQuestion(r.data.reply);
        });
      })
      .catch(function () {
        busy = false;
        showNetworkError(startNew);
      });
  }

  function resume() {
    state.transcript.forEach(function (m) { bubble(m.from, m.text); });
    api('GET', '/api/sessions/' + state.sessionId, null, state.token)
      .then(function (r) {
        if (r.status === 404) return restart();
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        privacyUrl = r.data.privacyPolicyUrl;
        renderFoot(r.data.handoff);
        if (r.data.reply.type === 'done') {
          setProgress(null);
          return renderDoneControls();
        }
        return renderQuestion(r.data.reply, { silent: true });
      })
      .catch(function () { showNetworkError(resume); });
  }

  function renderDoneControls() {
    clearControls();
    var again = document.createElement('button');
    again.type = 'button';
    again.className = 'skip';
    again.textContent = 'Начать заново';
    again.addEventListener('click', restart);
    controls.appendChild(again);
  }

  function restart() {
    clear();
    log.textContent = '';
    clearControls();
    state = { transcript: [] };
    dialogMode = false;
    progress.hidden = false;
    goal('kval_restart');
    startNew();
  }

  // Кнопка в шапке: начать разговор заново посреди диалога. Пока бот «печатает», не реагирует —
  // иначе старый ответ дорисуется в новую ленту. Если уже что-то ответили, сначала переспрашиваем.
  function askRestart() {
    if (busy || !controls.childNodes.length || controls.querySelector('.confirm')) return;
    var answered = state.transcript.some(function (m) { return m.from === 'user'; });
    if (!answered || state.done) return restart();
    var prev = Array.prototype.slice.call(controls.childNodes);
    clearControls();
    var box = document.createElement('div');
    box.className = 'confirm';
    var p = document.createElement('p');
    p.textContent = 'Начать разговор заново? Ответы выше не сохранятся.';
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'primary';
    yes.textContent = 'Начать заново';
    yes.addEventListener('click', restart);
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'skip';
    no.textContent = 'Продолжить разговор';
    no.addEventListener('click', function () {
      clearControls();
      prev.forEach(function (n) { controls.appendChild(n); });
      scrollEnd();
      var f = controls.querySelector('input, textarea, button');
      if (f) f.focus({ preventScroll: true });
    });
    box.appendChild(p);
    box.appendChild(yes);
    box.appendChild(no);
    controls.appendChild(box);
    scrollEnd();
    yes.focus({ preventScroll: true });
  }

  // ---------- открытие / закрытие ----------
  // ---------- телефон: экран целиком, клавиатура, прокрутка страницы ----------
  var mobile = window.matchMedia ? window.matchMedia('(max-width: 520px)') : { matches: false };
  var coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  var vv = window.visualViewport || null;
  var savedOverflow = null;
  // клавиатура уменьшает видимую область — подгоняем окно чата, чтобы поле ввода не уходило под неё
  function fitViewport() {
    if (!mobile.matches || !vv || panel.hidden) { panel.style.top = ''; panel.style.height = ''; return; }
    panel.style.top = vv.offsetTop + 'px';
    panel.style.height = vv.height + 'px';
    scrollEnd();
  }
  if (vv) {
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
  }
  function lockPage(on) {
    var el = document.documentElement;
    if (on && mobile.matches && savedOverflow === null) {
      savedOverflow = el.style.overflow;
      el.style.overflow = 'hidden';
    } else if (!on && savedOverflow !== null) {
      el.style.overflow = savedOverflow;
      savedOverflow = null;
    }
  }

  function open() {
    panel.hidden = false;
    lockPage(true);
    fitViewport();
    host.classList.add('open');
    launcher.setAttribute('aria-expanded', 'true');
    launcher.hidden = true;
    goal('kval_open');
    if (!started) {
      started = true;
      if (state.sessionId) resume(); else startNew();
    } else {
      var focusable = controls.querySelector('input, textarea, button');
      if (focusable) focusable.focus({ preventScroll: true });
    }
  }

  function close() {
    panel.hidden = true;
    lockPage(false);
    fitViewport();
    host.classList.remove('open');
    launcher.hidden = false;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus({ preventScroll: true });
  }

  launcher.addEventListener('click', open);
  $('.close').addEventListener('click', close);
  $('.restart').addEventListener('click', askRestart);
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-kval-open], a[href="#kvalificator"]');
    if (t) { e.preventDefault(); open(); }
  });

  // Логотип агентства в шапке (утверждённый файл с сервера, для тёмного фона); не загрузился —
  // остаются иконка и название текстом
  (function loadLogo() {
    var img = $('.logo');
    img.onload = function () {
      img.hidden = false;
      $('.avatar').hidden = true;
      $('#kv-title').classList.add('sr-only');
    };
    img.onerror = function () { img.remove(); };
    img.src = API + '/brand/logo/onDark';
  })();

  function mount() {
    document.body.appendChild(host);
    if (location.hash === '#kvalificator') open();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  window.SorokaKval = { open: open, close: close, restart: restart };

  // ---------- оформление ----------
  function css() {
    var side = opts.position;
    return [
      ':host{all:initial;--kv-color:#20252a;--kv-accent:#12c9d6;--kv-accent-text:#0a7f89;--kv-on-accent:#20252a;--kv-bg:#fff;--kv-text:#14213d;--kv-muted:#5b6478;--kv-bot:#eef3f9;--kv-line:#dde4ee;--kv-error:#b42318;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:15px;line-height:1.45;color:var(--kv-text)}',
      '@media (prefers-color-scheme:dark){:host{--kv-bg:#121a26;--kv-text:#e8edf5;--kv-muted:#9aa6b8;--kv-bot:#1d2838;--kv-line:#2a3648;--kv-error:#ff8a80}}',
      '*{box-sizing:border-box}',
      'button{font:inherit;cursor:pointer}',
      '.launcher{position:fixed;bottom:20px;' + side + ':20px;display:flex;align-items:center;gap:10px;min-height:56px;padding:0 22px 0 8px;border:0;border-radius:28px;',
      'background:var(--kv-color);color:#fff;font-weight:600;box-shadow:0 10px 30px rgba(10,30,60,.28);transition:transform .2s ease,box-shadow .2s ease}',
      '.launcher[hidden]{display:none}',
      '.launcher:hover{transform:translateY(-2px);box-shadow:0 14px 34px rgba(10,30,60,.34)}',
      '.launcher:focus-visible,.option:focus-visible,.primary:focus-visible,.send:focus-visible,.skip:focus-visible,.close:focus-visible,.restart:focus-visible{outline:3px solid var(--kv-accent);outline-offset:2px}',
      '.launcher-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--kv-accent);color:var(--kv-on-accent)}',
      '.launcher-icon svg{width:22px;height:22px}',
      '.panel{position:fixed;bottom:20px;' + side + ':20px;width:380px;height:min(640px,calc(100vh - 40px));display:flex;flex-direction:column;',
      'background:var(--kv-bg);border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(10,30,60,.32);animation:kv-in .22s ease-out}',
      '.panel[hidden]{display:none}',
      '@keyframes kv-in{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}',
      '.head{display:flex;align-items:center;gap:12px;padding:16px;background:var(--kv-color);color:#fff}',
      '.avatar{flex:none;display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:var(--kv-accent);color:var(--kv-on-accent)}',
      '.avatar svg{width:22px;height:22px}',
      '.avatar.has-logo{background:#fff;overflow:hidden}',
      '.avatar img{width:30px;height:30px;object-fit:contain}',
      '.head-text{flex:1;min-width:0}',
      '.logo{display:block;height:30px;width:auto;max-width:100%;margin:0 0 4px}',
      '.logo[hidden]{display:none}',
      '.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.avatar[hidden]{display:none}',
      'h2{margin:0;font-size:16px;font-weight:700}',
      '.sub{margin:2px 0 0;font-size:13px;opacity:.85}',
      '.close,.restart{flex:none;display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:#fff}',
      '.close:hover,.restart:hover{background:rgba(255,255,255,.14)}',
      '.close svg{width:20px;height:20px}.restart svg{width:18px;height:18px}',
      '.restart+.close{margin-left:-8px}',
      '.confirm{display:flex;flex-direction:column;gap:6px}',
      '.confirm p{margin:0 0 2px;font-size:13px;color:var(--kv-muted);text-align:center}',
      '.progress{height:3px;background:var(--kv-line)}',
      '.progress span{display:block;height:100%;width:0;background:var(--kv-accent);transition:width .3s ease}',
      '.log{position:relative;flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}',
      '.msg{max-width:86%;padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}',
      '.msg.bot{align-self:flex-start;background:var(--kv-bot);border-bottom-left-radius:4px}',
      // сумма в смете не разрывается на две строки
      '.msg.bot b{white-space:nowrap}',
      '.msg.user{align-self:flex-end;background:var(--kv-color);color:#fff;border-bottom-right-radius:4px}',
      '.msg.error{color:var(--kv-error)}',
      '.msg.typing{display:flex;gap:4px;padding:14px}',
      '.msg.typing i{width:7px;height:7px;border-radius:50%;background:var(--kv-muted);animation:kv-dot 1s infinite ease-in-out}',
      '.msg.typing i:nth-child(2){animation-delay:.15s}.msg.typing i:nth-child(3){animation-delay:.3s}',
      '@keyframes kv-dot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',
      '.controls{padding:0 16px 12px;display:flex;flex-direction:column;gap:8px;max-height:46%;overflow-y:auto}',
      '.controls:empty{display:none}',
      '.options{display:flex;flex-direction:column;gap:6px}',
      '.option{min-height:44px;padding:10px 14px;text-align:left;border:1.5px solid var(--kv-line);border-radius:12px;background:var(--kv-bg);color:var(--kv-text);transition:border-color .15s,background .15s}',
      '.option:hover{border-color:var(--kv-accent);background:var(--kv-bot)}',
      '.primary{min-height:46px;padding:10px 18px;border:0;border-radius:12px;background:var(--kv-color);color:#fff;font-weight:600}',
      '.primary:hover{filter:brightness(1.1)}',
      '.consent p{margin:0 0 8px;font-size:13px;color:var(--kv-muted)}',
      '.consent a,.foot a,.agree a{color:var(--kv-accent-text)}',
      '.input.with-consent{flex-direction:column;align-items:stretch}',
      '.agree{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--kv-muted);cursor:pointer}',
      '.input .agree input{flex:none;width:18px;height:18px;min-height:0;margin:0;padding:0;border:0;accent-color:var(--kv-color)}',
      '.primary:disabled{opacity:.45;cursor:not-allowed;filter:none}',
      '.input{display:flex;gap:8px;align-items:flex-end}',
      '.input input,.input textarea{flex:1;min-width:0;min-height:46px;padding:12px 14px;border:1.5px solid var(--kv-line);border-radius:12px;background:var(--kv-bg);color:var(--kv-text);font:inherit;font-size:16px;resize:none}',
      '.input input:focus,.input textarea:focus{outline:none;border-color:var(--kv-accent)}',
      '.send{flex:none;display:grid;place-items:center;width:46px;height:46px;border:0;border-radius:12px;background:var(--kv-accent);color:var(--kv-on-accent)}',
      '.send svg{width:20px;height:20px}',
      '.skip{align-self:center;min-height:36px;padding:6px 12px;border:0;background:transparent;color:var(--kv-muted);text-decoration:underline}',
      '.foot{padding:8px 16px 12px;font-size:12px;color:var(--kv-muted);text-align:center;border-top:1px solid var(--kv-line)}',
      '.foot:empty{display:none}',
      // телефон: чат на весь экран (высоту подгоняет fitViewport под клавиатуру), отступы под вырез и полоску «домой»
      '@media (max-width:520px){.panel{inset:0;width:auto;height:100%;height:100dvh;border-radius:0;animation:kv-up .2s ease-out}',
      '@keyframes kv-up{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}',
      '.head{padding:calc(12px + env(safe-area-inset-top)) 8px 12px 16px;gap:8px}',
      '.logo{height:26px;margin-bottom:3px}.sub{font-size:12px}',
      '.log{padding:12px 12px 8px}.msg{max-width:88%;font-size:15px}',
      '.controls{padding:8px 12px calc(10px + env(safe-area-inset-bottom));max-height:55%;border-top:1px solid var(--kv-line);background:var(--kv-bg)}',
      '.option{min-height:48px}.skip{min-height:40px}',
      '.foot{padding-bottom:calc(10px + env(safe-area-inset-bottom))}',
      '.launcher{bottom:calc(16px + env(safe-area-inset-bottom));' + side + ':16px}.launcher-label{display:none}.launcher{padding:0 8px}}',
      '@media (prefers-reduced-motion:reduce){.panel,.launcher,.progress span{animation:none;transition:none}}',
    ].join('');
  }

  function iconChat() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  }
  function iconClose() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  }
  function iconRestart() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  }
  function iconSend() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  }
})();
