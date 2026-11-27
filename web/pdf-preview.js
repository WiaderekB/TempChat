import { element, link, iconControl } from './ui.js';
import { AnnotationMode, getDocument, GlobalWorkerOptions } from './vendor/pdfjs/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

export function pdfPreview({ blob, url }, filename) {
  const panel = element('div');
  panel.tabIndex = 0;
  panel.setAttribute('aria-label', 'PDF viewer');
  const toolbar = element('div', '', 'pdf-actions');
  const status = element('span', 'Loading PDF preview…', 'muted');
  status.setAttribute('role', 'status');
  const previous = iconControl(element('button', '', 'quiet'), 'left', 'Previous page');
  const next = iconControl(element('button', '', 'quiet'), 'right', 'Next page');
  previous.type = next.type = 'button';
  previous.hidden = next.hidden = true;
  const pages = element('div', '', 'pdf-tools');
  pages.append(previous, status, next);
  const zoom = element('div', '', 'pdf-tools pdf-zoom');
  const decrease = iconControl(element('button', '', 'quiet'), 'minus', 'Zoom out');
  const increase = iconControl(element('button', '', 'quiet'), 'plus', 'Zoom in');
  const reset = element('button', '', 'quiet');
  decrease.type = increase.type = reset.type = 'button';
  reset.title = 'Fit to width';
  zoom.append(decrease, reset, increase);
  zoom.hidden = true;
  toolbar.append(pages, zoom);
  const objectUrl = blob ? URL.createObjectURL(blob) : undefined;
  if (objectUrl) {
    const download = link('Download PDF', objectUrl);
    download.download = filename;
    const open = link('Open PDF', objectUrl);
    open.target = '_blank';
    open.rel = 'noopener';
    toolbar.append(download, open);
  }
  const canvas = element('canvas', '', 'pdf-page');
  canvas.setAttribute('role', 'img');
  canvas.hidden = true;
  const sheet = element('div', '', 'pdf-sheet');
  sheet.append(canvas);
  panel.append(toolbar, sheet);

  let page = 1;
  let scale = 100;
  let document;
  let loading;
  let disposed = false;
  let drawing = false;

  previous.addEventListener('click', () => { void draw(page - 1); });
  next.addEventListener('click', () => { void draw(page + 1); });
  decrease.addEventListener('click', () => setZoom(scale - 25));
  increase.addEventListener('click', () => setZoom(scale + 25));
  reset.addEventListener('click', () => setZoom(100));
  panel.addEventListener('keydown', (event) => {
    if (!document || drawing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    const target = page + step;
    if (!step || target < 1 || target > document.numPages) return;
    event.preventDefault();
    void draw(target);
  });
  setZoom(100);
  void load();

  function setZoom(percent) {
    scale = Math.min(250, Math.max(25, percent));
    canvas.style.setProperty('--pdf-zoom', scale / 100);
    reset.textContent = scale + '%';
    reset.setAttribute('aria-label', 'Fit to width, current zoom ' + scale + '%');
    decrease.disabled = scale === 25;
    increase.disabled = scale === 250;
  }

  async function load() {
    try {
      const input = blob ? { data: new Uint8Array(await blob.arrayBuffer()) } : { url };
      if (disposed) return;
      loading = getDocument({ ...input, disableFontFace: true, useSystemFonts: true, useWasm: false, maxImageSize: 16_000_000 });
      document = await loading.promise;
      if (!disposed) await draw(1);
    } catch {
      if (!disposed) status.textContent = 'PDF preview could not load.';
    }
  }

  async function draw(number) {
    drawing = true;
    previous.disabled = next.disabled = true;
    try {
      const sheet = await document.getPage(number);
      if (disposed) return;
      const size = sheet.getViewport({ scale: 1 });
      const viewport = sheet.getViewport({ scale: Math.min(4, 2560 / size.width, 2800 / size.height) });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await sheet.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
      if (disposed) return;
      page = number;
      status.textContent = 'Page ' + page + ' of ' + document.numPages;
      canvas.setAttribute('aria-label', status.textContent);
      canvas.hidden = false;
      zoom.hidden = false;
      previous.hidden = next.hidden = document.numPages === 1;
      panel.closest('.asset-content')?.scrollTo({ top: 0 });
    } catch {
      if (!disposed) status.textContent = 'This page could not be rendered.';
    } finally {
      drawing = false;
      previous.disabled = page <= 1;
      next.disabled = page >= document.numPages;
    }
  }

  return {
    panel,
    dispose() {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      loading?.destroy().catch(() => {});
    },
  };
}
