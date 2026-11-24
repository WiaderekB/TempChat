export const $ = (id) => document.getElementById(id);

export function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
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
      ? 'Przesyłka przekracza limit serwera.' : 'Serwer nie odpowiedział poprawnie.'));
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
    feedback(error.message, true);
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
    actions.append(button('Anuluj', () => modal.el.close()));
  });
}

export async function copyText(value, label = 'Skopiowano.') {
  try {
    await navigator.clipboard.writeText(value);
    notify(label);
  } catch {
    const { body } = present('Skopiuj tekst');
    const field = element('textarea');
    field.value = value;
    field.readOnly = true;
    field.setAttribute('aria-label', 'Tekst do skopiowania');
    body.append(field);
    field.select();
  }
}

export function dateTime(epoch) {
  return new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'short', timeStyle: 'short',
  }).format(epoch * 1000);
}

const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(\b(?:and|as|async|await|break|case|catch|class|const|continue|def|else|except|false|False|finally|for|from|function|if|import|in|let|new|None|null|or|pass|private|public|raise|return|static|throw|true|True|try|var|void|while|with|yield)\b)|(\b\d+(?:\.\d+)?\b)/g;

export function codeBlock(source, language, diff = false) {
  const wrap = element('div', '', 'code-card');
  const tools = element('div', '', 'code-tools');
  const pre = element('pre');
  const code = element('code');
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', diff ? 'Różnice między wersjami' : 'Podgląd kodu');
  tools.append(element('span', diff ? 'Różnice' : language || 'Kod'), button('Kopiuj', () => copyText(source)));
  if (diff) {
    for (const line of source.split(/(?<=\n)/)) {
      const style = line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : '';
      code.append(style ? element('span', line, style) : document.createTextNode(line));
    }
  } else if (language && source.length < 32000) {
    let offset = 0;
    for (const match of source.matchAll(tokens)) {
      if (match.index > offset) code.append(source.slice(offset, match.index));
      const style = ['string', 'comment', 'keyword', 'number'][match.slice(1).findIndex(Boolean)];
      code.append(element('span', match[0], 'syntax-' + style));
      offset = match.index + match[0].length;
    }
    code.append(source.slice(offset));
  } else {
    code.textContent = source;
  }
  pre.append(code);
  wrap.append(tools, pre);
  return wrap;
}
