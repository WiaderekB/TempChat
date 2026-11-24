import { $, element, button, link, request, run, formAction, notify, showError, present, choose,
  copyText, dateTime, codeBlock } from './ui.js';
import { resources } from './files.js';

const viewIds = ['join-view', 'room-view', 'login-view', 'admin-view'];
const roomLink = (code) => '/r/' + code;
const fullLink = (code) => new URL(roomLink(code), location.origin).href;
const roomAPI = (code) => '/api/room/' + code + '/';
const adminAPI = '/api/admin/';

function view(id) {
  for (const panel of viewIds) $(panel).hidden = panel !== id;
  const admin = id === 'admin-view' || id === 'login-view';
  $('nav-link').href = admin ? '/' : '/admin';
  $('nav-link').textContent = admin ? 'Dołącz do pokoju' : 'Panel administratora';
}

function showJoin(code = '', message = '') {
  view('join-view');
  $('join-code').value = code;
  showError($('join-error'), message);
}

formAction($('join-form'), async () => {
  showError($('join-error'));
  const code = $('join-code').value;
  await request(roomAPI(code) + 'join', { method: 'POST', data: { nick: $('join-nick').value } });
  location.assign(roomLink(code));
}, (message) => showError($('join-error'), message));

function activateRoom(code, initial) {
  view('room-view');
  const base = roomAPI(code);
  const scroller = $('messages-scroll');
  const list = $('messages');
  const older = $('load-older');
  const input = $('message-text');
  const form = $('message-form');
  const assets = resources(base, refreshSoon);
  const pollDelay = 1800;
  let mode = 'text';
  let last = 0;
  let first = 0;
  let catalogAt = null;
  let timer;
  let alive = true;
  let polling = false;

  function state(data) {
    $('room-title').textContent = data.room.title;
    $('room-code').textContent = code;
    $('current-user').textContent = data.nick;
    $('people-count').textContent = data.people.length;
    const people = data.people.map((name) => {
      const row = element('li');
      const dot = element('span', '', 'status-dot');
      dot.setAttribute('aria-hidden', 'true');
      row.append(dot, document.createTextNode(name));
      return row;
    });
    $('people').replaceChildren(...people);
  }

  function connected(flag) {
    $('connection').classList.toggle('offline', !flag);
    $('connection-label').textContent = flag ? 'Połączono' : 'Ponawiam połączenie…';
  }

  function message(data) {
    const row = element('li', '', 'message');
    const meta = element('div', '', 'msg-meta');
    const time = element('time', new Intl.DateTimeFormat('pl-PL', { timeStyle: 'short' }).format(data.created * 1000));
    time.dateTime = new Date(data.created * 1000).toISOString();
    time.title = dateTime(data.created);
    meta.append(element('strong', data.author), time);
    row.append(meta);
    if (data.kind === 'code') {
      row.append(codeBlock(data.body, data.lang));
    } else if (data.kind === 'asset') {
      const icon = data.asset_kind === 'folder' ? '▱ ' : '▤ ';
      row.append(button(icon + data.name + ' · v' + data.num,
        () => assets.openAsset(data.asset, data.num, data.name), 'msg-asset'));
      if (data.body) row.append(element('p', data.body, 'msg-text muted'));
    } else {
      row.append(element('p', data.body, 'msg-text'));
    }
    return row;
  }

  async function updateChat() {
    const starting = !last;
    let batch;
    do {
      batch = await request(base + 'messages' + (last ? '?after=' + last : ''));
      if (!alive) return;
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 110;
      if (batch.length) {
        if (!first) {
          first = batch[0].id;
          older.hidden = batch.length < 80;
        }
        last = batch.at(-1).id;
        $('chat-empty').hidden = true;
        list.append(...batch.map(message));
        if (nearBottom || starting) scroller.scrollTop = scroller.scrollHeight;
      }
    } while (!starting && batch.length === 80);
  }

  older.addEventListener('click', () => run(older, async () => {
    const batch = await request(base + 'messages?before=' + first);
    const oldHeight = scroller.scrollHeight;
    if (batch.length) {
      first = batch[0].id;
      list.prepend(...batch.map(message));
      scroller.scrollTop += scroller.scrollHeight - oldHeight;
    }
    older.hidden = batch.length < 80;
  }));

  async function sync() {
    if (!alive || polling) return;
    polling = true;
    let nextDelay = pollDelay;
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

  function setMode(value) {
    mode = value;
    const codeMode = mode === 'code';
    $('code-mode').setAttribute('aria-pressed', String(codeMode));
    $('text-mode').setAttribute('aria-pressed', String(!codeMode));
    $('language').hidden = !codeMode;
    input.classList.toggle('code-mode', codeMode);
    input.placeholder = codeMode ? 'Wklej lub wpisz kod…' : 'Napisz wiadomość…';
    input.spellcheck = !codeMode;
    input.focus();
  }
  $('text-mode').addEventListener('click', () => setMode('text'));
  $('code-mode').addEventListener('click', () => setMode('code'));
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
    await request(base + 'messages', { method: 'POST',
      data: { kind: mode, body: sent, lang: mode === 'code' ? $('language').value : '' } });
    if (input.value === sent) input.value = '';
    input.focus();
    refreshSoon();
  });
  $('share-room').addEventListener('click', () => copyText(fullLink(code), 'Skopiowano link do pokoju.'));
  $('leave-room').addEventListener('click', () => run($('leave-room'), async () => {
    await request(base + 'leave', { method: 'POST' });
    alive = false;
    clearTimeout(timer);
    location.assign('/');
  }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSoon(); });
  state(initial);
  assets.render();
  refreshSoon();
}

let adminTimer;

function roomCard(room) {
  const item = element('article', '', 'admin-room');
  const code = element('span', room.code, 'mono room-id');
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
      const confirmed = await choose('Zamknij pokój ' + room.code + '?',
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
  modal.body.append(element('p', 'Kod pokoju: ' + room.code, 'mono room-id'), actions);
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
