---
title: The project file
description: The shape of project.json and the contents of the .montash/ directory
---

A montash project is a single directory, laid out roughly like this.

```
my-edit/
├── project.json        the entire edit (the single source of truth)
├── assets/             project-owned media (imported with --copy, plus text assets)
├── out/                exported files
└── .montash/           montash's own working area
```

`project.json` is human-readable JSON; reading it tells you exactly what is placed where.
It is **not meant to be edited by hand**, though — go through the CLI.

## The shape of `project.json`

```json
{
  "schema_version": 2,
  "name": "my-vlog",
  "created_at": "2026-09-15T05:30:00Z",
  "updated_at": "2026-09-15T05:30:27Z",
  "settings": {
    "fps": { "num": 30000, "den": 1001 },
    "resolution": { "width": 1920, "height": 1080 },
    "sample_rate": 48000,
    "channels": 2,
    "text_engine": "libass"
  },
  "assets": {
    "clip_a": {
      "id": "clip_a",
      "type": "video",
      "path": "./assets/clip_a.mp4",
      "duration_f": 425
    }
  },
  "tracks": [
    {
      "id": "V1",
      "kind": "video",
      "clips": [
        { "id": "c1", "asset": "clip_a", "start_f": 0, "in_f": 60, "out_f": 435, "speed": 1.0 }
      ]
    }
  ],
  "transitions": [],
  "audio": {},
  "text_presets": {},
  "render_presets": {},
  "meta": { "tags": [] }
}
```

| Key | Contents |
|-----|----------|
| `schema_version` | Format version (currently 2) |
| `settings` | Frame rate, resolution, sample rate, channel count, default font, text engine |
| `assets` | Imported media, as an **object keyed by ID** |
| `tracks` | Tracks and the clips on them. **An array; its order is the compositing order** (later is on top) |
| `transitions` | Transitions. **An array** |
| `audio` | Master gain, ducking and loudness normalization settings |
| `text_presets` / `render_presets` | Project-specific presets |
| `meta` | Information about the last render, plus tags |

Things keyed by ID (like `assets`) are objects; things where order matters (`tracks`, `transitions`) are arrays.

Paths are either relative to the project root (`./assets/...`) or absolute. `~` is not expanded.

## The frame rate is a rational number

`settings.fps` is kept as an integer numerator and denominator.

```json
"fps": { "num": 30000, "den": 1001 }
```

That is 29.97fps. One frame lasts `den / num` seconds (1001/30000, about 0.0333667s).
Stored as a decimal like `0.0333`, rounding error would accumulate; as a rational it stays **exact no matter how many frames pass**.

| You ask for | What is stored |
|-------------|----------------|
| `23.976` | `24000/1001` |
| `24` | `24/1` |
| `25` | `25/1` |
| `29.97` | `30000/1001` |
| `30` | `30/1` |
| `50` | `50/1` |
| `59.94` | `60000/1001` |
| `60` | `60/1` |

You can also pass a fraction directly: `montash init --fps 30000/1001`.

Conversion to seconds happens only when displaying a value or handing it to ffmpeg (`seconds = frames × den / num`).

## Time is an integer

Time fields carry their unit in the suffix, and **the stored value is always an integer**.

| Suffix | Unit | Example |
|--------|------|---------|
| `_f` | **Frames** at the project frame rate | `start_f: 375`, `in_f: 60`, `out_f: 435` |
| `_smp` | **Samples** at the project `sample_rate` (sub-frame audio correction) | `offset_smp: -960` |
| `_s` | Seconds — reference data from ffprobe, never used for editing decisions | `duration_s: 14.214` |

`_f` values are zero or greater; only `offset_smp` can be negative.

:::note[Clip length is not stored]
A clip's `duration_f` is computed from `in_f`, `out_f` and `speed` rather than stored
(`duration_f = max(1, round((out_f - in_f) / speed))`, `end_f = start_f + duration_f`).
Text clips, subtitle clips and generated clips do carry their own `duration_f`.
:::

## Element IDs

| Kind | Form | Example |
|------|------|---------|
| Asset | Slug of the filename (`_2`, `_3` on collision) | `clip_a` |
| Clip (video, audio, overlay) | `c<N>` | `c7` |
| Transition | `t<N>` | `t3` |
| Text (title) | `x<N>` | `x2` |
| Subtitle | `s<N>` | `s1` |
| Ducking | `d<N>` | `d1` |
| Track | `V<N>` / `A<N>` / `T<N>` | `V1`, `A2`, `T1` |
| op | `o_<4 digits>` | `o_0042` |
| Commit | `k_<4 digits>` | `k_0007` |

The counters live in `.montash/ids.json`, not in `project.json`.
They only ever increase, so a deleted ID is never handed out again.

## Inside `.montash/`

This is montash's working area. **Everything except `assets/` and `project.json` can be regenerated.**

| Path | Role |
|------|------|
| `.montash/ids.json` | ID counters |
| `.montash/history/HEAD` | The current op ID |
| `.montash/history/ops.jsonl` | Append-only log of ops |
| `.montash/history/commits.jsonl` | Append-only log of commits |
| `.montash/history/moves.jsonl` | Log of `checkout` / `undo` / `redo` movements |
| `.montash/history/tags.json` | Tags |
| `.montash/history/objects/<sha1>.json` | Snapshots of `project.json`, content-addressed and deduplicated |
| `.montash/cache/<asset_id>/` | Derived files per asset: `probe.json` (raw ffprobe), `proxy.mp4`, `thumbs.jpg`, `thumbs.json`, `waveform.json` |
| `.montash/preview/` | The preview: `timeline.mp4`, `timeline.json`, `audio.m4a`, `segments/<sha1>.mp4` |
| `.montash/render/` | The last render's settings and its progress |
| `.montash/tmp/` | Temporary files (generated `.ass` files and so on) |
| `.montash/logs/` | Execution logs |

`ops.jsonl` and `commits.jsonl` are **append-only**; nothing but `history prune` ever removes a line.

### Keeping a project in git

If you track a project in git, these are reasonable to ignore.

```text
.montash/cache/
.montash/preview/
.montash/tmp/
out/
```

`project.json` and `.montash/history/` are the edit itself, and are worth committing.

## See also

- [CLI reference](/en/reference/cli/)
- [Glossary](/en/reference/glossary/)
