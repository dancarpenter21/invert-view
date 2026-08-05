import type { Extension } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';

export type IntegratedTextEditor = {
  destroy(): void;
  focus(): void;
  getContent(): string;
  replaceContent(content: string): void;
};

type EditorOptions = {
  container: HTMLElement;
  content: string;
  fileName: string;
  mime: string;
  onChange: (content: string) => void;
  onSave: () => void;
  onMessage: (message: string) => void;
};

const extensionFor = (name: string) => name.toLowerCase().split('.').at(-1) || '';

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
  let replacing = false; let previewTimer: number | undefined; let previewActive = false; let previewVersion = 0;
  const view = new EditorView({ parent: host, doc: options.content, extensions: [basicSetup, editorTheme, EditorView.contentAttributes.of({ 'aria-label': `Editor for ${options.fileName}`, spellcheck: 'false' }), ...(await languageFor(options.fileName, options.mime)), EditorView.updateListener.of((update) => { if (!update.docChanged || replacing) return; const content = update.state.doc.toString(); options.onChange(content); if (previewActive) { window.clearTimeout(previewTimer); previewTimer = window.setTimeout(() => void renderPreview(), 150); } })] });

  async function renderPreview(): Promise<void> {
    const preview = options.container.querySelector<HTMLElement>('.markdown-preview'); if (!preview) return; const version = ++previewVersion; preview.setAttribute('aria-busy', 'true');
    try {
      const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]); const rendered = await marked.parse(view.state.doc.toString().replace(/^[\u200B-\u200F\uFEFF]/, ''), { gfm: true }); if (version !== previewVersion) return; preview.innerHTML = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
      preview.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => { const href = link.getAttribute('href') || ''; if (/^(?:https?:|mailto:)/i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; } });
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
    replaceContent: (content) => { replacing = true; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } }); replacing = false; options.onChange(content); if (previewActive) void renderPreview(); },
  };
}
