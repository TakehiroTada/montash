# 07. 編集操作 → ffmpeg マッピング

`project.json` のタイムラインを ffmpeg コマンドに変換する規則。`montash render` と `montash preview build` が共通のグラフビルダーを使い、出力設定だけが異なる。

## 1. 基本方針

1. **1 タイムライン = 1 つの `ffmpeg -filter_complex`** を基本とする（中間ファイル無し、品質劣化無し）。プレビューだけはセグメント分割する（§11）。
2. 入力はクリップごとに `-ss/-to` 付き `-i` を分ける方式を **既定** とし、入力数が上限（既定 64）を超えるときのみ 1 アセット 1 入力 + `split` にフォールバック。
3. **時間は可能な限りフレーム数・サンプル数で ffmpeg に渡す**（05 章 §2）。秒で渡さざるを得ない箇所（`-ss`、`xfade=offset`、ASS の時刻）は有理数から変換し、誤差の上限を明記する。
4. 映像はトラックごとに **連結（concat / xfade）→ トラック間を overlay** で合成。音声はクリップごとに `adelay`（サンプル）で位置決めして `amix`。
5. テキスト・字幕は **ASS を生成して libass（`subtitles` フィルタ）で焼く**（§6）。`drawtext` は libass 無しビルド向けのフォールバック。
6. プレビューは映像をセグメントキャッシュ、音声はタイムライン全体を毎回 1 パスで生成し、最後に mux する（§11）。

### 記法

`F = settings.fps`（`num/den`）、`SR = settings.sample_rate`。
`sec(f) = f * den / num` を小数 6 桁で書式化（例: `sec(375) @29.97 = 12.512500`）。
`smp(f) = round(f * den * SR / num)`。

## 2. 入力段

| 状態 | ffmpeg |
|------|--------|
| クリップ `c`（asset A, in_f, out_f） | `-ss {sec(in_f)} -to {sec(out_f)} -i A`（`-accurate_seek` 既定。`start_time_s` が非 0 のアセットは加算して補正）。その後 §3 の `fps=` で厳密にフレーム化し、`trim=end_frame={out_f - in_f}` で長さを固定する |
| `speed != 1` | 入力は `in..out` そのまま、`setpts=PTS/{speed}` → `fps=` → `trim=end_frame={duration_f}`。音声は `atempo`（0.5〜100 の範囲外は多段）または `asetrate` |
| 画像アセット | `-loop 1 -framerate {num}/{den} -t {sec(duration_f)} -i img.png` → `trim=end_frame={duration_f}` |
| `loop: true`（音声 BGM） | `-stream_loop -1 -i bgm.mp3` + `atrim=end_sample={smp(duration_f)}` |
| generator color | `color=c={color}:s={W}x{H}:r={num}/{den}:d={sec(duration_f)}` → `trim=end_frame` / 音声 `anullsrc=r={SR}:cl=stereo` → `atrim=end_sample` |
| プロキシ入力（preview） | パスを `derived.proxy.path` に置き換え。プロキシは同じ fps・`start_time=0` で生成しているので in/out は同じ |

`-ss` の秒はマイクロ秒精度で、真のフレーム境界との差は 1µs 未満。続く `fps={num}/{den}` が最寄りフレームに量子化するため、出力フレーム列は決定的になる。

## 3. クリップ単位の正規化（映像）

すべての映像クリップを **タイムライン解像度・fps・pix_fmt** に揃えてから連結する（`concat`/`xfade` の要件）。

```
[i:v] fps={num}/{den}:round=near,
      scale={W}:{H}:force_original_aspect_ratio=decrease:flags=bicubic,
      pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={background},
      setsar=1,
      format=yuv420p,
      [+ 任意: crop, eq, lut3d, hflip/vflip, rotate]
      [+ setpts=PTS/{speed}, fps={num}/{den}]                    ← speed != 1 のときのみ
      trim=start_frame=0:end_frame={duration_f}, setpts=PTS-STARTPTS,
      [+ fade=t=in:s=0:n={fade.in_f}:color={color}]
      [+ fade=t=out:s={duration_f - fade.out_f}:n={fade.out_f}:color={color}]
[vN]
```

| 操作 | フィルタ |
|------|----------|
| クロップ | `crop={w}:{h}:{x}:{y}`（scale の前。`%` は W/H から px に解決） |
| 色調整 | `eq=brightness={b}:contrast={c}:saturation={s}:gamma={g}` |
| LUT | `lut3d=file={path}` |
| 反転／回転 | `hflip`, `vflip`, `transpose=1`、任意角は `rotate={rad}:c=black` |
| 不透明度 | `format=yuva420p,colorchannelmixer=aa={opacity}`（overlay トラックで使用） |
| フェード | `fade=t=in|out:s={start_frame}:n={nb_frames}`（**フレーム指定**。`st/d` の秒指定は使わない） |
| ホールド（hold generator） | 前クリップ最終フレームを `trim=start_frame={n-1}:end_frame={n},loop=loop=-1:size=1:start=0,trim=end_frame={duration_f}` |

## 4. トラック内の連結（映像）

### 4.1 トランジション無し（隣接）

```
[v1][v2][v3]concat=n=3:v=1:a=0[V1]
```

ギャップは `settings.background` の `color` ソースを同じフレーム数で挿入して連結。全クリップが同一 fps・解像度・pix_fmt・SAR なので `concat` は厳密にフレーム数の和になる。

### 4.2 トランジション有り（`xfade`）

`concat` と `xfade` は混在できないため、トラック内は **左から順に `xfade` を畳み込む**：

```
[v1][v2]xfade=transition={type}:duration={sec(d_f)}:offset={sec(len1_f - d_f)}[x1];
[x1][v3]xfade=transition={type2}:duration={sec(d2_f)}:offset={sec(len1_f + len2_f - d_f - d2_f)}[V1]
```

- `offset` = 先行ストリームの**フレーム数** − `d_f` を秒に変換したもの。先行が xfade 済みなら `len(x1)_f = len1_f + len2_f - d_f`（整数演算で追跡し、最後に `sec()` する）。
- `mode: handle`: `ext_from = ceil(d_f / 2)`、`ext_to = d_f - ext_from` として、事前に `from.out_f += ext_from`、`to.in_f -= ext_to` で切り出す。合成後のフレーム数 = `len_from + len_to - d_f` = 元のタイムライン上のフレーム数と一致する。
- `mode: overlap`: in/out はそのまま。`to.start_f` が `project.json` 上で既に `d_f` 分前倒しされている。
- トランジション無しの境界が混在するトラックでは、xfade 連鎖を **区間ごとに切り**、区間同士を `concat` する。
- `xfade` は両入力が同一解像度・fps・pix_fmt・一定フレームレートであること。§3 で保証。
- `xfade` の `offset`/`duration` は秒でしか渡せない。§3 で全フレームの pts が `k * den/num` に量子化されているため、`sec()` のマイクロ秒丸め（< 1µs）でフレームの取り違えは起きないが、**M1 のゴールデンテスト（29.97fps）で「合成後フレーム数 = 期待値」を必ず検証する**（12 章 ADR-09）。

### 4.3 先頭／末尾フェード（`montash fade`）

トラック合成後に `fade=t=in:s=0:n={in_f}`、`fade=t=out:s={total_f - out_f}:n={out_f}` を適用。

## 5. トラック間合成（映像）

トラック配列順（下 → 上）に `overlay` を重ねる。上位トラックのクリップはタイムライン上の絶対位置に置く必要があるため、**フレーム番号 `n` で `enable`** する。

```
[ovN]setpts=PTS+{sec(start_f)}/TB[ovN'];
[base][ovN']overlay=x={X}:y={Y}:enable='between(n,{start_f},{end_f - 1})':eof_action=pass:shortest=0[bN]
```

- `n` は base 側の出力フレーム番号（0 起点）なので整数比較で正確。
- `position` プリセット → 座標式：

| preset | x | y |
|--------|---|---|
| `top-left` | `{m}` | `{m}` |
| `top-right` | `W-w-{m}` | `{m}` |
| `bottom-left` | `{m}` | `H-h-{m}` |
| `bottom-right` | `W-w-{m}` | `H-h-{m}` |
| `center` | `(W-w)/2` | `(H-h)/2` |
| `x%,y%` | `W*{x}/100` | `H*{y}/100` |
| px | そのまま | そのまま |

- `scale` はオーバーレイ側で `scale=iw*{s}:-2`（`WxH` 指定時は `scale={W}:{H}:force_original_aspect_ratio=decrease`）。
- アルファ付き PNG/ProRes 4444 は `format=yuva420p`（`keep_alpha`）または `rgba` を維持して overlay。
- 同一トラック内で時間的に重ならない複数オーバーレイは、それぞれ独立入力として順に overlay する。

## 6. テキスト（libass / ASS 生成）

テキストトラックの全クリップから **1 つの ASS ファイル**（`.montash/tmp/<hash>.ass`）を生成し、映像合成の最後（overlay の後、出力 `format` の前）に 1 回だけ `subtitles` フィルタで焼く。

```
[bN]subtitles=filename='.montash/tmp/ab12.ass':fontsdir='.montash/tmp/fonts':original_size={W}x{H}[Vtext]
```

### 6.1 なぜ libass か

`drawtext` は自動折り返し・行単位のスタイル・フォントフォールバック（CJK と絵文字の混在）・複数行の背景ボックスが弱い。ASS/libass は位置（`\pos`, `\an`）、フェード（`\fad`）、縁取り／影、折り返し、太字／斜体、行内オーバーライドを一貫して扱え、字幕焼き込み（§7）と同じ経路になる。要 `--enable-libass`（`doctor` で `subtitles` フィルタの有無を確認。無ければ `settings.text_engine: drawtext` にフォールバックし、機能制限を警告）。

### 6.2 生成する ASS の構造

```
[Script Info]
ScriptType: v4.00+
PlayResX: {W}                      ; プロジェクト解像度 = px 座標が 1:1
PlayResY: {H}
WrapStyle: 0                       ; 0=スマート折り返し（wrap:true）/ 2=折り返さない（wrap:false）
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: x1,Noto Sans CJK JP,96,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,2,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:03.00,x1,,0,0,0,,{\pos(960,540)\fad(500,500)}Summer Trip 2026
```

- **テキストクリップ 1 つ = Style 1 つ + Dialogue 1 行**（Style 名 = クリップ ID）。プリセットは Style の既定値を埋めるだけ。
- 色: `#RRGGBB[AA]` → ASS の `&HAABBGGRR`（ASS のアルファは `00` が不透明なので `AA' = 255 - AA`）。
- **位置**: プリセット → `\an`（テンキー配置: 7 8 9 / 4 5 6 / 1 2 3）+ `Margin*`。`center` → `\an5` + `\pos(W/2,H/2)`、`bottom-center` → `\an2` + `MarginV`、`top-right` → `\an9` + `MarginR/MarginV`。`{x,y}` 指定 → `\an7`（左上基準。`align` が center/right なら `\an8`/`\an9` に切替）+ `\pos(x,y)`。`%` は W/H から px に解決。
- **背景ボックス**（`bg`）: `BorderStyle=4`（libass 拡張: 行ブロック全体を `BackColour` で塗る。padding は `Outline` 値）。`bg_padding` → `Outline`、縁取りが同時に必要な場合は `\bord` を行内オーバーライドで分離。libass が古く `BorderStyle=4` 非対応なら `3`（行ごとのボックス）にフォールバック。
- **縁取り／影**: `Outline`/`OutlineColour`、`Shadow`/`BackColour`（BorderStyle=1 のとき Shadow 色は `BackColour`）。影の x/y 個別指定は `\xshad`/`\yshad`。
- **フェード**: `\fad({round(sec(in_f)*1000)},{round(sec(out_f)*1000)})`（ミリ秒）。
- **複数行**: 入力の `\n` → `\N`。先頭スペースは `\h`。`align` は `\an` の列で表現。
- **時刻**: ASS はセンチ秒（0.01s）精度。`Start = floor(sec(start_f) * 100) / 100`、`End = ceil(sec(end_f) * 100) / 100` とする。1 フレーム（≥ 16.7ms @60fps）はセンチ秒より長いので、この丸めで前後のフレームに漏れることはない。
- **エスケープ**（`markup: plain`）: `{` → `\{`、`}` → `\}`、`\` → `\\`（`\N`/`\h` は生成側が付ける）。`markup: ass` は本文をそのまま通す（AI が `{\b1}強調{\b0}` のようなオーバーライドを書ける）。
- **フォント**: `fonts list` で解決した **ファイルをコピー／シンボリックリンクした `fontsdir`** を渡し、`Fontname` にはファミリー名を書く。これで fontconfig の有無（macOS / WSL）に依存しない。フォールバック用に CJK フォントを常に `fontsdir` に含める。
- `original_size={W}x{H}` を渡すと、プレビュー（プロキシ解像度）でも同じ ASS が正しく縮尺される（PlayRes と出力サイズが異なっても libass がスケールする）。

### 6.3 drawtext フォールバック（`text_engine: drawtext`）

libass 無しの環境のみ。テキストクリップごとに `drawtext=fontfile=...:textfile=...:enable='between(n,{start_f},{end_f-1})':alpha='...'` を積む。折り返し・`bg_padding`・`markup: ass` は非対応（`W_TEXT_ENGINE_LIMITED`）。文字列は `textfile=` 一時ファイル方式で渡す。

## 7. 字幕

| mode | ffmpeg |
|------|--------|
| burn（SRT/VTT） | SRT を ASS に変換して §6 の ASS に **Events として統合**（Style は `subtitle` クリップの `style` から生成、`offset_f` は変換時に加算）。1 回の `subtitles` で全部焼ける |
| burn（ASS 素材） | 素材のスタイルを尊重するため **別の `subtitles=filename=<asset.ass>:fontsdir=...`** を追加で通す（`offset_f` があれば時刻をシフトした一時コピー） |
| soft (MP4) | `-i subs.srt -c:s mov_text -metadata:s:s:0 language=ja -disposition:s:0 default` |
| soft (MKV) | `-c:s srt` または `-c:s ass` |

## 8. 音声

### 8.1 クリップ単位

```
[i:a] aresample={SR}:async=1, aformat=sample_fmts=fltp:channel_layouts=stereo,
      [+ atempo={speed}（pitch_keep=true）| asetrate={SR*speed},aresample={SR}（pitch_keep=false）]
      atrim=start_sample=0:end_sample={smp(duration_f)}, asetpts=PTS-STARTPTS,
      [+ volume={gain_db}dB]
      [+ afade=t=in:ss=0:ns={smp(fade.in_f)}:curve={curve}]
      [+ afade=t=out:ss={smp(duration_f) - smp(fade.out_f)}:ns={smp(fade.out_f)}]
      adelay={smp(start_f) + offset_smp}S|{同}S          ← サンプル単位（S サフィックス）でタイムライン位置へ
[aN]
```

- `atrim`/`afade`/`adelay` はすべて **サンプル指定**（`start_sample`/`end_sample`、`ss`/`ns`、`...S`）。秒指定は使わない。
- `adelay` の負値は不可なので、`smp(start_f) + offset_smp < 0` になる場合は `atrim=start_sample={-値}` で先頭を削って `adelay=0S`。

### 8.2 トランジション音声（`acrossfade`）

隣接クリップの `audio: crossfade` は、`adelay` の前に `[a1][a2]acrossfade=ns={smp(d_f)}:c1=tri:c2=tri` で連結し、連結結果に 1 回 `adelay`。混在する場合は §4.2 と同様に区間分割して `concat=v=0:a=1`。

### 8.3 トラック合成・ダッキング

```
[a1][a2][a3]amix=inputs=3:duration=longest:normalize=0[A1];
[A1]volume={track_gain}dB[A1g];
[A1g]asplit[A1a][A1b];
[A2g][A1b]sidechaincompress=threshold={10^(thr_db/20)}:ratio={ratio}:attack={atk}:release={rel}:makeup={mk}[A2d];
[A1a][A2d]amix=inputs=2:duration=longest:normalize=0[Amix];
[Amix]atrim=end_sample={smp(total_f)},volume={master}dB[Aout]
```

- `--simple` ダッキング: `silencedetect` で A1 の発話区間を事前解析 → `volume='if(between(n,s1,e1)+...,{ducked},1)':eval=frame`（`n` はサンプル番号）を A2 に適用。
- 音声トラックが 1 つも無い区間は `anullsrc` を `amix` に含めて尺を保証し、最後に `atrim=end_sample={smp(total_f)}` で全長を固定する。

### 8.4 正規化（`loudnorm` 2 パス）

1. パス 1: 音声グラフのみ（`-vn`）で `loudnorm=I={i}:TP={tp}:LRA={lra}:print_format=json -f null -` を実行し measured 値を取得。
2. パス 2: `loudnorm=...:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true` を `[Aout]` の末尾に付与。
3. `preview build` では 1 パス（`linear=false`）または省略（`settings.preview.normalize=false`）。

## 9. 出力段（レンダー）

| プリセット | 映像 | 音声 | コンテナ／備考 |
|-----------|------|------|----------------|
| `youtube-1080p` | `libx264 -preset slow -crf 18 -pix_fmt yuv420p -profile:v high -level 4.2 -g {round(2*num/den)} -movflags +faststart` | `aac -b:a 192k -ar {SR}` | mp4 |
| `youtube-4k` | 同上、`-crf 17 -level 5.1`、scale 3840x2160 | 同上 | mp4 |
| `instagram-reel` | 1080x1920、`--reframe` による crop、`-crf 20` | `aac 128k` | mp4、90 秒超で警告 |
| `web-preview` | 1280x720 `-preset veryfast -crf 28` | `aac 96k` | mp4 |
| `prores-422` | `prores_ks -profile:v 3 -pix_fmt yuv422p10le` | `pcm_s16le` | mov |
| `archive-h265` | `libx265 -preset medium -crf 22 -tag:v hvc1` | `aac 192k` | mp4 |
| `audio-only-mp3` | なし（`-vn`） | `libmp3lame -q:a 2` | mp3 |
| `gif` | `fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse` | なし | gif |
| `thumbnail` | `-frames:v 1 -q:v 2` | なし | png/jpg |

- 共通: `-y`（`--overwrite` 時のみ）、`-hide_banner -nostats -progress pipe:1`、`-map [Vout] -map [Aout]`、`-frames:v {total_f}`（尺の固定はフレーム数で）、`-r {num}/{den}`（`--fps` で別 fps 指定時は最終段に `fps=` を追加）、`-shortest` は使わない。
- `--hwaccel auto`: `h264_videotoolbox`（macOS）→ `h264_nvenc` → `h264_vaapi` → `h264_qsv` の順。ビットレート指定に切り替え、`-crf` は無視して警告。
- `--reframe center|left|right|<x>%`: タイムライン解像度で合成してから出力段で crop → scale する。crop の幅・高さ・オフセットは ffmpeg の式（`ih*9/16` など）ではなく **Bun 側で計算した具体値**を渡す。`yuv420p` は幅・高さ・オフセットがすべて偶数でなければならず、式のままだと奇数になりうるため、切り出し寸法は最も近い偶数へ丸め（元の寸法は超えない）、オフセットは偶数へ切り下げる。
  例: タイムライン 1920x1080 → `instagram-reel`(1080x1920) の `center` は `crop=608:1080:656:0,scale=1080:1920:flags=bicubic,setsar=1`（`left` は `x=0`、`right` は `x=1312`、`40%` は `x=524`）。省略時は crop せず、グラフ側の `scale=...:force_original_aspect_ratio=decrease,pad=...` でレターボックスする。
- `--two-pass`: `-pass 1 -f null /dev/null` → `-pass 2`。
- 終了後 `ffprobe -count_frames` で `render verify`（`nb_read_frames == total_f`、音声尺 ± 1 フレーム）。

## 10. プロキシ生成（`proxy build`）

```
ffmpeg -i A -vf "fps={num}/{den},scale=-2:{height},format=yuv420p" -c:v libx264 -preset veryfast -crf 28 -g {round(num/den)} -keyint_min {round(num/den)} -sc_threshold 0
       -c:a aac -b:a 96k -ac 2 -ar {SR} -movflags +faststart -avoid_negative_ts make_zero .montash/cache/{id}/proxy.mp4
```

- **プロジェクト fps に変換し、`start_time = 0`** で生成する。これにより原本と同じ `in_f/out_f` がプロキシにそのまま使え、GOP = 1 秒でシークが速い。
- サムネイル: `fps=1/{interval_s},scale=160:-2,tile={cols}x{rows}`。`thumbs.json` には `interval_f` を書く。
- 波形: `-ac 1 -ar 8000 -f s16le -` を Bun 側で 80 サンプル単位のピークに集約（100 点/秒）。

## 11. プレビュー合成（`preview build`）

映像はセグメントキャッシュ、音声は全体 1 パス、最後に mux する。

### 11.1 映像セグメント

1. タイムラインを **セグメント境界** で分割する。境界 = 映像／テキストトラックのクリップ開始／終了、トランジション開始／終了の和集合（フレーム単位）。最小セグメント長 60 フレーム程度に統合し、**xfade 区間は必ず 1 セグメント内に含める**。
2. 各セグメントについて、関係するクリップ・効果・`settings`・ASS からハッシュを計算。`.montash/preview/segments/<hash>.mp4` があれば再利用。
3. 無いセグメントだけ §2〜§7 の映像グラフを `--from_f/--to_f` で生成する（入力はプロキシ、`-an`、出力は `libx264 -preset ultrafast -crf 30 -g 30 -pix_fmt yuv420p -r {num}/{den}`、全セグメント同一パラメータ）。`--parallel N` で並列。テキストは **セグメント開始を 0 とした時刻にシフトした ASS** を生成して焼く。
4. `ffmpeg -f concat -safe 0 -i list.txt -c copy video.mp4`（無再エンコード。全セグメントがフレーム数で切れているため継ぎ目は正確）。

### 11.2 音声（全体 1 パス）

- §8 の音声グラフをタイムライン全体で実行し、`audio.m4a`（`aac 96k`）を生成する。映像デコードを伴わないので数秒で終わる。
- 音声に影響する部分（音声クリップ・ゲイン・フェード・ダッキング・トランジション音声）のハッシュが前回と同じなら再利用。
- **理由**: AAC はエンコーダ遅延（priming）があり、セグメントごとに音声を含めて `-c copy` concat すると境界でクリック・ズレが出る。音声を 1 本にすればこの問題を根本的に避けられる。

### 11.3 mux

```
ffmpeg -i video.mp4 -i audio.m4a -c copy -movflags +faststart timeline.mp4
```

`timeline.json` を書き、WebSocket で `preview.state: ready`。`--audio-only` は 11.2 だけを実行して `audio.m4a` を配信する。

## 12. `--dry-run` / `explain render` 出力例（29.97fps）

```
# inputs
ffmpeg -hide_banner -nostats -progress pipe:1 \
  -ss 2.002000 -to 14.764750 -i /raw/clip_a.mp4 \       # c1: in_f=60 out_f=435 (+8f handle for t1 → 443)
  -ss 0.000000 -to 20.253567 -i /raw/clip_b.mp4 \       # c2: in_f=0 out_f=600 (−7f handle → in −7 は 0 で clamp 不可 → validate 済)
  -stream_loop -1 -i /raw/bgm.mp3 \                     # c_bgm (loop)
  -loop 1 -framerate 30000/1001 -t 44.544500 -i /raw/logo.png \  # o1
  -filter_complex "
    [0:v]fps=30000/1001,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,trim=end_frame=383,setpts=PTS-STARTPTS[v0];
    [1:v]...,trim=end_frame=607,setpts=PTS-STARTPTS[v1];
    [v0][v1]xfade=transition=fade:duration=0.500500:offset=12.278933[V1];        # d_f=15, offset=(383−15)f
    [3:v]scale=iw*0.12:-2,format=yuva420p,colorchannelmixer=aa=0.9,setpts=PTS+0/TB[ov1];
    [V1][ov1]overlay=x=W-w-24:y=24:enable='between(n,0,1334)':eof_action=pass[b1];
    [b1]subtitles=filename='.montash/tmp/ab12.ass':fontsdir='.montash/tmp/fonts':original_size=1920x1080[Vout];
    [0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end_sample=613413,asetpts=PTS-STARTPTS[a0];
    [1:a]...[a1];
    [a0][a1]acrossfade=ns=24024[A1];
    [2:a]atrim=end_sample=2138136,volume=-12dB,afade=t=out:ss=2042040:ns=96096[a2];
    [A1]asplit[A1a][A1b];
    [a2][A1b]sidechaincompress=threshold=0.0316:ratio=8:attack=20:release=500[A2d];
    [A1a][A2d]amix=inputs=2:duration=longest:normalize=0,atrim=end_sample=2138136[Aout]
  " \
  -map "[Vout]" -map "[Aout]" -frames:v 1335 -r 30000/1001 \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -g 60 -movflags +faststart \
  -c:a aac -b:a 192k -ar 48000 \
  out/my-vlog.mp4
```

## 13. 既知の落とし穴と対策

| 問題 | 対策 |
|------|------|
| `xfade` が VFR 入力で失敗 | §3 で必ず `fps=` を通す |
| `xfade` の `offset` 秒指定とフレーム境界のズレ | 全 pts を `fps=` で量子化してから `sec()` をマイクロ秒精度で渡す。29.97fps のゴールデンテストでフレーム数を検証 |
| `-ss` 前置で B フレームによりズレ | `-accurate_seek`（既定）+ `fps=` + `trim=end_frame` で長さを固定 |
| ASS の時刻がセンチ秒精度 | Start は floor、End は ceil。1 フレーム > 10ms なので隣接フレームに漏れない |
| ASS の特殊文字 | `{` `}` `\` をエスケープ（`markup: plain`）。ファイル名は `.montash/tmp/` の短い相対パス |
| ASS のフォント解決が環境依存 | `fontsdir=` に解決済みフォントファイルを集めて渡す。CJK フォールバックを常に同梱 |
| libass 無しビルド | `doctor` が検出し `text_engine: drawtext` にフォールバック（機能制限を警告） |
| `overlay` の `enable` で最終フレームが残る | `eof_action=pass` と `-frames:v {total_f}` |
| AAC の priming による concat 境界のクリック | 音声はセグメント化せず全体 1 パス（§11.2） |
| `amix` で音量が下がる | `normalize=0` |
| `sidechaincompress` の threshold 単位 | dB → 線形値（`10^(dB/20)`）に変換 |
| 29.97fps でフレーム→サンプルが非整数 | `smp()` で丸め（誤差 < 1 サンプル）。`offset_smp` はサンプル native |
| 入力数上限（`-i` が多すぎる） | 64 超で `split` 方式へ切替 |
| `loudnorm` 2 パスの時間 | preview では省略。render は `-vn` の音声グラフのみで測定 |
| WSL で `/mnt/c` の I/O が遅い | `import --copy` で ext4 側へコピー推奨（`doctor` が警告） |
