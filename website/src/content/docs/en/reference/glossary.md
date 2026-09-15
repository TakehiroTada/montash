---
title: Glossary
description: Terms used throughout the montash documentation
---

## Editing terms

### Asset
A source media file imported with `montash import` — video, audio, image, subtitle or text.
Its ID comes from the filename (`clip_a.mp4` becomes `clip_a`).
**montash never writes to an asset's file.**

### Track
A layer that clips sit on. There are three kinds: video (`V1`, `V2`, …), audio (`A1`, `A2`, …) and text (`T1`, …).
Higher-numbered video tracks composite on top.

### Clip
A piece of an asset placed on a track, with an ID like `c1`, `c2`.
It records which range of the asset (`in_f` to `out_f`) sits at which point of the timeline (`start_f`).

Placing footage that has sound creates **two linked clips**, one video and one audio.
Moving either moves the other; `--unlink` detaches them.

### Handle
Source material that **remains beyond the edges** of the range a clip uses.
Transitions consume handles to overlap two shots.
Without enough handle you get `E_INSUFFICIENT_HANDLE`.

### Ripple
Applying the result of an edit **to everything that follows** as well.
Shorten a clip by a second with ripple, and the following clips move a second earlier, leaving no hole.

- `--ripple` / `--ripple=all` — everything after it on every track (music and titles move too)
- `--ripple=track` — only the following elements on that track

### Gap
A stretch with no video. Trimming or deleting without ripple creates one (`W_GAP_CREATED`).
`montash timeline gaps` lists them.

### Title (text clip)
Text placed on a text track, with an ID like `x1`, `x2`.
It carries a body and a style (font, size, colour, position).

### Subtitle
An external SRT / VTT / ASS file attached to the timeline, with an ID like `s1`, `s2`.
Two modes: `burn` (rendered into the picture) and `soft` (muxed as a selectable track).

### Transition
An effect at the join between two adjacent clips, with an ID like `t1`, `t2`.
Implemented with ffmpeg's `xfade` filter.

### Ducking
Lowering one track's level while another one is playing —
"drop the music while someone is speaking". IDs look like `d1`, `d2`.

### Proxy
A light H.264/AAC copy of an asset, used for playback in the browser.
It lives at `.montash/cache/<asset_id>/proxy.mp4` and **can be rebuilt at any time**.

### Preview
The assembled review video for the whole timeline, at `.montash/preview/timeline.mp4`.
Video is cached per segment, so only what changed is rebuilt.
It is proxy quality, and loudness normalization is not applied.

## History terms

### op
The record of one state-changing command, with an ID like `o_0001`, `o_0002`. **Recorded automatically.**
It holds the command that ran, what it changed, and snapshots of the state before and after.

### Commit
A run of consecutive ops given a human-readable message, with an ID like `k_0001`, `k_0002`.
`k` stands for kommit, chosen so commit IDs never collide with clip IDs like `c1`.

### Pending ops
Ops that have not been committed yet — git's uncommitted changes.
`montash status` lists them.

### HEAD
The op currently expanded into `project.json`.

### tip
The newest op on a branch. `montash checkout tip` returns to it.

### Detached
HEAD is somewhere that is not the tip — you are looking at a past state.
Editing from here starts a new branch, and the original run of ops is kept.

### Tag
A name on an op or a commit. Create one with `montash tag rough-cut`
and return to it with `montash checkout rough-cut`.

### Object
A snapshot of `project.json`, named by the hash of its content and deduplicated.
The equivalent of a git blob.

### `~n` notation
Means "n steps earlier": `HEAD~3`, `k_0007~1`.

### actor
Who performed an op: `ai`, `human`, `web` or `system`.
Actions from the browser are recorded as `web`.

## Time terms

### Frame notation (`f:`)
`f:45` means frame 45. It **never rounds**,
so use this form when feeding a value the CLI gave you back into another command.

### Snapping
Rounding a time given in seconds to the nearest frame. When it happens, `W_SNAPPED` is returned.

### Rational frame rate
Storing the frame rate as an integer ratio such as `30000/1001`.
29.97fps held as a decimal accumulates error; held as a rational it stays exact.

## See also

- [CLI reference](/en/reference/cli/)
- [The project file](/en/reference/project-file/)
