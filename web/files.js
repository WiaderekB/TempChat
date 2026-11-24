import { $, element, link, request, choose, notify, languageLabel, formatBytes, assetIcons, run } from './ui.js';
import { assetBrowser, assetHash } from './asset-view.js';

const MAX_ENTRIES = 10000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_HEADER = 4 * 1024 * 1024;
const GALLERY_PAGE = 60;
const kindLabels = { folder: 'Folder', file: 'File', code: 'Code' };

function filePackets(files) {
  return Array.from(files, (file) => ({ name: file.name, kind: 'file', entries: [{ path: file.name, file }] }));
}

function folderPacket(files) {
  const selection = Array.from(files);
  if (!selection.length) return [];
  const name = selection[0].webkitRelativePath.split('/')[0];
  const entries = selection.map((file) => ({ path: file.webkitRelativePath.slice(name.length + 1), file }));
  return [{ name, kind: 'folder', entries }];
}

async function collectFolder(directory, entries, ancestors = '') {
  for await (const handle of directory.values()) {
    const path = ancestors + handle.name;
    if (entries.length >= MAX_ENTRIES) throw new Error('A folder can contain up to 10,000 items.');
    if (handle.kind === 'directory') {
      entries.push({ path, file: null });
      await collectFolder(handle, entries, path + '/');
    } else {
      entries.push({ path, file: await handle.getFile() });
    }
  }
}

async function collectDropped(entry, entries, path) {
  if (path && entries.length >= MAX_ENTRIES) throw new Error('A folder can contain up to 10,000 items.');
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    entries.push({ path, file });
  } else if (entry.isDirectory) {
    if (path) entries.push({ path, file: null });
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await collectDropped(child, entries, path ? path + '/' + child.name : child.name);
    } while (batch.length);
  }
}

function readDrop(transfer) {
  const entries = Array.from(transfer.items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  const files = Array.from(transfer.files);
  if (!entries.length) return Promise.resolve(filePackets(files));
  return Promise.all(entries.map(async (entry) => {
    const contents = [];
    await collectDropped(entry, contents, entry.isDirectory ? '' : entry.name);
    return { name: entry.name, kind: entry.isDirectory ? 'folder' : 'file', entries: contents };
  }));
}

function packetBody(packet, mode, note) {
  const files = packet.entries.map(({ file }) => file).filter(Boolean);
  if (packet.entries.length > MAX_ENTRIES || files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) {
    throw new Error('The upload limit is 64 MiB and 10,000 items.');
  }
  const info = {
    name: packet.name, kind: packet.kind, mode, note,
    entries: packet.entries.map(({ path, file }) => ({ path, size: file?.size ?? null })),
  };
  const header = new TextEncoder().encode(JSON.stringify(info));
  if (header.length > MAX_HEADER) throw new Error('The list of paths is too long.');
  const prefix = new ArrayBuffer(4);
  new DataView(prefix).setUint32(0, header.length);
  return new Blob([prefix, header, ...files], { type: 'application/octet-stream' });
}

export function resources(base, afterUpload) {
  const viewer = assetBrowser(base, afterUpload, (prefix, name, entries) => request(prefix + '/files', {
    method: 'POST', data: packetBody({ name, kind: 'folder', entries }),
  }));
  const search = $('asset-search');
  const list = $('resources');
  const empty = $('assets-empty');
  const more = $('asset-more');
  let catalog = { files: [], codes: [] };
  let tab = 'all';
  let busy = false;
  let rendered;
  let searchTimer;
  let generation = 0;
  let nextPage;

  function setNext(action) {
    nextPage = action;
    more.hidden = !action;
  }

  function showEmpty(text) {
    empty.textContent = text;
    empty.hidden = !text;
  }

  function render(value = catalog) {
    catalog = value;
    const query = search.value.trim();
    const signature = JSON.stringify([tab, query, value]);
    if (signature === rendered) return;
    rendered = signature;
    const ticket = ++generation;
    clearTimeout(searchTimer);
    list.replaceChildren();
    setNext();
    const count = catalog.files.length + catalog.codes.length;
    $('asset-count').textContent = count;
    $('asset-count').hidden = !count;
    $('all-tab').setAttribute('aria-pressed', String(tab === 'all'));
    $('files-tab').setAttribute('aria-pressed', String(tab === 'files'));
    $('snippets-tab').setAttribute('aria-pressed', String(tab === 'codes'));
    if (query) {
      showEmpty('Searching…');
      searchTimer = setTimeout(() => void searchPage(query, tab, 0, ticket), 180);
      return;
    }
    const source = tab === 'all' ? [...catalog.files, ...catalog.codes].sort((a, b) => b.created - a.created || b.id - a.id) : catalog[tab];
    showEmpty(source.length ? '' : {
      all: 'No assets yet. Drop files or folders here, or add a code snippet.',
      files: 'No files or folders yet.',
      codes: 'No code snippets yet.',
    }[tab]);
    showPage(0);

    function showPage(offset) {
      appendCards(source.slice(offset, offset + GALLERY_PAGE));
      const next = offset + GALLERY_PAGE;
      setNext(next < source.length ? () => showPage(next) : undefined);
    }
  }

  async function searchPage(query, category, offset, ticket) {
    try {
      const params = new URLSearchParams({ q: query, category, offset });
      const result = await request(base + 'search?' + params);
      if (ticket !== generation) return;
      showEmpty(list.childElementCount || result.items.length ? '' : 'No files or assets match your search.');
      appendCards(result.items);
      setNext(result.next === null ? undefined : () => searchPage(query, category, result.next, ticket));
    } catch (error) {
      if (ticket === generation) {
        showEmpty(error.message);
        setNext(() => searchPage(query, category, offset, ticket));
      }
    }
  }

  function appendCards(items) {
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = element('li');
      const card = link('', assetHash({ id: item.id, version: item.num, path: item.path }), 'gallery-card');
      card.setAttribute('aria-label', (item.path ? item.name + '/' + item.path : item.name) + ' · v' + item.num);
      const content = element('span', '', 'gallery-card-body');
      const top = element('span', '', 'gallery-card-top');
      const icon = element('span', assetIcons[item.entry_kind ?? item.kind], 'gallery-icon');
      icon.setAttribute('aria-hidden', 'true');
      const name = item.path ? item.path.split('/').at(-1) : item.name;
      top.append(element('span', name, 'gallery-card-title'), element('span', 'v' + item.num, 'pill'));
      const type = item.kind === 'code' ? languageLabel(item.lang) : formatBytes(item.size);
      const location = item.path ? item.name + '/' + item.path : [kindLabels[item.kind], type, item.author].join(' · ');
      content.append(top, element('span', location, 'gallery-card-meta'));
      card.append(icon, content);
      row.append(card);
      fragment.append(row);
    }
    list.append(fragment);
  }

  async function save(packet) {
    const url = base + 'assets';
    try {
      return await request(url, { method: 'POST', data: packetBody(packet) });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    const current = await request(base + 'catalog');
    const existing = current.files.find((item) => item.name === packet.name.normalize('NFC'));
    const options = [['copy', 'Save a copy', '']];
    const description = element('div', '', 'dialog-form');
    const notes = element('input');
    notes.id = 'revision-note';
    notes.maxLength = 200;
    if (existing?.kind === packet.kind) {
      options.unshift(['version', 'Add new version', 'primary']);
      const label = element('label', 'Version note (optional)');
      label.htmlFor = notes.id;
      description.append(label, notes);
    }
    const mode = await choose('An asset already uses this name', packet.name, options, description);
    if (mode) return request(url, { method: 'POST', data: packetBody(packet, mode, notes.value) });
    return null;
  }

  async function queue(getPackets) {
    if (busy) return;
    busy = true;
    const controls = [$('pick-file'), $('pick-folder')];
    controls.forEach((control) => { control.disabled = true; });
    let uploaded = 0;
    const errors = [];
    try {
      for (const packet of await getPackets()) {
        try {
          if (await save(packet)) uploaded++;
        } catch (error) {
          errors.push(packet.name + ' · ' + error.message);
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') errors.push(error.message);
    } finally {
      busy = false;
      controls.forEach((control) => { control.disabled = false; });
    }
    if (uploaded) afterUpload();
    if (errors.length) notify(errors.join(' · '), true);
    else if (uploaded) notify(uploaded === 1 ? '1 upload complete.' : uploaded + ' uploads complete.');
  }

  const drop = $('gallery-screen');
  drop.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', (event) => {
    if (!drop.contains(event.relatedTarget)) drop.classList.remove('dragging');
  });
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragging');
    queue(() => readDrop(event.dataTransfer));
  });
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });

  $('pick-file').addEventListener('click', () => $('file-input').click());
  $('pick-folder').addEventListener('click', () => {
    if (!window.showDirectoryPicker) {
      $('folder-input').click();
      return;
    }
    queue(async () => {
      const directory = await window.showDirectoryPicker();
      const entries = [];
      await collectFolder(directory, entries);
      return [{ name: directory.name, kind: 'folder', entries }];
    });
  });
  for (const [id, read] of [['file-input', filePackets], ['folder-input', folderPacket]]) {
    const input = $(id);
    input.addEventListener('change', () => {
      const packets = read(input.files);
      input.value = '';
      queue(() => packets);
    });
  }
  for (const [id, filter] of [['all-tab', 'all'], ['files-tab', 'files'], ['snippets-tab', 'codes']]) {
    $(id).addEventListener('click', () => { tab = filter; render(); });
  }

  search.addEventListener('input', () => render());
  more.addEventListener('click', () => { if (nextPage) run(more, nextPage); });

  return { render, navigate: viewer.navigate, openAsset: viewer.open };
}
