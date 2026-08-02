import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

type TerminalServerMessage =
  | { type: 'ready'; pid: number; cwd: string }
  | { type: 'output'; data: string }
  | { type: 'status'; busy: boolean }
  | { type: 'exit'; code: number; signal: number }
  | { type: 'error'; message: string };

const HEIGHT_KEY = 'inv-viewer-terminal-height';
const OPEN_KEY = 'inv-viewer-terminal-open';
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 140;

export class BrowserTerminal {
  private readonly dock: HTMLElement;
  private readonly host: HTMLElement;
  private readonly status: HTMLElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly restartButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly resizer: HTMLElement;
  private readonly getWorkingDirectory: () => string;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private socket: WebSocket | null = null;
  private expanded = true;
  private active = false;
  private ready = false;
  private busy = false;
  private exited = false;
  private height = DEFAULT_HEIGHT;
  private resizePointer: number | null = null;
  private connectionGeneration = 0;
  private resizeFrame: number | null = null;
  private lastDimensions = '';

  constructor(dock: HTMLElement, getWorkingDirectory: () => string) {
    this.dock = dock; this.getWorkingDirectory = getWorkingDirectory;
    this.host = this.required<HTMLElement>('#terminal-host'); this.status = this.required<HTMLElement>('#terminal-status');
    this.toggleButton = this.required<HTMLButtonElement>('#terminal-toggle'); this.restartButton = this.required<HTMLButtonElement>('#terminal-restart'); this.clearButton = this.required<HTMLButtonElement>('#terminal-clear'); this.resizer = this.required<HTMLElement>('#terminal-resizer');
    try {
      const storedHeight = Number(window.localStorage.getItem(HEIGHT_KEY)); if (Number.isFinite(storedHeight) && storedHeight > 0) this.height = storedHeight;
      const storedOpen = window.localStorage.getItem(OPEN_KEY); this.expanded = storedOpen === null ? true : storedOpen === 'true';
    } catch { /* Defaults remain usable when storage is unavailable. */ }
    this.setHeight(this.height, false); this.renderExpandedState(); this.bindControls();
    new ResizeObserver(() => this.scheduleFit()).observe(this.host);
  }

  activate(): void { this.active = true; if (this.expanded) this.ensureTerminal(); }

  private required<T extends Element>(selector: string): T {
    const element = this.dock.querySelector<T>(selector); if (!element) throw new Error(`Required terminal element not found: ${selector}`); return element;
  }

  private maximumHeight(): number { return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.65)); }

  private setHeight(height: number, persist = true): void {
    this.height = Math.round(Math.max(MIN_HEIGHT, Math.min(this.maximumHeight(), height)));
    this.dock.closest<HTMLElement>('.application-viewport')?.style.setProperty('--terminal-height', `${this.height}px`);
    document.documentElement.style.setProperty('--terminal-height', `${this.height}px`);
    this.resizer.setAttribute('aria-valuemin', String(MIN_HEIGHT)); this.resizer.setAttribute('aria-valuemax', String(this.maximumHeight())); this.resizer.setAttribute('aria-valuenow', String(this.height)); this.resizer.setAttribute('aria-valuetext', `${this.height} pixels high`);
    if (persist) try { window.localStorage.setItem(HEIGHT_KEY, String(this.height)); } catch { /* Resizing still works. */ }
    this.scheduleFit();
  }

  private renderExpandedState(): void {
    this.dock.classList.toggle('collapsed', !this.expanded); this.toggleButton.setAttribute('aria-expanded', String(this.expanded));
    this.toggleButton.textContent = this.expanded ? '⌄' : '⌃'; this.toggleButton.title = this.expanded ? 'Collapse terminal' : 'Open terminal';
    if (this.expanded) this.scheduleFit();
  }

  private bindControls(): void {
    this.toggleButton.addEventListener('click', () => {
      this.expanded = !this.expanded; try { window.localStorage.setItem(OPEN_KEY, String(this.expanded)); } catch { /* State persistence is optional. */ }
      this.renderExpandedState(); if (this.active && this.expanded) this.ensureTerminal();
    });
    this.clearButton.addEventListener('click', () => this.terminal?.clear());
    this.restartButton.addEventListener('click', () => {
      if (this.busy && !window.confirm('A command is still running. End it and start a new shell in the displayed folder?')) return;
      this.restart();
    });
    this.resizer.addEventListener('pointerdown', (event) => { if (event.button !== 0 || !this.expanded) return; event.preventDefault(); this.resizePointer = event.pointerId; document.body.classList.add('resizing-terminal'); });
    document.addEventListener('pointermove', (event) => { if (event.pointerId !== this.resizePointer) return; event.preventDefault(); this.setHeight(window.innerHeight - event.clientY, false); });
    const finishResize = (event: PointerEvent) => { if (event.pointerId !== this.resizePointer) return; this.resizePointer = null; document.body.classList.remove('resizing-terminal'); this.setHeight(this.height); };
    document.addEventListener('pointerup', finishResize); document.addEventListener('pointercancel', finishResize);
    this.resizer.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !this.expanded) return; event.preventDefault();
      const height = event.key === 'Home' ? MIN_HEIGHT : event.key === 'End' ? this.maximumHeight() : this.height + (event.key === 'ArrowUp' ? 20 : -20); this.setHeight(height);
    });
    window.addEventListener('resize', () => this.setHeight(this.height, false));
  }

  private ensureTerminal(): void {
    if (!this.terminal) {
      this.terminal = new Terminal({
        cursorBlink: true, cursorStyle: 'bar', fontFamily: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.25, scrollback: 5_000,
        theme: { background: '#101113', foreground: '#d8ff49', cursor: '#d8ff49', cursorAccent: '#101113', selectionBackground: '#59622699', black: '#17181b', brightBlack: '#686a72', red: '#ff7a86', brightRed: '#ff9ba4', green: '#b9e33c', brightGreen: '#d8ff49', yellow: '#e6cf6a', brightYellow: '#f4e282', blue: '#75a7ff', brightBlue: '#9bbfff', magenta: '#c893ff', brightMagenta: '#dcb5ff', cyan: '#63d7d2', brightCyan: '#88ebe6', white: '#d8d9dc', brightWhite: '#ffffff' },
      });
      this.fitAddon = new FitAddon(); this.terminal.loadAddon(this.fitAddon); this.terminal.open(this.host);
      this.terminal.onData((data) => this.send({ type: 'input', data }));
      this.terminal.attachCustomKeyEventHandler((event) => this.handleClipboardKey(event));
    }
    this.scheduleFit(); if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.connect();
  }

  private handleClipboardKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const modifier = navigator.platform.toLowerCase().includes('mac') ? event.metaKey : event.ctrlKey && event.shiftKey;
    if (!modifier) return true;
    if (event.key.toLowerCase() === 'c' && this.terminal?.hasSelection()) { void navigator.clipboard?.writeText(this.terminal.getSelection()); return false; }
    if (event.key.toLowerCase() === 'v' && navigator.clipboard?.readText) { void navigator.clipboard.readText().then((data) => this.send({ type: 'input', data })).catch(() => {}); return false; }
    return true;
  }

  private restart(): void {
    this.connectionGeneration += 1; this.socket?.close(1000, 'Shell restarted.'); this.socket = null; this.ready = false; this.busy = false; this.exited = false; this.lastDimensions = '';
    this.terminal?.reset(); this.terminal?.clear(); this.connect();
  }

  private connect(): void {
    if (!this.terminal || !this.fitAddon) return;
    const generation = ++this.connectionGeneration; const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(`${protocol}//${window.location.host}/api/terminal`); this.socket = socket; this.setStatus('Connecting…', 'connecting');
    socket.addEventListener('open', () => {
      if (generation !== this.connectionGeneration) return socket.close();
      this.fitAddon?.fit(); const dimensions = this.dimensions(); socket.send(JSON.stringify({ type: 'start', cwd: this.getWorkingDirectory(), ...dimensions })); this.lastDimensions = `${dimensions.cols}x${dimensions.rows}`;
    });
    socket.addEventListener('message', (event) => {
      if (generation !== this.connectionGeneration) return;
      try {
        const message = JSON.parse(String(event.data)) as TerminalServerMessage;
        if (message.type === 'output') this.terminal?.write(message.data);
        else if (message.type === 'ready') { this.ready = true; this.exited = false; this.setStatus('Ready', 'ready'); this.scheduleFit(); this.terminal?.focus(); }
        else if (message.type === 'status') { this.busy = message.busy; this.setStatus(message.busy ? 'Running' : 'Ready', message.busy ? 'busy' : 'ready'); }
        else if (message.type === 'exit') { this.ready = false; this.busy = false; this.exited = true; this.terminal?.writeln(`\r\n\x1b[90m[process exited with code ${message.code}${message.signal ? `, signal ${message.signal}` : ''}]\x1b[0m`); this.setStatus('Exited', 'exited'); }
        else if (message.type === 'error') { this.terminal?.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`); this.setStatus('Error', 'error'); }
      } catch { this.setStatus('Protocol error', 'error'); }
    });
    socket.addEventListener('close', () => {
      if (generation !== this.connectionGeneration) return; this.socket = null; this.ready = false; this.busy = false;
      if (!this.exited) { this.terminal?.writeln('\r\n\x1b[90m[terminal disconnected]\x1b[0m'); this.setStatus('Disconnected', 'error'); }
    });
    socket.addEventListener('error', () => { if (generation === this.connectionGeneration) this.setStatus('Connection error', 'error'); });
  }

  private dimensions(): { cols: number; rows: number } { return { cols: Math.max(2, this.terminal?.cols || 80), rows: Math.max(1, this.terminal?.rows || 24) }; }

  private send(message: object): void { if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }

  private scheduleFit(): void {
    if (!this.expanded || !this.terminal || !this.fitAddon) return;
    if (this.resizeFrame !== null) window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null; if (!this.expanded || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
      try { this.fitAddon?.fit(); } catch { return; }
      const dimensions = this.dimensions(); const signature = `${dimensions.cols}x${dimensions.rows}`;
      if (signature !== this.lastDimensions && this.ready) { this.lastDimensions = signature; this.send({ type: 'resize', ...dimensions }); }
    });
  }

  private setStatus(label: string, state: string): void { this.status.textContent = label; this.status.dataset.state = state; }
}
