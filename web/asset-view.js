import { $, element, button, link, request, choose, notify, copyText, dateTime, formatBytes,
  formAction, assetIcons, highlightSource, languageLabel, selectLanguage } from './ui.js';
import { markdownHtml } from './markdown.mjs';

const order = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const changeLabels = { added: 'Added', removed: 'Removed', changed: 'Modified' };
const FILE_PAGE = 120;
const TABLE_PAGE = 75;

export function assetHash({ id, version, path = '', mode = 'preview', from }) {
  const query = new URLSearchParams();
  if (path) query.set('path', path);
  if (mode !== 'preview') query.set('view', mode);
  if (mode === 'changes' && from !== undefined && from !== version - 1) query.set('from', from);
  return '#asset/' + id + '/' + version + (query.size ? '?' + query : '');
}

function readRoute(hash) {
  const match = /^#asset\/([1-9]\d*)\/([1-9]\d*)(?:\?(.*))?$/.exec(hash);
  if (!match) return;
  const id = Number(match[1]);
  const version = Number(match[2]);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(version)) return;
  const query = new URLSearchParams(match[3]);
  const view = query.get('view');
  const from = query.get('from');
  return {
    id, version, path: query.get('path') ?? '',
    mode: view === 'changes' || view === 'edit' ? view : 'preview',
    from: from !== null && /^(0|[1-9]\d*)$/.test(from) && Number(from) < version ? Number(from) : version - 1,
  };
}

function folderTree(entries) {
  const root = { path: '', dir: true, children: [] };
  const nodes = new Map([['', root]]);
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let parent = root;
    for (const [position, name] of parts.entries()) {
      const path = parent.path ? parent.path + '/' + name : name;
      const terminal = position === parts.length - 1;
      let node = nodes.get(path);
      if (!node) {
        node = { path, name, dir: !terminal || entry.dir, children: [] };
        nodes.set(path, node);
        parent.children.push(node);
      }
      if (terminal) node.state = entry.state;
      parent = node;
    }
  }
  for (const node of nodes.values()) {
    node.children.sort((a, b) => Number(b.dir) - Number(a.dir) || order.compare(a.name, b.name));
  }
  return { nodes, root };
}

function queryPath(path) {
  return path ? '?path=' + encodeURIComponent(path) : '';
}

function diffQuery(from, path) {
  const query = new URLSearchParams({ from, format: 'split' });
  if (path) query.set('path', path);
  return '?' + query;
}

function versionLabel(num) {
  return num ? 'v' + num : 'Empty snapshot';
}

function icon(kind) {
  const badge = element('span', assetIcons[kind], 'browser-icon');
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

function lineCount(text) {
  if (!text) return 0;
  return text.split('\n').length - Number(text.endsWith('\n'));
}

function sourcePreview(text, language) {
  const scroll = element('div', '', 'source-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', 'Source preview');
  const lines = element('div', '', 'numbered-source');
  const gutter = element('pre', Array.from({ length: lineCount(text) }, (_, index) => index + 1).join('\n'), 'line-numbers');
  gutter.setAttribute('aria-hidden', 'true');
  const pre = element('pre');
  const code = element('code');
  highlightSource(code, text, language);
  pre.append(code);
  lines.append(gutter, pre);
  scroll.append(lines);
  return scroll;
}

function pagedList(list, items, createRow) {
  let offset = 0;
  let footer;
  function appendPage() {
    footer?.remove();
    const page = document.createDocumentFragment();
    for (const item of items.slice(offset, offset + FILE_PAGE)) page.append(createRow(item));
    offset += FILE_PAGE;
    list.append(page);
    if (offset < items.length) {
      footer = element('li', '', 'list-more');
      footer.append(button('Show more', appendPage, 'quiet'));
      list.append(footer);
    }
  }
  appendPage();
  return list;
}

function columnName(index) {
  let label = '';
  do {
    label = String.fromCharCode(65 + index % 26) + label;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return label;
}

function tablePreview(data) {
  const panel = element('div', '', 'asset-table');
  const scroll = element('div', '', 'asset-table-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', 'Tabular preview');
  const table = element('table');
  const head = element('thead');
  const labels = element('tr');
  const rowNumber = element('th', '#');
  rowNumber.scope = 'col';
  labels.append(rowNumber);
  for (let index = 0; index < data.columns; index++) {
    const label = element('th', columnName(index));
    label.scope = 'col';
    labels.append(label);
  }
  head.append(labels);
  const rows = element('tbody');
  table.append(head, rows);
  scroll.append(table);
  if (data.rows.length) panel.append(scroll);
  else panel.append(element('p', 'No rows to display.', 'asset-empty'));
  if (data.rows_limited || data.columns_limited) {
    panel.append(element('p', 'This preview shows part of the file. Download it to see all rows and columns.', 'asset-empty'));
  }
  if (data.invalid) panel.append(element('p', 'Some rows could not be read. Open Source to inspect the file.', 'asset-empty'));
  const more = button('Show more rows', appendRows);
  more.classList.add('asset-more');
  panel.append(more);
  let offset = 0;
  appendRows();
  return panel;

  function appendRows() {
    const fragment = document.createDocumentFragment();
    for (const [index, values] of data.rows.slice(offset, offset + TABLE_PAGE).entries()) {
      const row = element('tr');
      const label = element('th', String(offset + index + 1));
      label.scope = 'row';
      row.append(label);
      for (let column = 0; column < data.columns; column++) {
        row.append(element('td', values[column] ?? ''));
      }
      fragment.append(row);
    }
    rows.append(fragment);
    offset += TABLE_PAGE;
    more.hidden = offset >= data.rows.length;
  }
}

function diffCell(line, state = '', prefix = '') {
  const cell = element('div', '', 'diff-cell' + (state ? ' ' + state : ''));
  const number = element('span', line ? String(line[0]) : '', 'diff-number');
  const marker = element('span', line ? prefix : '', 'diff-marker');
  marker.setAttribute('aria-hidden', 'true');
  cell.append(number, marker, element('code', line?.[1] ?? ''));
  return cell;
}

function diffContent(data, from, version, split) {
  const result = element('div', '', 'asset-diff');
  if (data.notice) {
    result.append(element('p', data.notice, 'asset-empty'));
    return result;
  }
  if (split) {
    const captions = element('div', '', 'diff-grid diff-captions');
    captions.append(element('span', versionLabel(from) + ' · Before'), element('span', versionLabel(version) + ' · After'));
    result.append(captions);
  }
  for (const [index, block] of data.blocks.entries()) {
    if (index) result.append(element('div', 'Unchanged lines omitted', 'diff-gap'));
    for (const row of block) {
      if (split) {
        const line = element('div', '', 'diff-grid');
        const leftStyle = row.before ? (row.changed ? 'diff-old' : '') : 'diff-blank';
        const rightStyle = row.after ? (row.changed ? 'diff-new' : '') : 'diff-blank';
        line.append(diffCell(row.before, leftStyle, row.changed ? '−' : ''),
          diffCell(row.after, rightStyle, row.changed ? '+' : ''));
        result.append(line);
      } else if (row.changed) {
        if (row.before) result.append(diffCell(row.before, 'diff-old', '−'));
        if (row.after) result.append(diffCell(row.after, 'diff-new', '+'));
      } else {
        result.append(diffCell(row.after));
      }
    }
  }
  return result;
}

export function assetBrowser(base, afterWrite) {
  const screen = $('asset-screen');
  const workspace = $('asset-workspace');
  const controls = $('asset-controls');
  const versionSelect = $('asset-version');
  const tree = $('asset-tree');
  const search = $('asset-find');
  const toggleTree = $('asset-tree-toggle');
  const content = $('asset-content');
  const pathActions = $('asset-path-actions');
  const status = $('asset-status');
  const expanded = new Set();
  let activeHash = '';
  let generation = 0;
  let assetCache;
  let treeCache;
  let active;
  let split = !window.matchMedia('(max-width: 640px)').matches;

  function open(id, version) {
    location.hash = assetHash({ id, version });
  }

  function navigate(hash) {
    const route = readRoute(hash);
    if (!route) {
      if (activeHash) {
        activeHash = '';
        generation++;
        active = undefined;
        assetCache = undefined;
        treeCache = undefined;
      }
      return false;
    }
    if (hash !== activeHash) {
      activeHash = hash;
      void load(route, ++generation);
    }
    return true;
  }

  function go(updates) {
    location.hash = assetHash({ ...active.route, ...updates });
  }

  function setTreeOpen(openTree) {
    screen.classList.toggle('tree-open', openTree);
    toggleTree.setAttribute('aria-expanded', String(openTree));
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('error', isError);
  }

  async function load(route, ticket) {
    const url = base + 'assets/' + route.id;
    const changedAsset = active?.asset.id !== route.id;
    if (changedAsset) {
      $('asset-title').textContent = '';
      $('asset-title-divider').hidden = true;
      controls.hidden = true;
      workspace.hidden = true;
      search.value = '';
      expanded.clear();
      setTreeOpen(false);
      setStatus('Loading asset…');
    } else {
      pathActions.replaceChildren();
      content.replaceChildren(element('p', 'Loading…', 'asset-empty'));
    }
    try {
      let asset = assetCache;
      if (asset?.id !== route.id || !asset.history.some(({ num }) => num === route.version)) {
        asset = await request(url);
      }
      if (ticket !== generation) return;
      assetCache = asset;
      const revision = asset.history.find(({ num }) => num === route.version);
      if (!revision) throw new Error('Version not found.');
      const prefix = url + '/' + route.version;
      const folder = asset.kind === 'folder';
      if (route.mode === 'edit' && asset.kind !== 'code') route.mode = 'preview';
      const comparing = route.mode === 'changes';
      let index;
      if (folder) {
        const key = prefix + (comparing ? '/changes/' + route.from : '/preview');
        if (treeCache?.key === key) {
          index = treeCache.index;
        } else {
          const entries = comparing ? await request(prefix + '/changes' + diffQuery(route.from))
            : (await request(prefix + '/preview')).entries;
          if (ticket !== generation) return;
          index = folderTree(entries);
          treeCache = { key, index };
        }
        while (route.path && !index.nodes.has(route.path)) {
          route.path = route.path.slice(0, Math.max(0, route.path.lastIndexOf('/')));
        }
        const parents = route.path.split('/');
        parents.pop();
        for (let count = 1; count <= parents.length; count++) expanded.add(parents.slice(0, count).join('/'));
        if (route.path && index.nodes.get(route.path).dir) expanded.add(route.path);
      } else {
        route.path = '';
      }
      const canonical = assetHash(route);
      if (canonical !== activeHash) {
        activeHash = canonical;
        history.replaceState(null, '', canonical);
      }
      active = { asset, route, revision, prefix, index };
      renderToolbar();
      renderTree();
      renderPath();
      renderRevision();
      setStatus('');
      workspace.hidden = false;
      content.scrollTop = 0;
      await renderContent(ticket);
    } catch (error) {
      if (ticket !== generation) return;
      if (workspace.hidden) setStatus(error.message, true);
      else content.replaceChildren(element('p', error.message, 'asset-empty error'));
    }
  }

  function renderToolbar() {
    const { asset, route, prefix } = active;
    $('asset-title').textContent = asset.name;
    $('asset-title').title = asset.name;
    $('asset-title-divider').hidden = false;
    controls.hidden = false;
    workspace.classList.toggle('single-asset', asset.kind !== 'folder');
    const options = asset.history.map((item) => {
      const option = element('option', versionLabel(item.num) + ' · ' + dateTime(item.created));
      option.value = item.num;
      return option;
    });
    versionSelect.replaceChildren(...options);
    versionSelect.value = route.version;
    const previewLink = $('asset-preview-link');
    const changesLink = $('asset-changes-link');
    previewLink.href = assetHash({ ...route, mode: 'preview' });
    changesLink.href = assetHash({ ...route, mode: 'changes' });
    for (const [control, mode] of [[previewLink, 'preview'], [changesLink, 'changes']]) {
      if (route.mode === mode) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    }
    const actions = $('asset-actions');
    actions.replaceChildren(link(asset.kind === 'folder' ? 'Download ZIP' : 'Download', prefix + '/download'));
    if (asset.kind === 'code') actions.append(link('New version', assetHash({ ...route, mode: 'edit' }), 'button'));
    if (route.version !== asset.history[0].num) actions.append(button('Restore', async () => {
      const confirmed = await choose('Restore version', 'A copy of v' + route.version + ' will become the latest version.',
        [['restore', 'Restore version', 'primary']]);
      if (!confirmed) return;
      const saved = await request(prefix + '/restore', { method: 'POST' });
      afterWrite();
      location.hash = assetHash({ id: route.id, version: saved.num, path: route.path });
      notify('Version restored.');
    }));
  }

  versionSelect.addEventListener('change', () => {
    const version = Number(versionSelect.value);
    go({ version, from: version - 1, mode: active.route.mode === 'edit' ? 'preview' : active.route.mode });
  });
  search.addEventListener('input', renderTree);
  toggleTree.addEventListener('click', () => setTreeOpen(!screen.classList.contains('tree-open')));

  function pathLink(node, label = node.name, className = 'tree-link') {
    const control = link('', assetHash({ ...active.route, path: node.path }), className);
    const name = element('span', label, 'tree-name');
    control.title = node.path;
    control.append(icon(node.dir ? 'folder' : 'file'), name);
    if (node.state) control.append(element('span', changeLabels[node.state], 'change-badge ' + node.state));
    if (active.route.path === node.path) control.setAttribute('aria-current', 'page');
    control.addEventListener('click', () => setTreeOpen(false));
    return control;
  }

  function renderTree() {
    if (!active?.index) {
      tree.replaceChildren();
      return;
    }
    const { index, route } = active;
    $('asset-tree-title').textContent = route.mode === 'changes' ? 'Changed files' : 'Files';
    const query = search.value.trim().toLowerCase();
    if (query) {
      const matches = Array.from(index.nodes.values()).filter((node) => node.path && node.path.toLowerCase().includes(query));
      const list = element('ul', '', 'tree-list search-results');
      pagedList(list, matches, (node) => {
        const item = element('li');
        item.append(pathLink(node, node.path));
        return item;
      });
      tree.replaceChildren(matches.length ? list : element('p', 'No matching paths.', 'asset-empty'));
      return;
    }
    const root = link('Folder root', assetHash({ ...route, path: '' }), 'tree-root');
    if (!route.path) root.setAttribute('aria-current', 'page');
    tree.replaceChildren(root, renderBranches(index.root.children));

    function renderBranches(nodes) {
      const list = element('ul', '', 'tree-list');
      return pagedList(list, nodes, (node) => {
        const item = element('li');
        const row = element('div', '', 'tree-row');
        if (node.dir) {
          const isOpen = expanded.has(node.path);
          const expander = element('button', isOpen ? '⌄' : '›', 'tree-expander quiet');
          expander.type = 'button';
          expander.setAttribute('aria-expanded', String(isOpen));
          expander.setAttribute('aria-label', (isOpen ? 'Collapse ' : 'Expand ') + node.path);
          expander.addEventListener('click', () => {
            if (expanded.has(node.path)) expanded.delete(node.path);
            else expanded.add(node.path);
            const openTree = expanded.has(node.path);
            expander.textContent = openTree ? '⌄' : '›';
            expander.setAttribute('aria-expanded', String(openTree));
            expander.setAttribute('aria-label', (openTree ? 'Collapse ' : 'Expand ') + node.path);
            if (openTree) item.append(renderBranches(node.children));
            else item.lastElementChild.remove();
          });
          row.append(expander);
        } else {
          const spacer = element('span', '', 'tree-spacer');
          spacer.setAttribute('aria-hidden', 'true');
          row.append(spacer);
        }
        row.append(pathLink(node));
        item.append(row);
        if (node.dir && expanded.has(node.path)) item.append(renderBranches(node.children));
        return item;
      });
    }
  }

  function renderPath() {
    const { asset, route, index, prefix } = active;
    const path = $('asset-breadcrumb');
    path.replaceChildren();
    pathActions.replaceChildren();
    const segments = route.path ? route.path.split('/') : [];
    const root = segments.length ? link(asset.name, assetHash({ ...route, path: '' }), 'path-link')
      : element('span', asset.name, 'path-current');
    path.append(root);
    let parent = '';
    for (const [position, segment] of segments.entries()) {
      parent = parent ? parent + '/' + segment : segment;
      const divider = element('span', '/', 'path-divider');
      divider.setAttribute('aria-hidden', 'true');
      path.append(divider, position === segments.length - 1 ? element('span', segment, 'path-current')
        : link(segment, assetHash({ ...route, path: parent }), 'path-link'));
    }
    const node = index?.nodes.get(route.path);
    if (route.path) pathActions.append(button('Copy path', () => copyText(route.path, 'Path copied.')));
    if (node && !node.dir && node.state !== 'removed') {
      pathActions.append(link('Download file', prefix + '/download' + queryPath(route.path)));
    }
  }

  function renderRevision() {
    const { asset, revision, route } = active;
    const meta = $('asset-revision');
    const details = element('div', '', 'asset-revision-info');
    details.append(element('span', versionLabel(revision.num), 'revision-tag'),
      element('span', revision.author), element('span', dateTime(revision.created)),
      element('span', formatBytes(revision.size)));
    if (revision.note) details.append(element('span', revision.note, 'asset-revision-note'));
    meta.replaceChildren(details);
    if (route.mode !== 'changes') return;
    const compare = element('label', 'Compare with', 'asset-baseline');
    const select = element('select');
    for (const num of [...asset.history.map((item) => item.num).filter((num) => num < route.version), 0]) {
      const option = element('option', versionLabel(num));
      option.value = num;
      select.append(option);
    }
    select.value = route.from;
    select.addEventListener('change', () => go({ from: Number(select.value) }));
    compare.append(select);
    meta.append(compare);
  }

  async function renderContent(ticket) {
    const { asset, route, prefix, index } = active;
    const node = index?.nodes.get(route.path);
    if (node?.dir) {
      const list = element('ul', '', 'folder-rows');
      pagedList(list, node.children, (child) => {
        const item = element('li');
        item.append(pathLink(child, child.name, 'folder-link'));
        return item;
      });
      const empty = route.mode === 'changes' ? 'No changes in this folder.' : 'This folder is empty.';
      content.replaceChildren(node.children.length ? list : element('p', empty, 'asset-empty'));
      return;
    }

    if (route.mode === 'changes') {
      content.replaceChildren(element('p', 'Loading comparison…', 'asset-empty'));
      const path = route.path || (asset.kind === 'code' ? 'fragment' : asset.name);
      const result = await request(prefix + '/changes' + diffQuery(route.from, path));
      if (ticket !== generation) return;
      renderDiff(result, route);
      return;
    }

    content.replaceChildren(element('p', 'Loading file…', 'asset-empty'));
    const preview = await request(prefix + '/preview' + queryPath(route.path));
    if (ticket !== generation) return;
    if (route.mode === 'edit') {
      renderEditor(preview);
      return;
    }
    if (preview.type === 'binary') {
      content.replaceChildren(element('p', preview.text, 'asset-empty'));
      return;
    }
    const filename = node?.name ?? asset.name;
    if (preview.type === 'image') {
      const image = element('img', '', 'asset-image');
      image.alt = filename;
      image.src = preview.source;
      const frame = element('div', '', 'asset-image-frame');
      frame.append(image);
      content.replaceChildren(frame);
      return;
    }
    const extension = filename.includes('.') ? filename.split('.').at(-1).toLowerCase() : '';
    const language = preview.lang ?? extension;
    const markdown = preview.type === 'text' && asset.kind !== 'code' && ['md', 'markdown'].includes(extension);
    const table = preview.type === 'table';
    const actions = element('div', '', 'source-toolbar');
    const body = element('div', '', 'source-body');
    const label = preview.type === 'zip' ? 'ZIP contents' : table ? extension.toUpperCase() + ' · ' + preview.rows.length + ' rows'
      : [markdown ? 'Markdown' : languageLabel(language), lineCount(preview.text) + ' lines'].filter(Boolean).join(' · ');
    actions.append(element('span', label, 'muted'));
    const copy = button('Copy', () => copyText(preview.text, 'Copied.'));
    if (markdown || table) {
      const flip = button('Source', () => {
        const showSource = flip.textContent === 'Source';
        flip.textContent = showSource ? (table ? 'Table' : 'Rendered') : 'Source';
        if (showSource) {
          body.replaceChildren(sourcePreview(preview.text, table ? '' : language));
          if (preview.source_limited) body.prepend(element('p', 'This is a partial source preview.', 'asset-empty'));
        } else {
          renderFormatted();
        }
      });
      actions.append(flip);
      renderFormatted();
    } else {
      body.append(sourcePreview(preview.text, language));
    }
    actions.append(copy);
    content.replaceChildren(actions, body);

    function renderFormatted() {
      if (table) {
        body.replaceChildren(tablePreview(preview));
        return;
      }
      const rendered = element('div', '', 'markdown-message asset-markdown');
      rendered.innerHTML = markdownHtml(preview.text);
      body.replaceChildren(rendered);
    }
  }

  function renderDiff(result, route) {
    const toolbar = element('div', '', 'source-toolbar');
    const output = element('div', '', 'diff-output');
    const label = element('span', versionLabel(route.from) + ' to ' + versionLabel(route.version), 'muted');
    const modes = element('div', '', 'segmented');
    modes.setAttribute('aria-label', 'Diff layout');
    const splitButton = button('Side by side', () => { split = true; draw(); });
    const unifiedButton = button('Unified', () => { split = false; draw(); });
    modes.append(splitButton, unifiedButton);
    toolbar.append(label, modes);
    content.replaceChildren(toolbar, output);
    draw();

    function draw() {
      splitButton.setAttribute('aria-pressed', String(split));
      unifiedButton.setAttribute('aria-pressed', String(!split));
      output.replaceChildren(diffContent(result, route.from, route.version, split));
    }
  }

  function renderEditor(preview) {
    const { asset, route } = active;
    const form = element('form', '', 'dialog-form asset-editor');
    const language = $('language').cloneNode(true);
    language.id = 'version-language';
    selectLanguage(language, preview.lang);
    const code = element('textarea');
    code.id = 'version-code';
    code.value = preview.text;
    code.rows = 12;
    code.maxLength = 64000;
    code.required = true;
    code.spellcheck = false;
    code.className = 'mono';
    const note = element('input');
    note.id = 'version-note';
    note.maxLength = 200;
    for (const [name, control] of [
      ['Language', language], ['Code', code], ['Change note (optional)', note],
    ]) {
      const label = element('label', name);
      label.htmlFor = control.id;
      form.append(label, control);
    }
    const actions = element('div', '', 'small-actions');
    const submit = element('button', 'Save version', 'primary');
    submit.type = 'submit';
    const error = element('p', '', 'error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    actions.append(submit, link('Cancel', assetHash({ ...route, mode: 'preview' })));
    form.append(error, actions);
    content.replaceChildren(form);
    code.focus();
    formAction(form, async () => {
      const saved = await request(base + 'messages', {
        method: 'POST',
        data: { kind: 'code', asset: asset.id, body: code.value, lang: language.value, note: note.value },
      });
      afterWrite();
      open(asset.id, saved.num);
    }, (message) => {
      error.textContent = message;
      error.hidden = false;
    });
  }

  return { open, navigate };
}
