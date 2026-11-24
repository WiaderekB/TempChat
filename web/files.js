import { $, element, button, link, request, present, choose, notify, codeBlock, dateTime, formAction } from './ui.js';

const MAX_ENTRIES = 2048;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_HEADER = 1024 * 1024;
const icons = { folder: '▱', file: '▤', code: '</>' };
const changesLabels = { added: 'Dodano', removed: 'Usunięto', changed: 'Zmieniono' };
const kindLabels = { folder: 'Folder', file: 'Plik', code: 'Kod' };

function bytes(size) {
  if (size < 1024) return size + ' B';
  const scale = size < 1024 ** 2 ? 1024 : 1024 ** 2;
  return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 }).format(size / scale)
    + (scale === 1024 ? ' KiB' : ' MiB');
}

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
    if (entries.length >= MAX_ENTRIES) throw new Error('Folder może zawierać najwyżej 2048 elementów.');
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
  if (entries.length >= MAX_ENTRIES) throw new Error('Folder może zawierać najwyżej 2048 elementów.');
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
    throw new Error('Limit przesyłania wynosi 64 MiB i 2048 elementów.');
  }
  const info = {
    name: packet.name, kind: packet.kind, mode, note,
    entries: packet.entries.map(({ path, file }) => ({ path, size: file?.size ?? null })),
  };
  const header = new TextEncoder().encode(JSON.stringify(info));
  if (header.length > MAX_HEADER) throw new Error('Lista ścieżek jest zbyt długa.');
  const prefix = new ArrayBuffer(4);
  new DataView(prefix).setUint32(0, header.length);
  return new Blob([prefix, header, ...files], { type: 'application/octet-stream' });
}

function resourceButton(name, description, kind, action) {
  const control = button('', action, 'list-button');
  const nameBlock = element('span', name);
  if (description) nameBlock.append(element('span', description, 'item-subtitle'));
  const icon = element('span', icons[kind], 'item-icon');
  icon.setAttribute('aria-hidden', 'true');
  control.append(icon, nameBlock);
  return control;
}

export function resources(base, afterUpload) {
  let catalog = { files: [], codes: [] };
  let tab = 'all';
  let busy = false;
  let rendered;

  function render(value = catalog) {
    catalog = value;
    const signature = JSON.stringify([tab, value]);
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
    const items = tab === 'all' ? [...catalog.files, ...catalog.codes].sort((a, b) => b.created - a.created || b.id - a.id) : catalog[tab];
    $('assets-empty').hidden = items.length > 0;
    $('assets-empty').textContent = { all: 'Brak zasobów.', files: 'Brak plików i folderów.', codes: 'Brak fragmentów kodu.' }[tab];
    for (const item of items) {
      const row = element('li');
      const card = button('', () => openAsset(item.id, item.num, item.name), 'gallery-card');
      card.setAttribute('aria-label', item.name + ' · v' + item.num);
      const top = element('span', '', 'gallery-card-top');
      const icon = element('span', icons[item.kind], 'gallery-icon');
      icon.setAttribute('aria-hidden', 'true');
      top.append(icon, element('span', 'v' + item.num, 'pill'));
      const metadata = [kindLabels[item.kind], item.kind === 'code' ? item.lang : bytes(item.size), item.author];
      card.append(top, element('span', item.name, 'gallery-card-title'),
        element('span', metadata.filter(Boolean).join(' · '), 'gallery-card-meta'));
      row.append(card);
      list.append(row);
    }
  }

  async function openAsset(id, initial, title) {
    const url = base + 'assets/' + id;
    const modal = present(title);
    modal.body.textContent = 'Wczytywanie…';
    try {
      const asset = await request(url);
      const select = element('select');
      select.setAttribute('aria-label', 'Numer wersji');
      for (const revision of asset.history) {
        const option = element('option', 'v' + revision.num + ' · ' + dateTime(revision.created));
        option.value = revision.num;
        select.append(option);
      }
      select.value = initial;
      const tools = element('div', '', 'small-actions');
      const toolbar = element('div', '', 'version-toolbar');
      const info = element('div');
      const detail = element('div');
      toolbar.append(select, tools);
      modal.body.replaceChildren(toolbar, info, detail);

      async function showVersion() {
        const revision = asset.history.find((item) => item.num === Number(select.value));
        if (!revision) return;
        modal.error('');
        const prefix = url + '/' + revision.num;
        const snippet = asset.kind === 'code';
        tools.replaceChildren(link(asset.kind === 'folder' ? 'Pobierz ZIP' : 'Pobierz', prefix + '/download'),
          button('Podgląd', () => preview()),
          button('Zmiany', () => showChanges()));
        if (snippet) tools.append(button('Nowa wersja', () => editSnippet(asset, revision, prefix), 'primary'));
        if (revision.num !== asset.history[0].num) {
          tools.append(button('Przywróć', async () => {
            const restore = await choose('Przywróć wersję', 'Kopia v' + revision.num + ' stanie się najnowszą wersją.',
              [['restore', 'Przywróć wersję', 'primary']]);
            if (!restore) {
              await openAsset(id, revision.num, title);
              return;
            }
            const result = await request(prefix + '/restore', { method: 'POST' });
            afterUpload();
            await openAsset(id, result.num, title);
            notify('Przywrócono wersję.');
          }));
        }
        info.replaceChildren(element('p', revision.author + ' · ' + bytes(revision.size), 'muted version-meta'));
        if (revision.note) info.append(element('p', revision.note));
        const content = element('div');
        detail.replaceChildren(content);
        await preview();

        async function preview() {
          const view = element('div', 'Wczytywanie…');
          content.replaceChildren(view);
          await renderPreview(prefix, view, asset.name).catch((error) => { view.textContent = error.message; });
        }

        async function showChanges() {
          const view = element('div', 'Wczytywanie…');
          content.replaceChildren(view);
          await renderChanges(prefix, view, snippet).catch((error) => { view.textContent = error.message; });
        }
      }

      select.addEventListener('change', () => showVersion().catch((error) => modal.error(error.message)));
      await showVersion();
    } catch (error) {
      modal.body.textContent = '';
      modal.error(error.message);
    }
  }

  async function editSnippet(asset, revision, prefix) {
    const current = await request(prefix + '/preview');
    const modal = present('Nowa wersja · ' + asset.name);
    const form = element('form', '', 'dialog-form');
    const language = $('language').cloneNode(true);
    language.id = 'version-language';
    if (![...language.options].some((item) => item.value === current.lang)) {
      const option = element('option', current.lang);
      option.value = current.lang;
      language.append(option);
    }
    language.value = current.lang;
    const code = element('textarea');
    code.id = 'version-code';
    code.value = current.text;
    code.rows = 9;
    code.maxLength = 64000;
    code.required = true;
    code.spellcheck = false;
    code.className = 'mono';
    const note = element('input');
    note.id = 'version-note';
    note.maxLength = 200;
    for (const [name, control] of [
      ['Język kodu', language], ['Kod', code], ['Opis zmian (opcjonalnie)', note],
    ]) {
      const label = element('label', name);
      label.htmlFor = control.id;
      form.append(label, control);
    }
    const actions = element('div', '', 'small-actions');
    const submit = element('button', 'Zapisz wersję', 'primary');
    submit.type = 'submit';
    actions.append(submit, button('Anuluj', () => openAsset(asset.id, revision.num, asset.name)));
    form.append(actions);
    modal.body.append(form);
    code.focus();
    formAction(form, async () => {
      const saved = await request(base + 'messages', {
        method: 'POST',
        data: { kind: 'code', asset: asset.id, body: code.value, lang: language.value, note: note.value },
      });
      afterUpload();
      await openAsset(asset.id, saved.num, asset.name);
    }, modal.error);
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
    const options = [['copy', 'Zapisz jako kopię', '']];
    const description = element('div', '', 'dialog-form');
    const notes = element('input');
    notes.id = 'revision-note';
    notes.maxLength = 200;
    if (existing?.kind === packet.kind) {
      options.unshift(['version', 'Dodaj nową wersję', 'primary']);
      const label = element('label', 'Opis wersji (opcjonalnie)');
      label.htmlFor = notes.id;
      description.append(label, notes);
    }
    const mode = await choose('Plik lub folder już istnieje', packet.name, options, description);
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
    else if (uploaded) notify('Przesłano: ' + uploaded);
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

  return { render, openAsset };
}

async function renderPreview(prefix, target, name) {
  const data = await request(prefix + '/preview');
  if (data.type !== 'folder') {
    target.replaceChildren(previewText(data, name));
    return;
  }
  const rows = element('ul', '', 'entries');
  const detail = element('div');
  for (const item of data.entries) {
    const row = element('li');
    if (item.dir) {
      row.className = 'entry-directory';
      row.textContent = item.path + '/';
    } else {
      row.append(resourceButton(item.path, '', 'file', async () => {
        const query = '?path=' + encodeURIComponent(item.path);
        const panel = element('div', '', 'entry-detail');
        panel.append(element('p', item.path, 'entry-path'), link('Pobierz plik', prefix + '/download' + query));
        detail.replaceChildren(panel);
        try {
          panel.append(previewText(await request(prefix + '/preview' + query), item.path));
        } catch (error) {
          panel.append(element('p', error.message, 'error'));
        }
      }));
    }
    rows.append(row);
  }
  target.replaceChildren(rows, detail);
  if (!data.entries.length) target.append(element('p', 'Pusty folder.', 'empty'));
}

function previewText(data, name) {
  if (data.type === 'binary') return element('p', data.text, 'muted');
  if (data.type === 'zip') return codeBlock(data.text, 'Zawartość ZIP');
  const extension = data.lang ?? (name.includes('.') ? name.split('.').at(-1).toLowerCase() : '');
  return codeBlock(data.text, extension);
}

async function renderChanges(prefix, target, snippet) {
  if (snippet) {
    const result = await request(prefix + '/changes?path=fragment');
    target.replaceChildren(codeBlock(result.text, '', true));
    return;
  }
  const data = await request(prefix + '/changes');
  target.replaceChildren();
  if (!data.length) {
    target.append(element('p', 'Brak zmian względem poprzedniej wersji.', 'empty'));
    return;
  }
  const rows = element('ul', '', 'entries');
  const detail = element('div');
  for (const change of data) {
    const row = element('li', '', 'entry-file ' + change.state);
    row.append(resourceButton(change.path, changesLabels[change.state], 'file', async () => {
      const result = await request(prefix + '/changes?path=' + encodeURIComponent(change.path));
      detail.replaceChildren(codeBlock(result.text, '', true));
    }));
    rows.append(row);
  }
  target.append(rows, detail);
}
