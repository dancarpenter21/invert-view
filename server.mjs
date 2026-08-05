import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs, watch as watchFileSystem } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createTerminalWebSocketServer, TERMINAL_SOCKET_PATH, websocketOriginAllowed } from './terminal-server.mjs';

const PORT = Number(process.env.INV_VIEWER_PORT || 4174);
const CACHE_DIRECTORY = '.inv-cache';
const THUMBNAIL_DIRECTORY = 'thumbnails';
const PLAYBACK_DIRECTORY = 'playback';
const FRAME_METADATA_FILE = '.inv-frames.json';
const HEADER_BYTES = 8192;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 200;
const TEXT_MIME_BY_EXTENSION = new Map([
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.json', 'application/json'], ['.yaml', 'text/yaml'], ['.yml', 'text/yaml'], ['.csv', 'text/csv'], ['.log', 'text/plain'], ['.xml', 'application/xml'], ['.html', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'], ['.ts', 'text/plain'],
]);
let openedRoot = null;
const jobs = new Map();
const lastJobUpdateAt = new WeakMap();
let publishJobUpdate = () => {};
let manifestWriteQueue = Promise.resolve();

export const xor = (buffer) => {
  const result = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index < buffer.length; index += 1) result[index] = buffer[index] ^ 0xff;
  return result;
};

export function restoredName(name) { return name.replace(/\.inv(?=\.[^.]+$|$)/i, ''); }

export function invertedName(name) {
  const extension = extname(name);
  return extension.length > 1 ? `${name.slice(0, -extension.length)}.inv${extension}` : `${name}.inv`;
}

export function detectMime(header) {
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (header.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) return 'image/png';
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (header.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'AVI ') return 'video/x-msvideo';
  if (header.subarray(0, 4).toString('ascii') === 'OggS') return 'video/ogg';
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = header.subarray(8, 12).toString('ascii');
    if (brand === 'qt  ') return 'video/quicktime';
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    return 'video/mp4';
  }
  return 'application/octet-stream';
}

export function videoFrameDurationMs(header) {
  if (detectMime(header) !== 'video/x-msvideo') return null;
  const chunk = header.indexOf(Buffer.from('avih'));
  if (chunk < 0 || chunk + 12 > header.length) return null;
  const microseconds = header.readUInt32LE(chunk + 8);
  return microseconds > 0 && microseconds <= 1_000_000 ? microseconds / 1_000 : null;
}

export function isInvertedMedia(header) {
  return detectMime(header) === 'application/octet-stream' && detectMime(xor(header)) !== 'application/octet-stream';
}

export function isWatchableChange(filename) {
  if (filename === null || filename === undefined) return true;
  const path = Buffer.isBuffer(filename) ? filename.toString() : String(filename);
  return path.split(/[\\/]/, 1)[0] !== CACHE_DIRECTORY;
}

export function watchDirectoryChanges(directory, onChange, { debounceMs = WATCH_DEBOUNCE_MS, onError = () => {}, watchImplementation = watchFileSystem } = {}) {
  let timer = null; let closed = false; let watcher;
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); timer = null;
    watcher?.close();
  };
  watcher = watchImplementation(directory, { persistent: false }, (_eventType, filename) => {
    if (closed || !isWatchableChange(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (!closed) onChange(); }, debounceMs);
  });
  watcher.once('error', (error) => { close(); onError(error); });
  return { close };
}

export function textMimeFor(name) { return TEXT_MIME_BY_EXTENSION.get(extname(restoredName(name)).toLowerCase()) || null; }
export function isConventionalInvertedName(name) { return /\.inv(?=\.[^.]+$|$)/i.test(name); }

function kindFor(mime) { return mime.startsWith('image/') ? 'images' : mime.startsWith('video/') ? 'videos' : 'other'; }
function cacheRoot() { return join(openedRoot, CACHE_DIRECTORY); }
function assertOpened() { if (!openedRoot) throw new Error('Open a local folder first.'); }
function resolveOpenedPath(relativePath) {
  assertOpened();
  if (!relativePath || typeof relativePath !== 'string') throw new Error('A file path is required.');
  const candidate = resolve(openedRoot, normalize(relativePath));
  if (candidate !== openedRoot && !candidate.startsWith(`${openedRoot}${sep}`)) throw new Error('File path is outside the opened folder.');
  if (relative(candidate, cacheRoot()) === '' || !relative(candidate, cacheRoot()).startsWith(`..${sep}`)) throw new Error('Cache files are not source files.');
  return candidate;
}
function resolveSource(relativePath) { return resolveOpenedPath(relativePath); }
async function resolveManagedEntry(relativePath) {
  const source = resolveOpenedPath(relativePath);
  const info = await fs.stat(source);
  return { source, info };
}
async function resolveDirectory(relativePath = '') {
  assertOpened();
  const candidate = relativePath ? resolveOpenedPath(relativePath) : openedRoot;
  const info = await fs.stat(candidate);
  if (!info.isDirectory()) throw new Error('The supplied path is not a directory.');
  return candidate;
}
async function hasListableParent(directory) {
  const parent = dirname(directory);
  if (parent === directory) return false;
  try { await fs.readdir(parent); return true; } catch { return false; }
}
function keyFor(relativePath) { return createHash('sha256').update(relativePath).digest('hex').slice(0, 12); }
function stemFor(relativePath) { return basename(restoredName(relativePath), extname(restoredName(relativePath))).replace(/[^a-z0-9._-]+/gi, '_') || 'video'; }
export function frameDirectoryName(relativePath) { return `${basename(relativePath)}.frames`; }
export function frameTimeRangeFor(durationMs, frameCount, names) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isSafeInteger(frameCount) || frameCount <= 0 || !Array.isArray(names)) return null;
  const frameNumbers = names.map((name) => /^(\d{6,})\.inv\.jpg$/i.exec(name)?.[1]).filter(Boolean).map(Number).filter((number) => Number.isSafeInteger(number) && number >= 1 && number <= frameCount);
  if (!frameNumbers.length) return null;
  const firstFrame = Math.min(...frameNumbers); const lastFrame = Math.max(...frameNumbers);
  return { startMs: Math.max(0, durationMs * (firstFrame - 1) / frameCount), endMs: Math.min(durationMs, durationMs * lastFrame / frameCount) };
}
function artifactPaths(relativePath) {
  const id = `${stemFor(relativePath)}-${keyFor(relativePath)}`;
  return { thumbnail: join(cacheRoot(), THUMBNAIL_DIRECTORY, `${id}.thumb.inv.jpg`), playback: join(cacheRoot(), PLAYBACK_DIRECTORY, `${id}.playback.inv.mp4`), frames: join(openedRoot, dirname(relativePath), frameDirectoryName(relativePath)) };
}
async function readManifest() {
  try { return JSON.parse(await fs.readFile(join(cacheRoot(), 'manifest.json'), 'utf8')); } catch { return { version: 1, files: {} }; }
}
async function writeManifest(manifest) {
  await fs.mkdir(cacheRoot(), { recursive: true });
  const destination = join(cacheRoot(), 'manifest.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(temporary, destination);
}
function updateManifest(update) {
  const task = manifestWriteQueue.then(async () => {
    const manifest = await readManifest();
    await update(manifest);
    await writeManifest(manifest);
  });
  manifestWriteQueue = task.catch(() => {});
  return task;
}
async function fileFingerprint(source) { const info = await fs.stat(source); return { size: info.size, modifiedMs: info.mtimeMs }; }
function fingerprintMatches(entry, fingerprint) { return entry?.size === fingerprint.size && entry?.modifiedMs === fingerprint.modifiedMs; }
function updateManifestEntry(manifest, relativePath, fingerprint, values) {
  const current = manifest.files[relativePath];
  manifest.files[relativePath] = { ...(fingerprintMatches(current, fingerprint) ? current : {}), ...fingerprint, ...values };
}
async function sourceHeader(source) {
  const handle = await fs.open(source, 'r');
  try { const buffer = Buffer.alloc(HEADER_BYTES); const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}
async function restoredHeader(source) { return xor(await sourceHeader(source)); }
export async function restoredText(source) {
  const info = await fs.stat(source);
  if (info.size > MAX_TEXT_BYTES) throw new Error('Text files larger than 5 MB cannot be edited in the browser.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(xor(await fs.readFile(source))); }
  catch (error) { if (error instanceof TypeError) throw new Error('The restored file is not valid UTF-8 text.'); throw error; }
}
export async function saveRestoredText(source, content) {
  if (typeof content !== 'string') throw new Error('Text content is required.');
  const restored = Buffer.from(content, 'utf8');
  if (restored.length > MAX_TEXT_BYTES) throw new Error('Text files larger than 5 MB cannot be edited in the browser.');
  const temporary = `${source}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, xor(restored));
  await fs.rename(temporary, source);
}
async function isCurrentThumbnail(relativePath, source, manifest) {
  const currentManifest = manifest || await readManifest(); const entry = currentManifest.files[relativePath];
  if (!entry?.thumbnail) return false;
  const fingerprint = await fileFingerprint(source);
  if (entry.size !== fingerprint.size || entry.modifiedMs !== fingerprint.modifiedMs) return false;
  try { await fs.access(entry.thumbnail); return true; } catch { return false; }
}
async function currentPlaybackPath(relativePath, source, manifest) {
  const currentManifest = manifest || await readManifest(); const entry = currentManifest.files[relativePath];
  if (!entry?.playback) return null;
  const fingerprint = await fileFingerprint(source);
  if (!fingerprintMatches(entry, fingerprint)) return null;
  try { await fs.access(entry.playback); return entry.playback; } catch { return null; }
}
async function invertFile(source, destination) { await pipeline(createReadStream(source), new Transform({ transform(chunk, _encoding, callback) { callback(null, xor(chunk)); } }), createWriteStream(destination)); }
async function restoredTemporaryFile(source) {
  const suffix = extname(restoredName(source)) || '.bin'; const destination = join(tmpdir(), `inv-viewer-${randomUUID()}${suffix}`);
  await invertFile(source, destination); return destination;
}
function reportJob(job, force = false) {
  const now = Date.now(); const lastUpdate = lastJobUpdateAt.get(job) || 0;
  if (!force && now - lastUpdate < 250) return;
  lastJobUpdateAt.set(job, now); publishJobUpdate(job);
}
function runFfmpeg(args, job) {
  return new Promise((resolveJob, rejectJob) => {
    let stderr = ''; let lastOutputTimeUs = 0;
    const process = spawn('ffmpeg', ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    process.once('error', (error) => rejectJob(error));
    process.stdout.setEncoding('utf8'); process.stdout.on('data', (data) => data.split('\n').forEach((line) => {
      const match = /^out_time_(?:ms|us)=(\d+)$/.exec(line.trim());
      if (match) { lastOutputTimeUs = Math.max(lastOutputTimeUs, Number(match[1])); if (job.durationMs) job.progress = Math.min(0.98, lastOutputTimeUs / (job.durationMs * 1000)); reportJob(job); }
    }));
    process.stderr.setEncoding('utf8'); process.stderr.on('data', (data) => { stderr += data; });
    process.once('close', (code) => code === 0 ? resolveJob(lastOutputTimeUs / 1000) : rejectJob(new Error(stderr.trim() || `ffmpeg exited with code ${code}`)));
  });
}
async function durationFor(source) {
  return new Promise((resolveDuration) => {
    const process = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', source]); let output = '';
    process.stdout.on('data', (chunk) => { output += chunk; }); process.once('error', () => resolveDuration(null));
    process.once('close', () => { const seconds = Number(output.trim()); resolveDuration(Number.isFinite(seconds) ? seconds * 1000 : null); });
  });
}
function createJob(type, relativePath) { const job = { id: randomUUID(), type, path: relativePath, status: 'queued', progress: 0, error: null, createdAt: Date.now() }; jobs.set(job.id, job); reportJob(job, true); return job; }
async function thumbnailJob(relativePath, source) {
  const job = createJob('thumbnail', relativePath); job.status = 'running'; reportJob(job, true);
  const paths = artifactPaths(relativePath); let restored = null; let temporaryJpg = null;
  try {
    restored = await restoredTemporaryFile(source); temporaryJpg = join(tmpdir(), `inv-viewer-${randomUUID()}.jpg`);
    await fs.mkdir(dirname(paths.thumbnail), { recursive: true });
    try { await runFfmpeg(['-ss', '00:00:01', '-i', restored, '-frames:v', '1', '-q:v', '2', temporaryJpg], job); }
    catch { await runFfmpeg(['-i', restored, '-frames:v', '1', '-q:v', '2', temporaryJpg], job); }
    await invertFile(temporaryJpg, paths.thumbnail);
    const fingerprint = await fileFingerprint(source);
    await updateManifest((manifest) => updateManifestEntry(manifest, relativePath, fingerprint, { thumbnail: paths.thumbnail }));
    job.status = 'complete'; job.progress = 1; reportJob(job, true);
  } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); reportJob(job, true); }
  finally { await Promise.all([restored, temporaryJpg].filter(Boolean).map((item) => fs.rm(item, { force: true }))); }
  return job;
}
function activePlaybackJob(relativePath) {
  return [...jobs.values()].find((job) => job.type === 'playback' && job.path === relativePath && (job.status === 'queued' || job.status === 'running')) || null;
}
async function playbackJob(job, relativePath, source) {
  job.status = 'running'; reportJob(job, true); const paths = artifactPaths(relativePath);
  let restored = null; let encoded = null; let staged = null;
  try {
    const initialFingerprint = await fileFingerprint(source);
    restored = await restoredTemporaryFile(source); job.durationMs = await durationFor(restored); encoded = join(tmpdir(), `inv-viewer-${randomUUID()}.mp4`);
    await runFfmpeg(['-i', restored, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', encoded], job);
    const finalFingerprint = await fileFingerprint(source);
    if (!fingerprintMatches(initialFingerprint, finalFingerprint)) throw new Error('The source video changed while its compatible copy was being prepared.');
    await fs.mkdir(dirname(paths.playback), { recursive: true }); staged = `${paths.playback}.${randomUUID()}.tmp`; await invertFile(encoded, staged);
    const verifiedFingerprint = await fileFingerprint(source);
    if (!fingerprintMatches(initialFingerprint, verifiedFingerprint)) throw new Error('The source video changed while its compatible copy was being prepared.');
    await fs.rename(staged, paths.playback); staged = null;
    await updateManifest((manifest) => updateManifestEntry(manifest, relativePath, initialFingerprint, { playback: paths.playback }));
    job.status = 'complete'; job.progress = 1; reportJob(job, true);
  } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); reportJob(job, true); }
  finally { await Promise.all([restored, encoded, staged].filter(Boolean).map((item) => fs.rm(item, { force: true }))); }
  return job;
}
async function resolveFrameOutputDirectory(value, source) {
  if (value === undefined || value === null || value === '') return dirname(source);
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('The extracted frame directory must be an absolute path.');
  const directory = resolve(value); const info = await fs.stat(directory);
  if (!info.isDirectory()) throw new Error('The extracted frame path is not a directory.');
  await fs.access(directory, fsConstants.W_OK); return directory;
}
async function availableFrameDestination(relativePath, timeMs, directory) {
  const stem = stemFor(relativePath); const timestamp = String(Math.round(timeMs)).padStart(9, '0');
  for (let copy = 1; ; copy += 1) {
    const suffix = copy === 1 ? '' : `-${copy}`; const destination = join(directory, `${stem}.frame-${timestamp}${suffix}.inv.jpg`);
    try { await fs.lstat(destination); } catch (error) { if (error?.code === 'ENOENT') return destination; throw error; }
  }
}
async function extractVideoFrame(relativePath, source, timeMs, directory) {
  let restored = null; let jpeg = null; let staged = null;
  try {
    restored = await restoredTemporaryFile(source); jpeg = join(tmpdir(), `inv-viewer-${randomUUID()}.jpg`);
    await runFfmpeg(['-ss', (timeMs / 1_000).toFixed(3), '-i', restored, '-frames:v', '1', '-q:v', '2', jpeg], {});
    const destination = await availableFrameDestination(relativePath, timeMs, directory); staged = `${destination}.${randomUUID()}.tmp`; await invertFile(jpeg, staged); await fs.rename(staged, destination); staged = null;
    return { outputPath: destination, name: basename(destination), timeMs: Math.round(timeMs) };
  } finally { await Promise.all([restored, jpeg, staged].filter(Boolean).map((item) => fs.rm(item, { force: true }))); }
}
async function explodeJob(job, relativePath, source) {
  job.status = 'running'; reportJob(job, true); const paths = artifactPaths(relativePath);
  let restored = null; let work = null; let staged = null;
  try {
    restored = await restoredTemporaryFile(source); job.durationMs = await durationFor(restored); work = join(tmpdir(), `inv-viewer-frames-${randomUUID()}`); await fs.mkdir(work);
    const observedDurationMs = await runFfmpeg(['-i', restored, '-q:v', '2', join(work, '%06d.jpg')], job);
    const generated = (await fs.readdir(work)).filter((name) => name.endsWith('.jpg')).sort(); if (!generated.length) throw new Error('ffmpeg produced no frames.');
    staged = `${paths.frames}.${randomUUID()}.tmp`; await fs.mkdir(staged, { recursive: true });
    for (const name of generated) await invertFile(join(work, name), join(staged, name.replace(/\.jpg$/i, '.inv.jpg')));
    const fingerprint = await fileFingerprint(source); const durationMs = Number.isFinite(job.durationMs) && job.durationMs > 0 ? job.durationMs : observedDurationMs > 0 ? observedDurationMs : null;
    const frameMetadata = { version: 1, sourceName: basename(relativePath), sourceSize: fingerprint.size, sourceModifiedMs: fingerprint.modifiedMs, durationMs, frameCount: generated.length, firstFrameNumber: 1 };
    try { await fs.writeFile(join(staged, FRAME_METADATA_FILE), `${JSON.stringify(frameMetadata, null, 2)}\n`); } catch { /* Timing metadata is optional; keep the extracted frames. */ }
    await fs.mkdir(dirname(paths.frames), { recursive: true }); await fs.rm(paths.frames, { recursive: true, force: true }); await fs.rename(staged, paths.frames);
    await updateManifest((manifest) => updateManifestEntry(manifest, relativePath, fingerprint, { frames: paths.frames, frameCount: generated.length, durationMs }));
    job.status = 'complete'; job.progress = 1; reportJob(job, true);
  } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); reportJob(job, true); }
  finally { await Promise.all([restored, work, staged].filter(Boolean).map((item) => fs.rm(item, { recursive: true, force: true }))); }
  return job;
}
export async function frameMetadataForDirectory(directory) {
  try {
    if (!basename(directory).endsWith('.frames')) return null;
    const expectedSourceName = basename(directory).slice(0, -'.frames'.length); if (!expectedSourceName) return null;
    const metadata = JSON.parse(await fs.readFile(join(directory, FRAME_METADATA_FILE), 'utf8'));
    if (metadata?.version !== 1 || metadata.sourceName !== expectedSourceName || metadata.firstFrameNumber !== 1 || !Number.isSafeInteger(metadata.frameCount) || metadata.frameCount <= 0 || !Number.isFinite(metadata.durationMs) || metadata.durationMs <= 0) return null;
    const source = join(dirname(directory), expectedSourceName); const info = await fs.stat(source);
    if (!info.isFile() || info.size !== metadata.sourceSize || info.mtimeMs !== metadata.sourceModifiedMs || !detectMime(await restoredHeader(source)).startsWith('video/')) return null;
    return metadata;
  } catch { return null; }
}
async function scanFolder(relativeDirectory = '', { includeHidden = false, query = '', offset = 0, limit = 250 } = {}) {
  const directory = await resolveDirectory(relativeDirectory); const entries = []; const manifest = await readManifest(); const frameMetadata = await frameMetadataForDirectory(directory);
  const directoryEntries = await fs.readdir(directory, { withFileTypes: true }); let matched = 0; let hasMore = false;
  const total = !query ? directoryEntries.filter((entry) => entry.name !== CACHE_DIRECTORY && (includeHidden || !entry.name.startsWith('.')) && (entry.isDirectory() || (entry.isFile() && isConventionalInvertedName(entry.name)))).length : null;
  for (const entry of directoryEntries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))) {
    if (entry.name === CACHE_DIRECTORY || (!includeHidden && entry.name.startsWith('.'))) continue;
    const source = join(directory, entry.name); const path = relative(openedRoot, source);
    if (entry.isDirectory()) { if (matched++ < offset) continue; if (entries.length >= limit) { hasMore = true; break; } entries.push({ path, name: entry.name, directory: true }); continue; }
    if (!entry.isFile()) continue;
    if (query && !entry.name.toLowerCase().includes(query)) continue;
    const header = await sourceHeader(source); const textMime = textMimeFor(entry.name);
    if (!isInvertedMedia(header) && !(textMime && isConventionalInvertedName(entry.name))) continue;
    const restored = xor(header); const detectedMime = detectMime(restored); const mime = detectedMime === 'application/octet-stream' && textMime ? textMime : detectedMime; const info = await fs.stat(source); const frameDurationMs = detectedMime.startsWith('video/') ? videoFrameDurationMs(restored) : null;
    const record = { path, name: entry.name, size: info.size, modified: info.mtimeMs, mime, kind: kindFor(mime), editableText: Boolean(textMime), thumbnail: null, ...(frameDurationMs ? { frameDurationMs } : {}) };
    if (matched++ < offset) continue;
    if (entries.length >= limit) { hasMore = true; break; }
    if (record.kind === 'videos') { if (await isCurrentThumbnail(path, source, manifest)) record.thumbnail = `/api/thumbnail?path=${encodeURIComponent(path)}`; else { record.thumbnail = 'pending'; void thumbnailJob(path, source); } }
    entries.push(record);
  }
  const range = frameMetadata ? frameTimeRangeFor(frameMetadata.durationMs, frameMetadata.frameCount, entries.map((entry) => entry.name)) : null;
  const frameTimeRange = range ? { sourceName: frameMetadata.sourceName, ...range } : null;
  return { files: entries, hasMore, total, frameTimeRange };
}
function sendJson(response, status, value) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
function contentType(file) { return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' })[extname(file)] || 'application/octet-stream'; }
async function serveApplication(response, pathname) {
  const dist = resolve('dist'); const requested = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`);
  const candidate = requested.startsWith(`${dist}${sep}`) ? requested : join(dist, 'index.html');
  try { const data = await fs.readFile(candidate); response.writeHead(200, { 'content-type': contentType(candidate) }); response.end(data); }
  catch { const index = join(dist, 'index.html'); const data = await fs.readFile(index); response.writeHead(200, { 'content-type': contentType(index) }); response.end(data); }
}
async function readJson(request) { let body = ''; for await (const chunk of request) body += chunk; return body ? JSON.parse(body) : {}; }
export function validateFolderName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('Provide a single folder name.');
  return name;
}
export function validateRenameName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw new Error('Provide a single item name.');
  return name;
}
async function renameEntry(path, requestedName) {
  const { source, info } = await resolveManagedEntry(path); const name = validateRenameName(requestedName);
  if (!info.isFile() && !info.isDirectory()) throw new Error('Only files and folders can be renamed.');
  const storedName = info.isDirectory() ? name : invertedName(name); const destination = join(dirname(source), storedName);
  resolveOpenedPath(relative(openedRoot, destination));
  if (destination === source) return { path: relative(openedRoot, destination), name: storedName };
  try { await fs.lstat(destination); throw new Error(`An item already exists with that name: ${storedName}`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await fs.rename(source, destination);
  return { path: relative(openedRoot, destination), name: storedName };
}
async function moveEntries(paths, destinationPath) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Select at least one item to move.');
  const destination = await resolveDirectory(destinationPath || ''); const uniquePaths = [...new Set(paths)];
  const entries = await Promise.all(uniquePaths.map(async (path) => ({ path, ...(await resolveManagedEntry(path)) })));
  const targets = entries.map(({ source }) => join(destination, basename(source)));
  if (new Set(targets).size !== targets.length) throw new Error('Selected items would use the same destination name.');
  for (let index = 0; index < entries.length; index += 1) { const { source, info } = entries[index]; const target = targets[index]; if (dirname(source) === destination) throw new Error('An item is already in that folder.'); if (info.isDirectory() && (destination === source || destination.startsWith(`${source}${sep}`))) throw new Error('A folder cannot be moved into itself.'); try { await fs.access(target); throw new Error(`A destination item already exists: ${basename(target)}`); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  for (let index = 0; index < entries.length; index += 1) await fs.rename(entries[index].source, targets[index]);
}
async function deleteEntries(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Select at least one item to delete.');
  const uniquePaths = [...new Set(paths)]; const entries = await Promise.all(uniquePaths.map((path) => resolveManagedEntry(path)));
  for (const { source } of entries) await fs.rm(source, { recursive: true, force: false });
}
export function rangeFor(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid byte range.');
  let start; let end;
  if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  else { const length = Number(match[2]); start = Math.max(0, size - length); end = size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('Requested byte range is not satisfiable.');
  return { start, end: Math.min(end, size - 1) };
}
function isClientDisconnect(error, request) { return request.aborted || error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || error?.code === 'ECONNRESET'; }
async function serveRestored(request, response, source, mime, filename) {
  const info = await fs.stat(source); const range = rangeFor(request.headers.range, info.size); const start = range?.start ?? 0; const end = range?.end ?? info.size - 1; const length = end - start + 1;
  response.writeHead(range ? 206 : 200, { 'content-type': mime, 'content-length': length, 'content-disposition': `inline; filename="${filename.replaceAll('"', '')}"`, 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}), 'cache-control': 'no-store' });
  try { await pipeline(createReadStream(source, { start, end }), new Transform({ transform(chunk, _encoding, callback) { callback(null, xor(chunk)); } }), response); }
  catch (error) { if (!isClientDisconnect(error, request)) throw error; }
}
async function handleRequest(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`); const path = url.pathname;
    if (request.method === 'POST' && path === '/api/open') { const body = await readJson(request); const candidate = resolve(String(body.path || '')); const info = await fs.stat(candidate); if (!info.isDirectory()) throw new Error('The supplied path is not a directory.'); openedRoot = candidate; const catalog = await scanFolder('', { includeHidden: Boolean(body.showHidden), query: String(body.query || '').toLowerCase() }); return sendJson(response, 200, { root: openedRoot, directory: '', parentListable: await hasListableParent(openedRoot), ...catalog }); }
    if (request.method === 'GET' && path === '/api/catalog') { const directory = url.searchParams.get('path') || ''; const current = await resolveDirectory(directory); const catalog = await scanFolder(directory, { includeHidden: url.searchParams.get('hidden') === '1', query: (url.searchParams.get('query') || '').toLowerCase(), offset: Math.max(0, Number(url.searchParams.get('offset') || 0) || 0), limit: 250 }); return sendJson(response, 200, { root: openedRoot, directory, parentListable: await hasListableParent(current), ...catalog }); }
    if (request.method === 'GET' && path === '/api/jobs') return sendJson(response, 200, [...jobs.values()]);
    if (request.method === 'POST' && path === '/api/folders') { const body = await readJson(request); const directory = await resolveDirectory(body.directory || ''); await fs.mkdir(join(directory, validateFolderName(body.name))); return sendJson(response, 201, { ok: true }); }
    if (request.method === 'POST' && path === '/api/files/rename') { const body = await readJson(request); return sendJson(response, 200, await renameEntry(body.path, body.name)); }
    if (request.method === 'POST' && path === '/api/files/move') { const body = await readJson(request); await moveEntries(body.paths, body.destination); return sendJson(response, 200, { ok: true }); }
    if (request.method === 'DELETE' && path === '/api/files') { const body = await readJson(request); await deleteEntries(body.paths); return sendJson(response, 200, { ok: true }); }
    if (request.method === 'POST' && path === '/api/videos/explode') { const body = await readJson(request); const source = resolveSource(body.path); const mime = detectMime(await restoredHeader(source)); if (!mime.startsWith('video/')) throw new Error('Only detected video files can be exploded.'); const job = createJob('frames', body.path); void explodeJob(job, body.path, source); return sendJson(response, 202, job); }
    if (request.method === 'POST' && path === '/api/videos/frame') { const body = await readJson(request); const relativePath = String(body.path || ''); const timeMs = Number(body.timeMs); if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error('A valid video time is required.'); const source = resolveSource(relativePath); const mime = detectMime(await restoredHeader(source)); if (!mime.startsWith('video/')) throw new Error('Only detected video files can provide frames.'); const directory = await resolveFrameOutputDirectory(body.outputDirectory, source); return sendJson(response, 201, await extractVideoFrame(relativePath, source, timeMs, directory)); }
    if (request.method === 'POST' && path === '/api/videos/playback') { const body = await readJson(request); const relativePath = String(body.path || ''); const source = resolveSource(relativePath); const mime = detectMime(await restoredHeader(source)); if (!mime.startsWith('video/')) throw new Error('Only detected video files can be prepared for playback.'); if (await currentPlaybackPath(relativePath, source)) return sendJson(response, 200, { status: 'ready', url: `/api/videos/playback?path=${encodeURIComponent(relativePath)}` }); const active = activePlaybackJob(relativePath); if (active) return sendJson(response, 202, { status: 'preparing', job: active }); const job = createJob('playback', relativePath); void playbackJob(job, relativePath, source); return sendJson(response, 202, { status: 'preparing', job }); }
    if (request.method === 'GET' && path === '/api/videos/playback') { const relativePath = url.searchParams.get('path'); const source = resolveSource(relativePath); const playback = await currentPlaybackPath(relativePath, source); if (!playback) throw new Error('A compatible playback copy is not ready.'); const sourceName = restoredName(basename(relativePath)); const filename = `${basename(sourceName, extname(sourceName)) || 'video'}.mp4`; return serveRestored(request, response, playback, 'video/mp4', filename); }
    if (request.method === 'GET' && path === '/api/media') { const relativePath = url.searchParams.get('path'); const source = resolveSource(relativePath); const mime = detectMime(await restoredHeader(source)); return serveRestored(request, response, source, mime, restoredName(basename(source))); }
    if (request.method === 'GET' && path === '/api/thumbnail') { const relativePath = url.searchParams.get('path'); const source = resolveSource(relativePath); const manifest = await readManifest(); const thumbnail = manifest.files[relativePath]?.thumbnail; if (!thumbnail) throw new Error('Thumbnail is not ready.'); return serveRestored(request, response, thumbnail, 'image/jpeg', basename(thumbnail)); }
    if (request.method === 'GET' && path === '/api/text') { const relativePath = url.searchParams.get('path'); const source = resolveSource(relativePath); if (!textMimeFor(basename(source)) || !isConventionalInvertedName(basename(source))) throw new Error('Only supported inverted text files can be edited.'); const info = await fs.stat(source); return sendJson(response, 200, { content: await restoredText(source), size: info.size, modified: info.mtimeMs }); }
    if (request.method === 'PUT' && path === '/api/text') { const body = await readJson(request); const source = resolveSource(body.path); if (!textMimeFor(basename(source)) || !isConventionalInvertedName(basename(source))) throw new Error('Only supported inverted text files can be edited.'); await saveRestoredText(source, body.content); const info = await fs.stat(source); return sendJson(response, 200, { size: info.size, modified: info.mtimeMs }); }
    if (request.method === 'GET' && !path.startsWith('/api/')) return serveApplication(response, path);
    sendJson(response, 404, { error: 'Not found.' });
}
export const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (isClientDisconnect(error, request)) return;
    if (response.headersSent) { response.destroy(error); return; }
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  });
});
const liveWebSockets = new WebSocketServer({ noServer: true });
const terminalWebSockets = createTerminalWebSocketServer();
server.on('upgrade', (request, socket, head) => {
  if (!websocketOriginAllowed(request)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  let path;
  try { path = new URL(request.url || '/', `http://${request.headers.host}`).pathname; } catch { socket.destroy(); return; }
  const webSockets = path === '/api/live' ? liveWebSockets : path === TERMINAL_SOCKET_PATH ? terminalWebSockets : null;
  if (!webSockets) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit('connection', client, request));
});
publishJobUpdate = (job) => {
  const message = JSON.stringify({ type: 'job', job });
  for (const client of liveWebSockets.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
};
liveWebSockets.on('connection', (socket) => {
  let directoryWatcher = null; let subscriptionVersion = 0;
  const send = (message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const stopWatching = () => { subscriptionVersion += 1; directoryWatcher?.close(); directoryWatcher = null; };
  send({ type: 'snapshot', jobs: [...jobs.values()] });
  socket.on('message', async (payload) => {
    let message;
    try { message = JSON.parse(String(payload)); } catch { return; }
    if (message?.type !== 'watch-directory') return;
    stopWatching(); const version = subscriptionVersion; const requestedRoot = String(message.root || ''); const requestedDirectory = String(message.directory || '');
    try {
      if (!openedRoot || requestedRoot !== openedRoot) throw new Error('The opened folder has changed.');
      const root = openedRoot; const directory = await resolveDirectory(requestedDirectory); const canonicalDirectory = relative(root, directory);
      if (version !== subscriptionVersion || root !== openedRoot) return;
      const publishChange = () => send({ type: 'catalog-change', root, directory: canonicalDirectory });
      directoryWatcher = watchDirectoryChanges(directory, publishChange, { onError: (error) => {
        if (version !== subscriptionVersion) return;
        directoryWatcher = null;
        send({ type: 'watch-error', root, directory: canonicalDirectory, error: error instanceof Error ? error.message : String(error) });
      } });
      send({ type: 'watch-ready', root, directory: canonicalDirectory });
      publishChange();
    } catch (error) {
      if (version === subscriptionVersion) send({ type: 'watch-error', root: requestedRoot, directory: requestedDirectory, error: error instanceof Error ? error.message : String(error) });
    }
  });
  socket.once('close', stopWatching);
});
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => console.log(`Uninvert API listening on http://127.0.0.1:${PORT}`));
  const shutdown = () => {
    for (const client of terminalWebSockets.clients) client.terminate();
    for (const client of liveWebSockets.clients) client.terminate();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 1_000).unref();
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
