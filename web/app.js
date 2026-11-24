import { $, element, button, link, request, run, formAction, notify, showError, present, choose,
  copyText, dateTime, codeBlock } from './ui.js';
import { resources } from './files.js';

const viewIds = ['join-view', 'room-view', 'login-view', 'admin-view'];
const roomLink = (code) => '/r/' + code;
const fullLink = (code) => new URL(roomLink(code), location.origin).href;
const roomAPI = (code) => '/api/room/' + code + '/';
const adminAPI = '/api/admin/';
const digits = (value) => value.replace(/[^0-9]/g, '').slice(0, 6);
const formatCode = (value) => value.length > 3 ? value.slice(0, 3) + ' - ' + value.slice(3) : value;
const shortTime = new Intl.DateTimeFormat('pl-PL', { timeStyle: 'short' });
const shortDay = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long' });

function view(id) {
  for (const panel of viewIds) $(panel).hidden = panel !== id;
  const admin = id === 'admin-view' || id === 'login-view';
  $('nav-link').href = admin ? '/' : '/admin';
  $('nav-link').textContent = admin ? 'Dołącz do pokoju' : 'Panel administratora';
}

function showJoin(code = '', message = '') {
  view('join-view');
  $('join-code').value = formatCode(code);
  showError($('join-error'), message);
}

$('join-code').addEventListener('input', (event) => {
  const field = event.currentTarget;
  const left = digits(field.value.slice(0, field.selectionStart)).length;
  field.value = formatCode(digits(field.value));
  const position = left + (left > 3 ? 3 : 0);
  field.setSelectionRange(position, position);
});

formAction($('join-form'), async () => {
  showError($('join-error'));
  const code = digits($('join-code').value);
  await request(roomAPI(code) + 'join', { method: 'POST', data: { nick: $('join-nick').value } });
  location.assign(roomLink(code) + location.hash);
}, (message) => showError($('join-error'), message));

function activateRoom(code, initial) {
  view('room-view');
  const base = roomAPI(code);
  const scroller = $('messages-scroll');
  const list = $('messages');
  const older = $('load-older');
  const latest = $('jump-latest');
  const input = $('message-text');
  const form = $('message-form');
  const chat = $('chat-screen');
  const gallery = $('gallery-screen');
  const assets = resources(base, refreshSoon);
  let mode = 'text';
  let last = 0;
  let first = 0;
  let catalogAt = null;
  let timer;
  let alive = true;
  let polling = false;
  let savedScroll = 0;
  let followLatest = true;
  let people = [];
  let peopleModal;

  function state(data) {
    $('room-title').textContent = data.room.title;
    $('room-code').textContent = formatCode(code);
    $('people-count').textContent = data.people.length;
    $('show-people').setAttribute('aria-label', 'Uczestnicy: ' + data.people.length);
    if (people.length !== data.people.length || people.some((name, i) => name !== data.people[i])) {
      people = data.people;
      if (peopleModal) renderPeople();
    }
  }

  function renderPeople() {
    const rows = people.map((name) => {
      const row = element('li');
      const dot = element('span', '', 'status-dot');
      dot.setAttribute('aria-hidden', 'true');
      row.append(dot, document.createTextNode(name));
      return row;
    });
    const peopleList = element('ul', '', 'people-list');
    peopleList.append(...rows);
    peopleModal.body.replaceChildren(peopleList);
  }

  function connected(flag) {
    $('connection').classList.toggle('offline', !flag);
    const label = flag ? 'Połączono' : 'Ponawiam połączenie…';
    $('connection-label').textContent = label;
    $('connection').title = label;
  }

  function message(data) {
    const row = element('li', '', 'message' + (data.mine ? ' is-mine' : ''));
    const content = element('div', '', 'message-content' + (data.kind === 'code' ? ' has-code' : ''));
    const meta = element('div', '', 'msg-meta');
    const bubble = element('div', '', 'bubble');
    const time = element('time', shortTime.format(data.created * 1000));
    time.dateTime = new Date(data.created * 1000).toISOString();
    time.title = dateTime(data.created);
    meta.append(element('strong', data.mine ? 'Ty' : data.author), time);
    if (!data.mine) {
      const avatar = element('span', Array.from(data.author)[0]?.toUpperCase(), 'avatar');
      avatar.setAttribute('aria-hidden', 'true');
      row.append(avatar);
    }
    if (data.kind === 'code') {
      if (data.asset) {
        bubble.append(button(data.name + ' · v' + data.num,
          () => assets.openAsset(data.asset, data.num, data.name), 'snippet-heading'));
      }
      bubble.append(codeBlock(data.body, data.lang));
    } else if (data.kind === 'asset') {
      const icon = data.asset_kind === 'folder' ? '▱ ' : '▤ ';
      bubble.append(button(icon + data.name + ' · v' + data.num,
        () => assets.openAsset(data.asset, data.num, data.name), 'msg-asset'));
      if (data.body) bubble.append(element('p', data.body, 'msg-text muted attachment-note'));
    } else {
      const paragraph = element('p', data.body, 'msg-text');
      const excerpt = data.body.split('\n').slice(0, 12).join('\n').slice(0, 900).trimEnd();
      if (excerpt.length < data.body.trimEnd().length) {
        paragraph.id = 'message-' + data.id;
        paragraph.textContent = excerpt + '…';
        const toggle = button('Pokaż całą wiadomość', () => {
          const expand = toggle.getAttribute('aria-expanded') === 'false';
          toggle.setAttribute('aria-expanded', String(expand));
          toggle.textContent = expand ? 'Zwiń wiadomość' : 'Pokaż całą wiadomość';
          paragraph.textContent = expand ? data.body : excerpt + '…';
        }, 'message-summary');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', paragraph.id);
        bubble.append(paragraph, toggle);
      } else {
        bubble.append(paragraph);
      }
    }
    content.append(meta, bubble);
    row.append(content);
    return row;
  }

  function renderMessages(batch, prepend = false) {
    const fragment = document.createDocumentFragment();
    let day = prepend ? '' : list.lastElementChild?.dataset.day;
    for (const item of batch) {
      const created = shortDay.format(item.created * 1000);
      if (day !== created) {
        fragment.append(element('li', created, 'date-divider'));
        day = created;
      }
      const row = message(item);
      row.dataset.day = created;
      fragment.append(row);
    }
    if (prepend) {
      if (list.firstElementChild?.textContent === day) list.firstElementChild.remove();
      list.prepend(fragment);
    } else {
      list.append(fragment);
    }
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
  }

  function scrollToLatest() {
    scroller.scrollTop = scroller.scrollHeight;
    latest.hidden = true;
  }

  function showScreen() {
    const showGallery = location.hash === '#zasoby';
    if (showGallery && !chat.hidden) {
      savedScroll = scroller.scrollTop;
      followLatest = nearBottom();
    }
    const restorePosition = !showGallery && chat.hidden;
    chat.hidden = showGallery;
    gallery.hidden = !showGallery;
    $('chat-link').toggleAttribute('aria-current', !showGallery);
    $('gallery-link').toggleAttribute('aria-current', showGallery);
    $(showGallery ? 'gallery-link' : 'chat-link').setAttribute('aria-current', 'page');
    if (restorePosition) {
      if (followLatest) scrollToLatest();
      else scroller.scrollTop = savedScroll;
    }
  }

  async function updateChat() {
    const starting = !last;
    let batch;
    do {
      batch = await request(base + 'messages' + (last ? '?after=' + last : ''));
      if (!alive) return;
      if (batch.length) {
        const follow = nearBottom() || starting;
        if (!first) {
          first = batch[0].id;
          older.hidden = batch.length < 80;
        }
        last = batch.at(-1).id;
        $('chat-empty').hidden = true;
        renderMessages(batch);
        if (!chat.hidden && follow) scrollToLatest();
        else latest.hidden = false;
      }
    } while (!starting && batch.length === 80);
  }

  older.addEventListener('click', () => run(older, async () => {
    const batch = await request(base + 'messages?before=' + first);
    const oldHeight = scroller.scrollHeight;
    const oldPosition = scroller.scrollTop;
    if (batch.length) {
      first = batch[0].id;
      renderMessages(batch, true);
    }
    older.hidden = batch.length < 80;
    scroller.scrollTop = oldPosition + scroller.scrollHeight - oldHeight;
  }));
  scroller.addEventListener('scroll', () => {
    if (nearBottom()) latest.hidden = true;
  });
  latest.addEventListener('click', scrollToLatest);

  async function sync() {
    if (!alive || polling) return;
    polling = true;
    let nextDelay = 1800;
    try {
      const data = await request(base + 'state');
      if (!alive) return;
      state(data);
      connected(true);
      if (data.last !== last) await updateChat();
      if (data.last !== catalogAt) {
        const catalog = await request(base + 'catalog');
        if (!alive) return;
        assets.render(catalog);
        catalogAt = data.last;
      }
    } catch (error) {
      if (error.status === 401 || error.status === 404) {
        alive = false;
        if ($('dialog').open) $('dialog').close();
        showJoin(code, error.message);
      } else if (alive) {
        connected(false);
        nextDelay = 4500;
      }
    } finally {
      polling = false;
      if (alive) timer = setTimeout(sync, nextDelay);
    }
  }

  function refreshSoon() {
    if (!alive || polling) return;
    clearTimeout(timer);
    void sync();
  }

  function setMode(value, focus = input) {
    mode = value;
    const codeMode = mode === 'code';
    $('code-mode').setAttribute('aria-pressed', String(codeMode));
    $('code-fields').hidden = !codeMode;
    input.classList.toggle('code-mode', codeMode);
    input.placeholder = codeMode ? 'Wklej lub wpisz kod…' : 'Napisz wiadomość…';
    input.spellcheck = !codeMode;
    focus?.focus();
  }
  $('code-mode').addEventListener('click', () => setMode(mode === 'code' ? 'text' : 'code'));
  $('add-code').addEventListener('click', () => {
    location.hash = '#rozmowa';
    showScreen();
    setMode('code', $('snippet-title'));
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
    if (mode === 'code' && event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && (event.metaKey || event.altKey)) {
      event.preventDefault();
      input.setRangeText('    ', input.selectionStart, input.selectionEnd, 'end');
    }
  });
  formAction(form, async () => {
    const sent = input.value;
    const title = $('snippet-title').value;
    const kind = mode;
    await request(base + 'messages', { method: 'POST',
      data: { kind, body: sent, title, lang: kind === 'code' ? $('language').value : '' } });
    if (input.value === sent) {
      input.value = '';
      if (kind === 'code' && mode === 'code') setMode('text', null);
    }
    if ($('snippet-title').value === title) $('snippet-title').value = '';
    if (!chat.hidden) input.focus();
    scrollToLatest();
    refreshSoon();
  });
  $('show-people').addEventListener('click', () => {
    peopleModal = present('Uczestnicy');
    renderPeople();
    peopleModal.el.addEventListener('close', () => { peopleModal = null; }, { once: true });
  });
  $('share-room').addEventListener('click', () => copyText(fullLink(code), 'Skopiowano link do pokoju.'));
  $('leave-room').addEventListener('click', () => run($('leave-room'), async () => {
    await request(base + 'leave', { method: 'POST' });
    alive = false;
    clearTimeout(timer);
    location.assign('/');
  }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSoon(); });
  window.addEventListener('hashchange', showScreen);
  state(initial);
  connected(true);
  assets.render();
  showScreen();
  refreshSoon();
}

let adminTimer;

function roomCard(room) {
  const item = element('article', '', 'admin-room');
  const code = element('span', formatCode(room.code), 'mono room-id');
  const title = element('h3', room.title);
  const detail = element('p', '', 'muted');
  detail.append(code, ' · Osób online: ' + room.online + ' · Retencja: ' + room.hours + ' godz.');
  if (!room.online) detail.append(' · Wygaśnie: ' + dateTime(room.expires));
  const actions = element('div', '', 'small-actions');
  actions.append(
    link('Otwórz', roomLink(room.code)),
    button('Kopiuj link', () => copyText(fullLink(room.code), 'Skopiowano link do pokoju.')),
    button('Zmień retencję', () => changeRetention(room)),
    button('Zamknij', async () => {
      const confirmed = await choose('Zamknij pokój ' + formatCode(room.code) + '?',
        'Zamknięcie od razu usuwa wiadomości, kod, pliki, foldery i wszystkie ich wersje.',
        [['close', 'Zamknij i usuń dane', 'danger']]);
      if (!confirmed) return;
      await request(adminAPI + 'rooms/' + room.code, { method: 'DELETE' });
      await loadRooms();
      notify('Pokój zamknięty.');
    }, 'danger'),
  );
  item.append(title, detail, actions);
  return item;
}

function changeRetention(room) {
  const modal = present('Czas przechowywania pokoju');
  const form = element('form', '', 'dialog-form');
  const label = element('label', 'Godziny od opuszczenia pokoju');
  label.htmlFor = 'retention';
  const input = element('input');
  input.id = 'retention';
  input.type = 'number';
  input.min = '24';
  input.max = '8760';
  input.required = true;
  input.value = room.hours;
  const submit = element('button', 'Zapisz', 'primary');
  submit.type = 'submit';
  form.append(label, input, submit);
  modal.body.append(form);
  formAction(form, async () => {
    await request(adminAPI + 'rooms/' + room.code, { method: 'PATCH', data: { hours: input.valueAsNumber } });
    modal.el.close();
    await loadRooms();
    notify('Zapisano retencję.');
  }, modal.error);
}

let displayedRooms;

async function loadRooms() {
  const rooms = await request(adminAPI + 'rooms');
  const snapshot = JSON.stringify(rooms.map((room) => ({ ...room, expires: room.online ? 0 : room.expires })));
  if (snapshot === displayedRooms) return;
  displayedRooms = snapshot;
  $('room-count').textContent = rooms.length;
  const content = rooms.length ? rooms.map(roomCard) : [element('p', 'Brak aktywnych pokoi.', 'empty')];
  $('active-rooms').replaceChildren(...content);
}

async function adminScreen() {
  clearInterval(adminTimer);
  try {
    await loadRooms();
    view('admin-view');
    adminTimer = setInterval(() => loadRooms().catch((error) => {
      if (error.status === 401) {
        clearInterval(adminTimer);
        view('login-view');
        showError($('login-error'), error.message);
      }
    }), 5000);
  } catch (error) {
    view('login-view');
    if (error.status !== 401) showError($('login-error'), error.message);
  }
}

formAction($('login-form'), async () => {
  showError($('login-error'));
  await request(adminAPI + 'login', { method: 'POST', data: { password: $('password').value } });
  $('login-form').reset();
  await adminScreen();
}, (message) => showError($('login-error'), message));

$('admin-logout').addEventListener('click', () => run($('admin-logout'), async () => {
  await request(adminAPI + 'logout', { method: 'POST' });
  clearInterval(adminTimer);
  view('login-view');
}));

formAction($('create-form'), async () => {
  const data = { title: $('new-title').value, hours: $('new-hours').valueAsNumber };
  const room = await request(adminAPI + 'rooms', { method: 'POST', data });
  $('create-form').reset();
  await loadRooms();
  const modal = present('Pokój utworzony');
  const actions = element('div', '', 'small-actions');
  actions.append(button('Kopiuj link', () => copyText(fullLink(room.code), 'Skopiowano link do pokoju.')),
    link('Otwórz pokój', roomLink(room.code), 'button primary'));
  modal.body.append(element('p', 'Kod pokoju: ' + formatCode(room.code), 'mono room-id'), actions);
});

async function start() {
  if (location.pathname === '/admin') {
    await adminScreen();
    return;
  }
  const room = /^\/r\/([0-9]{6})$/.exec(location.pathname);
  if (!room) {
    showJoin();
    return;
  }
  const code = room[1];
  try {
    activateRoom(code, await request(roomAPI(code) + 'state'));
  } catch (error) {
    showJoin(code, error.status === 401 ? '' : error.message);
  }
}

void start();
