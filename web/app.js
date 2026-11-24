import { $, element, button, link, request, run, formAction, notify, showError, present, choose,
  copyText, dateTime, codeBlock, selectLanguage, snippetPicker } from './ui.js';
import { resources } from './files.js';
import { markdownHtml } from './markdown.mjs';

const viewIds = ['join-view', 'room-view', 'login-view', 'admin-view'];
const roomLink = (code) => '/r/' + code;
const fullLink = (code) => new URL(roomLink(code), location.origin).href;
const roomAPI = (code) => '/api/room/' + code + '/';
const adminAPI = '/api/admin/';
const adminRoomAPI = (code) => adminAPI + 'rooms/' + code;
const digits = (value) => value.replace(/[^0-9]/g, '').slice(0, 6);
const formatCode = (value) => value.length > 3 ? value.slice(0, 3) + ' - ' + value.slice(3) : value;
const shortTime = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' });
const shortDay = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' });

function view(id) {
  for (const panel of viewIds) $(panel).hidden = panel !== id;
  const admin = id === 'admin-view' || id === 'login-view';
  $('nav-link').href = admin ? '/' : '/admin';
  $('nav-link').textContent = admin ? 'Join room' : 'Admin panel';
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
  const submitMessage = form.querySelector('button[type=submit]');
  const snippetName = $('snippet-title');
  const language = $('language');
  const chat = $('chat-screen');
  const gallery = $('gallery-screen');
  const management = $('manage-screen');
  const manageLink = $('manage-link');
  const settingsFields = { title: $('manage-name'), hours: $('manage-hours') };
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
  let roomSettings;
  let checkingManagement = false;
  let nextManagementCheck = 0;
  let newSnippetLanguage = '';
  const picker = snippetPicker(snippetName, $('snippet-suggestions'), (selected, previous) => {
    if (!previous) newSnippetLanguage = language.value;
    selectLanguage(language, selected ? selected.lang : newSnippetLanguage);
    updateSubmitLabel();
  });

  function setRoomTitle(name) {
    const title = $('room-title');
    title.textContent = name;
    title.title = name;
  }

  function state(data) {
    setRoomTitle(data.room.title);
    $('room-code').textContent = formatCode(code);
    $('people-count').textContent = data.people.length;
    $('show-people').setAttribute('aria-label', 'Participants: ' + data.people.length);
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
    const label = flag ? 'Connected' : 'Reconnecting…';
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
    meta.append(element('strong', data.mine ? 'You' : data.author), time);
    if (!data.mine) {
      const avatar = element('span', Array.from(data.author)[0]?.toUpperCase(), 'avatar');
      avatar.setAttribute('aria-hidden', 'true');
      row.append(avatar);
    }
    if (data.kind === 'code') {
      let heading;
      if (data.asset) {
        heading = button(data.name + ' · v' + data.num,
          () => assets.openAsset(data.asset, data.num, data.name), 'snippet-heading');
        heading.title = 'Open full version';
      }
      bubble.append(codeBlock(data.body, data.lang, { heading }));
    } else if (data.kind === 'asset') {
      const icon = data.asset_kind === 'folder' ? '▱ ' : '▤ ';
      bubble.append(button(icon + data.name + ' · v' + data.num,
        () => assets.openAsset(data.asset, data.num, data.name), 'msg-asset'));
      if (data.body) bubble.append(element('p', data.body, 'msg-text muted attachment-note'));
    } else {
      const text = element('div', '', 'msg-text markdown-message');
      const excerpt = data.body.split('\n').slice(0, 12).join('\n').slice(0, 900).trimEnd();
      const shortened = excerpt.length < data.body.trimEnd().length;
      const preview = markdownHtml(shortened ? excerpt : data.body);
      text.innerHTML = preview;
      bubble.append(text);
      if (shortened) {
        text.id = 'message-' + data.id;
        const toggle = button('Show full message', () => {
          const expand = toggle.getAttribute('aria-expanded') === 'false';
          toggle.setAttribute('aria-expanded', String(expand));
          toggle.textContent = expand ? 'Show less' : 'Show full message';
          text.innerHTML = expand ? markdownHtml(data.body) : preview;
        }, 'message-summary');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', text.id);
        bubble.append(toggle);
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
    const showGallery = location.hash === '#assets' || location.hash === '#zasoby';
    const activeLink = location.hash === '#manage' && !manageLink.hidden ? 'manage-link'
      : showGallery ? 'gallery-link' : 'chat-link';
    const showChat = activeLink === 'chat-link';
    if (!showChat && !chat.hidden) {
      savedScroll = scroller.scrollTop;
      followLatest = nearBottom();
    }
    const restorePosition = showChat && chat.hidden;
    chat.hidden = !showChat;
    gallery.hidden = activeLink !== 'gallery-link';
    management.hidden = activeLink !== 'manage-link';
    for (const id of ['chat-link', 'gallery-link', 'manage-link']) {
      if (id === activeLink) $(id).setAttribute('aria-current', 'page');
      else $(id).removeAttribute('aria-current');
    }
    if (restorePosition) {
      if (followLatest) scrollToLatest();
      else scroller.scrollTop = savedScroll;
    }
  }

  function showManagementLink(allowed) {
    if (!allowed) roomSettings = undefined;
    if (manageLink.hidden === !allowed) return;
    manageLink.hidden = !allowed;
    showScreen();
  }

  function applyRoomSettings(room, submitted = {}) {
    for (const [key, field] of Object.entries(settingsFields)) {
      if (!roomSettings || field.value === String(roomSettings[key]) || field.value === submitted[key]) {
        field.value = room[key];
      }
    }
    roomSettings = room;
  }

  async function checkManagement() {
    if (!alive || checkingManagement) return;
    checkingManagement = true;
    nextManagementCheck = Date.now() + 30000;
    const previous = roomSettings;
    try {
      const room = await request(adminRoomAPI(code));
      if (!alive) return;
      if (roomSettings === previous) applyRoomSettings(room);
      showManagementLink(true);
    } catch (error) {
      if (alive && (error.status === 401 || error.status === 404)) showManagementLink(false);
    } finally {
      checkingManagement = false;
    }
  }

  function managementError(error) {
    if (error.status !== 401) throw error;
    showManagementLink(false);
    notify(error.message, true);
  }

  formAction($('room-settings-form'), async () => {
    showError($('manage-error'));
    const draft = { title: settingsFields.title.value, hours: settingsFields.hours.value };
    const data = {};
    if (draft.title.trim() !== roomSettings.title) data.title = draft.title;
    if (settingsFields.hours.valueAsNumber !== roomSettings.hours) data.hours = settingsFields.hours.valueAsNumber;
    if (!Object.keys(data).length) return notify('No changes to save.');
    try {
      const { room } = await request(adminRoomAPI(code), { method: 'PATCH', data });
      applyRoomSettings(room, draft);
      setRoomTitle(room.title);
      notify('Room settings saved.');
    } catch (error) {
      managementError(error);
    }
  }, (message) => showError($('manage-error'), message));

  const close = $('manage-close');
  close.addEventListener('click', () => run(close, async () => {
    try {
      if (!await closeRoom(code)) return;
      alive = false;
      clearTimeout(timer);
      location.assign('/admin');
    } catch (error) {
      managementError(error);
    }
  }));

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
    if (!document.hidden && Date.now() >= nextManagementCheck) void checkManagement();
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
        picker.update(catalog.codes);
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

  function updateSubmitLabel() {
    const label = mode === 'code' && picker.selected ? 'Save version' : 'Send';
    submitMessage.textContent = label;
    submitMessage.title = label + ' (Ctrl or Command + Enter)';
  }

  function setMode(value, focus = input) {
    mode = value;
    const codeMode = mode === 'code';
    $('code-mode').setAttribute('aria-pressed', String(codeMode));
    $('code-fields').hidden = !codeMode;
    input.classList.toggle('code-mode', codeMode);
    input.placeholder = codeMode ? 'Paste or type code…' : 'Write a message…';
    input.spellcheck = !codeMode;
    if (!codeMode) picker.close();
    updateSubmitLabel();
    focus?.focus();
  }
  $('code-mode').addEventListener('click', () => setMode(mode === 'code' ? 'text' : 'code'));
  $('add-code').addEventListener('click', () => {
    location.hash = '#chat';
    showScreen();
    picker.reset();
    setMode('code', snippetName);
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
    const title = snippetName.value;
    const target = picker.selected;
    const kind = mode;
    const data = { kind, body: sent };
    if (kind === 'code') {
      data.lang = language.value;
      if (target) data.asset = target.id;
      else data.title = title;
    }
    await request(base + 'messages', { method: 'POST', data });
    if (input.value === sent) {
      input.value = '';
      if (kind === 'code' && picker.selected === target && snippetName.value === title) {
        picker.reset();
        if (mode === 'code') setMode('text', null);
      }
    }
    if (!chat.hidden) input.focus();
    scrollToLatest();
    refreshSoon();
  });
  $('show-people').addEventListener('click', () => {
    peopleModal = present('Participants');
    renderPeople();
    peopleModal.el.addEventListener('close', () => { peopleModal = null; }, { once: true });
  });
  $('share-room').addEventListener('click', () => copyText(fullLink(code), 'Room link copied.'));
  $('leave-room').addEventListener('click', () => run($('leave-room'), async () => {
    await request(base + 'leave', { method: 'POST' });
    alive = false;
    clearTimeout(timer);
    location.assign('/');
  }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void checkManagement();
      refreshSoon();
    }
  });
  window.addEventListener('hashchange', () => {
    showScreen();
    if (location.hash === '#manage') void checkManagement();
  });
  state(initial);
  connected(true);
  assets.render();
  showScreen();
  void checkManagement();
  refreshSoon();
}

async function closeRoom(code) {
  const confirmed = await choose('Close room ' + formatCode(code) + '?',
    'Closing the room immediately deletes its messages, code, files, folders, and version history.',
    [['close', 'Close and delete data', 'danger']]);
  if (!confirmed) return false;
  await request(adminRoomAPI(code), { method: 'DELETE' });
  return true;
}

let adminTimer;

function roomCard(room) {
  const item = element('article', '', 'admin-room');
  const code = element('span', formatCode(room.code), 'mono room-id');
  const title = element('h3', room.title);
  const detail = element('p', '', 'muted');
  detail.append(code, ' · Online: ' + room.online + ' · Retention: ' + room.hours + ' hours');
  if (!room.online) detail.append(' · Expires: ' + dateTime(room.expires));
  const actions = element('div', '', 'small-actions');
  actions.append(
    link('Open', roomLink(room.code)),
    button('Copy link', () => copyText(fullLink(room.code), 'Room link copied.')),
    button('Edit retention', () => changeRetention(room)),
    button('Close', async () => {
      if (!await closeRoom(room.code)) return;
      await loadRooms();
      notify('Room closed.');
    }, 'danger'),
  );
  item.append(title, detail, actions);
  return item;
}

function changeRetention(room) {
  const modal = present('Room retention');
  const form = element('form', '', 'dialog-form');
  const label = element('label', 'Hours after everyone leaves');
  label.htmlFor = 'retention';
  const input = element('input');
  input.id = 'retention';
  input.type = 'number';
  input.min = '24';
  input.max = '8760';
  input.required = true;
  input.value = room.hours;
  const submit = element('button', 'Save', 'primary');
  submit.type = 'submit';
  form.append(label, input, submit);
  modal.body.append(form);
  formAction(form, async () => {
    await request(adminRoomAPI(room.code), { method: 'PATCH', data: { hours: input.valueAsNumber } });
    modal.el.close();
    await loadRooms();
    notify('Retention updated.');
  }, modal.error);
}

let displayedRooms;

async function loadRooms() {
  const rooms = await request(adminAPI + 'rooms');
  const snapshot = JSON.stringify(rooms.map((room) => ({ ...room, expires: room.online ? 0 : room.expires })));
  if (snapshot === displayedRooms) return;
  displayedRooms = snapshot;
  $('room-count').textContent = rooms.length;
  const content = rooms.length ? rooms.map(roomCard) : [element('p', 'No active rooms.', 'empty')];
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
  const modal = present('Room created');
  const actions = element('div', '', 'small-actions');
  actions.append(button('Copy link', () => copyText(fullLink(room.code), 'Room link copied.')),
    link('Open room', roomLink(room.code), 'button primary'));
  modal.body.append(element('p', 'Room code: ' + formatCode(room.code), 'mono room-id'), actions);
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
