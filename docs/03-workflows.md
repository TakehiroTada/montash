# 03. 作業手順カタログ（Workflows）

本書はこのプロジェクトの **出発点** です。動画編集で人間が実際に行う作業を「手順」として書き起こし、各ステップに対応する CLI コマンドを紐付けます。ここに無い作業に対応するコマンドは作りません。

## 手順の書き方（テンプレート）

```
### W-xx. 手順名
- 目的:        この手順で何が達成されるか
- 起点:        人間がどう言い出すか（プロンプト例）
- 事前条件:    手順開始時に成立していること
- 手順:        ステップ番号 / 誰が / 何をする / 使うコマンド
- 完了条件:    手順が終わったと判断できる観測可能な状態
- 失敗と対処:  典型的な失敗と AI がとるべき次の行動
- 派生コマンド: この手順から必要になったコマンド（04 章へ）
```

登場人物: **人**（編集ディレクター）、**AI**（オペレーター）、**Web**（プレビュー UI）。

## 手順一覧

| ID | 手順名 | 分類 | 優先度 |
|----|--------|------|--------|
| W-01 | 環境確認とプロジェクト作成 | 準備 | M |
| W-02 | 素材の取り込みと下見 | 準備 | M |
| W-03 | 粗編集（カットして並べる） | 編集 | M |
| W-04 | プレビューで確認して微調整する | 確認・編集 | M |
| W-05 | トランジションを入れる | 編集 | M |
| W-06 | テロップ・タイトルを入れる | 演出 | M |
| W-07 | BGM・音量を整える | 音声 | M |
| W-08 | ロゴ・PiP・画像を重ねる | 演出 | S |
| W-09 | 書き出す | 出力 | M |
| W-10 | やり直す・戻す | 補助 | M |
| W-11 | 既存プロジェクトを一部修正して再書き出し | 編集・出力 | S |
| W-12 | 複数フォーマットで一括書き出し | 出力 | S |
| W-13 | 素材の場所が変わったので再リンクする | 補助 | S |
| W-14 | 字幕ファイルを付ける | 演出 | S |
| W-15 | 作業をコミットとして記録する（git ライク） | 履歴 | M |
| W-16 | Web の History タイムラインで戻る・進む | 履歴・確認 | M |
| W-17 | Web で素材を管理する | 準備 | S |

---

## W-01. 環境確認とプロジェクト作成

- **目的**: ffmpeg が使えることを確認し、空のプロジェクトを作る。
- **起点**: 「新しい動画を作りたい。1080p 30fps で」
- **事前条件**: bash が使える。作業ディレクトリに書き込み権限がある。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | ffmpeg / ffprobe / Node の有無とビルドオプション（libx264, libfreetype, libass）を確認 | `montash doctor --json` |
| 2 | AI | 不足があれば人間に報告し、インストール手順を提示（手順終了） | — |
| 3 | AI | プロジェクトディレクトリを作成し初期化（**fps と解像度がプロジェクトの基準単位**になる。素材の fps が分かっていればそれに合わせる） | `montash init <name> --fps 30 --resolution 1920x1080 --sample-rate 48000`（29.97 素材なら `--fps 29.97`） |
| 4 | AI | 設定内容（fps の有理数表現、1 フレームの秒数を含む）を人間に報告 | `montash project show --json` |

- **完了条件**: `<name>/project.json` が存在し、`montash project show` が設定を返す。`<name>/.montash/` が作られている。
- **失敗と対処**:
  - ffmpeg が無い → `doctor` の `hint` にある OS 別インストールコマンドを人間に提示。
  - 既に `project.json` がある → エラー `E_PROJECT_EXISTS`。上書きしたい場合のみ `--force`。AI は人間に確認する。
- **派生コマンド**: `doctor`, `init`, `project show`

---

## W-02. 素材の取り込みと下見

M1実装: 取り込み・プロキシ・一覧・詳細を `tests/workflows/W-02.sh` で検証。`proxy build --all` は映像／音声のプロキシを生成し、画像・字幕・テキストは対象外。サムネイル・波形とWeb Assets閲覧は後続マイルストーン。

- **目的**: 素材をプロジェクトに登録し、長さ・解像度・音声の有無を把握し、プレビュー用プロキシを作る。
- **起点**: 「`raw/` の中の動画全部を読み込んで、どんな素材があるか教えて」
- **事前条件**: W-01 完了。素材ファイルが存在する。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | 素材を一括インポート（ffprobe でメタ取得、ID 自動付与） | `montash import raw/*.mp4 raw/*.wav --json` |
| 2 | AI | プロキシ・サムネイル・波形をバックグラウンド生成 | `montash proxy build --all` |
| 3 | AI | 一覧を取得し、人間向けに要約（尺・解像度・fps・音声） | `montash assets list --json` |
| 4 | 人 | Web でサムネイルを見て、使いたい素材と区間を口頭で伝える | `montash serve --open`（AI が起動） |
| 5 | AI | 特定素材の詳細（ストリーム情報、キーフレーム間隔）を確認 | `montash assets show <id> --json` |

- **完了条件**: `assets list` に全素材が載り、`proxy status` が全件 `ready`。
- **失敗と対処**:
  - 対応外コーデック／破損 → `E_ASSET_UNREADABLE`。該当ファイルをスキップし人間に報告。
  - fps／解像度がプロジェクトと不一致 → 警告 `W_ASSET_MISMATCH`。レンダー時に自動変換される旨を伝える（`--strict` でエラー化）。素材の大半がプロジェクトと異なる fps なら、編集開始前に `montash project set fps <素材の fps>` を提案する（クリップが無い時点なら再スナップの影響が無い）。
  - 同名ファイル → ID に連番を付与（`clip_a`, `clip_a_2`）。
- **派生コマンド**: `import`, `assets list|show|remove`, `proxy build|status`, `serve`

---

## W-03. 粗編集（カットして並べる）

- **目的**: 使う区間だけをクリップとして V1/A1 に順番に並べ、全体の流れを作る。
- **起点**: 「clip_a の 2 秒から 14.5 秒、clip_b の頭から 20 秒、clip_c の最後 10 秒を順に繋げて」
- **事前条件**: W-02 完了。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | クリップを末尾に順次追加（映像＋音声を同時にリンク配置） | `montash clip add --asset clip_a --in 2 --out 14.5 --at end` |
| 2 | AI | 「最後 10 秒」のような相対指定はアセット尺から計算して指定 | `montash clip add --asset clip_c --in -10 --at end`（負値 = 末尾から） |
| 3 | AI | 並び順・合計尺を確認 | `montash timeline show --json` |
| 4 | AI | 人間に「合計 ○秒、3 クリップ」と報告し、Web で確認を促す | — |

- **完了条件**: `timeline show` に意図した順序でクリップが並び、ギャップ・重なりが無い（`validate` が OK）。
- **失敗と対処**:
  - in/out がアセット尺を超える → `E_RANGE_OUT_OF_ASSET`。`hint` にアセット尺が入るので AI が値を丸めて再実行。
  - 指定位置に既存クリップがある → `E_CLIP_OVERLAP`。`--on-overlap error|overwrite|push` で解消方針を指定（既定 `error`）。
- **派生コマンド**: `clip add`, `timeline show`, `validate`

---

## W-04. プレビューで確認して微調整する

M2実装: `tests/workflows/W-04.sh` で、映像セグメントキャッシュ + 音声1パス + mux によるプレビュー生成、`preview status` の `ready` / `stale`、編集後のキャッシュ再利用、`--from/--to` の部分再生成、`--audio-only`、`serve` の自動生成・Range配信・`--no-auto-preview` を検証（`scripts/e2e-preview.ts`。chromium があれば実ブラウザの再生と再生位置保持まで）。手順4〜6のクリップ編集コマンドは別マイルストーンのため、未登録のあいだは skip する。

- **目的**: 人間が Web でプレビューを見て、カット点や順番を細かく直す。作業の中心ループ。
- **起点**: 「2 番目のクリップ、頭をもう 0.5 秒切って。あと 3 番目と 2 番目を入れ替えて」
- **事前条件**: W-03 完了。`montash serve` が起動している。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | プレビュー用の合成プロキシを更新（serve 起動中は自動） | `montash preview build` |
| 2 | 人 | Web で再生・シーク。気になる箇所の時刻／クリップを口頭で伝える（Web はクリップ ID と時刻を表示） | — |
| 3 | AI | 曖昧な指示（「2 番目」）を ID に解決 | `montash clip list --track V1 --json` |
| 4 | AI | 頭を 0.5 秒トリム（後続を詰めるのでリップル） | `montash clip trim c2 --in +0.5 --ripple` |
| 5 | AI | クリップの順序入れ替え | `montash clip move c3 --before c2` |
| 6 | AI | 特定時刻で分割し、不要部分をリップル削除（前半は `c1` のまま。後半の新 ID は結果 JSON の `created.id` から取る） | `montash clip split c1 --at 00:00:08.000 --json` → `created.id` = `c5` → `montash clip delete c5 --ripple` |
| 7 | AI | 結果を確認し、人間に「再生ヘッドを ○秒に」と促す | `montash timeline show --json` |
| 8 | 人/AI | 納得するまで 2〜7 を繰り返す | — |

- **完了条件**: 人間が「OK」と言う。`validate` が OK。
- **失敗と対処**:
  - 「2 番目」が V1 と V2 で曖昧 → AI は `clip list` で候補を提示し人間に確認。
  - トリム量がクリップ尺を超える → `E_TRIM_EXCEEDS_CLIP`。AI はクリップ削除の意図か確認。
  - プレビューが更新されない → `montash preview status` で確認、`preview build --force`。
- **派生コマンド**: `preview build|status`, `clip list|trim|move|split|delete`, `timeline show`

---

## W-05. トランジションを入れる

- **目的**: クリップの繋ぎ目に効果を入れる。冒頭／末尾のフェードも含む。
- **起点**: 「全部の繋ぎ目に 0.5 秒のクロスフェード、最初はフェードイン 1 秒、最後はフェードアウト 2 秒」
- **事前条件**: W-03 完了。隣接クリップに十分な余白（ハンドル）があること。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | 隣接ペアすべてに一括追加 | `montash transition add --track V1 --all-cuts --type crossfade --duration 0.5` |
| 2 | AI | 個別に変更（例: 2→3 だけワイプ） | `montash transition set t2 --type wipeleft --duration 0.8` |
| 3 | AI | 冒頭・末尾のフェード | `montash fade --track V1 --in 1.0 --out 2.0 --with-audio` |
| 4 | AI | 一覧確認 | `montash transition list --json` |

- **完了条件**: `transition list` に意図どおり登録され、`validate` が OK。プレビューで繋ぎが確認できる。
- **失敗と対処**:
  - クロスフェードに必要な余白（アセット側に in より前／out より後の素材）が無い → `E_INSUFFICIENT_HANDLE`。`hint` に最大可能 duration。AI は duration を縮めるか、`--mode overlap`（クリップを重ねて全体尺を縮める）を提案。
- **派生コマンド**: `transition add|set|remove|list`, `fade`

---

## W-06. テロップ・タイトルを入れる

- **目的**: タイトル、字幕風テロップ、ローワーサード等の文字を重ねる。
- **起点**: 「冒頭 3 秒に『Summer Trip 2026』を中央に大きく。12 秒から 15 秒に『福岡到着』を左下に小さく」
- **事前条件**: W-03 完了。使用フォントが環境にある（`doctor` で確認済）。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | 利用可能フォントとプリセットを確認 | `montash fonts list --json` / `montash text presets --json` |
| 2 | AI | タイトル追加（テキストトラックは自動作成 `T1`） | `montash text add --text "Summer Trip 2026" --at 0 --duration 3 --preset title-center --fade-in 0.5 --fade-out 0.5` |
| 3 | AI | ローワーサード追加 | `montash text add --text "福岡到着" --at 12 --duration 3 --preset lower-third --font "Noto Sans CJK JP" --size 48` |
| 4 | AI | 文言や位置の修正 | `montash text set x1 --text "福岡に到着" --position 5%,85%` |
| 5 | AI | プレビューで確認を依頼 | `montash preview build` |

- **完了条件**: `text list` に登録され、プレビューで表示・タイミング・フォントが確認できる。
- **失敗と対処**:
  - フォント未検出 → `E_FONT_NOT_FOUND`。`hint` に類似フォント候補。AI は代替を提案。
  - 日本語が豆腐 → CJK フォントの指定漏れ。`--font` を CJK 対応に変更（libass は `fontsdir` に CJK フォールバックを常に含めるため、通常は起きない）。
  - libass 無しの ffmpeg → `W_TEXT_ENGINE_LIMITED`（drawtext フォールバック。折り返し・背景 padding 不可）。AI は `install-deps.sh` でフル機能ビルドの導入を提案。
  - 表示区間がタイムライン尺を超える → 警告 `W_BEYOND_TIMELINE`。
- **派生コマンド**: `text add|set|remove|list|presets`, `fonts list`

---

## W-07. BGM・音量を整える

- **目的**: BGM を敷き、会話が聞き取れる音量バランスにし、末尾で音を落とす。
- **起点**: 「bgm.mp3 を全体に敷いて、声が入っているところは BGM を下げて。最後は 2 秒でフェードアウト。全体の音量を YouTube 向けに揃えて」
- **事前条件**: W-03 完了。音声アセットがインポート済。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | BGM 用トラック追加 | `montash track add --kind audio --name A2` |
| 2 | AI | BGM をタイムライン全長に配置（足りなければループ） | `montash clip add --asset bgm --track A2 --at 0 --duration timeline --loop` |
| 3 | AI | BGM 音量を下げる | `montash audio gain --clip c_bgm --db -12` |
| 4 | AI | 会話トラックを基準にダッキング | `montash audio duck --target A2 --sidechain A1 --threshold -30dB --ratio 8 --release 500` |
| 5 | AI | 末尾フェードアウト | `montash audio fade --clip c_bgm --out 2.0` |
| 6 | AI | ラウドネス正規化をレンダー設定に | `montash audio normalize --loudness -14 --true-peak -1` |
| 7 | AI | 音声だけのプレビューを促す | `montash preview build --audio-only` |

- **完了条件**: `audio show` で各トラックのゲイン／フェード／ダッキング設定が確認でき、プレビューで聞ける。
- **失敗と対処**:
  - BGM が短い＆`--loop` 無し → 警告 `W_CLIP_SHORTER_THAN_REQUESTED`。AI は `--loop` を提案。
  - ダッキングでサイドチェインが無音トラック → 効果が出ない。`audio analyze A1` でレベル確認を促す。
- **派生コマンド**: `track add|list|remove|mute`, `audio gain|fade|duck|normalize|analyze|show`

---

## W-08. ロゴ・PiP・画像を重ねる

- **目的**: 画像や別動画を小窓・ロゴとして重ねる。
- **起点**: 「右上にロゴを全編、10 秒から 20 秒は右下に clip_d を 30% サイズで」
- **事前条件**: 画像／動画アセットがインポート済。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | オーバーレイ用映像トラック追加 | `montash track add --kind video --name V2` |
| 2 | AI | ロゴを全編配置 | `montash overlay add --asset logo --track V2 --at 0 --duration timeline --position top-right --margin 24 --scale 0.12 --opacity 0.9` |
| 3 | AI | PiP を区間配置 | `montash overlay add --asset clip_d --track V3 --at 10 --duration 10 --position bottom-right --scale 0.3` |
| 4 | AI | 確認 | `montash preview build` |

- **完了条件**: プレビューでロゴ・PiP が意図した位置・サイズ・区間で表示される。
- **失敗と対処**:
  - PNG のアルファが反映されない → アセットの `pix_fmt` を確認、`--keep-alpha` を指定。
  - トラック順（上に重なるほうが後）を間違えた → `track move V2 --above V3`。
- **派生コマンド**: `overlay add|set|remove|list`, `track move`

---

## W-09. 書き出す

M1実装: 全区間のカット結合と画像・空白区間・音声ミックスを、2プリセット（`youtube-1080p` / `web-preview`）でMP4に出力。`tests/workflows/W-09.sh` と実機テストが30／29.97／59.94fpsを検証する。トランジション・テキスト・部分書き出し・音量正規化は後続実装。

- **目的**: タイムラインを完成品として書き出す。
- **起点**: 「YouTube 用に書き出して。ファイル名は out/summer_trip.mp4」
- **事前条件**: `validate` が OK。人間が内容に OK を出している。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | 整合性チェック | `montash validate --json` |
| 2 | AI | 実行内容（ffmpeg コマンド）の事前確認 | `montash render --preset youtube-1080p -o out/summer_trip.mp4 --dry-run` |
| 3 | AI | レンダー実行（進捗を JSON Lines で受け取り、人間に % を報告） | `montash render --preset youtube-1080p -o out/summer_trip.mp4 --progress jsonl` |
| 4 | AI | 出力ファイルの検証（尺・解像度・ビットレート） | `montash render verify out/summer_trip.mp4 --json` |
| 5 | AI | 人間に結果（パス、サイズ、尺）を報告 | — |

- **完了条件**: 出力ファイルが存在し、`render verify` の尺がタイムライン尺と一致（±1 フレーム）。
- **失敗と対処**:
  - 出力先が既存 → `E_OUTPUT_EXISTS`。人間に確認して `--overwrite`。
  - ffmpeg 失敗 → `E_FFMPEG_FAILED`。stderr 末尾を `detail` に含める。AI はフィルタの不正（フォント、ハンドル不足）を疑い `validate --deep` を実行。
  - 遅い → `--hwaccel auto` または `--preset` を `fast` 系に変更提案。
- **派生コマンド**: `validate`, `render`, `render verify`, `render presets`

---

## W-10. やり直す・戻す

- **目的**: 直前の操作や、ある時点の状態に戻る（履歴モデルは 11 章）。
- **起点**: 「さっきのトリム、やっぱり無しで」「テロップ入れる前に戻して」
- **事前条件**: 履歴は常時有効。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | 現在位置と未コミット op を確認 | `montash status --json` |
| 2 | AI | 履歴を確認（コミット単位。`--ops` で操作単位） | `montash log --ops --json` |
| 3 | AI | 直前の操作を取り消す（op 単位） | `montash undo` / `montash undo 3` |
| 4 | AI | 「テロップ入れる前」= 該当コミットの親へ移動 | `montash log --grep テロップ --json` → `montash checkout k_0006~1` |
| 5 | AI | 取り消しをやり直す（進む） | `montash redo` / `montash checkout tip` |
| 6 | AI | 節目に名前を付ける | `montash tag "テロップ前"` / `montash checkout "テロップ前"` |
| 7 | AI | 特定コミットだけ取り消して他は残す | `montash revert k_0006 -m "タイトル追加を取り消し"`（未実装。M4。04 章 §1.9） |

- **完了条件**: `timeline show` が意図した過去の状態と一致する。`status` が HEAD 位置を示す。
- **失敗と対処**:
  - 過去に戻った後に新操作 → 先にあった変更列は失われず別系列として残る（`log --all`）。人間に「戻る前の状態にも戻れる」と伝える。
  - `redo` で子が複数 → `W_MULTIPLE_CHILDREN` と候補。AI は候補の `summary` を人間に提示して選ばせる。
  - タグ名重複 → `E_TAG_EXISTS`。
- **派生コマンド**: `status`, `log`, `undo`, `redo`, `checkout`, `tag`, `revert`

---

## W-11. 既存プロジェクトを一部修正して再書き出し

- **目的**: 完成済みプロジェクトのテロップ文言や BGM 音量だけを直して再出力。
- **起点**: 「先週作った summer_trip、タイトルのスペルミス直して再書き出しして」
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | プロジェクトを開いて状態を把握 | `cd summer_trip && montash project show --json && montash validate --json` |
| 2 | AI | 対象テキストを検索して修正 | `montash text list --json` → `montash text set x1 --text "Summer Trip 2026"` |
| 3 | AI | 前回のレンダー設定を再利用 | `montash render --last -o out/summer_trip_v2.mp4` |

- **完了条件**: 新ファイルが出力され、差分が意図箇所のみ（`montash diff --snapshot last-render` で確認）。
- **派生コマンド**: `render --last`, `diff`

---

## W-12. 複数フォーマットで一括書き出し

- **目的**: 同じタイムラインを横 16:9・縦 9:16・軽量版に書き出す。
- **起点**: 「YouTube 用と Instagram リール用と、確認用の軽いやつを出して」
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | プリセット確認 | `montash render presets --json` |
| 2 | AI | 縦動画のクロップ方針を決めて確認 | `montash render --preset instagram-reel --reframe center --dry-run` |
| 3 | AI | 一括実行 | `montash render batch --preset youtube-1080p --preset instagram-reel:--reframe=center --preset web-preview -o out/` |

- **完了条件**: `out/` にプリセット名付きの 3 ファイル。
- **派生コマンド**: `render batch`, `render --reframe`

---

## W-13. 素材の場所が変わったので再リンクする

- **目的**: 素材フォルダを移動した後にプロジェクトを復旧する。
- **起点**: 「raw を外付けに移したら開けなくなった」
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | 欠落アセットを列挙 | `montash validate --json`（`E_ASSET_MISSING` 一覧） |
| 2 | AI | ディレクトリ単位で再リンク（ファイル名＋サイズ／ハッシュで照合） | `montash assets relink --search /Volumes/ext/raw` |
| 3 | AI | 個別に再指定 | `montash assets relink clip_a --path /Volumes/ext/raw/clip_a.mp4` |

- **派生コマンド**: `assets relink`

---

## W-14. 字幕ファイルを付ける

- **目的**: 外部ツールで作った SRT を焼き込み、またはソフト字幕として付ける。
- **起点**: 「この SRT を焼き込んで。日本語フォントで下に」
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | SRT をインポート | `montash import subs/ja.srt` |
| 2 | AI | 焼き込み設定 | `montash subtitle add --asset ja_srt --mode burn --font "Noto Sans CJK JP" --size 40 --margin-bottom 60` |
| 3 | AI | またはソフト字幕（MP4/MKV に多重化） | `montash subtitle add --asset ja_srt --mode soft --lang ja` |

- **派生コマンド**: `subtitle add|set|remove|list`

---

## W-15. 作業をコミットとして記録する（git ライク）

- **目的**: 試行錯誤の op 列を「00:12〜00:15 をカット」のような人間が読める作業単位（コミット）としてまとめ、後から追跡・復元できるようにする。
- **起点**: 人間が「OK、それで」と言った時。あるいは AI が一連の指示を完了した時（明示の指示なしに AI が自律的に行う）。
- **事前条件**: 未コミットの op がある（`status` の `pending > 0`）。
- **手順**:

| # | 誰 | 何をする | コマンド |
|---|----|----------|----------|
| 1 | AI | 未コミット op と差分要約を確認 | `montash status --json` / `montash diff --json` |
| 2 | AI | 人間の指示を引用しつつ、規約（11 章 §5）に沿ったメッセージでコミット | `montash commit -m "00:12.0〜00:15.0 の言い間違いをカット" --body "指示: 「12秒あたりの噛んだところ消して」\n影響: c2 を f:360 で分割（後半 c7）→ c7 削除(ripple)、全長 f:1335→f:1245"` |
| 3 | AI | 単発の明確な操作は、そのコマンドに `-m` を付けて即コミット | `montash clip delete c7 --ripple -m "00:12.0〜00:15.0 の言い間違いをカット"` |
| 4 | AI | 節目（粗編集完了、テロップ完了、書き出し直前）にタグ | `montash tag rough-cut -m "粗編集完了"` |
| 5 | AI | 人間に「コミット k_0007 として記録した」と ID とメッセージを報告。Web の History にノードが現れる | `montash log --limit 3` |

- **完了条件**: `status` の pending が 0。`log` に新コミットがあり、Web の History タイムラインに表示される。
- **失敗と対処**:
  - pending が無い → `E_NOTHING_TO_COMMIT`。報告のみ。
  - 一部の op だけコミットしたい → `--last <n>`（末尾側の連続 op のみ）。途中の op だけは選べない旨を説明。
  - メッセージが規約外（範囲が無い等）→ 警告 `W_COMMIT_MESSAGE_STYLE`（エラーにはしない）。`--auto-message` で叩き台を得てから直す。
- **派生コマンド**: `status`, `commit`, `-m`（全状態変更コマンド）, `tag`, `log`, `show`, `diff`, `blame`

---

## W-16. Web の History タイムラインで戻る・進む

- **目的**: 人間がブラウザ上で作業履歴を俯瞰し、コミットや op をクリックして即時にその時点の状態を確認・採用する（トレーサビリティ）。
- **起点**: 「さっきのバージョンの方が良かった気がする、見せて」「テロップ入れる前と後を見比べたい」
- **事前条件**: `montash serve` 起動中（`--read-only` でない）。履歴にコミットがある。
- **手順**:

| # | 誰 | 何をする | コマンド／操作 |
|---|----|----------|----------------|
| 1 | 人 | 下部の History タイムラインでコミット k_0006「粗編集 3 クリップ」を hover → 影響範囲が編集タイムラインに出る | Web |
| 2 | 人 | ノードをクリック → 即時にその状態へ | Web → `POST /api/cli ["checkout","k_0006"]` → `montash checkout k_0006`（actor: web） |
| 3 | Web | 編集タイムライン・Inspector が即時更新。プレビューは `stale` → 数秒で `ready`。ヘッダーに「過去の状態を表示中」 | 自動 |
| 4 | 人 | 再生して確認。`[` `]` キーで前後の op を行き来 | Web → `undo` / `redo` |
| 5a | 人 | 「これで行く」→ この状態を採用。AI に伝える | — |
| 6a | AI | 過去状態を採用したことを記録し、以降の編集を続行（先にあった系列は `log --all` に残る） | `montash status` → `montash tag adopted-k6` → 編集続行 → `montash commit -m "..."` |
| 5b | 人 | 「やっぱり最新に戻す」 | Web「最新へ」→ `montash checkout tip` |
| 7 | AI | AI 側でも `status` で HEAD の位置を確認して人間の判断に合わせる（Web 操作は履歴に `actor: web` で残るので AI が把握できる） | `montash status --json` / `montash log --ops --limit 5` |

- **完了条件**: 人間が意図した時点の状態が `project.json` に展開され、プレビューで確認できる。Web の操作が `moves.jsonl` に記録されている。
- **失敗と対処**:
  - `serve --read-only` で起動している → ボタン無効。AI に「`montash checkout k_0006` して」と口頭で頼む。
  - 未コミット op がある状態で戻る → 警告帯「未コミットの変更 n 件があります（失われません）」。戻った後に `checkout tip` で復帰可能。
  - プレビューが古い状態のまま → `stale` バッジと再生成進捗。キャッシュが無い時点なら数十秒かかる旨を表示。
  - AI が人間の Web 操作を知らずに編集を続けようとする → AI は編集前に必ず `status` を確認する（10 章 §3）。
- **派生コマンド**: `checkout`, `undo`, `redo`, `tag`, `serve`（`POST /api/cli` 許可リスト）

---

## W-17. Web で素材を管理する

- **目的**: 動画・音声・画像・テキスト・字幕の素材を、ブラウザの Assets タブから取り込み・整理・確認する。
- **起点**: 「追加で撮った動画を入れたい」「使ってない素材を消して」「テロップの定型文を素材として登録しておきたい」「この素材、どこで使ってる？」
- **事前条件**: `montash serve` 起動中（`--read-only` でない）。
- **手順**:

| # | 誰 | 何をする | コマンド／操作 |
|---|----|----------|----------------|
| 1 | 人 | Assets タブを開き、種別フィルタ・検索で素材を探す。サムネイル／波形／単体プレビューで中身を確認 | Web（`GET /api/assets`） |
| 2 | 人 | 「+ 取り込み」でパスを入力、またはファイルをドロップ | Web → `montash import <path> --proxy --thumbs --waveform`（ドロップ時は `POST /api/upload` → `assets/incoming/` へ保存 → import） |
| 3 | 人 | 「+ テキスト素材」で ID `title_main`、本文「Summer Trip 2026」を登録 | Web → `montash assets new-text title_main --text "Summer Trip 2026"` |
| 4 | 人 | ラベル・タグを付けて整理 | Web → `montash assets set clip_a --label "冒頭ドローン" --tags 空撮,冒頭` |
| 5 | 人 | 素材の「使用箇所」を見る（c1 (V1) など）。未使用素材を削除 | Web → `montash assets remove clip_x`（使用中なら確認 → `--force`） |
| 6 | 人 | 欠落素材（⚠）を再リンク | Web → `montash assets relink clip_c --path /Volumes/ext/raw/clip_c.mp4` |
| 7 | 人 | 素材をタイムラインに置きたい → 「タイムラインへ追加」で CLI 例をコピーし AI に伝える（Web はタイムライン編集を実行しない） | Inspector の例 `clip add --asset clip_d --at 18.233` |
| 8 | AI | Web で取り込まれた素材を `assets list` で把握し、指示に従ってタイムラインに配置。テキスト素材を参照してテロップ追加 | `montash assets list --json` / `montash text add --asset title_main --at 0 --duration 3 --preset title-center` |

- **完了条件**: 素材が `assets list` に現れ、プロキシが `ready`。Web の操作が op（`actor: web`）として `log --ops` に残る。
- **失敗と対処**:
  - アップロードが大きい → 進捗表示。8GB 超は `E_UPLOAD_TOO_LARGE`、パス指定取り込みを案内。
  - 対応外形式 → `E_ASSET_UNREADABLE` をトースト表示。
  - 使用中素材の削除 → 確認ダイアログで参照クリップ一覧を表示し、`--force` で参照クリップも削除されることを明示。
- **派生コマンド**: `import`, `assets set|set-text|new-text|remove|relink|show`, `proxy build`, `text add --asset`, `serve`（`POST /api/upload`）

---

## W-18. クリップに効果を掛ける

- **目的**: 既に並べたクリップに、ぼかし・色補正・LUT などの効果を掛け、プレビューで確かめながらパラメータを詰める。
- **起点**: 「顔が映ってるところをぼかして」「全体をもう少し明るく、彩度も上げて」「このクリップだけフィルム風の色にして」
- **事前条件**: クリップが 1 本以上ある（W-03 済み）。`montash doctor` が必要な ffmpeg フィルタを満たしている。
- **手順**:

| # | 誰 | 何をする | コマンド／操作 |
|---|----|----------|----------------|
| 1 | AI | 使える効果と、その引数を調べる | `montash effect presets --json`（`schema` にも載る） |
| 2 | AI | 効果を掛ける。引数は効果ごとの定義から決まる | `montash effect add c1 blur --sigma 12` |
| 3 | AI | 実際に流れる ffmpeg のフィルタを見せて確認する | `montash effect add c1 blur --sigma 12 --dry-run` |
| 4 | 人 | プレビューで見て「もう少し弱く」と伝える | Web でプレビュー確認 |
| 5 | AI | パラメータだけ調整する（掛け直さない） | `montash effect set c1 blur --sigma 6` |
| 6 | AI | 掛かっている効果と順序を確認する | `montash effect list c1 --json` |
| 7 | AI | 効果の適用順を入れ替える／外す | `montash effect set c1 blur --index 0` / `montash effect remove c1 blur` |
| 8 | AI | 良ければ作業単位としてコミットする | `montash commit -m "c1 の顔まわりをぼかし、彩度を少し上げた"` |

- **完了条件**: `effect list` に効果が順序どおり並び、`render --dry-run` のフィルタグラフに反映され、プレビューで見た目が変わる。op として履歴に残る。
- **失敗と対処**:
  - 効果名が登録されていない → `E_PLUGIN_MISSING`。`hint` に「導入済みの効果一覧」と、プラグインを入れる案内を出す。**AI は自分でプラグインを導入しない**（人間に依頼する。10 章）。
  - 引数が範囲外 → `E_USAGE`（`sigma must be <= 64` のように、どの引数がどう外れたかを出す）。
  - 必要な ffmpeg フィルタが無いビルド → `montash doctor` で不足として報告される。
  - キーフレームを求められた → `E_NOT_IMPLEMENTED`（F-FX-8、M6 以降）。
- **派生コマンド**: `effect add|set|remove|list|presets`, `render --dry-run`, `doctor`

---

## W-19. プラグインを導入して使う

- **目的**: 本体に無い効果や入出力を、プラグインとして入れて使う。プラグインが無い環境でプロジェクトを開いたときの挙動も確かめる。
- **起点**: 「グロー効果を使いたい」「このプロジェクト、同僚の環境でも開ける？」
- **事前条件**: なし（プラグインの入手は人間が行う）。
- **手順**:

| # | 誰 | 何をする | コマンド／操作 |
|---|----|----------|----------------|
| 1 | 人 | プラグインを入手し、導入する（**AI は導入しない**。任意コードを実行するため） | `montash plugin install ./montash-glow` |
| 2 | AI | 何が入ったか、何を要求しているかを確認する | `montash plugin list --json` / `montash doctor` |
| 3 | AI | 追加された効果を、組み込みと同じように使う | `montash effect add c1 glow --radius 8` |
| 4 | AI | プロジェクトが依存するプラグインを記録する | 自動（`project.plugins.requires[]` に記録される） |
| 5 | 人 | プラグインの無い環境でプロジェクトを開く | `montash timeline show`（**開ける**。未知の効果は保持される） |
| 6 | AI | その環境でレンダーを試み、何が足りないかを報告する | `montash render` → `E_PLUGIN_MISSING`、`montash plugin doctor` で不足一覧 |

- **完了条件**: プラグイン有りの環境で効果が掛かり、無い環境でも `project.json` が開けて保存でき、レンダー時にだけ明確に失敗する。
- **失敗と対処**:
  - `apiVersion` が合わない → `E_PLUGIN_INCOMPATIBLE`。受理できるバージョン範囲を `hint` に出す。
  - プラグインが解析や外部プロセスを要求する → マニフェストの `capabilities` を導入時に人間へ提示し、同意なしには入れない。
  - 同名の効果が衝突 → 後勝ち（`source` で出自が分かる）。`plugin list` で警告する。
- **派生コマンド**: `plugin list|install|remove|doctor`, `effect add`, `doctor`, `render`

---

## 手順から導出されたコマンド一覧（04 章の目次）

| グループ | コマンド | 由来手順 |
|----------|----------|----------|
| 環境 | `doctor`, `schema`, `help --json` | W-01, 全般 |
| プロジェクト | `init`, `project show`, `validate`, `diff` | W-01, W-09, W-11 |
| アセット | `import`, `assets list|show|remove|relink|set|new-text|set-text`, `proxy build|status`, `fonts list` | W-02, W-06, W-13, W-17 |
| トラック | `track add|list|remove|mute|move` | W-07, W-08 |
| クリップ | `clip add|list|show|move|trim|split|delete` | W-03, W-04 |
| タイムライン | `timeline show` | W-03, W-04 |
| トランジション | `transition add|set|remove|list`, `fade` | W-05 |
| テキスト | `text add|set|remove|list|presets` | W-06 |
| オーバーレイ | `overlay add|set|remove|list` | W-08 |
| 音声 | `audio gain|fade|duck|normalize|analyze|show` | W-07 |
| 字幕 | `subtitle add|set|remove|list` | W-14 |
| プレビュー | `serve`, `preview build|status` | W-02, W-04 |
| 出力 | `render`, `render verify|presets|batch` | W-09, W-11, W-12 |
| 履歴 | `status`, `log`, `show`, `diff`, `blame`, `commit`, `-m`, `checkout`, `undo`, `redo`, `revert`, `reset`, `tag`, `history prune|verify|export|import` | W-10, W-11, W-15, W-16 |
| エフェクト | `effect add|set|remove|list|presets` | W-18 |
| プラグイン | `plugin list|install|remove|doctor` | W-19 |
| AI 支援 | `batch`, `explain` | 全般（10 章） |
