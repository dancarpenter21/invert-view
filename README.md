# Uninvert File Browser

Uninvert is a private, local viewer for files produced by `../invert_file.py`.
It determines an inverted file's restored MIME type from its file signature,
hides recognizable files that are already uninverted, then streams restored
images and videos to the browser without uploading them. Video playback uses
seekable byte-range streaming, so restored files do not need to fit in memory.
Video previews start muted; opening a video uses the full player with its
original audio and complete seekable duration when the browser supports the
source container and codecs.

## Requirements

- Node.js 20.19+ or 22.12+ (Node 24 is supported)
- `zsh` at `/usr/bin/zsh` for the integrated terminal. Installing dependencies
  also requires the standard native Node build toolchain for `node-pty`.
- `ffmpeg` on `PATH` for video thumbnails and frame extraction. `ffprobe` is
  optional and is used only to make frame-job progress more accurate.

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
and deliberately restart in the browser's displayed folder. The terminal can
be collapsed or resized from its top edge, and both preferences are remembered
by the browser. Collapsing keeps the shell alive; refreshing or closing the tab
ends it. Zsh history, control keys, ANSI applications, and configured tab
completion are available through the pseudo-terminal.

Large directories are loaded in pages of 250 entries. Use the paging controls
at the bottom of the browser to move between pages without waiting for the
entire directory to be scanned or rendered at once.

The displayed directory updates live when eligible inverted files or folders
are created, modified, renamed, or deleted. Each browser tab watches only its
current directory and changes the subscription when navigating. The catalog
keeps its active search, filter, sort, and page settings; an open full media or
text viewer is left undisturbed until you return to the catalog. WebSocket
reconnection performs a fresh catalog read, and periodic HTTP refreshes act as
a fallback while live watching is unavailable.

Select one item with a click, add or remove items with Ctrl/Cmd-click, or use
Shift-click to select a visible range. Press Escape or use **Clear** to clear a
selection. Double click opens an item. The action controls create a folder,
move selected items, or delete them after confirmation; selected items can also
be dragged onto a directory to move them. Moves never overwrite an existing
destination item. Selecting a file shows its complete source path in the path
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

## Media cache and frames

When the service detects an inverted video, it creates a thumbnail in the
opened folder's `.inv-cache/thumbnails/` directory. The thumbnail itself is an
inverted JPEG ending in `.inv.jpg`; no plain thumbnail is retained. Cache
metadata in `.inv-cache/manifest.json` records the source size and modification
time, so a thumbnail is regenerated only when its source changes.

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

The main viewer edits restored UTF-8 text for conventional inverted files with
these extensions: `.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.csv`, `.log`,
`.xml`, `.html`, `.css`, `.js`, and `.ts`. The editor accepts files up to 5 MB.
Saving bytewise-inverts the updated UTF-8 text and atomically replaces the
selected `.inv` source file.

The API binds only to `127.0.0.1`, validates every requested path against the
opened root, and never traverses `.inv-cache` as source content.
