import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectMime, frameDirectoryName, frameMetadataForDirectory, frameTimeRangeFor, invertedName, isConventionalInvertedName, isInvertedMedia, isWatchableChange, rangeFor, restoredName, restoredText, saveRestoredText, server, textMimeFor, validateFolderName, validateRenameName, videoFrameDurationMs, watchDirectoryChanges, xor } from '../server.mjs';

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
  assert.equal(restoredName('fight.mp4.inv'), 'fight.mp4');
  assert.equal(restoredName('fight.inv.mp4'), 'fight.inv.mp4');
  assert.equal(restoredName('archive.inv'), 'archive');
});

test('media byte ranges select only the requested restored bytes', () => {
  assert.deepEqual(rangeFor('bytes=3-7', 10), { start: 3, end: 7 });
  assert.deepEqual(rangeFor('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(rangeFor('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(rangeFor(undefined, 10), null);
  assert.throws(() => rangeFor('bytes=10-12', 10), /not satisfiable/);
});

test('AVI frame timing is read from its main header', () => {
  const avi = Buffer.alloc(64); avi.write('RIFF', 0); avi.write('AVI ', 8); avi.write('avih', 24); avi.writeUInt32LE(33_367, 32);
  assert.equal(videoFrameDurationMs(avi), 33.367);
  assert.equal(videoFrameDurationMs(Buffer.from('not video')), null);
});

test('aborted media streams stay available and legacy video gains cached compatible playback', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-playback-')); const frameOutput = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-captures-')); const segmentOutput = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-segments-')); const plain = join(directory, 'clip.avi'); const source = join(directory, 'clip.avi.inv'); const prepared = join(directory, 'prepared.mp4'); const restoredSegment = join(directory, 'segment.mp4');
  try {
    const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'mp3', plain]);
    assert.equal(generated.status, 0, generated.stderr?.toString());
    const restored = Buffer.concat([await fs.readFile(plain), Buffer.alloc(8 * 1024 * 1024)]); await fs.writeFile(source, xor(restored)); await fs.rm(plain);
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    const opened = await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: directory }) }); assert.equal(opened.status, 200);
    await new Promise((resolveAbort, rejectAbort) => { const request = httpRequest(`${base}/api/media?path=${encodeURIComponent('clip.avi.inv')}`, (response) => { response.once('data', () => { response.destroy(); resolveAbort(); }); }); request.once('error', rejectAbort); request.end(); });
    await new Promise((resolveWait) => setTimeout(resolveWait, 30)); assert.equal((await fetch(`${base}/api/jobs`)).status, 200);
    const begin = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv' }) }); const first = await begin.json(); assert.equal(begin.status, 202); assert.equal(first.status, 'preparing'); assert.equal(first.job.type, 'playback');
    const duplicateResponse = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv' }) }); const duplicate = await duplicateResponse.json(); assert.equal(duplicate.status, 'preparing'); assert.equal(duplicate.job.id, first.job.id);
    let playbackJob;
    async function refreshPlaybackJob() { const snapshot = await (await fetch(`${base}/api/jobs`)).json(); playbackJob = snapshot.find((job) => job.id === first.job.id); }
    const deadline = Date.now() + 20_000; while (!playbackJob || (playbackJob.status !== 'complete' && playbackJob.status !== 'failed')) { if (Date.now() >= deadline) throw new Error(`Timed out waiting for playback preparation: ${playbackJob?.error || 'no job result'}`); await refreshPlaybackJob(); if (playbackJob?.status === 'complete' || playbackJob?.status === 'failed') break; await new Promise((resolveWait) => setTimeout(resolveWait, 25)); }
    assert.equal(playbackJob.status, 'complete', playbackJob.error);
    const ready = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv' }) }); assert.equal(ready.status, 200); assert.equal((await ready.json()).status, 'ready');
    const range = await fetch(`${base}/api/videos/playback?path=${encodeURIComponent('clip.avi.inv')}`, { headers: { range: 'bytes=0-31' } }); const rangeBytes = Buffer.from(await range.arrayBuffer()); assert.equal(range.status, 206); assert.equal(range.headers.get('content-type'), 'video/mp4'); assert.equal(rangeBytes.length, 32); assert.equal(rangeBytes.subarray(4, 8).toString('ascii'), 'ftyp');
    const complete = await fetch(`${base}/api/videos/playback?path=${encodeURIComponent('clip.avi.inv')}`); await fs.writeFile(prepared, Buffer.from(await complete.arrayBuffer())); const probed = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', prepared]); assert.equal(probed.status, 0, probed.stderr?.toString()); const streams = JSON.parse(probed.stdout.toString()).streams; assert(streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')); assert(streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    const manifest = JSON.parse(await fs.readFile(join(directory, '.inv-cache', 'manifest.json'), 'utf8')); const cached = await fs.readFile(manifest.files['clip.avi.inv'].playback); assert.equal(detectMime(cached), 'application/octet-stream'); assert.equal(detectMime(xor(cached.subarray(0, 32))), 'video/mp4');
    const extractedResponse = await fetch(`${base}/api/videos/frame`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv', timeMs: 500 }) }); const extracted = await extractedResponse.json(); assert.equal(extractedResponse.status, 201); assert.match(extracted.name, /^clip\.frame-000000500\.jpg\.inv$/); assert.equal(extracted.outputPath, join(directory, extracted.name)); const extractedBytes = await fs.readFile(extracted.outputPath); assert.equal(detectMime(extractedBytes), 'application/octet-stream'); assert.equal(detectMime(xor(extractedBytes)), 'image/jpeg');
    await fs.writeFile(join(frameOutput, 'clip.frame-000000600.jpg.inv'), Buffer.from('existing')); const configuredResponse = await fetch(`${base}/api/videos/frame`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv', timeMs: 600, outputDirectory: frameOutput }) }); const configured = await configuredResponse.json(); assert.equal(configuredResponse.status, 201); assert.equal(configured.name, 'clip.frame-000000600-2.jpg.inv'); assert.equal(configured.outputPath, join(frameOutput, configured.name)); assert.equal(detectMime(xor(await fs.readFile(configured.outputPath))), 'image/jpeg');
    for (const outputDirectory of ['relative/path', join(frameOutput, 'missing'), prepared]) { const invalid = await fetch(`${base}/api/videos/frame`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv', timeMs: 700, outputDirectory }) }); assert.equal(invalid.status, 400); }
    await fs.writeFile(join(segmentOutput, 'clip.segment-000000200-000000800.mp4.inv'), Buffer.from('existing')); const segmentResponse = await fetch(`${base}/api/videos/segment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv', startMs: 200, endMs: 800, outputDirectory: segmentOutput }) }); const queuedSegment = await segmentResponse.json(); assert.equal(segmentResponse.status, 202); assert.equal(queuedSegment.type, 'segment');
    let segmentJob; const segmentDeadline = Date.now() + 20_000; while (!segmentJob || (segmentJob.status !== 'complete' && segmentJob.status !== 'failed')) { if (Date.now() >= segmentDeadline) throw new Error(`Timed out waiting for segment extraction: ${segmentJob?.error || 'no job result'}`); const snapshot = await (await fetch(`${base}/api/jobs`)).json(); segmentJob = snapshot.find((job) => job.id === queuedSegment.id); await new Promise((resolveWait) => setTimeout(resolveWait, 25)); } assert.equal(segmentJob.status, 'complete', segmentJob.error); assert.equal(segmentJob.result.name, 'clip.segment-000000200-000000800-2.mp4.inv'); assert.equal(segmentJob.result.outputPath, join(segmentOutput, segmentJob.result.name)); assert.deepEqual({ startMs: segmentJob.result.startMs, endMs: segmentJob.result.endMs }, { startMs: 200, endMs: 800 });
    const invertedSegment = await fs.readFile(segmentJob.result.outputPath); assert.equal(detectMime(invertedSegment), 'application/octet-stream'); await fs.writeFile(restoredSegment, xor(invertedSegment)); const segmentProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type', '-of', 'json', restoredSegment]); assert.equal(segmentProbe.status, 0, segmentProbe.stderr?.toString()); const segmentMedia = JSON.parse(segmentProbe.stdout.toString()); assert(segmentMedia.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')); assert(segmentMedia.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')); assert(Number(segmentMedia.format.duration) >= 0.45 && Number(segmentMedia.format.duration) <= 0.8);
    for (const [startMs, endMs] of [[-1, 500], [500, 500], [700, 200], [null, 500]]) { const invalid = await fetch(`${base}/api/videos/segment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv', startMs, endMs, outputDirectory: segmentOutput }) }); assert.equal(invalid.status, 400); }
    const invalidSegmentDirectory = await fetch(`${base}/api/videos/segment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv', startMs: 100, endMs: 500, outputDirectory: 'relative/path' }) }); assert.equal(invalidSegmentDirectory.status, 400);
    const sourceInfo = await fs.stat(source); await fs.utimes(source, sourceInfo.atime, new Date(sourceInfo.mtimeMs + 2_000)); const invalidated = await fetch(`${base}/api/videos/playback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'clip.avi.inv' }) }); const replacement = await invalidated.json(); assert.equal(invalidated.status, 202); assert.notEqual(replacement.job.id, first.job.id);
    const replacementDeadline = Date.now() + 20_000; let replacementJob; while (!replacementJob || (replacementJob.status !== 'complete' && replacementJob.status !== 'failed')) { if (Date.now() >= replacementDeadline) throw new Error(`Timed out waiting for replacement playback preparation: ${replacementJob?.error || 'no job result'}`); const snapshot = await (await fetch(`${base}/api/jobs`)).json(); replacementJob = snapshot.find((job) => job.id === replacement.job.id); await new Promise((resolveWait) => setTimeout(resolveWait, 25)); } assert.equal(replacementJob.status, 'complete', replacementJob.error);
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await Promise.all([directory, frameOutput, segmentOutput].map((item) => fs.rm(item, { recursive: true, force: true })));
  }
});

test('conventional inverted text files are identified without exposing plain text files', () => {
  assert.equal(textMimeFor('notes.md.inv'), 'text/markdown');
  assert.equal(textMimeFor('notes.md'), 'text/markdown');
  assert.equal(textMimeFor('clip.mp4.inv'), null);
  assert.equal(isConventionalInvertedName('notes.md.inv'), true);
  assert.equal(isConventionalInvertedName('notes.inv.md'), false);
  assert.equal(isConventionalInvertedName('notes.md'), false);
});

test('frame output directory stays next to its inverted source video', () => {
  assert.equal(frameDirectoryName('fight.mp4.inv'), 'fight.mp4.inv.frames');
  assert.equal(frameDirectoryName('rounds/fight.webm.inv'), 'fight.webm.inv.frames');
});

test('frame page time ranges use the generated frame numbers actually shown', () => {
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000001.jpg.inv', '000250.jpg.inv']), { startMs: 0, endMs: 25_000 });
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000251.jpg.inv', '000500.jpg.inv']), { startMs: 25_000, endMs: 50_000 });
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000751.jpg.inv', '001000.jpg.inv']), { startMs: 75_000, endMs: 100_000 });
  assert.deepEqual(frameTimeRangeFor(100_000, 1_000, ['000010.jpg.inv', '000200.jpg.inv']), { startMs: 900, endMs: 20_000 });
});

test('frame page time ranges ignore unrelated and out-of-range files', () => {
  assert.deepEqual(frameTimeRangeFor(10_000, 100, ['notes.jpg.inv', '000000.jpg.inv', '000050.jpg.inv', '000101.jpg.inv']), { startMs: 4_900, endMs: 5_000 });
  assert.equal(frameTimeRangeFor(10_000, 100, ['notes.jpg.inv']), null);
  assert.equal(frameTimeRangeFor(null, 100, ['000001.jpg.inv']), null);
});

test('frame timing metadata requires an unchanged matching inverted video sibling', async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-frame-metadata-'));
  const source = join(parent, 'fight.mp4.inv'); const frames = join(parent, 'fight.mp4.inv.frames');
  try {
    const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await fs.writeFile(source, xor(mp4)); await fs.mkdir(frames); const info = await fs.stat(source);
    const metadata = { version: 1, sourceName: 'fight.mp4.inv', sourceSize: info.size, sourceModifiedMs: info.mtimeMs, durationMs: 60_000, frameCount: 1_800, firstFrameNumber: 1 };
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

test('file creation API creates an empty inverted file without overwriting', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-create-file-'));
  try {
    await fs.mkdir(join(directory, 'drafts')); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: directory }) })).status, 200);
    const create = (name, target = '') => fetch(`${base}/api/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: target, name }) });
    const response = await create('notes.md', 'drafts'); assert.equal(response.status, 201); assert.deepEqual(await response.json(), { path: join('drafts', 'notes.md.inv'), name: 'notes.md.inv' }); assert.equal((await fs.stat(join(directory, 'drafts', 'notes.md.inv'))).size, 0);
    const catalog = await (await fetch(`${base}/api/catalog?path=drafts`)).json(); assert(catalog.files.some((entry) => entry.path === join('drafts', 'notes.md.inv') && entry.editableText));
    assert.equal((await create('notes.md', 'drafts')).status, 400); assert.equal((await create('../outside.md', 'drafts')).status, 400); assert.equal((await fs.stat(join(directory, 'drafts', 'notes.md.inv'))).size, 0);
  } finally { if (server.listening) await new Promise((resolveClose) => server.close(resolveClose)); await fs.rm(directory, { recursive: true, force: true }); }
});

test('friendly renamed file names retain their inverted storage marker', () => {
  assert.equal(invertedName('notes.txt'), 'notes.txt.inv');
  assert.equal(invertedName('archive'), 'archive.inv');
  assert.equal(invertedName('release.notes.md'), 'release.notes.md.inv');
  assert.equal(invertedName('literal.inv.txt'), 'literal.inv.txt.inv');
  assert.equal(invertedName('trailing.'), 'trailing..inv');
  assert.equal(validateRenameName('new name.txt'), 'new name.txt');
  for (const name of ['', '.', '..', '../outside', 'nested/path', 'nested\\path', 'bad\0name']) assert.throws(() => validateRenameName(name), /single item name/);
});

test('rename API renames files and folders without overwriting existing entries', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-rename-'));
  try {
    await fs.writeFile(join(directory, 'notes.txt.inv'), xor(Buffer.from('notes'))); await fs.mkdir(join(directory, 'drafts'));
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    const request = (path, name) => fetch(`${base}/api/files/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, name }) });
    assert.equal((await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: directory }) })).status, 200);

    const fileResponse = await request('notes.txt.inv', 'renamed.md'); assert.equal(fileResponse.status, 200); assert.deepEqual(await fileResponse.json(), { path: 'renamed.md.inv', name: 'renamed.md.inv' });
    assert.equal(await restoredText(join(directory, 'renamed.md.inv')), 'notes'); await assert.rejects(fs.stat(join(directory, 'notes.txt.inv')));
    const catalog = await (await fetch(`${base}/api/catalog`)).json(); assert(catalog.files.some((entry) => entry.path === 'renamed.md.inv' && entry.name === 'renamed.md.inv'));
    const folderResponse = await request('drafts', 'finished'); assert.equal(folderResponse.status, 200); assert.deepEqual(await folderResponse.json(), { path: 'finished', name: 'finished' }); assert((await fs.stat(join(directory, 'finished'))).isDirectory());

    await fs.writeFile(join(directory, 'collision.md.inv'), xor(Buffer.from('collision'))); const conflict = await request('renamed.md.inv', 'collision.md'); assert.equal(conflict.status, 400); assert.match((await conflict.json()).error, /already exists/);
    assert.equal(await restoredText(join(directory, 'renamed.md.inv')), 'notes'); assert.equal((await request('renamed.md.inv', '../outside.md')).status, 400); assert.equal((await request('finished', '.inv-cache')).status, 400);
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('move API moves files and folders into child and parent directories safely', async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-move-')); const root = join(parent, 'library');
  try {
    await fs.mkdir(join(root, 'target'), { recursive: true }); await fs.mkdir(join(root, 'album')); await fs.writeFile(join(root, 'album', 'nested.txt.inv'), xor(Buffer.from('nested'))); await fs.writeFile(join(root, 'one.txt.inv'), xor(Buffer.from('one')));
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    const move = (paths, destination) => fetch(`${base}/api/files/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths, destination }) });
    assert.equal((await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: root }) })).status, 200);

    assert.equal((await move(['one.txt.inv', 'album'], 'target')).status, 200); assert.equal(await restoredText(join(root, 'target', 'one.txt.inv')), 'one'); assert.equal(await restoredText(join(root, 'target', 'album', 'nested.txt.inv')), 'nested');
    assert.equal((await move(['target/one.txt.inv'], 'target')).status, 400);

    await fs.writeFile(join(root, 'free.txt.inv'), xor(Buffer.from('free'))); await fs.writeFile(join(root, 'collision.txt.inv'), xor(Buffer.from('source'))); await fs.writeFile(join(root, 'target', 'collision.txt.inv'), xor(Buffer.from('target')));
    assert.equal((await move(['free.txt.inv', 'collision.txt.inv'], 'target')).status, 400); assert.equal(await restoredText(join(root, 'free.txt.inv')), 'free'); assert.equal(await restoredText(join(root, 'collision.txt.inv')), 'source');
    await fs.mkdir(join(root, 'tree', 'child'), { recursive: true }); assert.equal((await move(['tree'], 'tree/child')).status, 400);

    await fs.writeFile(join(root, 'outward.txt.inv'), xor(Buffer.from('outward'))); assert.equal((await move(['outward.txt.inv'], '..')).status, 200); assert.equal(await restoredText(join(parent, 'outward.txt.inv')), 'outward'); await assert.rejects(fs.stat(join(root, 'outward.txt.inv')));
    assert.equal((await move(['../outward.txt.inv'], 'target')).status, 400); assert.equal((await move(['free.txt.inv'], '../outside')).status, 400);
  } finally {
    if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('cache activity is excluded from source directory notifications', () => {
  assert.equal(isWatchableChange('.inv-cache'), false);
  assert.equal(isWatchableChange(Buffer.from('.inv-cache')), false);
  assert.equal(isWatchableChange('notes.txt.inv'), true);
  assert.equal(isWatchableChange(null), true);
});

test('directory watcher reports coalesced create, modify, rename, and delete changes', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-watch-')); const source = join(directory, 'notes.txt.inv'); const renamed = join(directory, 'renamed.txt.inv'); let changes = 0;
  const watcher = watchDirectoryChanges(directory, () => { changes += 1; }, { debounceMs: 20 });
  try {
    await fs.writeFile(source, Buffer.from('created')); await waitFor(() => changes >= 1);
    await fs.appendFile(source, Buffer.from('modified')); await waitFor(() => changes >= 2);
    await fs.rename(source, renamed); await waitFor(() => changes >= 3);
    await fs.rm(renamed); await waitFor(() => changes >= 4);
    await fs.mkdir(join(directory, '.inv-cache')); await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(changes, 4);
    watcher.close(); await fs.writeFile(join(directory, 'after-close.txt.inv'), Buffer.from('ignored')); await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(changes, 4);
  } finally { watcher.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('restored text saves back as an inverted UTF-8 source', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-test-'));
  const source = join(directory, 'notes.txt.inv');
  try {
    await fs.writeFile(source, xor(Buffer.from('before')));
    assert.equal(await restoredText(source), 'before');
    await saveRestoredText(source, 'after ✓');
    assert.equal(await restoredText(source), 'after ✓');
    assert.deepEqual(await fs.readFile(source), xor(Buffer.from('after ✓')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('text API rejects stale saves and permits an explicit overwrite', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-text-conflict-')); const source = join(directory, 'notes.md.inv');
  try {
    await fs.writeFile(source, xor(Buffer.from('# Original'))); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: directory }) })).status, 200); const loadedResponse = await fetch(`${base}/api/text?path=${encodeURIComponent('notes.md.inv')}`); const loaded = await loadedResponse.json(); assert.equal(loadedResponse.status, 200); assert.equal(loaded.content, '# Original');
    await fs.writeFile(source, xor(Buffer.from('# External change is longer'))); const staleBody = { path: 'notes.md.inv', content: '# Editor change', expectedSize: loaded.size, expectedModified: loaded.modified };
    const stale = await fetch(`${base}/api/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(staleBody) }); assert.equal(stale.status, 409); assert.match((await stale.json()).error, /changed on disk/); assert.equal(await restoredText(source), '# External change is longer');
    const forced = await fetch(`${base}/api/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...staleBody, force: true }) }); const saved = await forced.json(); assert.equal(forced.status, 200); assert(Number.isFinite(saved.modified)); assert.equal(await restoredText(source), '# Editor change');
    const missingFingerprint = await fetch(`${base}/api/text`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'notes.md.inv', content: 'unsafe' }) }); assert.equal(missingFingerprint.status, 400);
  } finally { if (server.listening) await new Promise((resolveClose) => server.close(resolveClose)); await fs.rm(directory, { recursive: true, force: true }); }
});

test('restored text rejects invalid UTF-8 and content larger than 5 MB', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'inv-viewer-text-validation-')); const invalid = join(directory, 'invalid.txt.inv'); const oversized = join(directory, 'oversized.txt.inv');
  try { await fs.writeFile(invalid, xor(Buffer.from([0xc3, 0x28]))); await assert.rejects(restoredText(invalid), /valid UTF-8/); await assert.rejects(saveRestoredText(oversized, 'x'.repeat(5 * 1024 * 1024 + 1)), /larger than 5 MB/); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
});
