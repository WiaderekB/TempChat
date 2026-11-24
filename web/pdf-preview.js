import { element, link } from './ui.js';
import { AnnotationMode, getDocument, GlobalWorkerOptions } from './vendor/pdfjs/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

export function pdfPreview(pdf, filename) {
  const panel = element('div', '', 'latex-preview');
  const toolbar = element('div', '', 'latex-actions');
  const status = element('span', 'Loading PDF preview…', 'muted');
  status.setAttribute('role', 'status');
  const previous = element('button', 'Previous');
  const next = element('button', 'Next');
  previous.type = next.type = 'button';
  previous.hidden = next.hidden = true;
  const url = URL.createObjectURL(pdf);
  const download = link('Download PDF', url);
  download.download = filename;
  const open = link('Open PDF', url);
  open.target = '_blank';
  open.rel = 'noopener';
  toolbar.append(previous, status, next, download, open);
  const canvas = element('canvas', '', 'latex-page');
  canvas.setAttribute('role', 'img');
  canvas.hidden = true;
  panel.append(toolbar, canvas);

  let page = 1;
  let document;
  let loading;
  let disposed = false;

  previous.addEventListener('click', () => { void draw(page - 1); });
  next.addEventListener('click', () => { void draw(page + 1); });
  void load();

  async function load() {
    try {
      const data = new Uint8Array(await pdf.arrayBuffer());
      if (disposed) return;
      loading = getDocument({ data, disableFontFace: true, useWasm: false, maxImageSize: 16_000_000 });
      document = await loading.promise;
      if (!disposed) await draw(1);
    } catch {
      if (!disposed) status.textContent = 'PDF preview could not load.';
    }
  }

  async function draw(number) {
    previous.disabled = next.disabled = true;
    try {
      const sheet = await document.getPage(number);
      if (disposed) return;
      const size = sheet.getViewport({ scale: 1 });
      const viewport = sheet.getViewport({ scale: Math.min(2, 1280 / size.width, 1800 / size.height) });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await sheet.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
      if (disposed) return;
      page = number;
      status.textContent = 'Page ' + page + ' of ' + document.numPages;
      canvas.setAttribute('aria-label', status.textContent);
      canvas.hidden = false;
      previous.hidden = next.hidden = document.numPages === 1;
    } catch {
      if (!disposed) status.textContent = 'This page could not be rendered.';
    } finally {
      previous.disabled = page <= 1;
      next.disabled = page >= document.numPages;
    }
  }

  return {
    panel,
    dispose() {
      disposed = true;
      URL.revokeObjectURL(url);
      loading?.destroy().catch(() => {});
    },
  };
}
