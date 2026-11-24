import { $, element, button, link, request, choose, notify, copyText, dateTime, formatBytes,
  formAction, assetIcons, highlightSource, languageLabel, selectLanguage, iconControl } from './ui.js';
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

function sourceLabel(text, language) {
  const lines = lineCount(text);
  return [language, lines + (lines === 1 ? ' line' : ' lines')].filter(Boolean).join(' · ');
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

function codeEditor(text, language, fileLanguage = '') {
  const summary = element('span');
  const grid = element('div', '', 'editor-grid');
  const gutter = element('pre', '', 'line-numbers');
  const input = element('div', '', 'editor-input');
  const backdrop = element('pre');
  const highlighted = element('code');
  const field = element('textarea');
  field.setAttribute('aria-label', 'Code');
  field.value = text;
  field.setSelectionRange(0, 0);
  field.maxLength = language ? 64000 : 256 * 1024;
  field.required = Boolean(language);
  field.wrap = 'off';
  field.spellcheck = false;
  field.autocapitalize = 'off';
  field.autocomplete = 'off';
  backdrop.setAttribute('aria-hidden', 'true');
  gutter.setAttribute('aria-hidden', 'true');
  backdrop.append(highlighted);
  input.append(backdrop, field);
  grid.append(gutter, input);
  const position = element('span', '', 'editor-position');

  let count = 0;
  let numbers = [];
  let selectedLine = 0;

  function scroll() {
    gutter.scrollTop = backdrop.scrollTop = field.scrollTop;
    backdrop.scrollLeft = field.scrollLeft;
  }

  function cursor() {
    const before = field.value.slice(0, field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd);
    const line = before.split('\n').length;
    position.textContent = 'Ln ' + line + ', Col ' + (before.length - before.lastIndexOf('\n'));
    if (line !== selectedLine) {
      selectedLine = line;
      const current = element('span', String(line), 'editor-current');
      gutter.replaceChildren(numbers.slice(0, line - 1).join('\n') + (line > 1 ? '\n' : ''),
        current, '\n' + numbers.slice(line).join('\n'), '\n');
      scroll();
    }
  }

  function paint() {
    const syntax = language?.value ?? fileLanguage;
    highlighted.replaceChildren();
    highlightSource(highlighted, field.value, syntax);
    highlighted.append('\n');
    const nextCount = field.value.split('\n').length;
    if (count !== nextCount) {
      count = nextCount;
      numbers = Array.from({ length: count }, (_, index) => index + 1);
      selectedLine = 0;
    }
    summary.textContent = sourceLabel(field.value, languageLabel(syntax));
    cursor();
    scroll();
  }

  field.addEventListener('input', paint);
  field.addEventListener('scroll', scroll);
  field.addEventListener('selectionchange', cursor);
  field.addEventListener('click', cursor);
  field.addEventListener('keyup', cursor);
  field.addEventListener('keydown', (event) => {
    if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      field.form.requestSubmit();
    }
  });
  language?.addEventListener('change', paint);
  paint();
  return { summary, grid, field, position };
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

function diffCell(line, state = '', prefix = '', parts = [], numbers = [line?.[0]]) {
  const cell = element('div', '', 'diff-cell' + (state ? ' ' + state : ''));
  for (const number of numbers) cell.append(element('span', String(number ?? ''), 'diff-number'));
  const marker = element('span', line ? prefix : '', 'diff-marker');
  marker.setAttribute('aria-hidden', 'true');
  const code = element('code');
  if (parts.length) {
    for (const [text, changed] of parts) code.append(changed ? element('mark', text, 'diff-word') : text);
  } else {
    code.textContent = line?.[1] ?? '';
  }
  cell.append(marker, code);
  return cell;
}

function diffContent(data, from, version, split) {
  const result = element('div', '', split ? 'asset-diff' : 'asset-diff diff-unified');
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
    const additions = [];
    const appendAdditions = () => {
      result.append(...additions);
      additions.length = 0;
    };
    for (const row of block) {
      if (split) {
        const line = element('div', '', 'diff-grid');
        const leftStyle = row.before ? (row.changed ? 'diff-old' : '') : 'diff-blank';
        const rightStyle = row.after ? (row.changed ? 'diff-new' : '') : 'diff-blank';
        line.append(diffCell(row.before, leftStyle, row.changed ? '−' : '', row.words?.before),
          diffCell(row.after, rightStyle, row.changed ? '+' : '', row.words?.after));
        result.append(line);
      } else if (row.changed) {
        if (row.before) result.append(diffCell(row.before, 'diff-old', '−', row.words?.before, [row.before[0], null]));
        if (row.after) additions.push(diffCell(row.after, 'diff-new', '+', row.words?.after, [null, row.after[0]]));
      } else {
        appendAdditions();
        result.append(diffCell(row.after, '', '', [], [row.before[0], row.after[0]]));
      }
    }
    appendAdditions();
  }
  return result;
}

export function assetBrowser(base, afterWrite, uploadFiles) {
  const screen = $('asset-screen');
  const workspace = $('asset-workspace');
  const controls = $('asset-controls');
  const versionSelect = $('asset-version');
  const tree = $('asset-tree');
  const sidebar = tree.closest('.asset-sidebar');
  const search = $('asset-find');
  const toggleTree = $('asset-tree-toggle');
  const content = $('asset-content');
  const pathActions = $('asset-path-actions');
  const contentActions = $('asset-content-actions');
  const sourceInfo = $('asset-source-info');
  const status = $('asset-status');
  const expanded = new Set();
  let activeHash = '';
  let generation = 0;
  let assetCache;
  let treeCache;
  let active;
  let activePdf;
  let dropTarget;
  let uploading = false;
  let split = !window.matchMedia('(max-width: 640px)').matches;

  function open(id, version) {
    location.hash = assetHash({ id, version });
  }

  function navigate(hash) {
    if (hash !== activeHash) clearDropTarget();
    if (hash !== activeHash && activePdf) {
      activePdf.dispose();
      activePdf = undefined;
    }
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

  function setSourceInfo(label, ...actions) {
    sourceInfo.replaceChildren(label);
    sourceInfo.hidden = !label;
    contentActions.replaceChildren(...actions);
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
    setSourceInfo('');
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
      if (route.mode === 'edit' && (route.version !== asset.history[0].num ||
        (folder && index.nodes.get(route.path)?.dir))) route.mode = 'preview';
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

  function clearDropTarget() {
    dropTarget?.classList.remove('tree-drop-target');
    dropTarget = undefined;
  }

  function dropLocation(target) {
    return target.closest('[data-drop-path]') ??
      target.closest('.tree-row')?.querySelector('[data-drop-path]') ?? sidebar;
  }

  function dropUnavailable() {
    if (!active?.index || active.route.mode !== 'preview' || activeHash !== assetHash(active.route)) {
      return 'Open the folder in Preview to drop files.';
    }
    if (active.route.version !== active.asset.history[0].num) return 'Open the latest version to drop files.';
    return '';
  }

  sidebar.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const available = !uploading && !dropUnavailable();
    event.dataTransfer.dropEffect = available ? 'copy' : 'none';
    const target = available ? dropLocation(event.target) : undefined;
    if (target === dropTarget) return;
    clearDropTarget();
    dropTarget = target;
    dropTarget?.classList.add('tree-drop-target');
  });
  sidebar.addEventListener('dragleave', (event) => {
    if (!sidebar.contains(event.relatedTarget)) clearDropTarget();
  });
  sidebar.addEventListener('drop', async (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    clearDropTarget();
    if (uploading) return;
    const unavailable = dropUnavailable();
    if (unavailable) {
      notify(unavailable, true);
      return;
    }

    const files = Array.from(event.dataTransfer.files);
    if (Array.from(event.dataTransfer.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      notify('Drop individual files into the tree. Use the gallery to upload a whole folder.', true);
      return;
    }
    if (!files.length) return;
    const { asset, index, prefix, route } = active;
    const target = index.nodes.get(dropLocation(event.target).dataset.dropPath ?? '');
    if (!target.dir && files.length !== 1) {
      notify('Drop one file to replace it, or drop several files onto a folder.', true);
      return;
    }
    const entries = files.map((file) => ({
      file, path: target.dir ? [target.path, file.name.normalize('NFC')].filter(Boolean).join('/') : target.path,
    }));
    if (new Set(entries.map(({ path }) => path)).size !== entries.length ||
        entries.some(({ path }) => index.nodes.get(path)?.dir)) {
      notify('The dropped files contain duplicate names or conflict with a folder.', true);
      return;
    }

    const replaced = entries.filter(({ path }) => index.nodes.has(path)).length;
    const singleReplacement = entries.length === 1 && replaced === 1;
    const list = element('ul', '', 'drop-changes');
    for (const { file, path } of entries.slice(0, 8)) {
      const destination = file.name === path.split('/').at(-1) ? path : file.name + ' → ' + path;
      list.append(element('li', (index.nodes.has(path) ? 'Replace ' : 'Add ') + destination));
    }
    if (entries.length > 8) list.append(element('li', 'And ' + (entries.length - 8) + ' more'));
    const ticket = generation;
    uploading = true;
    try {
      const confirmed = await choose(singleReplacement ? 'Replace this file?' : 'Commit files to this folder?',
        'This will create a new version of ' + asset.name + '.',
        [['commit', singleReplacement ? 'Replace file' : 'Commit files', 'primary']], list);
      if (!confirmed || ticket !== generation) return;
      const saved = await uploadFiles(prefix, asset.name, entries);
      afterWrite();
      if (ticket === generation) go({
        version: saved.num, path: entries.length === 1 ? entries[0].path : target.path, mode: 'preview',
      });
      notify('Files committed to v' + saved.num + '.');
    } catch (error) {
      notify(error.message, true);
      if (error.status === 409 && ticket === generation) {
        assetCache = undefined;
        void load(route, ++generation);
      }
    } finally {
      uploading = false;
    }
  });

  function pathLink(node, label = node.name, className = 'tree-link') {
    const { route } = active;
    const control = link('', assetHash({ ...route, path: node.path, mode: route.mode === 'edit' ? 'preview' : route.mode }), className);
    const name = element('span', label, 'tree-name');
    control.title = node.path;
    if (className === 'tree-link') control.dataset.dropPath = node.path;
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
    const root = link('Folder root', assetHash({ ...route, path: '', mode: route.mode === 'edit' ? 'preview' : route.mode }), 'tree-root');
    root.dataset.dropPath = '';
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
        : link(segment, assetHash({ ...route, path: parent, mode: route.mode === 'edit' ? 'preview' : route.mode }), 'path-link'));
    }
    const node = index?.nodes.get(route.path);
    if (route.mode !== 'edit' && route.path) {
      pathActions.append(iconControl(button('', () => copyText(route.path, 'Path copied.'), 'quiet'), 'copy', 'Copy path'));
      if (node && !node.dir && node.state !== 'removed') {
        pathActions.append(iconControl(link('', prefix + '/download' + queryPath(route.path), 'button quiet'),
          'download', 'Download file'));
      }
    }
  }

  function renderRevision() {
    const { asset, revision, route } = active;
    const meta = $('asset-revision');
    const details = element('div', '', 'asset-revision-info');
    details.title = dateTime(revision.created);
    details.append(element('span', revision.author), element('span', formatBytes(revision.size)));
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
    pathActions.append(compare);
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
    const preview = await request(prefix + (route.mode === 'edit' ? '/edit' : '/preview') + queryPath(route.path));
    if (ticket !== generation) return;
    const filename = node?.name ?? asset.name;
    const extension = filename.includes('.') ? filename.split('.').at(-1).toLowerCase() : '';
    if (route.mode === 'edit') {
      renderEditor(preview, ticket, extension);
      return;
    }
    if (preview.type === 'pdf') {
      const { pdfPreview } = await import('./pdf-preview.js');
      if (ticket !== generation) return;
      const actions = preview.tex_path ? [link('LaTeX source', assetHash({ ...route, path: preview.tex_path }))] : [];
      setSourceInfo('PDF', ...actions);
      activePdf = pdfPreview({ url: prefix + '/download' + queryPath(route.path) }, filename);
      content.replaceChildren(activePdf.panel);
      return;
    }
    const binary = preview.type === 'binary';
    if (binary && !preview.latex && !preview.pdf_path) {
      content.replaceChildren(element('p', preview.text, 'asset-empty'));
      return;
    }
    if (preview.type === 'image') {
      const image = element('img', '', 'asset-image');
      image.alt = filename;
      image.src = preview.source;
      const frame = element('div', '', 'asset-image-frame');
      frame.append(image);
      content.replaceChildren(frame);
      return;
    }
    const language = preview.lang ?? extension;
    const markdown = preview.type === 'text' && asset.kind !== 'code' && ['md', 'markdown'].includes(extension);
    const table = preview.type === 'table';
    const actions = [];
    const body = element('div', '', 'source-body');
    const label = preview.type === 'zip' ? 'ZIP contents' : table ? extension.toUpperCase() + ' · ' + preview.rows.length + ' rows'
      : sourceLabel(preview.text, markdown ? 'Markdown' : languageLabel(language));
    if (preview.editable && route.version === asset.history[0].num) {
      actions.push(iconControl(link('', assetHash({ ...route, mode: 'edit' })), 'edit', 'Edit', true));
    }
    if (preview.pdf_path) {
      actions.push(link('View PDF', assetHash({ ...route, path: preview.pdf_path })));
    }
    const source = () => binary ? element('p', preview.text, 'asset-empty')
      : sourcePreview(preview.text, language);
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
      actions.push(flip);
      renderFormatted();
    } else {
      body.append(source());
    }
    if (preview.latex) {
      const engine = element('select', '', 'latex-engine');
      engine.setAttribute('aria-label', 'LaTeX engine');
      for (const [value, name] of [['pdflatex', 'pdfLaTeX'], ['xelatex', 'XeLaTeX']]) {
        const option = element('option', name);
        option.value = value;
        engine.append(option);
      }
      const feedback = element('pre', '', 'latex-feedback error');
      feedback.setAttribute('role', 'alert');
      feedback.hidden = true;
      let compiledEngine;
      let showingPdf = false;
      const toggle = button('Render PDF', async () => {
        feedback.hidden = true;
        if (showingPdf) {
          showSource();
          return;
        }
        if (compiledEngine !== engine.value) {
          toggle.textContent = 'Compiling…';
          engine.disabled = true;
          const query = new URLSearchParams({ engine: engine.value });
          if (route.path) query.set('path', route.path);
          try {
            const response = await fetch(prefix + '/latex?' + query, {
              method: 'POST', headers: { 'X-TempChat': '1' },
            });
            if (!response.ok) {
              const error = await response.json().catch(() => null);
              throw new Error(error?.error ?? 'The compiler did not return a PDF.');
            }
            const pdf = await response.blob();
            const { pdfPreview } = await import('./pdf-preview.js');
            if (ticket !== generation) return;
            if (pdf.type !== 'application/pdf') throw new Error('The compiler did not return a PDF.');
            activePdf?.dispose();
            activePdf = pdfPreview({ blob: pdf }, filename.replace(/\.tex$/i, '') + '.pdf');
            compiledEngine = engine.value;
          } catch (error) {
            if (ticket === generation) {
              feedback.textContent = error.message;
              feedback.hidden = false;
              toggle.textContent = 'Render PDF';
            }
            return;
          } finally {
            engine.disabled = false;
          }
        }
        showingPdf = true;
        toggle.textContent = 'Source';
        body.replaceChildren(activePdf.panel);
      });
      engine.addEventListener('change', () => {
        feedback.hidden = true;
        if (showingPdf) showSource();
      });
      actions.push(engine, toggle);
      content.replaceChildren(feedback, body);

      function showSource() {
        showingPdf = false;
        toggle.textContent = compiledEngine === engine.value ? 'View PDF' : 'Render PDF';
        body.replaceChildren(source());
      }
    } else {
      content.replaceChildren(body);
    }
    if (!binary) actions.push(iconControl(button('', () => copyText(preview.text, 'Copied.'), 'quiet'), 'copy', 'Copy content'));
    setSourceInfo(label, ...actions);

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
    const output = element('div', '', 'diff-output');
    const modes = element('div', '', 'segmented');
    modes.setAttribute('aria-label', 'Diff layout');
    const splitButton = button('Side by side', () => { split = true; draw(); });
    const unifiedButton = button('Unified', () => { split = false; draw(); });
    modes.append(splitButton, unifiedButton);
    setSourceInfo(versionLabel(route.from) + ' to ' + versionLabel(route.version), modes);
    content.replaceChildren(output);
    draw();

    function draw() {
      splitButton.setAttribute('aria-pressed', String(split));
      unifiedButton.setAttribute('aria-pressed', String(!split));
      output.replaceChildren(diffContent(result, route.from, route.version, split));
    }
  }

  function renderEditor(preview, ticket, fileLanguage) {
    const { asset, route, prefix } = active;
    const form = element('form', '', 'asset-editor');
    let language;
    if (asset.kind === 'code') {
      language = $('language').cloneNode(true);
      language.id = 'version-language';
      language.setAttribute('aria-label', 'Language');
      selectLanguage(language, preview.lang);
    }
    const { summary, grid, field: code, position } = codeEditor(preview.text, language, fileLanguage);
    setSourceInfo(summary, ...(language ? [language] : []));
    const footer = element('footer', '', 'editor-footer');
    const note = element('input', '', 'editor-note');
    note.maxLength = 200;
    note.placeholder = 'Optional change note';
    note.setAttribute('aria-label', note.placeholder);
    const actions = element('div', '', 'editor-actions');
    const submit = iconControl(element('button', '', 'primary'), 'check', 'Save', true);
    submit.type = 'submit';
    const error = element('div', '', 'error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    actions.append(iconControl(link('', assetHash({ ...route, mode: 'preview' }), 'button quiet'), 'close', 'Cancel editing'), submit);
    footer.append(error, note, position, actions);
    form.append(grid, footer);
    content.replaceChildren(form);
    code.focus();
    formAction(form, async () => {
      const data = { text: code.value, note: note.value, ...(language ? { lang: language.value } : {}) };
      const saved = await request(prefix + '/edit' + queryPath(route.path), {
        method: 'POST',
        data,
      });
      afterWrite();
      if (ticket === generation) go({ version: saved.num, mode: 'preview' });
    }, (message, _isError, failure) => {
      error.replaceChildren(element('p', message));
      if (failure?.status === 409) {
        error.append(button('Open latest version', async () => {
          assetCache = await request(base + 'assets/' + asset.id);
          if (ticket === generation) go({ version: assetCache.history[0].num, mode: 'preview' });
        }));
      }
      error.hidden = false;
    });
  }

  return { open, navigate };
}
