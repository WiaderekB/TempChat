import { $, element, link, request, choose, notify, languageLabel, formatBytes, assetIcons } from './ui.js';
import { assetBrowser, assetHash } from './asset-view.js';

const MAX_ENTRIES = 2048;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_HEADER = 1024 * 1024;
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
    if (entries.length >= MAX_ENTRIES) throw new Error('A folder can contain up to 2,048 items.');
    if (handle.kind === 'directory') {
      entries.push({ path, file: null });
      await collectFolder(handle, entries, path + '/');
    } else {
      entries.push({ path, file: await handle.getFile() });
    }
  }
}

async function collectDropped(entry, entries, parents = '') {
  const path = parents + entry.name;
  if (entries.length >= MAX_ENTRIES) throw new Error('A folder can contain up to 2,048 items.');
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    entries.push({ path, file });
  } else if (entry.isDirectory) {
    entries.push({ path, file: null });
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await collectDropped(child, entries, path + '/');
    } while (batch.length);
  }
}

function readDrop(transfer) {
  const entries = Array.from(transfer.items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  const files = Array.from(transfer.files);
  if (!entries.length) return Promise.resolve(filePackets(files));
  return Promise.all(entries.map(async (entry) => {
    const contents = [];
    await collectDropped(entry, contents);
    if (!entry.isDirectory) return { name: entry.name, kind: 'file', entries: contents };
    const relative = contents.slice(1).map(({ path, file }) => ({ path: path.slice(entry.name.length + 1), file }));
    return { name: entry.name, kind: 'folder', entries: relative };
  }));
}

function packetBody(packet, mode, note) {
  const files = packet.entries.map(({ file }) => file).filter(Boolean);
  if (packet.entries.length > MAX_ENTRIES || files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) {
    throw new Error('The upload limit is 64 MiB and 2,048 items.');
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
  const viewer = assetBrowser(base, afterUpload);
  const search = $('asset-search');
  let catalog = { files: [], codes: [] };
  let tab = 'all';
  let busy = false;
  let rendered;

  function render(value = catalog) {
    catalog = value;
    const query = search.value.trim().toLowerCase();
    const signature = JSON.stringify([tab, query, value]);
    if (signature === rendered) return;
    rendered = signature;
    const list = $('resources');
    list.replaceChildren();
    const count = catalog.files.length + catalog.codes.length;
    $('asset-count').textContent = count;
    $('asset-count').hidden = !count;
    $('all-tab').setAttribute('aria-pressed', String(tab === 'all'));
    $('files-tab').setAttribute('aria-pressed', String(tab === 'files'));
    $('snippets-tab').setAttribute('aria-pressed', String(tab === 'codes'));
    const source = tab === 'all' ? [...catalog.files, ...catalog.codes].sort((a, b) => b.created - a.created || b.id - a.id) : catalog[tab];
    const items = source.filter(({ name }) => name.toLowerCase().includes(query));
    $('assets-empty').hidden = items.length > 0;
    $('assets-empty').textContent = query ? 'No assets match your search.' : { all: 'No assets yet. Drop files or folders here, or add a code snippet.', files: 'No files or folders yet.', codes: 'No code snippets yet.' }[tab];
    for (const item of items) {
      const row = element('li');
      const card = link('', assetHash({ id: item.id, version: item.num }), 'gallery-card');
      card.setAttribute('aria-label', item.name + ' · v' + item.num);
      const content = element('span', '', 'gallery-card-body');
      const top = element('span', '', 'gallery-card-top');
      const icon = element('span', assetIcons[item.kind], 'gallery-icon');
      icon.setAttribute('aria-hidden', 'true');
      top.append(element('span', item.name, 'gallery-card-title'), element('span', 'v' + item.num, 'pill'));
      const type = item.kind === 'code' ? languageLabel(item.lang) : formatBytes(item.size);
      content.append(top, element('span', [kindLabels[item.kind], type, item.author].join(' · '), 'gallery-card-meta'));
      card.append(icon, content);
      row.append(card);
      list.append(row);
    }
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

  return { render, navigate: viewer.navigate, openAsset: viewer.open };
}
