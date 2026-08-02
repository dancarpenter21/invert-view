import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectMime, frameDirectoryName, frameMetadataForDirectory, frameTimeRangeFor, isConventionalInvertedName, isInvertedMedia, isWatchableChange, rangeFor, restoredName, restoredText, saveRestoredText, server, textMimeFor, validateFolderName, watchDirectoryChanges, xor } from '../server.mjs';

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for a filesystem notification.'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test('restored MIME is detected from inverted signatures rather than the filename', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
  const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  assert.equal(detectMime(xor(jpeg.map((value) => value ^ 0xff))), 'image/jpeg');
  assert.equal(detectMime(xor(mp4.map((value) => value ^ 0xff))), 'video/mp4');
  const avi = Buffer.from('RIFF____AVI ', 'ascii');
  assert.equal(detectMime(xor(avi.map((value) => value ^ 0xff))), 'video/x-msvideo');
  assert.equal(detectMime(Buffer.from('not a known file')), 'application/octet-stream');
});

test('only inverted files with a recognizable restored signature are cataloged', () => {
  const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const avi = Buffer.from('RIFF____AVI ', 'ascii');
  assert.equal(isInvertedMedia(mp4), false);
  assert.equal(isInvertedMedia(avi), false);
  assert.equal(isInvertedMedia(xor(mp4)), true);
  assert.equal(isInvertedMedia(xor(avi)), true);
});

test('inversion and conventional names round-trip', () => {
  const source = Buffer.from([0, 5, 255, 127]);
  assert.deepEqual(xor(xor(source)), source);
  assert.equal(restoredName('fight.inv.mp4'), 'fight.mp4');
  assert.equal(restoredName('archive.inv'), 'archive');
});

test('media byte ranges select only the requested restored bytes', () => {
  assert.deepEqual(rangeFor('bytes=3-7', 10), { start: 3, end: 7 });
  assert.deepEqual(rangeFor('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(rangeFor('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(rangeFor(undefined, 10), null);
  assert.throws(() => rangeFor('bytes=10-12', 10), /not satisfiable/);
});

test('aborted media streams stay available and legacy video gains cached compatible playback', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-playback-')); const plain = join(directory, 'clip.avi'); const source = join(directory, 'clip.inv.avi'); const prepared = join(directory, 'prepared.mp4');
  try {
    const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'mp3', plain]);
    assert.equal(generated.status, 0, generated.stderr?.toString());
    const restored = Buffer.concat([await fs.readFile(plain), Buffer.alloc(8 * 1024 * 1024)]); await fs.writeFile(source, xor(restored)); await fs.rm(plain);
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    const opened = await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: directory }) }); assert.equal(opened.status, 200);
    await new Promise((resolveAbort, rejectAbort) => { const request = httpRequest(`${base}/api/media?path=${encodeURIComponent('clip.inv.avi')}`, (response) => { response.once('data', () => { response.destroy(); resolveAbort(); }); }); request.once('error', rejectAbort); request.end(); });
    await new Promise((resolveWait) => setTimeout(resolveWait, 30)); assert.equal((await fetch(`${base}/api/jobs`)).status, 200);
    const begin = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.inv.avi' }) }); const first = await begin.json(); assert.equal(begin.status, 202); assert.equal(first.status, 'preparing'); assert.equal(first.job.type, 'playback');
    const duplicateResponse = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.inv.avi' }) }); const duplicate = await duplicateResponse.json(); assert.equal(duplicate.status, 'preparing'); assert.equal(duplicate.job.id, first.job.id);
    let playbackJob;
    async function refreshPlaybackJob() { const snapshot = await (await fetch(`${base}/api/jobs`)).json(); playbackJob = snapshot.find((job) => job.id === first.job.id); }
    const deadline = Date.now() + 20_000; while (!playbackJob || (playbackJob.status !== 'complete' && playbackJob.status !== 'failed')) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for playback preparation: ${playbackJob?.error || 'no job result'}`); await refreshPlaybackJob(); if (playbackJob?.status === 'complete' || playbackJob?.status === 'failed') break; await new Promise((resolveWait) => setTimeout(resolveWait, 25)); }
    assert.equal(playbackJob.status, 'complete', playbackJob.error);
    const ready = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.inv.avi' }) }); assert.equal(ready.status, 200); assert.equal((await ready.json()).status, 'ready');
    const range = await fetch(`${base}/api/videos/playback?path=${encodeURIComponent('clip.inv.avi')}`, { headers: { range: 'bytes=0-31' } }); const rangeBytes = Buffer.from(await range.arrayBuffer()); assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'video/mp4'); assert.equal(rangeBytes.length, 32); assert.equal(rangeBytes.subarray(4, 8).toString('ascii'), 'ftyp');
    const complete = await fetch(`${base}/api/videos/playback?path=${encodeURIComponent('clip.inv.avi')}`); await fs.writeFile(prepared, Buffer.from(await complete.arrayBuffer())); const probed = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', prepared]); assert.equal(probed.status, 0, probed.stderr?.toString()); const streams = JSON.parse(probed.stdout.toString()).streams; assert(streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')); assert(streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    const manifest = JSON.parse(await fs.readFile(join(directory, '.inv-cache', 'manifest.json'), 'utf8')); const cached = await fs.readFile(manifest.files['clip.inv.avi'].playback); assert.equal(detectMime(cached), 'application/octet-stream'); assert.equal(detectMime(xor(cached.subarray(0, 32))), 'video/mp4');
    const sourceInfo = await fs.stat(source); await fs.utimes(source, sourceInfo.atime, new Date(sourceInfo.mtimeMs + 2_000)); const invalidated = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.inv.avi' }) }); const replacement = await invalidated.json(); assert.equal(invalidated.status, 202); assert.notEqual(replacement.job.id, first.job.id);
    const replacementDeadline = Date.now() + 20_000; let replacementJob; while (!replacementJob || (replacementJob.status !== 'complete' && replacementJob.status !== 'failed')) { if (Date.now() >= replacementDeadline) throw new Error(`Timed out waiting for replacement playback preparation: ${replacementJob?.error || 'no job result'}`); const snapshot = await (await fetch(`${base}/api/jobs`)).json(); replacementJob = snapshot.find((job) => job.id === replacement.job.id); await new Promise((resolveWait) => setTimeout(resolveWait, 25)); } assert.equal(replacementJob.status, 'complete', replacementJob.error);
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('conventional inverted text files are identified without exposing plain text files', () => {
  assert.equal(textMimeFor('notes.inv.md'), 'text/markdown');
  assert.equal(textMimeFor('notes.md'), 'text/markdown');
  assert.equal(textMimeFor('clip.inv.mp4'), null);
  assert.equal(isConventionalInvertedName('notes.inv.md'), true);
  assert.equal(isConventionalInvertedName('notes.md'), false);
});

test('frame output directory stays next to its inverted source video', () => {
  assert.equal(frameDirectoryName('fight.inv.mp4'), 'fight.inv.mp4.frames');
  assert.equal(frameDirectoryName('rounds/fight.inv.webm'), 'fight.inv.webm.frames');
});

test('frame page time ranges use the generated frame numbers actually shown', () => {
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000001.inv.jpg', '000250.inv.jpg']), { startMs: 0, endMs: 25_000 });
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000251.inv.jpg', '000500.inv.jpg']), { startMs: 25_000, endMs: 50_000 });
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000751.inv.jpg', '001000.inv.jpg']), { startMs: 75_000, endMs: 100_000 });
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000010.inv.jpg', '000200.inv.jpg']), { startMs: 900, endMs: 20_000 });
});

test('frame page time ranges ignore unrelated and out-of-range files', () => {
  assert.deepEqual(frameTimeRangeFor(10_000, 100, ['notes.inv.jpg', '000000.inv.jpg', '000050.inv.jpg', '000101.inv.jpg']), { startMs: 4_900, endMs: 5_000 });
  assert.equal(frameTimeRangeFor(10_000, 100, ['notes.inv.jpg']), null);
  assert.equal(frameTimeRangeFor(null, 100, ['000001.inv.jpg']), null);
});

test('frame timing metadata requires an unchanged matching inverted video sibling', async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-frame-metadata-'));
  const source = join(parent, 'fight.inv.mp4'); const frames = join(parent, 'fight.inv.mp4.frames');
  try {
    const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await fs.writeFile(source, xor(mp4)); await fs.mkdir(frames); const info = await fs.stat(source);
    const metadata = { version: 1, sourceName: 'fight.inv.mp4', sourceSize: info.size, sourceModifiedMs: info.mtimeMs, durationMs: 60_000, frameCount: 1_800, firstFrameNumber: 1 };
    await fs.writeFile(join(frames, '.inv-frames.json'), JSON.stringify(metadata));
    assert.deepEqual(await frameMetadataForDirectory(frames), metadata);

    await fs.appendFile(source, Buffer.from([0xff]));
    assert.equal(await frameMetadataForDirectory(frames), null);
    assert.equal(await frameMetadataForDirectory(`${frames}-copy`), null);
    await fs.writeFile(join(frames, '.inv-frames.json'), '{invalid');
    assert.equal(await frameMetadataForDirectory(frames), null);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test('new folder names cannot escape the current directory', () => {
  assert.equal(validateFolderName('new folder'), 'new folder');
  assert.throws(() => validateFolderName('../outside'), /single folder name/);
  assert.throws(() => validateFolderName('nested/path'), /single folder name/);
});

test('cache activity is excluded from source directory notifications', () => {
  assert.equal(isWatchableChange('.inv-cache'), false);
  assert.equal(isWatchableChange(Buffer.from('.inv-cache')), false);
  assert.equal(isWatchableChange('notes.inv.txt'), true);
  assert.equal(isWatchableChange(null), true);
});

test('directory watcher reports coalesced create, modify, rename, and delete changes', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-watch-')); const source = join(directory, 'notes.inv.txt'); const renamed = join(directory, 'renamed.inv.txt'); let changes = 0;
  const watcher = watchDirectoryChanges(directory, () => { changes += 1; }, { debounceMs: 20 });
  try {
    await fs.writeFile(source, Buffer.from('created')); await waitFor(() => changes >= 1);
    await fs.appendFile(source, Buffer.from('modified')); await waitFor(() => changes >= 2);
    await fs.rename(source, renamed); await waitFor(() => changes >= 3);
    await fs.rm(renamed); await waitFor(() => changes >= 4);
    await fs.mkdir(join(directory, '.inv-cache')); await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(changes, 4);
    watcher.close(); await fs.writeFile(join(directory, 'after-close.inv.txt'), Buffer.from('ignored')); await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(changes, 4);
  } finally { watcher.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('restored text saves back as an inverted UTF-8 source', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-test-'));
  const source = join(directory, 'notes.inv.txt');
  try {
    await fs.writeFile(source, xor(Buffer.from('before')));
    assert.equal(await restoredText(source), 'before');
    await saveRestoredText(source, 'after ✓');
    assert.equal(await restoredText(source), 'after ✓');
    assert.deepEqual(await fs.readFile(source), xor(Buffer.from('after ✓')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
