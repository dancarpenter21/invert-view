import './style.css';
import { BrowserTerminal } from './terminal';
import type { IntegratedTextEditor } from './text-editor';

type FileKind = 'images' | 'videos' | 'other';
type SortOrder = 'ascending' | 'descending';
type ViewMode = 'detailed' | 'small' | 'medium' | 'large';
type CatalogFile = { path: string; name: string; size: number; modified: number; mime: string; kind: FileKind; editableText?: boolean; thumbnail: string | 'pending' | null; frameDurationMs?: number };
type DirectoryEntry = { path: string; name: string; directory: true };
type CatalogEntry = CatalogFile | DirectoryEntry;
type SegmentResult = { outputPath: string; name: string; startMs: number; endMs: number };
type Job = { id: string; type: 'thumbnail' | 'frames' | 'playback' | 'segment'; path: string; status: 'queued' | 'running' | 'complete' | 'failed'; progress: number; error: string | null; createdAt: number; result?: SegmentResult };
type PlaybackResponse = { status: 'ready'; url: string } | { status: 'preparing'; job: Job };
type FrameTimeRange = { sourceName: string; startMs: number; endMs: number };
type LiveServerMessage = { type: 'snapshot'; jobs: Job[] } | { type: 'job'; job: Job } | { type: 'watch-ready' | 'catalog-change'; root: string; directory: string } | { type: 'watch-error'; root: string; directory: string; error: string };

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root is missing.');
const state = { files: [] as CatalogEntry[], selected: null as CatalogFile | null, selectedPaths: new Set<string>(), selectionAnchor: '' as string, query: '', sortOrder: 'ascending' as SortOrder, view: 'detailed' as ViewMode, showHidden: false, previewVisible: false, root: '', directory: '', parentListable: false, hasMore: false, page: 0, total: null as number | null, frameTimeRange: null as FrameTimeRange | null, loadingPage: null as number | null, jobs: [] as Job[], screen: 'catalog' as 'catalog' | 'viewer', textContent: '', textDirty: false, catalogDirty: false, frameOutputDirectory: '', videoOutputDirectory: '' };
const urlFor = (route: string) => route;
const restoredName = (name: string) => name.replace(/\.inv$/i, '');
const mediaUrl = (file: CatalogFile) => urlFor(`/api/media?path=${encodeURIComponent(file.path)}`);
const playbackUrl = (file: CatalogFile) => urlFor(`/api/videos/playback?path=${encodeURIComponent(file.path)}`);
const formatSize = (bytes: number) => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(bytes > 100 * 1024 ** 2 ? 0 : 1)} MB`;
const formatModified = (modified: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(modified);
const formatVideoTime = (milliseconds: number) => { const totalSeconds = Math.max(0, Math.round(milliseconds / 1000)); const hours = Math.floor(totalSeconds / 3600); const minutes = Math.floor(totalSeconds % 3600 / 60); const seconds = totalSeconds % 60; return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`; };
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] || character);
const isDirectory = (entry: CatalogEntry): entry is DirectoryEntry => 'directory' in entry;
const absolutePath = (relativePath: string) => state.root ? `${state.root === '/' ? '' : state.root}${relativePath ? `/${relativePath}` : state.root === '/' ? '/' : ''}` : '';
const absoluteDirectory = () => absolutePath(state.directory);
const absoluteSelectedPath = () => state.selected && state.selectedPaths.has(state.selected.path) ? absolutePath(state.selected.path) : '';

app.innerHTML = `<main class="app-shell viewer-app"><aside class="sidebar"><a class="brand" href="./"><span class="brand-mark">↻</span>UNINVERT</a><section class="sidebar-config" aria-labelledby="configuration-heading"><p class="config-heading" id="configuration-heading">Configuration</p><label class="config-item" for="frame-output-directory"><span>Extracted frame directory</span><input id="frame-output-directory" type="text" autocomplete="off" placeholder="Same folder as video" /><small>Absolute path. Leave blank to save beside the source video.</small></label></section></aside><section class="workspace"><header class="topbar"><div class="crumbs"><span>Files</span><i>/</i><strong id="location-name">All files</strong></div><div class="top-actions"><label class="search" id="search-wrap"><span>⌕</span><input id="search" type="search" placeholder="Search files" /></label></div></header><section class="content" id="catalog-view"><div class="content-head"><div><form class="path-editor" id="path-editor"><div class="path-breadcrumbs" id="path-breadcrumbs" aria-label="Current path"></div><div class="path-input-row"><input id="path-input" autocomplete="off" aria-label="Current path" placeholder="/absolute/path/to/files" /><button class="copy-path" id="copy-path" type="button" aria-label="Copy current path" title="Copy current path">Copy</button></div></form><p id="file-summary">Enter a local folder path to begin.</p></div><div class="view-controls"><button class="preview-toggle" id="preview-toggle" aria-pressed="false">Preview</button><button class="hidden-toggle" id="hidden-toggle" aria-label="Show hidden files" aria-pressed="false">◉</button><button class="up-button" id="up-button">↑ Up</button><button class="sort-button" id="sort-button">Name <span>↓</span></button><div class="view-picker" aria-label="View options"><button class="view-toggle active" data-view="detailed" aria-pressed="true">☷</button><button class="view-toggle" data-view="small" aria-label="Small icons" aria-pressed="false">S</button><button class="view-toggle" data-view="medium" aria-label="Medium icons" aria-pressed="false">M</button><button class="view-toggle" data-view="large" aria-label="Large icons" aria-pressed="false">L</button></div></div></div><div class="drop-zone" id="empty-state"><div class="drop-icon">⇩</div><h2>Open inverted files locally</h2><p>Enter an absolute folder path above.</p></div><div class="file-grid view-detailed" id="file-grid" aria-live="polite"></div></section><section class="content viewer" id="viewer" hidden></section></section><aside class="preview-pane" id="preview-pane"><div class="preview-resizer" id="preview-resizer" role="separator" aria-label="Resize preview pane" aria-orientation="vertical" tabindex="0"></div><div class="preview-empty" id="preview-empty">Select a file to preview it.</div><div id="preview-content" hidden></div></aside></main><menu class="context-menu" id="context-menu" hidden><button id="open-entry">Open</button><button id="copy-entry-path">Copy Path</button><button id="rename-entry">Rename</button><button id="explode-video">Explode into frames</button><button class="danger" id="delete-entry">Delete</button></menu><div class="toast" id="toast" hidden></div><div class="job-status" id="job-status" role="status" aria-live="polite" hidden></div>`;

const applicationShell = app.querySelector<HTMLElement>('.app-shell');
if (!applicationShell) throw new Error('Application shell is missing.');
const viewport = document.createElement('div'); viewport.className = 'application-viewport'; applicationShell.before(viewport); viewport.append(applicationShell);
const terminalDock = document.createElement('section'); terminalDock.className = 'terminal-dock'; terminalDock.setAttribute('aria-label', 'Terminal');
terminalDock.innerHTML = `<div class="terminal-resizer" id="terminal-resizer" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" tabindex="0"></div><header class="terminal-header"><div class="terminal-title"><i></i><strong>Terminal</strong><span id="terminal-status" data-state="connecting">Waiting…</span></div><div class="terminal-actions"><button id="terminal-restart" type="button">New shell here</button><button id="terminal-clear" type="button">Clear</button><button id="terminal-toggle" type="button" aria-label="Toggle terminal" aria-expanded="true"></button></div></header><div class="terminal-host" id="terminal-host"></div>`;
viewport.append(terminalDock);

const find = <T extends Element>(selector: string): T => { const element = app.querySelector<T>(selector); if (!element) throw new Error(`Required element not found: ${selector}`); return element; };
const catalogNewFolderAction = document.createElement('button'); catalogNewFolderAction.id = 'catalog-new-folder'; catalogNewFolderAction.type = 'button'; catalogNewFolderAction.textContent = 'New folder'; catalogNewFolderAction.hidden = true;
const catalogTerminalAction = document.createElement('button'); catalogTerminalAction.id = 'catalog-terminal-here'; catalogTerminalAction.type = 'button'; catalogTerminalAction.textContent = 'Move terminal here'; catalogTerminalAction.hidden = true; find<HTMLElement>('#context-menu').append(catalogNewFolderAction, catalogTerminalAction);
const videoOutputConfig = document.createElement('label'); videoOutputConfig.className = 'config-item'; videoOutputConfig.htmlFor = 'video-output-directory'; videoOutputConfig.innerHTML = '<span>Extracted video directory</span><input id="video-output-directory" type="text" autocomplete="off" placeholder="Same folder as video" /><small>Absolute path. Leave blank to save beside the source video.</small>'; find('.sidebar-config').append(videoOutputConfig);
const extractionJobsPanel = document.createElement('section'); extractionJobsPanel.className = 'sidebar-jobs'; extractionJobsPanel.setAttribute('aria-labelledby', 'extraction-jobs-heading'); extractionJobsPanel.innerHTML = '<div class="sidebar-jobs-heading"><p class="config-heading" id="extraction-jobs-heading">Extraction jobs</p><span id="extraction-job-count">0</span></div><div class="sidebar-job-list" id="extraction-job-list" aria-live="polite"><p class="sidebar-jobs-empty">No extraction jobs yet.</p></div>'; find('.sidebar').append(extractionJobsPanel);
const FRAME_OUTPUT_DIRECTORY_KEY = 'inv-viewer-frame-output-directory'; const frameOutputDirectoryInput = find<HTMLInputElement>('#frame-output-directory');
try { state.frameOutputDirectory = window.localStorage.getItem(FRAME_OUTPUT_DIRECTORY_KEY) || ''; } catch { /* The setting remains available for this session. */ }
frameOutputDirectoryInput.value = state.frameOutputDirectory;
frameOutputDirectoryInput.addEventListener('input', () => { state.frameOutputDirectory = frameOutputDirectoryInput.value; try { window.localStorage.setItem(FRAME_OUTPUT_DIRECTORY_KEY, state.frameOutputDirectory); } catch { /* The setting remains available for this session. */ } });
const VIDEO_OUTPUT_DIRECTORY_KEY = 'inv-viewer-video-output-directory'; const videoOutputDirectoryInput = find<HTMLInputElement>('#video-output-directory');
try { state.videoOutputDirectory = window.localStorage.getItem(VIDEO_OUTPUT_DIRECTORY_KEY) || ''; } catch { /* The setting remains available for this session. */ }
videoOutputDirectoryInput.value = state.videoOutputDirectory;
videoOutputDirectoryInput.addEventListener('input', () => { state.videoOutputDirectory = videoOutputDirectoryInput.value; try { window.localStorage.setItem(VIDEO_OUTPUT_DIRECTORY_KEY, state.videoOutputDirectory); } catch { /* The setting remains available for this session. */ } });
const pathNavigation = document.createElement('div'); pathNavigation.className = 'path-navigation'; const upButton = find<HTMLButtonElement>('#up-button'); upButton.type = 'button'; pathNavigation.append(upButton, find('#path-breadcrumbs')); find('#path-editor').prepend(pathNavigation);
const displayActions = document.createElement('div'); displayActions.className = 'display-actions'; displayActions.append(find('#preview-toggle'), find('#hidden-toggle'), find('#sort-button'), find('.view-picker')); find('.view-controls').append(displayActions);
function createPagination(position: 'top' | 'bottom'): HTMLDivElement { const pagination = document.createElement('div'); pagination.className = `pagination pagination-${position}`; pagination.innerHTML = '<button type="button" data-page="previous">‹ Previous</button><label class="page-jump">Page <input type="number" data-page="jump" min="1" step="1" inputmode="numeric" aria-label="Go to page" /></label><span class="page-summary"></span><span class="page-time" hidden></span><span class="page-loading" aria-live="polite" hidden><i></i> Loading page…</span><button type="button" data-page="next">Next ›</button>'; pagination.hidden = true; return pagination; }
const topPagination = createPagination('top'); const bottomPagination = createPagination('bottom'); find('#empty-state').before(topPagination); find('#catalog-view').append(bottomPagination); const paginations = [topPagination, bottomPagination];
const selectionActions = document.createElement('div'); selectionActions.className = 'selection-actions'; selectionActions.innerHTML = '<span id="selection-count" aria-live="polite"></span><button id="clear-selection" hidden>Clear</button><button id="new-folder">New folder</button><button id="move-selected" disabled>Move</button><button id="delete-selected" disabled>Delete</button>'; find<HTMLElement>('.view-controls').prepend(selectionActions);
const PREVIEW_WIDTH_KEY = 'inv-viewer-preview-width'; const PREVIEW_MIN_WIDTH = 240; const PREVIEW_DEFAULT_WIDTH = 300; let previewPaneWidth = PREVIEW_DEFAULT_WIDTH;
function previewWidthMaximum(): number { const shell = find<HTMLElement>('.app-shell'); const sidebar = find<HTMLElement>('.sidebar'); return Math.max(PREVIEW_MIN_WIDTH, Math.min(640, shell.clientWidth - sidebar.getBoundingClientRect().width - 360)); }
function setPreviewWidth(width: number, persist = true): void { const maximum = previewWidthMaximum(); previewPaneWidth = Math.round(Math.max(PREVIEW_MIN_WIDTH, Math.min(maximum, width))); find<HTMLElement>('.app-shell').style.setProperty('--preview-width', `${previewPaneWidth}px`); const resizer = find<HTMLElement>('#preview-resizer'); resizer.setAttribute('aria-valuemin', String(PREVIEW_MIN_WIDTH)); resizer.setAttribute('aria-valuemax', String(maximum)); resizer.setAttribute('aria-valuenow', String(previewPaneWidth)); resizer.setAttribute('aria-valuetext', `${previewPaneWidth} pixels wide`); if (persist) try { window.localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewPaneWidth)); } catch { /* Resizing still works when local storage is unavailable. */ } }
const previewResizer = find<HTMLElement>('#preview-resizer'); previewResizer.title = 'Drag to resize preview'; let previewResizePointerId: number | null = null;
previewResizer.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); previewResizePointerId = event.pointerId; document.body.classList.add('resizing-preview'); });
document.addEventListener('pointermove', (event) => { if (event.pointerId !== previewResizePointerId) return; event.preventDefault(); setPreviewWidth(find<HTMLElement>('.app-shell').getBoundingClientRect().right - event.clientX, false); });
function finishPreviewResize(event: PointerEvent): void { if (event.pointerId !== previewResizePointerId) return; previewResizePointerId = null; document.body.classList.remove('resizing-preview'); setPreviewWidth(previewPaneWidth); }
document.addEventListener('pointerup', finishPreviewResize); document.addEventListener('pointercancel', finishPreviewResize);
previewResizer.addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const width = event.key === 'Home' ? PREVIEW_MIN_WIDTH : event.key === 'End' ? previewWidthMaximum() : previewPaneWidth + (event.key === 'ArrowLeft' ? 20 : -20); setPreviewWidth(width); });
try { const storedPreviewWidth = Number(window.localStorage.getItem(PREVIEW_WIDTH_KEY)); setPreviewWidth(Number.isFinite(storedPreviewWidth) && storedPreviewWidth > 0 ? storedPreviewWidth : PREVIEW_DEFAULT_WIDTH, false); } catch { setPreviewWidth(PREVIEW_DEFAULT_WIDTH, false); }
window.addEventListener('resize', () => setPreviewWidth(previewPaneWidth, false));
class ApiError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
async function api<T>(route: string, options?: RequestInit): Promise<T> { const response = await fetch(urlFor(route), options); const body = await response.text(); let payload: T & { error?: string }; try { payload = JSON.parse(body) as T & { error?: string }; } catch { throw new ApiError(response.status, response.ok ? 'The local service returned an invalid response.' : `The local service is unavailable (HTTP ${response.status}).`); } if (!response.ok) throw new ApiError(response.status, payload.error || 'The local service could not complete that request.'); return payload; }
let toastTimer: number | undefined;
function toast(message: string): void { const element = find<HTMLDivElement>('#toast'); window.clearTimeout(toastTimer); element.textContent = message; element.hidden = false; toastTimer = window.setTimeout(() => { element.hidden = true; }, 4_000); }
async function copyPathToClipboard(path: string, fallbackInput?: HTMLInputElement): Promise<void> {
  if (!path) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(path);
    else if (fallbackInput) { fallbackInput.focus(); fallbackInput.select(); if (!document.execCommand('copy')) throw new Error('Copy command was unavailable.'); }
    else {
      const helper = document.createElement('textarea'); helper.value = path; helper.style.position = 'fixed'; helper.style.opacity = '0'; document.body.append(helper); helper.focus(); helper.select();
      try { if (!document.execCommand('copy')) throw new Error('Copy command was unavailable.'); } finally { helper.remove(); }
    }
    toast('Path copied to clipboard.');
  } catch { toast('Could not copy the path.'); }
}
async function copyCurrentPath(): Promise<void> { const input = find<HTMLInputElement>('#path-input'); await copyPathToClipboard(input.value.trim(), input); }
function stopPreviewVideo(): void { const video = find<HTMLElement>('#preview-pane').querySelector<HTMLVideoElement>('#preview-media video'); if (!video) return; video.pause(); video.removeAttribute('src'); video.load(); }
const terminalJobsShown = new Set<string>(); let jobUpdatesInitialized = false; let jobStatusTimer: number | undefined;
function renderExtractionJobs(): void {
  const jobs = state.jobs.filter((job) => job.type === 'frames' || job.type === 'segment').sort((left, right) => Number(right.status === 'queued' || right.status === 'running') - Number(left.status === 'queued' || left.status === 'running') || right.createdAt - left.createdAt); const activeCount = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length; const count = find<HTMLElement>('#extraction-job-count'); count.textContent = activeCount ? `${activeCount} active` : String(jobs.length); count.classList.toggle('active', activeCount > 0); const list = find<HTMLElement>('#extraction-job-list');
  if (!jobs.length) { list.innerHTML = '<p class="sidebar-jobs-empty">No extraction jobs yet.</p>'; return; }
  list.innerHTML = jobs.map((job) => { const percent = Math.max(0, Math.min(100, Math.round(job.progress * 100))); const active = job.status === 'queued' || job.status === 'running'; const type = job.type === 'segment' ? 'Video segment' : 'All frames'; const name = restoredName(job.path.split('/').at(-1) || job.path); const status = job.status === 'complete' ? 'Completed' : job.status === 'failed' ? 'Failed' : job.status === 'queued' ? 'Queued' : job.progress > 0 ? `${percent}% complete` : 'Starting…'; const output = job.status === 'complete' ? job.type === 'segment' ? job.result?.outputPath : 'Frames saved beside source video' : job.status === 'failed' ? job.error : ''; const indeterminate = active && job.progress === 0; return `<article class="sidebar-job sidebar-job-${job.status}"><div><i aria-hidden="true"></i><strong>${escapeHtml(type)}</strong><span>${escapeHtml(status)}</span></div><p title="${escapeHtml(name)}">${escapeHtml(name)}</p>${output ? `<small title="${escapeHtml(output)}">${escapeHtml(output)}</small>` : ''}<div class="job-progress${indeterminate ? ' indeterminate' : ''}" role="progressbar" aria-label="${escapeHtml(`${type}: ${status}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div></article>`; }).join('');
}
function renderJobStatus(): void {
  const element = find<HTMLDivElement>('#job-status'); const visibleJobs = state.jobs.filter((job) => job.type === 'frames' || job.type === 'playback' || job.type === 'segment').sort((left, right) => left.createdAt - right.createdAt); const active = [...visibleJobs].reverse().find((job) => job.status === 'queued' || job.status === 'running');
  let job = active || visibleJobs.at(-1); if (!job) { element.hidden = true; return; }
  if (!active && terminalJobsShown.has(job.id)) return;
  window.clearTimeout(jobStatusTimer); if (!active) terminalJobsShown.add(job.id);
  const percent = Math.max(0, Math.min(100, Math.round(job.progress * 100))); const name = restoredName(job.path.split('/').at(-1) || job.path); const playback = job.type === 'playback'; const segment = job.type === 'segment';
  const title = job.status === 'complete' ? segment ? 'Segment ready' : playback ? 'Video ready' : 'Frame extraction complete' : job.status === 'failed' ? segment ? 'Segment extraction failed' : playback ? 'Video preparation failed' : 'Frame extraction failed' : segment ? 'Extracting segment' : playback ? 'Preparing video' : 'Extracting frames';
  const detail = job.status === 'failed' ? job.error || (segment ? 'The video segment could not be created.' : playback ? 'The compatible video could not be created.' : 'The extraction job failed.') : job.status === 'complete' ? segment ? job.result?.outputPath || 'The segment is ready.' : playback ? 'Compatible playback is ready.' : 'Frames are ready.' : job.status === 'queued' ? 'Preparing…' : job.progress > 0 ? `${percent}% complete` : playback || segment ? 'Converting…' : 'Extracting…';
  const indeterminate = job.status === 'queued' || (job.status === 'running' && job.progress === 0); element.className = `job-status job-${job.status}`; element.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(name)}</span><p>${escapeHtml(detail)}</p><div class="job-progress${indeterminate ? ' indeterminate' : ''}"><i style="width:${percent}%"></i></div>`; element.hidden = false;
  if (!active) jobStatusTimer = window.setTimeout(() => { element.hidden = true; }, 5_000);
}
function applyJobUpdate(job: Job): void {
  const previous = state.jobs.find((item) => item.id === job.id); state.jobs = [...state.jobs.filter((item) => item.id !== job.id), job]; renderJobStatus(); renderExtractionJobs(); updatePlaybackViewer(job);
  if (job.status === 'failed' && job.type === 'thumbnail' && previous?.status !== 'failed') toast(`Thumbnail creation failed: ${job.error}`);
  if (job.status === 'complete' && job.type !== 'playback' && previous?.status !== 'complete') void refreshCatalog();
}
function applyJobSnapshot(jobs: Job[]): void {
  const previous = new Map(state.jobs.map((job) => [job.id, job])); if (!jobUpdatesInitialized) jobs.filter((job) => (job.type === 'frames' || job.type === 'playback' || job.type === 'segment') && (job.status === 'complete' || job.status === 'failed')).forEach((job) => terminalJobsShown.add(job.id));
  state.jobs = jobs; jobUpdatesInitialized = true; renderJobStatus(); renderExtractionJobs(); jobs.filter((job) => job.type === 'playback').forEach(updatePlaybackViewer);
  const failedThumbnail = jobs.find((job) => job.type === 'thumbnail' && job.status === 'failed' && previous.get(job.id)?.status !== 'failed'); if (failedThumbnail && previous.size) toast(`Thumbnail creation failed: ${failedThumbnail.error}`);
  if (jobs.some((job) => job.status === 'complete' && previous.get(job.id)?.status !== 'complete')) void refreshCatalog();
}
let liveSocket: WebSocket | null = null; let liveReconnectTimer: number | undefined; let catalogLive = false; let watchErrorShown = false;
function currentWatchMatches(message: { root: string; directory: string }): boolean { return message.root === state.root && message.directory === state.directory; }
function subscribeToDirectory(): void {
  catalogLive = false;
  if (!state.root || liveSocket?.readyState !== WebSocket.OPEN) return;
  liveSocket.send(JSON.stringify({ type: 'watch-directory', root: state.root, directory: state.directory }));
}
function connectLiveUpdates(): void {
  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(`${protocol}//${window.location.host}/api/live`); liveSocket = socket;
  socket.addEventListener('open', subscribeToDirectory);
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data)) as LiveServerMessage;
      if (message.type === 'snapshot' && Array.isArray(message.jobs)) applyJobSnapshot(message.jobs);
      else if (message.type === 'job' && message.job) applyJobUpdate(message.job);
      else if (message.type === 'watch-ready' && currentWatchMatches(message)) { catalogLive = true; watchErrorShown = false; }
      else if (message.type === 'catalog-change' && currentWatchMatches(message)) scheduleCatalogRefresh();
      else if (message.type === 'watch-error' && currentWatchMatches(message)) { catalogLive = false; if (!watchErrorShown) { watchErrorShown = true; toast('Live file updates are unavailable; polling instead.'); } }
    } catch { /* HTTP polling remains available as a fallback. */ }
  });
  socket.addEventListener('close', () => { if (liveSocket === socket) liveSocket = null; catalogLive = false; window.clearTimeout(liveReconnectTimer); liveReconnectTimer = window.setTimeout(connectLiveUpdates, 1_500); });
}
function visibleFiles(): CatalogEntry[] { return state.files.filter((entry) => isDirectory(entry) || entry.name.toLowerCase().includes(state.query)).sort((a, b) => Number(isDirectory(b)) - Number(isDirectory(a)) || (state.sortOrder === 'ascending' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name))); }
const INTERNAL_DRAG_TYPE = 'application/x-inv-paths';
function parentDirectoryPath(): string { if (!state.directory) return '..'; const separator = state.directory.lastIndexOf('/'); return separator === -1 ? '' : state.directory.slice(0, separator); }
function navigateToParent(): void { if (!state.parentListable) return; if (state.directory) void navigateDirectory(parentDirectoryPath()); else { const separator = state.root.lastIndexOf('/'); void openFolder(separator > 0 ? state.root.slice(0, separator) : '/'); } }
function hasInternalDrag(event: DragEvent): boolean { return Array.from(event.dataTransfer?.types || []).includes(INTERNAL_DRAG_TYPE); }
function internalDragPaths(event: DragEvent): string[] {
  try { const value: unknown = JSON.parse(event.dataTransfer?.getData(INTERNAL_DRAG_TYPE) || '[]'); return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string') ? value : []; }
  catch { return []; }
}
function makeMoveDropTarget(card: HTMLElement, destination: string): void {
  card.addEventListener('dragenter', (event) => { if (!hasInternalDrag(event)) return; event.preventDefault(); card.classList.add('drop-target'); });
  card.addEventListener('dragover', (event) => { if (!hasInternalDrag(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; });
  card.addEventListener('dragleave', (event) => { if (!card.contains(event.relatedTarget as Node | null)) card.classList.remove('drop-target'); });
  card.addEventListener('drop', (event) => { if (!hasInternalDrag(event)) return; event.preventDefault(); event.stopPropagation(); card.classList.remove('drop-target'); void movePaths(internalDragPaths(event), destination); });
}
function appendParentCard(grid: HTMLDivElement): void {
  if (!state.parentListable) return;
  const card = document.createElement('button'); card.type = 'button'; card.className = 'file-card directory-card parent-card'; card.title = 'Parent directory'; card.setAttribute('aria-label', 'Parent directory'); card.setAttribute('aria-pressed', 'false');
  if (state.view !== 'detailed') { const thumb = document.createElement('div'); thumb.className = 'thumb'; const glyph = document.createElement('span'); glyph.className = 'file-glyph'; glyph.textContent = 'UP'; thumb.append(glyph); card.append(thumb); }
  const info = document.createElement('div'); info.className = 'card-info'; info.innerHTML = '<strong>▸ ..</strong><span class="card-details">Parent directory</span><span class="card-type">Parent directory</span><span class="card-modified"></span><span class="card-size"></span>'; card.append(info);
  card.addEventListener('dblclick', navigateToParent); makeMoveDropTarget(card, parentDirectoryPath()); grid.append(card);
}

function renderCatalog(): void {
  const shell = find<HTMLElement>('.app-shell'); shell.classList.toggle('preview-visible', state.previewVisible); const previewToggle = find<HTMLButtonElement>('#preview-toggle'); previewToggle.classList.toggle('active', state.previewVisible); previewToggle.setAttribute('aria-pressed', String(state.previewVisible));
  if (!state.selected) { stopPreviewVideo(); find<HTMLElement>('#preview-empty').hidden = false; find<HTMLElement>('#preview-content').hidden = true; }
  const files = visibleFiles(); const grid = find<HTMLDivElement>('#file-grid'); const hasRows = state.files.length > 0 || state.parentListable; grid.className = `file-grid view-${state.view}${hasRows ? '' : ' hidden'}`; find('#empty-state').classList.toggle('hidden', hasRows);
  const first = state.files.length ? state.page * 250 + 1 : 0; const last = state.page * 250 + state.files.length; find('#file-summary').textContent = state.files.length ? `${state.total === null ? `${first}–${last}` : `${first}–${last} of ${state.total}`} ${files.length === 1 ? 'item' : 'items'} in ${state.directory || 'root'}` : 'This folder has no inverted files or directories.'; find('#location-name').textContent = state.directory || 'Root'; find<HTMLButtonElement>('#up-button').disabled = !state.parentListable;
  const selectedCount = state.selectedPaths.size; const selectionCount = find<HTMLElement>('#selection-count'); selectionCount.textContent = selectedCount ? `${selectedCount} selected` : ''; find<HTMLButtonElement>('#clear-selection').hidden = selectedCount === 0; find<HTMLButtonElement>('#move-selected').disabled = selectedCount === 0; find<HTMLButtonElement>('#delete-selected').disabled = selectedCount === 0;
  const hidden = find<HTMLButtonElement>('#hidden-toggle'); hidden.classList.toggle('active', state.showHidden); hidden.setAttribute('aria-pressed', String(state.showHidden)); hidden.setAttribute('aria-label', state.showHidden ? 'Hide hidden files' : 'Show hidden files'); const knownPageCount = state.total === null ? state.page + 1 + Number(state.hasMore) : Math.max(1, Math.ceil(state.total / 250)); const pageSummary = state.total === null ? `of ${knownPageCount}${state.hasMore ? '+' : ''}` : `of ${knownPageCount}`; const loading = state.loadingPage !== null; paginations.forEach((pagination) => { pagination.hidden = !(state.page > 0 || state.hasMore); const previous = pagination.querySelector<HTMLButtonElement>('[data-page="previous"]'); const next = pagination.querySelector<HTMLButtonElement>('[data-page="next"]'); const jump = pagination.querySelector<HTMLInputElement>('[data-page="jump"]'); const summary = pagination.querySelector<HTMLElement>('.page-summary'); const time = pagination.querySelector<HTMLElement>('.page-time'); const loadingMessage = pagination.querySelector<HTMLElement>('.page-loading'); if (!previous || !next || !jump || !summary || !time || !loadingMessage) throw new Error('Pagination controls are missing.'); previous.disabled = state.page === 0 || loading; next.disabled = !state.hasMore || loading; jump.disabled = loading; jump.value = String(state.page + 1); jump.max = String(knownPageCount); summary.textContent = pageSummary; time.hidden = loading || !state.frameTimeRange; time.textContent = state.frameTimeRange ? `Approx. ${formatVideoTime(state.frameTimeRange.startMs)}–${formatVideoTime(state.frameTimeRange.endMs)}` : ''; loadingMessage.hidden = !loading; if (loading) loadingMessage.lastChild!.textContent = ` Loading page ${state.loadingPage! + 1}…`; }); renderPathEditor(); grid.innerHTML = ''; appendParentCard(grid);
  files.forEach((entry) => {
    const directory = isDirectory(entry); const card = document.createElement('button'); card.type = 'button'; card.className = `file-card${directory ? ' directory-card' : ''}${state.selectedPaths.has(entry.path) ? ' selected' : ''}`; card.title = entry.path; card.draggable = true; card.setAttribute('aria-pressed', String(state.selectedPaths.has(entry.path)));
    if (state.view !== 'detailed') { const thumb = document.createElement('div'); thumb.className = 'thumb'; if (!directory && entry.thumbnail && entry.thumbnail !== 'pending') { const image = new Image(); image.src = urlFor(entry.thumbnail); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; thumb.append(image); } else if (!directory && entry.kind === 'images') { const image = new Image(); image.src = mediaUrl(entry); image.alt = `Preview of ${restoredName(entry.name)}`; image.loading = 'lazy'; image.decoding = 'async'; image.addEventListener('error', () => { const glyph = document.createElement('span'); glyph.className = 'file-glyph'; glyph.textContent = 'IMG'; image.replaceWith(glyph); }); thumb.append(image); } else { const glyph = document.createElement('span'); glyph.className = 'file-glyph'; glyph.textContent = directory ? 'DIR' : entry.kind === 'images' ? 'IMG' : entry.kind === 'videos' ? 'VID' : 'TXT'; thumb.append(glyph); } card.append(thumb); }
    const info = document.createElement('div'); info.className = 'card-info'; info.innerHTML = directory ? `<strong>▸ ${escapeHtml(entry.name)}</strong><span class="card-details">Directory</span><span class="card-type">Directory</span><span class="card-modified"></span><span class="card-size"></span>` : `<strong>${escapeHtml(restoredName(entry.name))}</strong><span class="card-details">${formatSize(entry.size)} · ${escapeHtml(entry.mime)}</span><span class="card-type">${escapeHtml(entry.mime)}</span><span class="card-modified">${formatModified(entry.modified)}</span><span class="card-size">${formatSize(entry.size)}</span>`; card.append(info);
    card.addEventListener('click', (event) => selectEntry(entry, event)); card.addEventListener('dblclick', () => directory ? void navigateDirectory(entry.path) : void openViewer(entry)); card.addEventListener('dragstart', (event) => { if (!state.selectedPaths.has(entry.path)) state.selectedPaths = new Set([entry.path]); event.dataTransfer?.setData(INTERNAL_DRAG_TYPE, JSON.stringify([...state.selectedPaths])); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }); card.addEventListener('dragend', () => document.querySelectorAll('.drop-target').forEach((item) => item.classList.remove('drop-target')));
    if (directory) makeMoveDropTarget(card, entry.path);
    card.addEventListener('contextmenu', (event) => showContextMenu(event, entry)); grid.append(card);
  });
}
function renderPathEditor(): void {
  const input = find<HTMLInputElement>('#path-input'); const selectedPath = absoluteSelectedPath(); input.value = selectedPath || absoluteDirectory(); const copyButton = find<HTMLButtonElement>('#copy-path'); copyButton.disabled = !input.value; const breadcrumbs = find<HTMLElement>('#path-breadcrumbs'); breadcrumbs.innerHTML = ''; if (!state.root) return;
  const root = document.createElement('button'); root.type = 'button'; root.className = 'path-link'; root.textContent = '/'; root.addEventListener('click', () => void openFolder('/')); breadcrumbs.append(root);
  let path = ''; for (const segment of absoluteDirectory().split('/').filter(Boolean)) { const separator = document.createElement('span'); separator.textContent = '/'; breadcrumbs.append(separator); path = `${path}/${segment}`; const item = document.createElement('button'); item.type = 'button'; item.className = 'path-link'; item.textContent = segment; const destination = path; item.addEventListener('click', () => void openFolder(destination)); breadcrumbs.append(item); }
  if (selectedPath && state.selected) { const separator = document.createElement('span'); separator.textContent = '/'; const file = document.createElement('button'); file.type = 'button'; file.className = 'path-link path-file'; file.textContent = state.selected.name; file.title = 'Open selected file'; file.addEventListener('click', () => void openViewer(state.selected!)); breadcrumbs.append(separator, file); }
}
function showPreview(file: CatalogFile): void {
  stopPreviewVideo(); state.selected = file; const empty = find<HTMLElement>('#preview-empty'); const content = find<HTMLElement>('#preview-content'); empty.hidden = true; content.hidden = false; content.innerHTML = `<h2>${escapeHtml(restoredName(file.name))}</h2><p>${escapeHtml(file.mime)} · ${formatSize(file.size)}</p><div class="preview-media" id="preview-media"></div><button class="back-button" id="open-preview">Open file</button>`; find('#open-preview').addEventListener('click', () => void openViewer(file)); const media = find<HTMLElement>('#preview-media');
  if (file.thumbnail && file.thumbnail !== 'pending') { const image = new Image(); image.src = urlFor(file.thumbnail); image.alt = `Preview of ${restoredName(file.name)}`; media.append(image); }
  else if (file.kind === 'images') { const image = new Image(); image.src = mediaUrl(file); image.alt = `Restored preview of ${restoredName(file.name)}`; media.append(image); }
  else if (file.kind === 'videos' && file.mime === 'video/x-msvideo') { media.innerHTML = '<p class="preview-note">Open this video to prepare a browser-compatible copy.</p>'; }
  else if (file.kind === 'videos') { const video = document.createElement('video'); video.src = mediaUrl(file); video.controls = true; video.muted = true; video.preload = 'metadata'; video.setAttribute('aria-label', `Muted preview of ${restoredName(file.name)}`); media.append(video); }
  else { media.innerHTML = '<span class="file-glyph large">TXT</span>'; }
}
function selectEntry(entry: CatalogEntry, event: MouseEvent): void {
  if (event.shiftKey && state.selectionAnchor) { const entries = visibleFiles(); const start = entries.findIndex((item) => item.path === state.selectionAnchor); const end = entries.findIndex((item) => item.path === entry.path); if (start !== -1 && end !== -1) state.selectedPaths = new Set(entries.slice(Math.min(start, end), Math.max(start, end) + 1).map((item) => item.path)); }
  else if (event.metaKey || event.ctrlKey) { if (state.selectedPaths.has(entry.path)) state.selectedPaths.delete(entry.path); else state.selectedPaths.add(entry.path); state.selectionAnchor = entry.path; }
  else { state.selectedPaths = new Set([entry.path]); state.selectionAnchor = entry.path; }
  if (!isDirectory(entry) && state.selectedPaths.has(entry.path)) { state.selected = entry; if (state.previewVisible) showPreview(entry); }
  else state.selected = null;
  renderCatalog();
}

function formatPreciseTime(milliseconds: number): string { const value = Math.max(0, Math.round(milliseconds)); const hours = Math.floor(value / 3_600_000); const minutes = Math.floor(value % 3_600_000 / 60_000); const seconds = Math.floor(value % 60_000 / 1_000); return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(value % 1_000).padStart(3, '0')}`; }
function parsePreciseTime(value: string): number | null { const match = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value.trim()); if (!match) return null; return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number((match[4] || '').padEnd(3, '0')); }
function createVideoTools(file: CatalogFile, video: HTMLVideoElement): HTMLDivElement {
  const tools = document.createElement('div'); tools.className = 'video-tools'; tools.innerHTML = `<section class="video-segment-tools" aria-label="Extract a video segment"><div class="segment-heading"><strong>Extract segment</strong><span class="segment-duration">Load the video to select a range</span></div><div class="segment-range" style="--segment-start:0%;--segment-end:100%;--playhead:0%"><i class="segment-track"></i><i class="segment-selection"></i><i class="segment-playhead"></i><input class="segment-start-range" type="range" min="0" value="0" disabled aria-label="Segment start" /><input class="segment-end-range" type="range" min="0" value="0" disabled aria-label="Segment end" /></div><div class="segment-controls"><button type="button" class="set-in">Set In</button><label>In <input class="segment-start-time" inputmode="decimal" placeholder="HH:MM:SS.mmm" disabled /></label><button type="button" class="set-out">Set Out</button><label>Out <input class="segment-end-time" inputmode="decimal" placeholder="HH:MM:SS.mmm" disabled /></label><button type="button" class="preview-segment" disabled>Preview segment</button><button type="button" class="clear-segment" disabled>Clear</button><button type="button" class="extract-segment" disabled>Extract segment</button></div></section><div class="video-frame-tools"><button type="button" data-step="-1">◀ Previous frame</button><button type="button" data-step="1">Next frame ▶</button><button type="button" class="extract-frame">Extract current frame</button><span></span></div>`;
  const frameDurationMs = file.frameDurationMs || 1_000 / 30; const frameTools = tools.querySelector<HTMLElement>('.video-frame-tools')!; const status = frameTools.querySelector('span'); if (status) status.textContent = `${(1_000 / frameDurationMs).toFixed(2)} fps`;
  frameTools.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((button) => button.addEventListener('click', () => { video.pause(); const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - frameDurationMs / 2_000) : Number.POSITIVE_INFINITY; video.currentTime = Math.min(maximum, Math.max(0, video.currentTime + Number(button.dataset.step) * frameDurationMs / 1_000)); }));
  const extractFrame = frameTools.querySelector<HTMLButtonElement>('.extract-frame'); extractFrame?.addEventListener('click', async () => {
    extractFrame.disabled = true; const label = extractFrame.textContent; extractFrame.textContent = 'Extracting…'; video.pause();
    try { const result = await api<{ outputPath: string }>('/api/videos/frame', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file.path, timeMs: Math.round(video.currentTime * 1_000), outputDirectory: state.frameOutputDirectory }) }); state.catalogDirty = true; toast(`Saved ${result.outputPath}`); }
    catch (error) { toast(error instanceof Error ? error.message : String(error)); }
    finally { extractFrame.disabled = false; extractFrame.textContent = label; }
  });

  const segment = tools.querySelector<HTMLElement>('.video-segment-tools')!; const startRange = segment.querySelector<HTMLInputElement>('.segment-start-range')!; const endRange = segment.querySelector<HTMLInputElement>('.segment-end-range')!; const startInput = segment.querySelector<HTMLInputElement>('.segment-start-time')!; const endInput = segment.querySelector<HTMLInputElement>('.segment-end-time')!; const setIn = segment.querySelector<HTMLButtonElement>('.set-in')!; const setOut = segment.querySelector<HTMLButtonElement>('.set-out')!; const preview = segment.querySelector<HTMLButtonElement>('.preview-segment')!; const clear = segment.querySelector<HTMLButtonElement>('.clear-segment')!; const extractSegment = segment.querySelector<HTMLButtonElement>('.extract-segment')!; const durationLabel = segment.querySelector<HTMLElement>('.segment-duration')!;
  setIn.disabled = true; setOut.disabled = true; let durationMs = 0; let startMs: number | null = null; let endMs: number | null = null; let previewing = false;
  const selected = () => startMs !== null && endMs !== null && endMs - startMs >= frameDurationMs - 0.5;
  function updateSegmentUi(): void {
    const maximum = Math.max(1, durationMs); const visualStart = startMs ?? 0; const visualEnd = endMs ?? durationMs; startRange.value = String(visualStart); endRange.value = String(visualEnd); startInput.value = startMs === null ? '' : formatPreciseTime(startMs); endInput.value = endMs === null ? '' : formatPreciseTime(endMs); segment.style.setProperty('--segment-start', `${visualStart / maximum * 100}%`); segment.style.setProperty('--segment-end', `${visualEnd / maximum * 100}%`); segment.classList.toggle('has-selection', selected()); preview.disabled = !selected(); extractSegment.disabled = !selected(); clear.disabled = startMs === null && endMs === null;
  }
  function setStart(value: number): void { const upper = endMs === null ? durationMs : endMs - frameDurationMs; startMs = Math.round(Math.max(0, Math.min(upper, value))); previewing = false; updateSegmentUi(); }
  function setEnd(value: number): void { const lower = startMs === null ? frameDurationMs : startMs + frameDurationMs; endMs = Math.round(Math.min(durationMs, Math.max(lower, value))); previewing = false; updateSegmentUi(); }
  function initializeSegment(): void { if (!Number.isFinite(video.duration) || video.duration <= 0) return; durationMs = Math.round(video.duration * 1_000); for (const range of [startRange, endRange]) { range.max = String(durationMs); range.step = String(frameDurationMs); range.disabled = false; } startInput.disabled = false; endInput.disabled = false; setIn.disabled = false; setOut.disabled = false; durationLabel.textContent = `${formatPreciseTime(durationMs)} total`; updateSegmentUi(); }
  video.addEventListener('loadedmetadata', initializeSegment); if (video.readyState >= HTMLMediaElement.HAVE_METADATA) initializeSegment();
  startRange.addEventListener('input', () => { setStart(Number(startRange.value)); video.pause(); video.currentTime = (startMs || 0) / 1_000; }); endRange.addEventListener('input', () => { setEnd(Number(endRange.value)); video.pause(); video.currentTime = (endMs || 0) / 1_000; });
  setIn.addEventListener('click', () => { video.pause(); setStart(video.currentTime * 1_000); }); setOut.addEventListener('click', () => { video.pause(); setEnd(video.currentTime * 1_000); });
  function commitTime(input: HTMLInputElement, endpoint: 'start' | 'end'): void { const parsed = parsePreciseTime(input.value); if (parsed === null || parsed > durationMs) { toast('Use a time within the video in HH:MM:SS.mmm format.'); updateSegmentUi(); return; } if (endpoint === 'start') setStart(parsed); else setEnd(parsed); }
  startInput.addEventListener('change', () => commitTime(startInput, 'start')); endInput.addEventListener('change', () => commitTime(endInput, 'end')); for (const input of [startInput, endInput]) input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
  clear.addEventListener('click', () => { startMs = null; endMs = null; previewing = false; video.pause(); updateSegmentUi(); });
  preview.addEventListener('click', async () => { if (!selected()) return; previewing = true; video.pause(); video.currentTime = startMs! / 1_000; try { await video.play(); } catch { previewing = false; toast('The browser could not start segment preview.'); } });
  video.addEventListener('timeupdate', () => { segment.style.setProperty('--playhead', `${Math.max(0, Math.min(100, video.currentTime * 1_000 / Math.max(1, durationMs) * 100))}%`); if (previewing && endMs !== null && video.currentTime * 1_000 >= endMs - 5) { previewing = false; video.pause(); video.currentTime = endMs / 1_000; } });
  extractSegment.addEventListener('click', async () => { if (!selected()) return; extractSegment.disabled = true; const label = extractSegment.textContent; extractSegment.textContent = 'Queueing…'; video.pause(); try { const job = await api<Job>('/api/videos/segment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file.path, startMs, endMs, outputDirectory: state.videoOutputDirectory }) }); applyJobUpdate(job); state.catalogDirty = true; toast('Segment extraction queued.'); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } finally { extractSegment.textContent = label; updateSegmentUi(); } });
  updateSegmentUi(); return tools;
}
function startVideoWhenReady(video: HTMLVideoElement): void {
  video.autoplay = true; video.playsInline = true;
  video.addEventListener('canplay', () => { void video.play().catch(() => { /* Controls remain available if browser policy blocks autoplay. */ }); }, { once: true });
}
function renderPreparedVideo(file: CatalogFile): void {
  if (state.screen !== 'viewer' || state.selected?.path !== file.path) return;
  const media = find<HTMLElement>('#viewer-media'); media.innerHTML = ''; const video = document.createElement('video'); video.src = playbackUrl(file); video.controls = true; video.muted = true; video.defaultMuted = true; video.preload = 'metadata'; video.className = 'viewer-video'; video.setAttribute('aria-label', `Compatible player for ${restoredName(file.name)}`); video.addEventListener('error', () => { if (state.selected?.path === file.path) media.innerHTML = '<p class="viewer-error">The compatible video could not be loaded. You can still restore and download the original file.</p>'; }); startVideoWhenReady(video); media.append(video, createVideoTools(file, video));
}
function renderPlaybackJob(file: CatalogFile, job: Job): void {
  if (state.screen !== 'viewer' || state.selected?.path !== file.path) return;
  if (job.status === 'complete') return renderPreparedVideo(file);
  const media = find<HTMLElement>('#viewer-media'); const percent = Math.max(0, Math.min(100, Math.round(job.progress * 100)));
  if (job.status === 'failed') { media.innerHTML = `<div class="playback-preparing playback-failed"><h2>Video preparation failed</h2><p>${escapeHtml(job.error || 'A browser-compatible copy could not be created.')}</p><p>You can still restore and download the original file.</p><button class="back-button" id="retry-playback" type="button">Try again</button></div>`; find('#retry-playback').addEventListener('click', () => void preparePlayback(file)); return; }
  const detail = job.status === 'queued' || job.progress === 0 ? 'Starting FFmpeg…' : `${percent}% complete`;
  media.innerHTML = `<div class="playback-preparing"><h2>Preparing video for browser playback</h2><p>${escapeHtml(detail)}</p><div class="job-progress${job.progress === 0 ? ' indeterminate' : ''}"><i style="width:${percent}%"></i></div><span>The original file is unchanged. You may leave this viewer while conversion continues.</span></div>`;
}
function updatePlaybackViewer(job: Job): void {
  if (job.type !== 'playback' || state.screen !== 'viewer' || state.selected?.path !== job.path || state.selected.kind !== 'videos') return;
  renderPlaybackJob(state.selected, job);
}
async function preparePlayback(file: CatalogFile): Promise<void> {
  if (state.screen !== 'viewer' || state.selected?.path !== file.path) return;
  const media = find<HTMLElement>('#viewer-media'); media.innerHTML = '<div class="playback-preparing"><h2>Preparing video for browser playback</h2><p>Checking the local cache…</p><div class="job-progress indeterminate"><i></i></div></div>';
  try {
    const result = await api<PlaybackResponse>('/api/videos/playback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file.path }) });
    if (state.screen !== 'viewer' || state.selected?.path !== file.path) return;
    if (result.status === 'ready') renderPreparedVideo(file); else { applyJobUpdate(result.job); renderPlaybackJob(file, result.job); }
  } catch (error) { if (state.screen === 'viewer' && state.selected?.path === file.path) media.innerHTML = `<p class="viewer-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`; }
}
function renderNativeVideo(file: CatalogFile): void {
  const media = find<HTMLElement>('#viewer-media'); const video = document.createElement('video'); let fallingBack = false; video.src = mediaUrl(file); video.controls = true; video.muted = true; video.defaultMuted = true; video.preload = 'metadata'; video.className = 'viewer-video'; video.setAttribute('aria-label', `Full player for ${restoredName(file.name)}`); video.addEventListener('error', () => { if (fallingBack || state.selected?.path !== file.path) return; fallingBack = true; video.removeAttribute('src'); video.load(); void preparePlayback(file); }); startVideoWhenReady(video); media.append(video, createVideoTools(file, video));
}
type TextSnapshot = { content: string; size: number; modified: number };
let activeTextEditor: IntegratedTextEditor | null = null;
async function renderTextEditor(file: CatalogFile, media: HTMLElement): Promise<void> {
  media.innerHTML = `<div class="text-editor-shell"><div class="text-editor-head"><span id="text-status">Loading editor…</span><button class="restore-button" id="save-text" type="button" disabled>Save</button></div><div class="text-conflict" id="text-conflict" hidden><div><strong>File changed on disk</strong><span>Reload the current disk version or explicitly overwrite it with your edits.</span></div><button type="button" id="reload-text">Reload disk version</button><button type="button" class="danger" id="overwrite-text">Overwrite anyway</button></div><div class="text-editor-mount" id="text-editor-mount"><div class="editor-loading">Loading restored text…</div></div></div>`;
  const status = find<HTMLElement>('#text-status'); const saveButton = find<HTMLButtonElement>('#save-text'); const conflict = find<HTMLElement>('#text-conflict'); let snapshot: TextSnapshot; let baseline = ''; let saving = false; let editor: IntegratedTextEditor | null = null;
  const updateDirtyState = (content: string) => { state.textDirty = content !== baseline; saveButton.disabled = saving || !state.textDirty; if (!saving) status.textContent = state.textDirty ? 'Unsaved changes' : 'Saved'; };
  const loadSnapshot = async (announce = false) => { const loaded = await api<TextSnapshot>('/api/text?path=' + encodeURIComponent(file.path)); if (state.selected?.path !== file.path) return; snapshot = loaded; baseline = loaded.content; conflict.hidden = true; if (editor) editor.replaceContent(loaded.content); state.textDirty = false; saveButton.disabled = true; status.textContent = announce ? 'Reloaded from disk' : 'Editing restored UTF-8 text'; };
  const save = async (force = false) => {
    if (!editor || saving || (!state.textDirty && !force)) return; saving = true; saveButton.disabled = true; status.textContent = force ? 'Overwriting…' : 'Saving…'; const content = editor.getContent();
    try { const result = await api<Omit<TextSnapshot, 'content'>>('/api/text', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file.path, content, expectedSize: snapshot.size, expectedModified: snapshot.modified, force }) }); if (state.selected?.path !== file.path) return; baseline = content; snapshot = { content, ...result }; file.size = result.size; file.modified = result.modified; if (state.selected) state.selected = { ...state.selected, size: result.size, modified: result.modified }; state.textDirty = false; state.catalogDirty = true; conflict.hidden = true; status.textContent = 'Saved'; toast('Text saved.'); }
    catch (error) { if (error instanceof ApiError && error.status === 409) { conflict.hidden = false; status.textContent = 'Save conflict'; } else { status.textContent = 'Save failed'; toast(error instanceof Error ? error.message : String(error)); } }
    finally { saving = false; saveButton.disabled = !state.textDirty; }
  };
  try {
    snapshot = await api<TextSnapshot>('/api/text?path=' + encodeURIComponent(file.path)); if (state.selected?.path !== file.path) return; baseline = snapshot.content; const module = await import('./text-editor'); if (state.selected?.path !== file.path) return; editor = await module.createIntegratedTextEditor({ container: find('#text-editor-mount'), content: snapshot.content, fileName: restoredName(file.name), mime: file.mime, onChange: updateDirtyState, onSave: () => void save(), onMessage: toast }); if (state.selected?.path !== file.path) { editor.destroy(); return; } activeTextEditor = editor; status.textContent = 'Editing restored UTF-8 text'; saveButton.addEventListener('click', () => void save()); find('#reload-text').addEventListener('click', () => void loadSnapshot(true).catch((error) => toast(error instanceof Error ? error.message : String(error)))); find('#overwrite-text').addEventListener('click', () => void save(true));
  } catch (error) { media.innerHTML = `<p class="viewer-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`; }
}
async function openViewer(file: CatalogFile): Promise<void> {
  stopPreviewVideo(); activeTextEditor?.destroy(); activeTextEditor = null; find<HTMLElement>('.app-shell').classList.remove('preview-visible'); state.selected = file; state.screen = 'viewer'; state.textDirty = false; find('#catalog-view').setAttribute('hidden', ''); find('#viewer').removeAttribute('hidden'); find('#search-wrap').setAttribute('hidden', ''); find('#location-name').textContent = restoredName(file.name); const viewer = find<HTMLElement>('#viewer'); viewer.innerHTML = `<div class="viewer-head"><button class="back-button" id="back-button">← Back to files</button><div><h1>${escapeHtml(restoredName(file.name))}</h1><p>${escapeHtml(file.mime)} · ${formatSize(file.size)} · ${formatModified(file.modified)}</p></div><button class="restore-button viewer-download" id="restore-button">Restore &amp; download <span>↓</span></button></div><div class="viewer-media" id="viewer-media"></div>`;
  find('#back-button').addEventListener('click', closeViewer); find('#restore-button').addEventListener('click', () => void downloadSelected()); const media = find<HTMLElement>('#viewer-media');
  if (file.editableText) void renderTextEditor(file, media);
  else if (file.kind === 'images') { const image = new Image(); image.src = mediaUrl(file); image.alt = `Restored preview of ${restoredName(file.name)}`; image.className = 'viewer-image'; media.append(image); }
  else if (file.kind === 'videos' && file.mime === 'video/x-msvideo') void preparePlayback(file);
  else if (file.kind === 'videos') renderNativeVideo(file);
  else media.innerHTML = '<p class="viewer-error">This restored file cannot be previewed.</p>';
}
function closeViewer(): void { if (state.textDirty && !window.confirm('Discard unsaved text changes?')) return; const refreshNeeded = state.catalogDirty; state.catalogDirty = false; state.textDirty = false; activeTextEditor?.destroy(); activeTextEditor = null; state.screen = 'catalog'; state.selected = null; find('#viewer').setAttribute('hidden', ''); find('#catalog-view').removeAttribute('hidden'); find('#search-wrap').removeAttribute('hidden'); find('#location-name').textContent = state.directory || 'Root'; renderCatalog(); if (refreshNeeded) scheduleCatalogRefresh(0); }
async function downloadSelected(): Promise<void> { if (!state.selected) return; const response = await fetch(mediaUrl(state.selected)); if (!response.ok) return toast('Could not restore this file.'); const blob = await response.blob(); const href = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = href; link.download = restoredName(state.selected.name); link.click(); window.setTimeout(() => URL.revokeObjectURL(href), 1_000); }
type CatalogResponse = { root: string; directory: string; parentListable: boolean; files: CatalogEntry[]; hasMore: boolean; total: number | null; frameTimeRange: FrameTimeRange | null };
function catalogRoute(): string { return `/api/catalog?path=${encodeURIComponent(state.directory)}&hidden=${state.showHidden ? '1' : '0'}&query=${encodeURIComponent(state.query)}&offset=${state.page * 250}`; }
function applyCatalog(result: CatalogResponse, reconcileSelection = false): void {
  state.directory = result.directory; state.parentListable = result.parentListable; state.files = result.files; state.hasMore = result.hasMore; state.total = result.total; state.frameTimeRange = result.frameTimeRange;
  if (reconcileSelection) {
    const currentEntries = new Map(result.files.map((entry) => [entry.path, entry])); state.selectedPaths = new Set([...state.selectedPaths].filter((path) => currentEntries.has(path)));
    if (state.selected) { const current = currentEntries.get(state.selected.path); state.selected = current && !isDirectory(current) ? current : null; }
    if (state.selectionAnchor && !currentEntries.has(state.selectionAnchor)) state.selectionAnchor = '';
  }
  if (state.screen === 'catalog') renderCatalog();
}
async function openFolder(path: string): Promise<void> { state.page = 0; const result = await api<CatalogResponse>('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, showHidden: state.showHidden, query: state.query }) }); state.root = result.root; state.selected = null; state.selectedPaths.clear(); state.selectionAnchor = ''; state.catalogDirty = false; applyCatalog(result); closeViewer(); subscribeToDirectory(); }
async function navigateDirectory(path: string): Promise<void> { state.directory = path; state.page = 0; state.query = ''; state.selected = null; state.selectedPaths.clear(); state.selectionAnchor = ''; find<HTMLInputElement>('#search').value = ''; const result = await api<CatalogResponse>(catalogRoute()); applyCatalog(result); subscribeToDirectory(); }
async function refreshCatalog(reconcileSelection = false): Promise<void> {
  if (!state.root) return;
  try {
    const requestedRoot = state.root; const requestedDirectory = state.directory; const requestedRoute = catalogRoute(); const result = await api<CatalogResponse>(requestedRoute);
    if (state.root !== requestedRoot || state.directory !== requestedDirectory || catalogRoute() !== requestedRoute) return;
    if (reconcileSelection && result.files.length === 0 && state.page > 0) { state.page -= 1; await refreshCatalog(true); return; }
    applyCatalog(result, reconcileSelection);
  } catch { /* The next explicit action reports a server error. */ }
}
let catalogRefreshTimer: number | undefined; let catalogRefreshRunning = false; let catalogRefreshPending = false;
function scheduleCatalogRefresh(delay = 150): void {
  if (!state.root) return;
  if (state.screen !== 'catalog') { state.catalogDirty = true; return; }
  window.clearTimeout(catalogRefreshTimer);
  catalogRefreshTimer = window.setTimeout(async () => {
    if (catalogRefreshRunning) { catalogRefreshPending = true; return; }
    catalogRefreshRunning = true;
    try { await refreshCatalog(true); }
    finally { catalogRefreshRunning = false; if (catalogRefreshPending) { catalogRefreshPending = false; scheduleCatalogRefresh(0); } }
  }, delay);
}
async function goToPage(page: number): Promise<void> { if (state.loadingPage !== null || page < 0 || (page > state.page && !state.hasMore)) return; const previousPage = state.page; state.page = page; state.loadingPage = page; renderCatalog(); try { const result = await api<CatalogResponse>(catalogRoute()); applyCatalog(result); } catch (error) { state.page = previousPage; toast(error instanceof Error ? error.message : String(error)); } finally { state.loadingPage = null; renderCatalog(); } }
async function movePaths(paths: string[], destination: string): Promise<void> { if (!paths.length) return; try { await api('/api/files/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths, destination }) }); state.selectedPaths.clear(); state.selectionAnchor = ''; state.selected = null; toast(`${paths.length} item${paths.length === 1 ? '' : 's'} moved.`); await refreshCatalog(true); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } }
async function createFolder(): Promise<void> { const name = window.prompt('New folder name:'); if (!name) return; try { await api('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: state.directory, name }) }); await refreshCatalog(); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } }
async function deleteSelected(): Promise<void> { const paths = [...state.selectedPaths]; if (!paths.length || !window.confirm(`Delete ${paths.length} selected item${paths.length === 1 ? '' : 's'}? This cannot be undone.`)) return; try { await api('/api/files', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) }); state.selectedPaths.clear(); state.selectionAnchor = ''; state.selected = null; toast(`${paths.length} item${paths.length === 1 ? '' : 's'} deleted.`); await refreshCatalog(); } catch (error) { toast(error instanceof Error ? error.message : String(error)); } }
async function refreshJobs(): Promise<void> { if (!state.root) return; try { applyJobSnapshot(await api<Job[]>('/api/jobs')); } catch { /* WebSocket updates and job status are optional. */ } }
type RenameResponse = { path: string; name: string };
let contextEntry: CatalogEntry | null = null;
const entryContextActions = ['#open-entry', '#copy-entry-path', '#rename-entry', '#explode-video', '#delete-entry'];
function positionContextMenu(event: MouseEvent): void { const menu = find<HTMLElement>('#context-menu'); menu.style.visibility = 'hidden'; menu.hidden = false; const bounds = menu.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`; menu.style.visibility = ''; }
function showContextMenu(event: MouseEvent, entry: CatalogEntry): void { event.preventDefault(); contextEntry = entry; entryContextActions.forEach((selector) => { find<HTMLButtonElement>(selector).hidden = false; }); find<HTMLButtonElement>('#explode-video').hidden = isDirectory(entry) || entry.kind !== 'videos'; catalogNewFolderAction.hidden = true; catalogTerminalAction.hidden = true; positionContextMenu(event); }
function showCatalogContextMenu(event: MouseEvent): void { event.preventDefault(); contextEntry = null; entryContextActions.forEach((selector) => { find<HTMLButtonElement>(selector).hidden = true; }); catalogNewFolderAction.hidden = false; catalogTerminalAction.hidden = false; const available = Boolean(state.root); catalogNewFolderAction.disabled = !available; catalogTerminalAction.disabled = !available; positionContextMenu(event); }
function hideContextMenu(): void { find<HTMLElement>('#context-menu').hidden = true; contextEntry = null; }
async function renameEntry(entry: CatalogEntry): Promise<void> {
  const currentName = isDirectory(entry) ? entry.name : restoredName(entry.name); const requestedName = window.prompt(`Rename ${isDirectory(entry) ? 'folder' : 'file'}:`, currentName);
  if (requestedName === null || requestedName === currentName) return;
  try {
    const result = await api<RenameResponse>('/api/files/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: entry.path, name: requestedName }) });
    if (state.selectedPaths.delete(entry.path)) state.selectedPaths.add(result.path);
    if (state.selectionAnchor === entry.path) state.selectionAnchor = result.path;
    if (state.selected?.path === entry.path) state.selected = { ...state.selected, path: result.path, name: result.name };
    toast(`Renamed to ${requestedName}.`); await refreshCatalog(true);
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
}
async function deleteEntry(entry: CatalogEntry): Promise<void> {
  const directory = isDirectory(entry); const name = directory ? entry.name : restoredName(entry.name); const detail = directory ? ' and all of its contents' : '';
  if (!window.confirm(`Delete ${directory ? 'folder' : 'file'} "${name}"${detail}? This cannot be undone.`)) return;
  try {
    await api('/api/files', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [entry.path] }) });
    state.selectedPaths.delete(entry.path); if (state.selectionAnchor === entry.path) state.selectionAnchor = ''; if (state.selected?.path === entry.path) state.selected = null;
    toast(`Deleted ${name}.`); await refreshCatalog(true);
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
}
find<HTMLFormElement>('#path-editor').addEventListener('submit', (event) => { event.preventDefault(); const value = find<HTMLInputElement>('#path-input').value.trim(); if (!value) return toast('Enter an absolute folder path.'); void openFolder(value).catch((error) => toast(error instanceof Error ? error.message : String(error))); });
find<HTMLButtonElement>('#copy-path').addEventListener('click', () => void copyCurrentPath());
find<HTMLButtonElement>('#preview-toggle').addEventListener('click', () => { state.previewVisible = !state.previewVisible; if (!state.previewVisible) stopPreviewVideo(); renderCatalog(); if (state.previewVisible && state.selected) showPreview(state.selected); });
find<HTMLButtonElement>('#hidden-toggle').addEventListener('click', () => { state.showHidden = !state.showHidden; state.page = 0; void refreshCatalog(); });
paginations.forEach((pagination) => { pagination.querySelector<HTMLButtonElement>('[data-page="previous"]')?.addEventListener('click', () => void goToPage(state.page - 1)); pagination.querySelector<HTMLButtonElement>('[data-page="next"]')?.addEventListener('click', () => void goToPage(state.page + 1)); const jump = pagination.querySelector<HTMLInputElement>('[data-page="jump"]'); const submitJump = () => { if (!jump) return; const maximum = Number(jump.max); const requested = Number(jump.value); const page = Math.min(maximum, Math.max(1, Number.isInteger(requested) ? requested : state.page + 1)); jump.value = String(page); if (page !== state.page + 1) void goToPage(page - 1); }; jump?.addEventListener('change', submitJump); jump?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submitJump(); } }); });
find<HTMLButtonElement>('#new-folder').addEventListener('click', () => void createFolder()); find<HTMLButtonElement>('#clear-selection').addEventListener('click', () => { state.selectedPaths.clear(); state.selectionAnchor = ''; state.selected = null; renderCatalog(); }); find<HTMLButtonElement>('#move-selected').addEventListener('click', () => { const destination = window.prompt('Move selected items to a folder within the opened root:', state.directory); if (destination !== null) void movePaths([...state.selectedPaths], destination); }); find<HTMLButtonElement>('#delete-selected').addEventListener('click', () => void deleteSelected());
find<HTMLElement>('#catalog-view').addEventListener('contextmenu', (event) => { const target = event.target as Element; if (target.closest('.file-card')) return; if (target.closest('button,input,textarea,select,a')) { hideContextMenu(); return; } showCatalogContextMenu(event); });
find<HTMLButtonElement>('#up-button').addEventListener('click', navigateToParent);
app.querySelectorAll<HTMLButtonElement>('.view-toggle').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view as ViewMode; app.querySelectorAll<HTMLButtonElement>('.view-toggle').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); renderCatalog(); }));
let searchTimer: number | undefined; find<HTMLInputElement>('#search').addEventListener('input', (event) => { state.query = (event.target as HTMLInputElement).value.trim().toLowerCase(); state.page = 0; window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void refreshCatalog(), 150); }); find('#sort-button').addEventListener('click', () => { state.sortOrder = state.sortOrder === 'ascending' ? 'descending' : 'ascending'; find('#sort-button').innerHTML = `Name <span>${state.sortOrder === 'ascending' ? '↓' : '↑'}</span>`; renderCatalog(); });
find('#open-entry').addEventListener('click', () => { const entry = contextEntry; hideContextMenu(); if (entry) isDirectory(entry) ? void navigateDirectory(entry.path) : void openViewer(entry); });
find('#copy-entry-path').addEventListener('click', () => { const entry = contextEntry; hideContextMenu(); if (entry) void copyPathToClipboard(absolutePath(entry.path)); });
find('#rename-entry').addEventListener('click', () => { const entry = contextEntry; hideContextMenu(); if (entry) void renameEntry(entry); });
find('#explode-video').addEventListener('click', () => { const entry = contextEntry; hideContextMenu(); if (!entry || isDirectory(entry) || entry.kind !== 'videos') return; void api<Job>('/api/videos/explode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: entry.path }) }).then(applyJobUpdate).catch((error) => toast(error instanceof Error ? error.message : String(error))); }); document.addEventListener('click', hideContextMenu);
find('#delete-entry').addEventListener('click', () => { const entry = contextEntry; hideContextMenu(); if (entry) void deleteEntry(entry); });
catalogNewFolderAction.addEventListener('click', () => { hideContextMenu(); void createFolder(); });
catalogTerminalAction.addEventListener('click', () => { hideContextMenu(); const directory = absoluteDirectory(); if (!directory) return toast('Open a folder before moving the terminal.'); const moved = browserTerminal.moveToDirectory(directory); toast(moved ? `Terminal moved to ${directory}` : `Terminal will move to ${directory} when it is ready.`); });
document.addEventListener('keydown', (event) => { if (event.key !== 'Escape' || state.selectedPaths.size === 0 || document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return; state.selectedPaths.clear(); state.selectionAnchor = ''; state.selected = null; renderCatalog(); });
window.addEventListener('beforeunload', (event) => { if (!state.textDirty) return; event.preventDefault(); event.returnValue = ''; });
connectLiveUpdates(); window.setInterval(() => { void refreshJobs(); if (!catalogLive) scheduleCatalogRefresh(0); }, 3_000); renderCatalog();
const developmentFolder = import.meta.env.DEV ? import.meta.env.VITE_DEFAULT_FOLDER : '';
const browserTerminal = new BrowserTerminal(terminalDock, absoluteDirectory);
async function initializeApplication(): Promise<void> {
  if (developmentFolder) try { await openFolder(developmentFolder); } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
  browserTerminal.activate();
}
void initializeApplication();
