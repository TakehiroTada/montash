# 11. 履歴モデル（git ライクなコミットとトレーサビリティ）

CLI の実行ログを **操作（op）** として自動記録し、AI がそれらを **コミット** としてメッセージ付きでまとめ、任意の時点へ **checkout** で即時に移動できる履歴モデルを定義します。Web プレビューはこの履歴をタイムラインとして可視化し、クリックで移動できます。

## 1. 目的

| 目的 | 実現手段 |
|------|----------|
| トレーサビリティ: いつ・誰（人/AI/Web）が・どのコマンドで・何を変えたかを追える | すべての状態変更を op として不可逆に記録（`actor`, `command`, `before/after`） |
| 作業単位の意味付け: 「0:12〜0:15 をカット」のように人間が読める粒度で残す | AI が `montash commit -m` でまとめる（git のコミット） |
| 即時に戻る／進む: 試行錯誤を恐れずに編集できる | `checkout` は保存済みスナップショットを `project.json` に書き戻すだけ（ミリ秒）。プレビューはセグメントキャッシュで差分再生成 |
| 分岐を失わない | 履歴は DAG。過去に戻ってから新しい変更をしても、先にあった変更列は破棄されず `log --all` / Web で辿れる |

## 2. 用語と git との対応

| montash | git の対応 | 説明 |
|-------|-----------|------|
| **op**（操作） | working tree の 1 変更（自動記録） | 状態を変える CLI コマンド 1 回 = op 1 つ。`o_0001` |
| **commit** | commit | 連続する op の集合にメッセージ・作者を付けたもの。`k_0001`（`k` = kommit、`c_` はクリップと衝突するため） |
| **pending ops** | unstaged/uncommitted changes | 最後のコミット以降の op 列。`montash status` で見える |
| **HEAD** | HEAD | 現在 `project.json` に展開されている op |
| **tip** | ブランチ先端 | ある系列の最新 op。HEAD が tip でない状態を **detached** と呼ぶ |
| **tag** | tag | op またはコミットに付ける名前（旧「スナップショット」を置き換え） |
| **object** | blob | `project.json` の内容ハッシュで保存された不変スナップショット |
| **checkout** | checkout | HEAD を移動し、その object を `project.json` に展開 |
| **revert** | revert | 指定コミットの差分の逆を新しい op として適用 |
| branch | branch | v1 では名前付きブランチ命令は持たない（DAG の分岐は自動保存され `log --all` で参照可）。Could |

## 3. データモデル

### 3.1 保存場所

```
.montash/history/
├── HEAD                      # 現在の op id（例: o_0042）
├── ops.jsonl                 # op の追記専用ログ（1 行 1 op。削除・改変しない）
├── commits.jsonl             # commit の追記専用ログ
├── tags.json                 # { "<name>": { "target": "o_0042"|"k_0007", "at": ..., "message": ... } }
└── objects/
    └── <sha1>.json[.gz]      # project.json の不変スナップショット（内容アドレス。重複しない）
```

- `ops.jsonl` / `commits.jsonl` は **追記のみ**（append-only）。`montash history prune` 以外で行が消えることはない。
- `objects/` は内容ハッシュで重複排除。undo→redo を繰り返してもファイルは増えない。
- 旧 `.montash/history/index.json` + `h_xxxx.json` 方式は本モデルに置き換える（05 章 §10 を更新）。

### 3.2 op

```jsonc
{
  "id": "o_0042",
  "parent": "o_0041",                    // 直前の HEAD（DAG の辺）。初期化時は null
  "at": "2026-09-14T02:00:00.123Z",
  "actor": "ai",                         // ai | human | web | system
  "actor_detail": "claude-session-xxx",  // 任意。MONTASH_ACTOR / MONTASH_ACTOR_DETAIL 環境変数から
  "command": ["clip", "trim", "c2", "--in", "+0.5", "--ripple"],   // 実行した引数（配列、シェル非依存）
  "summary": "c2 の頭を 0.5s トリム（リップル）",                     // CLI が自動生成する 1 行要約
  "before": "sha1:aaaa...",              // objects/ のハッシュ
  "after":  "sha1:bbbb...",
  "changes": [ { "op": "replace", "path": "/tracks/0/clips/1/in", "from": 0.0, "value": 0.5 } ],  // JSON Patch 風差分（要約用。真の差分は before/after から算出）
  "affects": { "clips": ["c2", "c2a", "c3", "c3a"], "range_f": [375, 1335] },   // Web でハイライトするための影響範囲（フレーム）
  "commit": "k_0007",                    // 所属コミット。pending なら null
  "duration_ms": 41
}
```

- `checkout` / `undo` / `redo` 自体は **op を作らない**（HEAD の移動であり、状態を新しく作らないため）。ただし `ops.jsonl` とは別に `.montash/history/moves.jsonl` に移動ログを追記し、監査可能にする。
- `batch --atomic` は 1 op（`command` に `["batch", ...]`、`changes` に全差分）。
- `--dry-run`、読み取り系コマンドは op を作らない。

### 3.3 commit

```jsonc
{
  "id": "k_0007",
  "parent": "k_0006",                    // 直前のコミット（op DAG 上で祖先にあるもの）
  "at": "2026-09-14T02:05:00Z",
  "author": "ai",
  "author_detail": "claude-session-xxx",
  "message": "00:12.0〜00:15.0 の言い間違いをカットし、後続を詰める",
  "body": "人間の指示: 「12秒あたりの噛んだところ消して」\n影響: c2 を f:360 で分割、後半 c7 (f:360–450) を削除（リップル）。全長 f:1335→f:1245（44.5→41.5s）",
  "ops": ["o_0040", "o_0041", "o_0042"], // 含まれる op（時系列順）。先頭 op の parent が親コミットの最終 op
  "head": "o_0042",                      // このコミットの最終状態
  "tags": ["before-bgm"],
  "stats": { "ops": 3, "duration_delta": -3.0, "clips_added": 1, "clips_removed": 1, "clips_modified": 2 }
}
```

### 3.4 HEAD の移動と DAG

```
k_0005          k_0006                     k_0007 (tip)
  │               │                          │
o_30 ─ o_31 ─ o_32 ─ o_33 ─ o_34 ─ o_35 ─ o_36
                      │
                      └─ o_37 ─ o_38 (別系列 tip)   ← o_33 を checkout 後に新しい変更をした結果
```

- HEAD が `o_33`（detached）で新しい op を作ると、`parent = o_33` の `o_37` が生まれ、`o_34..o_36` は **そのまま残る**。
- `redo` は HEAD の子のうち **最後に HEAD だった系列** を優先（`moves.jsonl` から判断）。子が複数あれば警告 `W_MULTIPLE_CHILDREN` と候補を返す。
- `log` は既定で HEAD から根までの系列を表示。`--all` で全系列を表示（Web は常に全系列を薄く描く）。

## 4. CLI コマンド（04 章 §15 を置き換え）

### 4.1 記録・確認

| コマンド | 説明 |
|----------|------|
| `montash status [--json]` | HEAD、tip か detached か、pending ops 一覧と要約、直近コミット、タグ |
| `montash log [--ops] [--all] [--limit 20] [--since <id\|time>] [--grep <str>] [--json] [--graph]` | コミット一覧（既定）。`--ops` で op も展開。`--graph` は ASCII の DAG |
| `montash show <op\|commit\|tag> [--json] [--patch]` | 詳細。`--patch` で before/after の差分（JSON Patch + 人間向け要約） |
| `montash diff [<a>] [<b>] [--json]` | 2 時点の差分。省略時 `a = 最終コミット`, `b = HEAD`（= pending の差分）。`montash diff k_0005 k_0007` |
| `montash blame <clip-id> [--json]` | あるクリップ／要素を最後に変更した op・commit・actor を返す |

### 4.2 コミット

```
montash commit -m <message> [--body <text>|--body-file <path>] [--ops <id..id>|--last <n>] [--author <name>] [--tag <name>] [--allow-empty] [--auto-message]
```

- 既定で **pending ops 全部** を 1 コミットにする。`--last 2` / `--ops o_0040..o_0042` で一部だけ（残りは pending のまま。ただし連続した末尾側のみ選べる）。
- `--auto-message`: op の `summary` と `affects.range` から規則ベースでメッセージを生成（LLM は使わない）。例: `「c2 トリム(+0.5s, ripple), c3 を c2 の前へ移動 — 12.0–44.5s に影響」`。AI は原則自分でメッセージを書く（10 章）。
- pending が無ければ `E_NOTHING_TO_COMMIT`（`--allow-empty` で空コミット、マイルストーン用）。
- HEAD が detached（tip でない）でも pending があればコミットできる（その系列の tip になる）。

**任意コマンドへの `-m`**: 状態変更コマンドはすべて `-m <message>` を受け付け、その op だけを即座にコミットする。

```
montash clip delete c7 --ripple -m "00:12.0〜00:15.0 の言い間違いをカット"
```

`montash commit --amend -m <msg>` で直近コミットのメッセージ・body を変更（op 集合は変えない。commits.jsonl には修正版を追記し、旧行は `superseded_by` で参照）。

### 4.3 移動

| コマンド | 説明 |
|----------|------|
| `montash checkout <op\|commit\|tag\|HEAD~n\|k_0007~1>` | HEAD を移動し `project.json` を展開。pending があっても失われない（op は保存済み）が、警告 `W_LEAVING_PENDING` を出す |
| `montash undo [<n>]` | `checkout HEAD~n`（op 単位） |
| `montash redo [<n>]` | HEAD の子へ進む（§3.4 の規則） |
| `montash checkout tip` | 現在系列の tip へ |
| `montash revert <commit\|op> [-m <msg>]` | 逆差分を新しい op として適用（＋即コミット）。適用できない（対象が既に無い）場合 `E_REVERT_CONFLICT` と対象一覧 |
| `montash reset --hard <commit>` | `checkout` と同じだが、その先の op を **参照上** 無視する（`log` の既定表示から消す。`--all` では見える。物理削除はしない） |

`checkout` は HEAD を書き換えて object を展開するだけなので **ミリ秒で完了** する。プレビューは `serve` の watcher が検知して差分再生成（キャッシュヒットなら数百 ms〜数秒）。

### 4.4 タグ（旧スナップショット）

| コマンド | 説明 |
|----------|------|
| `montash tag <name> [<target>] [-m <msg>]` | HEAD（または指定 op/commit）に名前を付ける |
| `montash tag list [--json]` / `montash tag delete <name>` | |
| `montash checkout <tag>` | 復元 |

旧 `snapshot save|restore|list|delete` は `tag` / `checkout` の別名として残す（互換のため。ドキュメント上は `tag` を正とする）。

### 4.5 保守

| コマンド | 説明 |
|----------|------|
| `montash history prune [--keep-commits 100] [--keep-days 30] [--dry-run]` | コミットに属さない古い op と、どこからも参照されない object を削除 |
| `montash history export -o <file.jsonl>` / `import` | 履歴の持ち出し・監査 |
| `montash history verify` | object ハッシュと DAG の整合性検証 |

### 4.6 環境変数

| 変数 | 意味 |
|------|------|
| `MONTASH_ACTOR` | `ai` / `human` / `web` / `system`。既定は TTY なら `human`、非 TTY なら `ai` |
| `MONTASH_ACTOR_DETAIL` | セッション ID やモデル名など任意文字列 |
| `MONTASH_AUTHOR` | commit の `author`（省略時 `MONTASH_ACTOR`） |

## 5. コミットメッセージ規約

AI が書くメッセージは **人間がプレビューの History タイムラインで一目で分かる** ことを目的とする。

```
<タイムライン上の範囲> <何をしたか>[（理由）]

例:
00:12.0〜00:15.0 の言い間違いをカット
00:00.0〜00:03.0 にタイトル「Summer Trip 2026」を追加
全カット点に 0.5s クロスフェードを追加
A2 に BGM を配置し、会話区間で −12dB ダッキング
c3 を c2 の前へ移動（人間の指示: 順番入れ替え）
```

- 1 行目は 50 文字前後。範囲は `MM:SS.s〜MM:SS.s`（1 時間超は `H:MM:SS.s`）。
- `body` に人間の元の指示（引用）と影響（クリップ ID、全長の変化）を書くと、後から「なぜ」が追える。
- 試行錯誤中は細かく op を積み、人間が OK と言った時点で 1 コミットにまとめるのが基本（10 章 §9）。

## 6. Web との連携（06 章 §2.7 / §3）

- Web は `GET /api/history?all=1` で op / commit / tag / HEAD / moves を取得し、**History タイムライン** として描く。
- ノードクリック → `POST /api/cli { "args": ["checkout", "k_0006"] }`（サーバが `montash checkout` を実行。`actor: web`）。
- `project.changed` → 編集タイムライン表示は即時更新、プレビューは `stale` → 再生成 → `ready`。
- History 上での「進む」= 子ノードをクリック、または `]` キー（`redo`）。「戻る」= 親ノード、`[` キー（`undo`）。
- ノード hover で `changes` 要約と `affects.range` を編集タイムライン上にハイライト。
- Web からコミットは作れない（メッセージを書くのは AI/人間の CLI 操作）。ただし pending ops の存在は表示し、「`montash commit -m "..."` してください」というコマンド例を出す。

## 7. 不変条件

1. `ops.jsonl` の各 op について `objects/<before>` と `objects/<after>` が存在する。
2. `op.parent` が指す op の `after` == 自身の `before`（DAG の連続性）。
3. `HEAD` は存在する op を指し、`project.json` の内容ハッシュは `HEAD.after` と一致する（一致しなければ「手編集された」として `W_DIRTY_WORKTREE`。`montash status` が検出し、`montash commit --from-worktree -m` で op 化できる）。
4. コミットの `ops` は時系列に連続し、先頭 op の `parent` は親コミットの `head`（または親コミットが無ければ根）。
5. `history verify` が以上を検証する。

## 8. 手順との対応

| 手順 | コマンド |
|------|----------|
| W-10 やり直す・戻す（改訂） | `undo`, `redo`, `checkout`, `log`, `status` |
| W-15 作業をコミットとして記録する | `commit`, `-m`, `log`, `show`, `diff`, `tag` |
| W-16 Web の History タイムラインで戻る・進む | Web + `checkout`（`POST /api/cli` 経由） |
| W-11 既存プロジェクトの一部修正 | `log --grep`, `blame`, `revert` |
