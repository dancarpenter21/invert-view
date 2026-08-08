import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { hoverTooltip } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { basicSetup, EditorView } from 'codemirror';

export type IntegratedTextEditor = {
  destroy(): void;
  focus(): void;
  getContent(): string;
  replaceContent(content: string, options?: { preserveView?: boolean }): void;
  setReadOnly(readOnly: boolean): void;
};

type EditorOptions = {
  container: HTMLElement;
  content: string;
  fileName: string;
  filePath: string;
  mime: string;
  readOnly?: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onMessage: (message: string) => void;
};

const extensionFor = (name: string) => name.toLowerCase().split('.').at(-1) || '';

function markdownImageUrl(documentPath: string, reference: string): string | null {
  let referencedPath: string;
  try { referencedPath = decodeURIComponent(reference.split(/[?#]/, 1)[0]); }
  catch { return null; }
  if (!referencedPath || referencedPath.includes('\0')) return null;
  const segments = referencedPath.startsWith('/') ? [] : documentPath.split('/').slice(0, -1);
  for (const segment of referencedPath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!segments.length) return null; segments.pop(); }
    else segments.push(segment);
  }
  let path = segments.join('/'); if (!/\.inv$/i.test(path)) path += '.inv';
  return `/api/media?path=${encodeURIComponent(path)}`;
}

type ImageHoverTarget = { from: number; to: number; reference: string };

function markdownImageTargetAt(view: EditorView, node: SyntaxNode | null): ImageHoverTarget | null {
  while (node && node.name !== 'Link' && node.name !== 'Image') node = node.parent;
  if (!node) return null;
  const url = node.getChild('URL');
  if (!url) return null;
  let reference = view.state.sliceDoc(url.from, url.to);
  if (reference.startsWith('<') && reference.endsWith('>')) reference = reference.slice(1, -1);
  reference = reference.replace(/\\([!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-])/g, '$1');
  return { from: node.from, to: node.to, reference };
}

function htmlImageTargetAt(view: EditorView, node: SyntaxNode | null): ImageHoverTarget | null {
  let container = node;
  while (container && container.name !== 'Element' && container.name !== 'OpenTag' && container.name !== 'SelfClosingTag') container = container.parent;
  if (!container) return null;
  const tag = container.name === 'Element' ? container.getChild('OpenTag') || container.getChild('SelfClosingTag') : container;
  const tagName = tag?.getChild('TagName'); if (!tag || !tagName) return null;
  const name = view.state.sliceDoc(tagName.from, tagName.to).toLowerCase(); const attributeName = name === 'img' ? 'src' : name === 'a' ? 'href' : ''; if (!attributeName) return null;
  for (const attribute of tag.getChildren('Attribute')) {
    const key = attribute.getChild('AttributeName'); const value = attribute.getChild('AttributeValue') || attribute.getChild('UnquotedAttributeValue'); if (!key || !value || view.state.sliceDoc(key.from, key.to).toLowerCase() !== attributeName) continue;
    let reference = view.state.sliceDoc(value.from, value.to); if ((reference.startsWith('"') && reference.endsWith('"')) || (reference.startsWith("'") && reference.endsWith("'"))) reference = reference.slice(1, -1);
    return { from: container.from, to: container.to, reference };
  }
  return null;
}

function imageHoverTargetAt(view: EditorView, position: number, side: -1 | 1): ImageHoverTarget | null {
  const node = syntaxTree(view.state).resolveInner(position, side);
  return markdownImageTargetAt(view, node) || htmlImageTargetAt(view, node);
}

function markdownImageHover(documentPath: string): Extension {
  return hoverTooltip(async (view, position, side) => {
    const target = imageHoverTargetAt(view, position, side); if (!target || target.reference.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target.reference)) return null;
    let referencedPath: string; try { referencedPath = decodeURIComponent(target.reference.split(/[?#]/, 1)[0]); } catch { return null; }
    if (!/\.inv$/i.test(referencedPath)) return null;
    const source = markdownImageUrl(documentPath, target.reference); if (!source) return null;
    const image = await new Promise<HTMLImageElement | null>((resolve) => { const candidate = new Image(); candidate.onload = () => resolve(candidate); candidate.onerror = () => resolve(null); candidate.src = source; });
    if (!image) return null;
    image.alt = `Preview of ${target.reference}`;
    return {
      pos: target.from, end: target.to, above: true,
      create: () => {
        const dom = document.createElement('div'); dom.className = 'cm-markdown-image-preview';
        dom.append(image);
        return { dom };
      },
    };
  }, { hoverTime: 250, hideOnChange: true });
}

async function languageFor(fileName: string, mime: string): Promise<Extension[]> {
  const extension = extensionFor(fileName);
  if (mime === 'text/markdown' || extension === 'md') return [(await import('@codemirror/lang-markdown')).markdown()];
  if (mime === 'application/json' || extension === 'json') return [(await import('@codemirror/lang-json')).json()];
  if (mime === 'text/html' || extension === 'html') return [(await import('@codemirror/lang-html')).html()];
  if (mime === 'text/css' || extension === 'css') return [(await import('@codemirror/lang-css')).css()];
  if (mime === 'text/javascript' || extension === 'js' || extension === 'ts') return [(await import('@codemirror/lang-javascript')).javascript({ typescript: extension === 'ts' })];
  if (mime === 'application/xml' || extension === 'xml') return [(await import('@codemirror/lang-xml')).xml()];
  if (mime === 'text/yaml' || extension === 'yaml' || extension === 'yml') return [(await import('@codemirror/lang-yaml')).yaml()];
  return [];
}

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#111214', color: '#e7e8ea', fontSize: '12px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: '1.55' },
  '.cm-content': { minHeight: '100%', padding: '12px 0', caretColor: '#d8ff49' },
  '.cm-line': { padding: '0 14px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#d8ff49' },
  '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#59622688' },
  '.cm-gutters': { backgroundColor: '#17181b', color: '#686a72', borderRight: '1px solid #292b30' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#1b1d1a' },
  '.cm-foldPlaceholder': { backgroundColor: '#24262a', borderColor: '#3b3d42', color: '#bfc1c6' },
  '.cm-panels': { backgroundColor: '#1b1c20', color: '#e8e9eb' },
  '.cm-panels input': { backgroundColor: '#111214', color: '#e8e9eb', border: '1px solid #383a40' },
}, { dark: true });

export async function createIntegratedTextEditor(options: EditorOptions): Promise<IntegratedTextEditor> {
  const markdown = options.mime === 'text/markdown' || extensionFor(options.fileName) === 'md';
  options.container.innerHTML = `<div class="integrated-editor${markdown ? ' markdown-editor' : ''}">${markdown ? '<div class="text-view-tabs" role="tablist" aria-label="Markdown view"><button id="text-editor-tab" type="button" role="tab" class="active" aria-selected="true" aria-controls="text-editor-panel" data-text-view="editor">Editor</button><button id="text-preview-tab" type="button" role="tab" tabindex="-1" aria-selected="false" aria-controls="text-preview-panel" data-text-view="preview">Preview</button></div>' : ''}<div class="code-editor-host" id="text-editor-panel" data-text-panel="editor"${markdown ? ' role="tabpanel" aria-labelledby="text-editor-tab"' : ''}></div>${markdown ? '<article class="markdown-preview" id="text-preview-panel" data-text-panel="preview" role="tabpanel" aria-labelledby="text-preview-tab" hidden></article>' : ''}</div>`;
  const root = options.container.querySelector<HTMLElement>('.integrated-editor'); const host = options.container.querySelector<HTMLElement>('.code-editor-host'); if (!root || !host) throw new Error('The integrated editor could not be created.');
  let replacing = false; let previewTimer: number | undefined; let previewActive = false; let previewVersion = 0; const readOnly = new Compartment();
  const readOnlyExtensions = (value: boolean) => [EditorState.readOnly.of(value), EditorView.editable.of(!value)];
  const view = new EditorView({ parent: host, doc: options.content, extensions: [basicSetup, editorTheme, readOnly.of(readOnlyExtensions(Boolean(options.readOnly))), EditorView.contentAttributes.of({ 'aria-label': `Editor for ${options.fileName}`, spellcheck: 'false' }), ...(await languageFor(options.fileName, options.mime)), ...(markdown ? [markdownImageHover(options.filePath)] : []), EditorView.updateListener.of((update) => { if (!update.docChanged || replacing) return; const content = update.state.doc.toString(); options.onChange(content); if (previewActive) { window.clearTimeout(previewTimer); previewTimer = window.setTimeout(() => void renderPreview(), 150); } })] });

  async function renderPreview(): Promise<void> {
    const preview = options.container.querySelector<HTMLElement>('.markdown-preview'); if (!preview) return; const version = ++previewVersion; preview.setAttribute('aria-busy', 'true');
    try {
      const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]); const rendered = await marked.parse(view.state.doc.toString().replace(/^[\u200B-\u200F\uFEFF]/, ''), { gfm: true }); if (version !== previewVersion) return; const sanitized = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true });
      sanitized.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => { const source = image.getAttribute('src') || ''; if (!source || source.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(source)) return; const url = markdownImageUrl(options.filePath, source); if (url) image.src = url; else image.removeAttribute('src'); });
      sanitized.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => { const href = link.getAttribute('href') || ''; if (/^(?:https?:|mailto:)/i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; } });
      preview.replaceChildren(sanitized);
    } catch (error) { if (version === previewVersion) preview.textContent = error instanceof Error ? `Preview failed: ${error.message}` : 'Preview failed.'; }
    finally { if (version === previewVersion) preview.removeAttribute('aria-busy'); }
  }

  root.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); options.onSave(); } });
  root.addEventListener('click', (event) => { const link = (event.target as Element).closest<HTMLAnchorElement>('.markdown-preview a[href]'); if (!link) return; const href = link.getAttribute('href') || ''; if (href.startsWith('#') || /^(?:https?:|mailto:)/i.test(href)) return; event.preventDefault(); options.onMessage('Relative Markdown links are not available in preview.'); });
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-text-view]')]; const activateTab = (button: HTMLButtonElement) => { const requested = button.dataset.textView || 'editor'; previewActive = requested === 'preview'; tabs.forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; }); root.querySelectorAll<HTMLElement>('[data-text-panel]').forEach((panel) => { panel.hidden = panel.dataset.textPanel !== requested; }); if (previewActive) void renderPreview(); else view.focus(); };
  tabs.forEach((button) => { button.addEventListener('click', () => activateTab(button)); button.addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const current = tabs.indexOf(button); const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)! : tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; activateTab(target); target.focus(); }); });

  view.focus();
  return {
    destroy: () => { window.clearTimeout(previewTimer); previewVersion += 1; view.destroy(); },
    focus: () => view.focus(),
    getContent: () => view.state.doc.toString(),
    setReadOnly: (value) => view.dispatch({ effects: readOnly.reconfigure(readOnlyExtensions(value)) }),
    replaceContent: (content, replaceOptions = {}) => {
      const scrollTop = view.scrollDOM.scrollTop; const scrollLeft = view.scrollDOM.scrollLeft; const nextLength = content.length;
      const selection = replaceOptions.preserveView ? EditorSelection.create(view.state.selection.ranges.map((range) => EditorSelection.range(Math.min(range.anchor, nextLength), Math.min(range.head, nextLength))), view.state.selection.mainIndex) : undefined;
      replacing = true; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, ...(selection ? { selection } : {}) }); replacing = false;
      if (replaceOptions.preserveView) { view.scrollDOM.scrollTop = scrollTop; view.scrollDOM.scrollLeft = scrollLeft; window.requestAnimationFrame(() => { view.scrollDOM.scrollTop = scrollTop; view.scrollDOM.scrollLeft = scrollLeft; }); }
      if (previewActive) void renderPreview();
    },
  };
}
