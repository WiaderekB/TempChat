import { $, element, button, link, request, run, formAction, notify, showError, present, choose,
  copyText, dateTime, codeBlock, selectLanguage, snippetPicker, iconControl, formatBytes } from './ui.js';
import { resources, uploadPickers, assetCover, attachmentSize, limitAttachments, shareAttachments, readDrop } from './files.js';
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

function localDateValue(epoch) {
  const date = new Date(epoch * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return String(date.getFullYear()).padStart(4, '0') + '-' + pad(date.getMonth() + 1) + '-' +
    pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function closureDraft({ hours, close_at }) {
  return { mode: close_at == null ? 'idle' : 'scheduled', hours: String(hours),
    date: close_at == null ? '' : localDateValue(close_at) };
}

function sameClosure(left, right) {
  return left.mode === right.mode && left.hours === right.hours && left.date === right.date;
}

function closureFields(prefix) {
  const node = element('div', '', 'expiry-fields');
  const mode = element('select');
  for (const [value, text] of [['idle', 'After everyone leaves'], ['scheduled', 'At a specific date and time']]) {
    const option = element('option', text);
    option.value = value;
    mode.append(option);
  }
  const hours = element('input');
  hours.type = 'number';
  hours.min = '1';
  hours.max = '8760';
  hours.step = '1';
  hours.required = true;
  const date = element('input');
  date.type = 'datetime-local';
  date.required = true;
  const modeField = wrap('mode', 'Automatically close', mode);
  const idleField = wrap('hours', 'Hours after everyone leaves', hours, '1 to 8,760 hours.');
  const dateField = wrap('date', 'Closing date and time', date,
    'Time zone: ' + Intl.DateTimeFormat().resolvedOptions().timeZone);
  node.append(modeField, idleField, dateField);
  mode.addEventListener('change', reflectMode);
  fill({ hours: 24, close_at: null });

  function wrap(key, title, control, hint) {
    const group = element('div', '', 'expiry-field');
    const label = element('label', title);
    control.id = prefix + '-' + key;
    label.htmlFor = control.id;
    group.append(label, control);
    if (hint) {
      const help = element('p', hint, 'muted');
      help.id = control.id + '-hint';
      control.setAttribute('aria-describedby', help.id);
      group.append(help);
    }
    return group;
  }

  function reflectMode() {
    const fixed = mode.value === 'scheduled';
    hours.disabled = idleField.hidden = fixed;
    date.disabled = dateField.hidden = !fixed;
  }

  function fill(room) {
    const draft = closureDraft(room);
    mode.value = draft.mode;
    hours.value = draft.hours;
    date.value = draft.date;
    reflectMode();
  }

  function read(previous) {
    if (mode.value === 'scheduled') {
      if (previous?.close_at != null && date.value === localDateValue(previous.close_at)) return {};
      const epoch = new Date(date.value).getTime() / 1000;
      if (!Number.isFinite(epoch) || localDateValue(epoch) !== date.value) {
        throw new Error('Choose a valid date and time in your time zone.');
      }
      return { close_at: epoch };
    }
    if (previous?.close_at === null && hours.valueAsNumber === previous.hours) return {};
    return { hours: hours.valueAsNumber, close_at: null };
  }

  return { node, fill, read, draft: () => ({ mode: mode.value, hours: hours.value, date: date.value }) };
}

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
  if (location.pathname === roomLink(code)) location.reload();
  else location.assign(roomLink(code) + location.hash);
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
  const uploadProgress = $('chat-upload-progress');
  const searchButton = $('chat-search');
  const attachMenu = $('attach-menu');
  const attachToggle = $('attach-toggle');
  const pending = $('pending-attachments');
  const codeModeControl = $('code-mode');
  const snippetName = $('snippet-title');
  const language = $('language');
  const chat = $('chat-screen');
  const gallery = $('gallery-screen');
  const assetScreen = $('asset-screen');
  const management = $('manage-screen');
  const manageLink = $('manage-link');
  const settingsName = $('manage-name');
  const expiry = closureFields('manage');
  $('manage-expiry').append(expiry.node);
  const assets = resources(base, refreshSoon);
  let mode = 'text';
  let attachments = [];
  let picking = false;
  let sendingAttachments = false;
  let last = 0;
  let first = 0;
  let catalogAt = null;
  let timer;
  let alive = true;
  let polling = false;
  let savedScroll = 0;
  let followLatest = true;
  let currentScreen;
  let assetReturn = '#assets';
  let people = [];
  let peopleModal;
  let chatSearch;
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

  function openChatAsset(id, version) {
    chatSearch?.el.close();
    assets.openAsset(id, version);
  }

  function message(data, context = false) {
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
          () => openChatAsset(data.asset, data.num), 'snippet-heading');
        heading.title = 'Open full version';
      }
      bubble.append(codeBlock(data.body, data.lang, { heading }));
    } else if (data.kind === 'asset' || data.kind === 'share') {
      if (data.kind === 'share' && data.body.trim()) appendMessageText(bubble, data, context);
      const cards = element('div', '', 'chat-attachments');
      for (const item of data.attachments ?? [{ ...data, kind: data.asset_kind }]) {
        const card = button('', () => openChatAsset(item.asset, item.num), 'chat-attachment');
        card.append(assetCover(item.kind, item.name), attachmentLabel(item));
        cards.append(card);
      }
      bubble.append(cards);
      if (data.kind === 'asset' && data.body) bubble.append(element('p', data.body, 'msg-text muted attachment-note'));
    } else {
      appendMessageText(bubble, data, context);
    }
    content.append(meta, bubble);
    row.append(content);
    return row;
  }

  function appendMessageText(bubble, data, context) {
    const text = element('div', '', 'msg-text markdown-message');
    const excerpt = data.body.split('\n').slice(0, 12).join('\n').slice(0, 900).trimEnd();
    const shortened = excerpt.length < data.body.trimEnd().length;
    const preview = markdownHtml(shortened ? excerpt : data.body);
    text.innerHTML = preview;
    bubble.append(text);
    if (shortened) {
      text.id = (context ? 'context-message-' : 'message-') + data.id;
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

  function attachmentLabel({ name, kind, size, num }) {
    const label = element('span', '', 'attachment-label');
    const metadata = [kind === 'folder' ? 'Folder' : 'File',
      typeof size === 'number' ? formatBytes(size) : '', num ? 'v' + num : ''].filter(Boolean);
    label.append(element('strong', name), element('span', metadata.join(' · '), 'attachment-meta'));
    return label;
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
      row.id = 'chat-line-' + item.id;
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

  iconControl(searchButton, 'search', 'Search chat');
  searchButton.title = 'Search chat (/)';
  searchButton.addEventListener('click', openChatSearch);

  function openChatSearch() {
    if (chatSearch) return;
    const modal = present('Search chat');
    chatSearch = modal;
    modal.el.addEventListener('close', () => { chatSearch = undefined; }, { once: true });
    const form = element('form', '', 'chat-search-form');
    const query = element('input');
    query.type = 'search';
    query.required = true;
    query.maxLength = 160;
    query.placeholder = 'Messages, names, or files…';
    query.setAttribute('aria-label', 'Search term');
    const submit = element('button', 'Search', 'primary');
    submit.type = 'submit';
    form.append(query, submit);
    const resultPanel = element('div', '', 'chat-search-panel');
    const results = element('ul', '', 'chat-search-results');
    const status = element('p', '', 'muted');
    status.setAttribute('role', 'status');
    let next;
    let term;
    let searchGeneration = 0;
    const more = button('More results', () => load(next), 'quiet');
    more.hidden = true;
    resultPanel.append(status, results, more);
    const context = element('div', '', 'chat-context');
    context.hidden = true;
    modal.body.append(form, resultPanel, context);
    query.focus();
    formAction(form, async () => {
      modal.error('');
      term = query.value.trim();
      if (!term) return;
      await load();
    }, modal.error);

    async function load(before) {
      const ticket = before ? searchGeneration : ++searchGeneration;
      if (!before) {
        results.replaceChildren();
        status.textContent = 'Searching…';
        more.hidden = true;
      }
      const params = new URLSearchParams({ q: term });
      if (before) params.set('before', before);
      let page;
      try {
        page = await request(base + 'message-search?' + params);
      } catch (error) {
        if (ticket !== searchGeneration || chatSearch !== modal) return;
        if (!before) status.textContent = '';
        throw error;
      }
      if (chatSearch !== modal || ticket !== searchGeneration) return;
      for (const hit of page.items) {
        const result = element('li');
        const open = button('', () => showResult(hit.id), 'chat-search-hit');
        const meta = element('span', '', 'chat-search-hit-meta');
        meta.append(element('strong', hit.author), element('span', dateTime(hit.created)));
        open.append(meta);
        if (hit.excerpt) open.append(element('span', hit.excerpt, 'chat-search-excerpt'));
        if (hit.files) open.append(element('span', hit.files, 'attachment-meta'));
        result.append(open);
        results.append(result);
      }
      next = page.next;
      more.hidden = next === null;
      status.textContent = results.children.length
        ? results.children.length + (next === null ? ' results' : ' results loaded') : 'No messages found.';
    }

    async function showResult(id) {
      const row = $('chat-line-' + id);
      if (row) {
        modal.el.close();
        row.tabIndex = -1;
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'center' });
        return;
      }
      const ticket = ++searchGeneration;
      const batch = await request(base + 'messages?around=' + id);
      if (chatSearch !== modal || ticket !== searchGeneration) return;
      const back = button('Back to results', () => {
        context.hidden = true;
        form.hidden = resultPanel.hidden = false;
        query.focus();
      }, 'quiet');
      const messages = element('ol', '', 'chat-context-messages');
      for (const data of batch) {
        const row = message(data, true);
        if (data.id === id) row.classList.add('context-match');
        messages.append(row);
      }
      context.replaceChildren(back, messages);
      form.hidden = resultPanel.hidden = true;
      context.hidden = false;
      back.focus();
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
    const showAsset = assets.navigate(location.hash);
    const showGallery = showAsset || location.hash === '#assets' || location.hash === '#zasoby';
    const activeLink = location.hash === '#manage' && !manageLink.hidden ? 'manage-link'
      : showGallery ? 'gallery-link' : 'chat-link';
    if (showAsset && currentScreen !== 'asset') assetReturn = currentScreen === 'chat-link' ? '#chat' : '#assets';
    currentScreen = showAsset ? 'asset' : activeLink;
    const showChat = activeLink === 'chat-link';
    if (!showChat && !chat.hidden) {
      savedScroll = scroller.scrollTop;
      followLatest = nearBottom();
    }
    const restorePosition = showChat && chat.hidden;
    chat.hidden = !showChat;
    searchButton.hidden = !showChat;
    gallery.hidden = activeLink !== 'gallery-link' || showAsset;
    assetScreen.hidden = !showAsset;
    $('asset-toolbar').hidden = !showAsset;
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
    if (!roomSettings || settingsName.value === roomSettings.title || settingsName.value === submitted.title) {
      settingsName.value = room.title;
    }
    const current = expiry.draft();
    if (!roomSettings || sameClosure(current, closureDraft(roomSettings)) ||
        (submitted.closure && sameClosure(current, submitted.closure))) expiry.fill(room);
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
    const draft = { title: settingsName.value, closure: expiry.draft() };
    const data = expiry.read(roomSettings);
    if (draft.title.trim() !== roomSettings.title) data.title = draft.title;
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
    let nextDelay = document.hidden ? 15000 : 1800;
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
        nextDelay = document.hidden ? 15000 : 4500;
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
    const label = mode === 'code' && picker.selected ? 'Save' : 'Send';
    submitMessage.textContent = label;
    submitMessage.title = label + ' (Ctrl or Command + Enter)';
  }

  function setMode(value, focus = input) {
    mode = value;
    const codeMode = mode === 'code';
    $('code-mode').setAttribute('aria-pressed', String(codeMode));
    $('code-fields').hidden = !codeMode;
    attachMenu.hidden = codeMode;
    input.classList.toggle('code-mode', codeMode);
    updateDraft();
    input.spellcheck = !codeMode;
    if (!codeMode) picker.close();
    updateSubmitLabel();
    focus?.focus();
  }
  iconControl(codeModeControl, 'code', 'Code mode');
  iconControl(attachToggle, 'attach', 'Attach files or folder');
  attachToggle.addEventListener('click', (event) => {
    if (picking || sendingAttachments) event.preventDefault();
  });
  iconControl($('attach-files'), 'file', 'Files', true);
  iconControl($('attach-folder'), 'folder', 'Folder', true);
  codeModeControl.addEventListener('click', () => setMode(mode === 'code' ? 'text' : 'code'));
  const uploads = uploadPickers($('chat-file-input'), $('chat-folder-input'), acceptAttachments);
  async function acceptAttachments(read) {
    if (picking || sendingAttachments || mode === 'code') return;
    picking = true;
    updateDraft();
    try {
      const selected = await read();
      attachments = limitAttachments([...attachments, ...selected]);
      if (selected.length) input.focus();
    } catch (error) {
      if (error.name !== 'AbortError') notify(error.message, true);
    } finally {
      picking = false;
      updateDraft();
    }
  }

  chat.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const canAttach = mode === 'text' && !picking && !sendingAttachments;
    event.dataTransfer.dropEffect = canAttach ? 'copy' : 'none';
    chat.classList.toggle('attaching-drop', canAttach);
  });
  chat.addEventListener('dragleave', (event) => {
    if (!chat.contains(event.relatedTarget)) chat.classList.remove('attaching-drop');
  });
  chat.addEventListener('drop', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    chat.classList.remove('attaching-drop');
    if (mode === 'code') {
      notify('Exit code mode to attach files.', true);
      return;
    }
    attachMenu.open = false;
    void acceptAttachments(() => readDrop(event.dataTransfer));
  });
  for (const [id, open] of [['attach-files', uploads.files], ['attach-folder', uploads.folder]]) {
    $(id).addEventListener('click', () => {
      attachMenu.open = false;
      open();
    });
  }
  document.addEventListener('pointerdown', (event) => {
    if (attachMenu.open && !attachMenu.contains(event.target)) attachMenu.open = false;
  });
  attachMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && attachMenu.open) {
      event.stopPropagation();
      attachMenu.open = false;
      attachToggle.focus();
    }
  });

  function updateDraft() {
    input.required = !attachments.length;
    input.placeholder = mode === 'code' ? 'Paste or type code…'
      : attachments.length ? 'Add a message…' : 'Write a message…';
    codeModeControl.disabled = Boolean(attachments.length) || picking;
    attachToggle.setAttribute('aria-disabled', String(picking || sendingAttachments));
    pending.hidden = !attachments.length;
    pending.replaceChildren(...attachments.map((packet) => {
      const tile = element('li', '', 'pending-attachment');
      const remove = iconControl(button('', () => {
        attachments = attachments.filter((item) => item !== packet);
        updateDraft();
        input.focus();
      }, 'quiet'), 'close', 'Remove ' + packet.name);
      remove.disabled = sendingAttachments;
      tile.append(assetCover(packet.kind, packet.name),
        attachmentLabel({ ...packet, size: attachmentSize(packet) }), remove);
      return tile;
    }));
  }
  $('add-code').addEventListener('click', () => {
    location.hash = '#chat';
    showScreen();
    if (attachments.length || picking) {
      notify('Send or remove the attachments before switching to code.', true);
      return;
    }
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
    if (picking) throw new Error('Wait for the folder to finish loading.');
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
    if (attachments.length) {
      sendingAttachments = true;
      updateDraft();
      uploadProgress.value = 0;
      uploadProgress.hidden = false;
      try {
        await shareAttachments(base, sent, attachments, (percent) => { uploadProgress.value = percent; });
        attachments = [];
      } finally {
        uploadProgress.hidden = true;
        sendingAttachments = false;
        updateDraft();
      }
    } else {
      await request(base + 'messages', { method: 'POST', data });
    }
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
  window.addEventListener('keydown', (event) => {
    if (!alive || event.defaultPrevented || event.isComposing || $('dialog').open) return;
    if (!assetScreen.hidden && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        event.key.toLowerCase() === 's' && assets.saveEdit()) {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.key === 'Escape' && !assetScreen.hidden) {
      event.preventDefault();
      if (!assets.finishEditing()) location.hash = assetReturn;
      return;
    }
    if (event.key === '/' && !event.target.closest?.('input, textarea, select, [contenteditable]')) {
      if (!assetScreen.hidden && assets.focusSearch()) event.preventDefault();
      else if (!gallery.hidden) {
        event.preventDefault();
        $('asset-search').focus();
      } else if (!chat.hidden) {
        event.preventDefault();
        openChatSearch();
      }
    }
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
  detail.append(code, ' · Online: ' + room.online);
  if (room.close_at != null) detail.append(' · Closes: ' + dateTime(room.close_at));
  else {
    detail.append(' · Retention: ' + room.hours + ' hours');
    if (!room.online) detail.append(' · Expires: ' + dateTime(room.expires));
  }
  const actions = element('div', '', 'small-actions');
  actions.append(
    link('Open', roomLink(room.code)),
    button('Copy link', () => copyText(fullLink(room.code), 'Room link copied.')),
    button('Edit auto-close', () => changeClosure(room)),
    button('Close', async () => {
      if (!await closeRoom(room.code)) return;
      await loadRooms();
      notify('Room closed.');
    }, 'danger'),
  );
  item.append(title, detail, actions);
  return item;
}

function changeClosure(room) {
  const modal = present('Room auto-close');
  const form = element('form', '', 'dialog-form');
  const expiry = closureFields('retention');
  expiry.fill(room);
  const submit = element('button', 'Save', 'primary');
  submit.type = 'submit';
  form.append(expiry.node, submit);
  modal.body.append(form);
  formAction(form, async () => {
    const data = expiry.read(room);
    if (Object.keys(data).length) await request(adminRoomAPI(room.code), { method: 'PATCH', data });
    modal.el.close();
    await loadRooms();
    notify('Auto-close settings saved.');
  }, modal.error);
}

let displayedRooms;

async function loadRooms() {
  const rooms = await request(adminAPI + 'rooms');
  const snapshot = JSON.stringify(rooms.map((room) => ({ ...room, expires: room.online && room.close_at == null ? 0 : room.expires })));
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

const newExpiry = closureFields('new');
$('new-expiry').append(newExpiry.node);
formAction($('create-form'), async () => {
  const data = { title: $('new-title').value, ...newExpiry.read() };
  const room = await request(adminAPI + 'rooms', { method: 'POST', data });
  $('create-form').reset();
  newExpiry.fill({ hours: 24, close_at: null });
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
