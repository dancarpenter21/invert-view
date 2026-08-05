# Uninvert File Browser

Uninvert is a private, local viewer for files produced by `../invert_file.py`.
It determines an inverted file's restored MIME type from its file signature,
hides recognizable files that are already uninverted, then streams restored
images and videos to the browser without uploading them. Video playback uses
seekable byte-range streaming, so restored files do not need to fit in memory.
Video previews start muted. Full players start muted and play automatically as
soon as the video is ready; they retain the original audio and complete seekable
duration when the browser supports the source container and codecs. Legacy
formats such as AVI/DivX are converted on demand to a seekable H.264/AAC MP4
without changing the source file.

## Requirements

- Node.js 20.19+ or 22.12+ (Node 24 is supported)
- `zsh` at `/usr/bin/zsh` for the integrated terminal. Installing dependencies
  also requires the standard native Node build toolchain for `node-pty`.
- `ffmpeg` on `PATH` for video thumbnails, frame extraction, and compatibility
  playback. Its build must include the `libx264` video encoder and AAC audio
  encoder. `ffprobe` is optional and is used to make job progress more accurate.

## Run locally

```sh
npm install
npm run dev
```

Open Vite's local URL, then enter the absolute path of the folder containing
your inverted files in the path field above the file list. The browser lists
only that folder's immediate contents; open directory entries or use **Up** to
navigate the tree. `npm run dev` starts both the browser UI and the local API.
The development launch sets
`VITE_DEFAULT_FOLDER` to `/home/danc/.diadev/docs`; set
`INV_VIEWER_DEFAULT_FOLDER` before launching to choose another initial folder.
Production starts with no folder open.

## Integrated terminal

The bottom dock runs a real interactive zsh session on the same machine and
with the same user permissions as the server. It is intended only for this
loopback-only local application; commands entered in the browser can read,
change, or delete anything that user can access.

A new shell starts in the folder currently displayed by the file browser. The
shell and browser then navigate independently so changing folders does not
interrupt a running command. Use **New shell here** to end the current shell
and deliberately restart in the browser's displayed folder. Alternatively,
right-click the catalog background and choose **Move terminal here** to `cd`
the existing shell without restarting it. If a command is running, the move is
queued until the command finishes. The terminal can be collapsed or resized
from its top edge, and both preferences are remembered by the browser.
Collapsing keeps the shell alive; refreshing or closing the tab ends it. Zsh
history, control keys, ANSI applications, and configured tab completion are
available through the pseudo-terminal.

Large directories are loaded in pages of 250 entries. Use the paging controls
at the bottom of the browser to move between pages without waiting for the
entire directory to be scanned or rendered at once.

The sidebar contains application configuration. **Extracted frame directory**
and **Extracted video directory** accept absolute paths and are remembered by
the browser. Leave either blank to save that kind of extraction beside its
source video. An **Extraction jobs** panel below these settings keeps queued,
running, completed, and failed frame or video-segment jobs visible, including
live progress and the output path for completed segments.

The displayed directory updates live when eligible inverted files or folders
are created, modified, renamed, or deleted. Each browser tab watches only its
current directory and changes the subscription when navigating. The catalog
keeps its active search, sort, and page settings; an open full media or
text viewer is left undisturbed until you return to the catalog. WebSocket
reconnection performs a fresh catalog read, and periodic HTTP refreshes act as
a fallback while live watching is unavailable.

Select one item with a click, add or remove items with Ctrl/Cmd-click, or use
Shift-click to select a visible range. Press Escape or use **Clear** to clear a
selection. Double click opens an item. The action controls create a folder,
move selected items, or delete them after confirmation; selected items can also
be dragged onto a directory to move them. A `..` entry stays at the top of each
listable directory for parent navigation and as a drop target; at the opened
root it can move items one level into the filesystem parent. Moves never
overwrite an existing destination item. Right-click any file or folder to open it, copy its full path,
rename it, or delete it;
right-click the catalog background to create a folder or move the integrated
terminal to the displayed directory.
file names are shown without their on-disk `.inv` marker, which is preserved automatically.
Selecting a file shows its complete source path in the path
field and breadcrumbs; use **Copy** beside the field to copy it. The preview
pane can be resized by dragging its left edge;
the chosen width is remembered by the browser. File actions, view controls, and
detailed columns reflow as the remaining browser workspace becomes narrower.

For a production-style local server:

```sh
npm run build
npm start
```

Then open `http://127.0.0.1:4174`.

## Media cache, frames, and segments

When the service detects an inverted video, it creates a thumbnail in the
opened folder's `.inv-cache/thumbnails/` directory. The thumbnail itself is an
inverted JPEG ending in `.inv.jpg`; no plain thumbnail is retained. Cache
metadata in `.inv-cache/manifest.json` records the source size and modification
time, so a thumbnail is regenerated only when its source changes.

Opening a legacy video in the full viewer starts one background compatibility
job. Its browser-compatible MP4 is stored inverted under `.inv-cache/playback/`
and reused until the source size or modification time changes. The viewer shows
conversion progress, and the job continues if you return to the catalog. Plain
restored and transcoded intermediates exist only in the operating system's
temporary directory and are removed when the job finishes or fails. Restore &
download always returns the original restored format, not the cached derivative.

The full video player includes previous-frame and next-frame buttons. AVI files
use their declared frame interval; other containers fall back to a 30 fps step.
**Extract current frame** pauses at the displayed time and writes an inverted
JPEG to the configured extracted-frame directory with a timestamped name such
as `fight.frame-000042123.inv.jpg`. When the setting is blank, the frame is
written beside its source. Existing captures are never overwritten.

The trim strip below the player exports one contiguous video segment. Set In
and Out from the current playhead, drag either range handle, or enter exact
`HH:MM:SS.mmm` timestamps. **Preview segment** plays only the selected range,
and **Extract segment** queues a background H.264/AAC MP4 transcode. The result
is inverted and saved to the configured extracted-video directory with a name
such as `fight.segment-000002000-000008500.inv.mp4`; collisions receive a
numeric suffix. The source remains unchanged and plain temporary files are
removed after success or failure.

Right-click a video card and choose **Explode into frames** to export every
decoded frame. Inverted JPEGs are placed beside the source video in a visible
directory named `<video>.frames/` (for example, `fight.inv.mp4.frames/`). The
extraction runs in the background; the viewer remains usable and reports its
status in a persistent progress popup. Job changes stream to the browser over a
local WebSocket, with periodic HTTP polling as a fallback. Plain restored videos
and JPEG intermediates are created only in the operating system's temporary
directory and are removed when each job finishes or fails.

New frame directories also contain a hidden `.inv-frames.json` metadata file.
When the directory remains beside the unchanged inverted source video with the
matching name, both pagination controls show the approximate video time covered
by the frames on the current page. The estimate uses the first and last frame
numbers shown, so it remains useful after frames are deleted or search results
introduce gaps. Older frame directories can gain timing metadata by exploding
their source video again.

## Editable text

Double-clicking a supported inverted text file opens a CodeMirror editor with
line numbers, search, undo/redo, and syntax highlighting where available. The
supported extensions are `.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.csv`,
`.log`, `.xml`, `.html`, `.css`, `.js`, and `.ts`. Use **Save** or Ctrl/Cmd+S
to write changes. The viewer warns before discarding unsaved edits and rejects
a save when the source changed on disk, offering explicit reload and overwrite
actions instead.

Markdown files add **Editor** and **Preview** tabs. Preview renders the current
unsaved buffer as sanitized GitHub-style Markdown; the rendered view is
read-only and embedded HTML cannot execute scripts or event handlers. The
editor accepts files up to 5 MB. Saving bytewise-inverts the updated UTF-8 text
and atomically replaces the selected `.inv` source file.

The API binds only to `127.0.0.1`, validates every requested path against the
opened root, and never traverses `.inv-cache` as source content.
