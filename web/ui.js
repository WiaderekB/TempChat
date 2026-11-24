export const $ = (id) => document.getElementById(id);

export function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const iconPaths = {
  edit: 'M13.5 6.5 17.5 10.5M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11Z',
  copy: 'M8 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M18 6 6 18',
  attach: 'm8 13 7-7a2.1 2.1 0 0 1 3 3l-9 9a4.25 4.25 0 0 1-6-6l9-9a6.4 6.4 0 0 1 9 9l-8 8',
  folder: 'M3 6h6l2 2h10v11H3Z',
  file: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6m-6 4h6',
  code: 'm8 6-5 6 5 6m8-12 5 6-5 6m-3-14-2 16',
  table: 'M3 4h18v16H3Zm0 5h18M3 14h18M9 9v11m6-11v11',
  image: 'M3 4h18v16H3Zm0 13 5-5 4 4 3-3 6 6m-6-11h.01',
  minus: 'M5 12h14',
  plus: 'M5 12h14m-7-7v14',
  left: 'm15 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  diff: 'M4 6h16v12H4ZM7 10h4m-2-2v4m4 3h4',
  split: 'M3 5h18v14H3Zm9 0v14M6 9h3m6 0h3M6 13h3m6 0h3',
  unified: 'M4 5h16v14H4Zm3 4h10M7 12h7m-7 3h10',
  link: 'M10 13a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.5-5.7l-1.7 1.6m2.2 4.6a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.5 5.7l1.7-1.6',
  history: 'M3 11a9 9 0 1 1 2 6m-2-12v6h6m3-4v5l3 2',
};

export function glyph(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [attr, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(attr, value);
  }
  svg.classList.add('glyph');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', iconPaths[name]);
  svg.append(path);
  return svg;
}

export function iconControl(control, icon, label, showLabel = false) {
  control.replaceChildren(glyph(icon), ...(showLabel ? [label] : []));
  control.title = label;
  control.setAttribute('aria-label', label);
  control.classList.toggle('icon-control', !showLabel);
  return control;
}

export function button(label, action, className = '') {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', () => run(node, action));
  return node;
}

export function link(label, target, className = 'button') {
  const node = element('a', label, className);
  node.href = target;
  return node;
}

export async function request(path, options = {}) {
  const { method = 'GET', data } = options;
  const response = await fetch(path, {
    method,
    headers: {
      'X-TempChat': '1',
      ...(data instanceof Blob ? { 'Content-Type': 'application/octet-stream' }
        : data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: data instanceof Blob ? data : data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) {
    const error = new Error(result?.error ?? (response.status === 413
      ? 'The upload exceeds the server limit.' : 'The server returned an unexpected response.'));
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function run(control, action, feedback = notify) {
  if (control.disabled) return;
  control.disabled = true;
  try {
    await action();
  } catch (error) {
    feedback(error.message, true, error);
  } finally {
    control.disabled = false;
  }
}

export function formAction(form, action, feedback) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run(form.querySelector('button[type=submit]'), action, feedback);
  });
}

let noticeTimer;

export function notify(message, isError = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.classList.toggle('is-error', isError);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4800);
}

export function showError(node, message = '') {
  node.textContent = message;
  node.hidden = !message;
}

const dialog = $('dialog');

export function present(title) {
  $('dialog-title').textContent = title;
  const body = element('div');
  const feedback = element('p', '', 'error dialog-feedback');
  feedback.role = 'alert';
  feedback.hidden = true;
  $('dialog-body').replaceChildren(feedback, body);
  if (!dialog.open) dialog.showModal();
  return { body, error: (message) => showError(feedback, message), el: dialog };
}

$('close-dialog').addEventListener('click', () => dialog.close());

export function choose(title, message, options, detail) {
  const modal = present(title);
  const actions = element('div', '', 'small-actions');
  modal.body.append(element('p', message));
  if (detail) modal.body.append(detail);
  modal.body.append(actions);
  return new Promise((resolve) => {
    let selection;
    modal.el.addEventListener('close', () => resolve(selection), { once: true });
    for (const [value, label, style] of options) {
      actions.append(button(label, () => {
        selection = value;
        modal.el.close();
      }, style));
    }
    actions.append(button('Cancel', () => modal.el.close()));
  });
}

export async function copyText(value, label = 'Copied.') {
  try {
    await navigator.clipboard.writeText(value);
    notify(label);
  } catch {
    const { body } = present('Copy text');
    const field = element('textarea');
    field.value = value;
    field.readOnly = true;
    field.setAttribute('aria-label', 'Text to copy');
    body.append(field);
    field.select();
  }
}

export function dateTime(epoch) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short', timeStyle: 'short',
  }).format(epoch * 1000);
}

export function formatBytes(size) {
  if (size < 1024) return size + ' B';
  const scale = size < 1024 ** 2 ? 1024 : 1024 ** 2;
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(size / scale)
    + (scale === 1024 ? ' KiB' : ' MiB');
}

export const assetIcons = { folder: '▱', file: '▤', code: '</>' };

export function languageLabel(value) {
  if (value === 'latex') return 'LaTeX';
  return Array.from($('language').options).find((option) => option.value === value)?.textContent ?? value;
}

export function selectLanguage(select, value) {
  if (!Array.from(select.options).some((option) => option.value === value)) {
    const option = element('option', value);
    option.value = value;
    select.append(option);
  }
  select.value = value;
}

export function snippetPicker(field, list, onSelect) {
  let choices = [];
  let matches = [];
  let selected;
  let active = -1;
  let open = false;
  let signature;
  const searchKey = (name) => name.normalize('NFC').trim().toLowerCase();

  function clearActive() {
    list.children[active]?.removeAttribute('aria-selected');
    field.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function render() {
    const query = searchKey(field.value);
    matches = choices.filter((snippet) => searchKey(snippet.name).includes(query));
    clearActive();
    const options = document.createDocumentFragment();
    for (const [index, snippet] of matches.entries()) {
      const option = element('li', '', 'snippet-option');
      option.id = 'snippet-option-' + snippet.id;
      option.role = 'option';
      option.dataset.index = index;
      option.append(element('span', snippet.name), element('span', languageLabel(snippet.lang), 'muted'));
      options.append(option);
    }
    list.replaceChildren(options);
    list.hidden = !matches.length;
    field.setAttribute('aria-expanded', String(!list.hidden));
  }

  function close() {
    open = false;
    clearActive();
    list.hidden = true;
    field.setAttribute('aria-expanded', 'false');
  }

  function show() {
    open = true;
    render();
  }

  function choose(snippet) {
    const previous = selected;
    selected = snippet;
    if (snippet) field.value = snippet.name;
    if (snippet || previous) onSelect(snippet, previous);
    close();
  }

  field.addEventListener('focus', show);
  field.addEventListener('click', () => { if (!open) show(); });
  field.addEventListener('blur', close);
  field.addEventListener('input', () => {
    if (selected && field.value !== selected.name) choose();
    show();
  });
  field.addEventListener('keydown', (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open) show();
      if (!matches.length) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = active < 0 && direction < 0 ? matches.length - 1
        : (active + direction + matches.length) % matches.length;
      clearActive();
      active = next;
      const option = list.children[active];
      option.setAttribute('aria-selected', 'true');
      field.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
  });
  list.addEventListener('mousedown', (event) => {
    if (event.target.closest('[role=option]')) event.preventDefault();
  });
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role=option]');
    if (option) choose(matches[Number(option.dataset.index)]);
  });

  return {
    get selected() { return selected; },
    update(snippets) {
      const next = JSON.stringify(snippets.map(({ id, name, lang }) => [id, name, lang]));
      if (next === signature) return;
      signature = next;
      choices = snippets;
      if (open) render();
    },
    reset() {
      field.value = '';
      choose();
    },
    close,
  };
}

const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(\b(?:and|as|async|await|break|case|catch|class|const|continue|def|else|except|false|False|finally|for|from|function|if|import|in|let|new|None|null|or|pass|private|public|raise|return|static|throw|true|True|try|var|void|while|with|yield)\b)|(\b\d+(?:\.\d+)?\b)/g;

const latexTokens = /(\\(?:[A-Za-z@]+|[^\r\n]))|(%[^\r\n]*)|(\$\$?|[{}\[\]&_^])|(\b\d+(?:\.\d+)?\b)/g;

export function highlightSource(code, source, language) {
  if (language && source.length < 32000) {
    const latex = language === 'tex' || language === 'latex';
    const styles = latex ? ['keyword', 'comment', 'delimiter', 'number'] : ['string', 'comment', 'keyword', 'number'];
    let offset = 0;
    for (const match of source.matchAll(latex ? latexTokens : tokens)) {
      if (match.index > offset) code.append(source.slice(offset, match.index));
      const style = styles[match.slice(1).findIndex(Boolean)];
      code.append(element('span', match[0], 'syntax-' + style));
      offset = match.index + match[0].length;
    }
    code.append(source.slice(offset));
  } else {
    code.textContent = source;
  }
}

export function codeBlock(source, language, { heading } = {}) {
  const wrap = element('div', '', 'code-card');
  const tools = element('div', '', 'code-tools');
  const labels = element('div', '', 'code-labels');
  const pre = element('pre');
  const code = element('code');
  let visible = source;
  if (heading) {
    labels.append(heading);
    const excerpt = source.split('\n', 9).slice(0, 8).join('\n').slice(0, 6000);
    if (excerpt.length < source.trimEnd().length) visible = excerpt + '\n…';
  }
  if (!heading || language) labels.append(element('span', languageLabel(language)));
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'Code preview');
  tools.append(labels, button('Copy', () => copyText(source)));
  highlightSource(code, visible, language);
  pre.append(code);
  wrap.append(tools, pre);
  return wrap;
}
