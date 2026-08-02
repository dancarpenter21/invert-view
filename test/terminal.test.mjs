import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { attachTerminalSocket, createShellStatusParser, resolveTerminalDirectory, SHELL_BUSY_MARKER, SHELL_IDLE_MARKER, websocketOriginAllowed } from '../terminal-server.mjs';

async function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal state.'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];
  closed = null;
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = WebSocket.CLOSING; }
}

class FakePty {
  pid = 4321;
  writes = [];
  resizes = [];
  killed = false;
  onData(listener) { this.dataListener = listener; return { dispose() {} }; }
  onExit(listener) { this.exitListener = listener; return { dispose() {} }; }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push({ cols, rows }); }
  kill() { this.killed = true; }
}

test('terminal directory resolution requires an existing absolute directory', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-view-terminal-directory-'));
  try {
    assert.equal(await resolveTerminalDirectory(directory), directory);
    assert.equal(await resolveTerminalDirectory('', directory), directory);
    await assert.rejects(resolveTerminalDirectory('relative/path'), /must be absolute/);
    const file = join(directory, 'file'); await fs.writeFile(file, 'content');
    await assert.rejects(resolveTerminalDirectory(file), /not a directory/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('websocket upgrades require an exact loopback origin and host match', () => {
  assert.equal(websocketOriginAllowed({ headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' } }), true);
  assert.equal(websocketOriginAllowed({ headers: { origin: 'http://localhost:4174', host: 'localhost:4174' } }), true);
  assert.equal(websocketOriginAllowed({ headers: { origin: 'https://evil.example', host: '127.0.0.1:4174' } }), false);
  assert.equal(websocketOriginAllowed({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:4174' } }), false);
  assert.equal(websocketOriginAllowed({ headers: { host: '127.0.0.1:4174' } }), false);
});

test('shell status markers are detected in order across output chunks', () => {
  const statuses = []; const parse = createShellStatusParser((busy) => statuses.push(busy));
  parse(`prompt${SHELL_BUSY_MARKER.slice(0, 5)}`); parse(`${SHELL_BUSY_MARKER.slice(5)}output${SHELL_IDLE_MARKER.slice(0, 4)}`); parse(SHELL_IDLE_MARKER.slice(4));
  assert.deepEqual(statuses, [true, false]);
});

test('terminal socket starts zsh, proxies input and resize, reports status, and kills on close', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-view-terminal-socket-')); const socket = new FakeSocket(); const terminal = new FakePty(); let spawnCall;
  attachTerminalSocket(socket, {
    shell: '/usr/bin/zsh', fallbackDirectory: directory, environment: { HOME: '/home/test', PATH: '/usr/bin' }, getIntegrationDirectory: async () => '/tmp/integration',
    spawnPty: (shell, args, options) => { spawnCall = { shell, args, options }; return terminal; },
  });
  try {
    socket.emit('message', JSON.stringify({ type: 'start', cwd: directory, cols: 100, rows: 30 })); await waitFor(() => socket.sent.some((message) => message.type === 'ready'));
    assert.equal(spawnCall.shell, '/usr/bin/zsh'); assert.deepEqual(spawnCall.args, ['-i']); assert.equal(spawnCall.options.cwd, directory); assert.equal(spawnCall.options.env.TERM, 'xterm-256color'); assert.equal(spawnCall.options.env.ZDOTDIR, '/tmp/integration');
    socket.emit('message', JSON.stringify({ type: 'input', data: 'echo hello\r' })); socket.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    assert.deepEqual(terminal.writes, ['echo hello\r']); assert.deepEqual(terminal.resizes, [{ cols: 120, rows: 40 }]);
    terminal.dataListener(`result${SHELL_BUSY_MARKER}${SHELL_IDLE_MARKER}`);
    assert.deepEqual(socket.sent.filter((message) => message.type === 'status').map((message) => message.busy), [true, false]);
    assert.equal(socket.sent.find((message) => message.type === 'output').data, `result${SHELL_BUSY_MARKER}${SHELL_IDLE_MARKER}`);
    socket.emit('close'); assert.equal(terminal.killed, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('terminal socket rejects invalid initialization without spawning a process', async () => {
  const socket = new FakeSocket(); let spawned = false;
  attachTerminalSocket(socket, { spawnPty: () => { spawned = true; }, getIntegrationDirectory: async () => '/tmp/integration' });
  socket.emit('message', JSON.stringify({ type: 'start', cwd: '/tmp', cols: 0, rows: 30 })); await waitFor(() => socket.closed !== null);
  assert.equal(spawned, false); assert.equal(socket.closed.code, 1011); assert.match(socket.sent.at(-1).message, /dimensions/);
});
