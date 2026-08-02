import { promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';

export const TERMINAL_SOCKET_PATH = '/api/terminal';
export const TERMINAL_MAX_PAYLOAD = 64 * 1024;
export const SHELL_BUSY_MARKER = '\x1b]633;C\x07';
export const SHELL_IDLE_MARKER = '\x1b]633;D\x07';

const MIN_COLUMNS = 2;
const MAX_COLUMNS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;
const SHELL_INTEGRATION = `
typeset -g __inv_view_original_zdotdir="\${INV_VIEWER_ORIGINAL_ZDOTDIR:-\$HOME}"
ZDOTDIR="\$__inv_view_original_zdotdir"
if [[ -r "\$ZDOTDIR/.zshrc" ]]; then
  source "\$ZDOTDIR/.zshrc"
fi
autoload -Uz add-zsh-hook
function __inv_view_preexec() { print -n -- \$'\\e]633;C\\a' }
function __inv_view_precmd() { print -n -- \$'\\e]633;D\\a' }
add-zsh-hook preexec __inv_view_preexec
add-zsh-hook precmd __inv_view_precmd
unset __inv_view_original_zdotdir
`;

let integrationDirectoryPromise;

async function integrationDirectory() {
  if (!integrationDirectoryPromise) integrationDirectoryPromise = (async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'inv-view-zsh-'));
    await fs.writeFile(join(directory, '.zshrc'), SHELL_INTEGRATION, { mode: 0o600 });
    process.once('exit', () => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* The OS also clears its temporary directory. */ } });
    return directory;
  })();
  return integrationDirectoryPromise;
}

function terminalSize(message) {
  const cols = Number(message?.cols); const rows = Number(message?.rows);
  if (!Number.isInteger(cols) || cols < MIN_COLUMNS || cols > MAX_COLUMNS || !Number.isInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) throw new Error('Invalid terminal dimensions.');
  return { cols, rows };
}

export async function resolveTerminalDirectory(candidate, fallback = process.cwd()) {
  const requested = candidate === undefined || candidate === null || candidate === '' ? fallback : candidate;
  if (typeof requested !== 'string' || !isAbsolute(requested)) throw new Error('The terminal working directory must be absolute.');
  const directory = resolve(requested); const info = await fs.stat(directory);
  if (!info.isDirectory()) throw new Error('The terminal working directory is not a directory.');
  return directory;
}

export function websocketOriginAllowed(request) {
  const origin = request?.headers?.origin; const host = request?.headers?.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
}

export function createShellStatusParser(onStatus) {
  const longestMarker = Math.max(SHELL_BUSY_MARKER.length, SHELL_IDLE_MARKER.length); let tail = '';
  return (data) => {
    const combined = tail + data; const markers = [];
    for (const [marker, busy] of [[SHELL_BUSY_MARKER, true], [SHELL_IDLE_MARKER, false]]) {
      let offset = combined.indexOf(marker);
      while (offset !== -1) { markers.push({ offset, busy }); offset = combined.indexOf(marker, offset + marker.length); }
    }
    markers.sort((left, right) => left.offset - right.offset).forEach(({ busy }) => onStatus(busy));
    tail = combined.slice(-(longestMarker - 1));
  };
}

export function attachTerminalSocket(socket, { shell = '/usr/bin/zsh', spawnPty = pty.spawn, fallbackDirectory = process.cwd(), environment = process.env, getIntegrationDirectory = integrationDirectory } = {}) {
  let terminal = null; let started = false; let closed = false;
  const send = (message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const closeWithError = (message, code = 1008) => { send({ type: 'error', message }); if (socket.readyState === WebSocket.OPEN) socket.close(code, message.slice(0, 120)); };
  const stopTerminal = () => { const running = terminal; terminal = null; if (running) try { running.kill(); } catch { /* The process may already have exited. */ } };
  const initializationTimer = setTimeout(() => { if (!started) closeWithError('Terminal initialization timed out.'); }, 5_000);

  socket.on('message', async (payload) => {
    let message;
    try { message = JSON.parse(String(payload)); } catch { return closeWithError('Invalid terminal message.'); }
    if (!started) {
      if (message?.type !== 'start') return closeWithError('The first terminal message must start a shell.');
      started = true; clearTimeout(initializationTimer);
      try {
        const { cols, rows } = terminalSize(message); const cwd = await resolveTerminalDirectory(message.cwd, fallbackDirectory); const zdotdir = await getIntegrationDirectory();
        if (closed) return;
        terminal = spawnPty(shell, ['-i'], {
          name: 'xterm-256color', cols, rows, cwd,
          env: { ...environment, TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: shell, INV_VIEWER_ORIGINAL_ZDOTDIR: environment.ZDOTDIR || environment.HOME || '', ZDOTDIR: zdotdir },
        });
        const parseStatus = createShellStatusParser((busy) => send({ type: 'status', busy }));
        terminal.onData((data) => { parseStatus(data); send({ type: 'output', data }); });
        terminal.onExit(({ exitCode, signal }) => { terminal = null; send({ type: 'exit', code: exitCode, signal }); if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Shell exited.'); });
        send({ type: 'ready', pid: terminal.pid, cwd });
      } catch (error) { closeWithError(error instanceof Error ? error.message : String(error), 1011); }
      return;
    }
    if (!terminal) return closeWithError('The shell is not running.');
    try {
      if (message?.type === 'input') {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > TERMINAL_MAX_PAYLOAD) throw new Error('Invalid terminal input.');
        terminal.write(message.data);
      } else if (message?.type === 'resize') {
        const { cols, rows } = terminalSize(message); terminal.resize(cols, rows);
      } else throw new Error('Unknown terminal message type.');
    } catch (error) { closeWithError(error instanceof Error ? error.message : String(error)); }
  });
  socket.once('close', () => { closed = true; clearTimeout(initializationTimer); stopTerminal(); });
  socket.once('error', () => { closed = true; clearTimeout(initializationTimer); stopTerminal(); });
  return { stop: stopTerminal };
}

export function createTerminalWebSocketServer(options = {}) {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_MAX_PAYLOAD });
  webSockets.on('connection', (socket) => attachTerminalSocket(socket, options));
  return webSockets;
}
