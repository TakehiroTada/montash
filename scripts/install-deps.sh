#!/usr/bin/env bash
# =============================================================================
# install-deps.sh — montash の npm 管理外依存（ffmpeg / ffprobe / Bun / フォント / WSL ツール）を
#                   Windows WSL2 / Linux / macOS の bash でインストール・確認するスクリプト
#
# 使い方:
#   bash scripts/install-deps.sh            # 不足分を確認し、確認プロンプト後にインストール
#   bash scripts/install-deps.sh --check    # 確認のみ（何もインストールしない。終了コード 0=充足 / 1=不足）
#   bash scripts/install-deps.sh --yes      # プロンプトなしでインストール
#   bash scripts/install-deps.sh --with-fonts   # 日本語フォント（Noto Sans CJK）も入れる
#   bash scripts/install-deps.sh --static   # Linux/WSL: ディストリの ffmpeg ではなく static ビルドを ~/.local に入れる
#   bash scripts/install-deps.sh --dry-run  # 実行予定のコマンドを表示するだけ
#   bash scripts/install-deps.sh --json     # 結果を JSON で出力（AI / montash doctor 連携用）
#
# 方針:
#   - macOS 標準の bash 3.2 でも動くように書く（連想配列・mapfile・${var,,} は使わない）。
#   - ffmpeg は「バージョン」ではなく「必要な機能（encoder/filter）が有るか」で判定する（docs/12 ADR-15）。
#       必須: libx264, aac, xfade, concat/overlay/fps/trim, loudnorm, sidechaincompress
#       推奨: subtitles(libass)  … 無いとテロップが drawtext フォールバック（機能制限）
#       最低 4.4、推奨 6.0 以上。
#   - Linux/WSL でディストリの ffmpeg が古い／機能不足なら、static ビルド（BtbN、代替 johnvansickle）を
#     ~/.local/share/montash/ffmpeg に展開し ~/.local/bin にリンクする（sudo 不要）。montash はこの場所も探索する。
#   - Bun は公式インストーラ（https://bun.sh/install）を使う。
#   - sudo は必要な場合のみ使い、何を実行するかを事前に表示する。既に入っているものは触らない（冪等）。
# =============================================================================
set -eu

# ---------- options ----------
CHECK_ONLY=0; ASSUME_YES=0; WITH_FONTS=0; JSON_OUT=0; FORCE_STATIC=0; DRY_RUN=0; PRINT_STATIC=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --with-fonts) WITH_FONTS=1 ;;
    --static) FORCE_STATIC=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --print-static-urls) PRINT_STATIC=1 ;;   # デバッグ: static ffmpeg の候補 URL を表示して終了（INSTALL_DEPS_ARCH_OVERRIDE で arch 指定可）
    --json) JSON_OUT=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# ---------- helpers ----------
have() { command -v "$1" >/dev/null 2>&1; }
log()  { [ "$JSON_OUT" = 1 ] || printf '%s\n' "$*"; }
ok()   { log "  [OK]   $*"; }
miss() { log "  [MISS] $*"; }
warn() { log "  [WARN] $*"; }
die()  { echo "error: $*" >&2; exit 1; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ "$JSON_OUT" = 1 ] && return 1
  printf '%s [y/N] ' "$1"; read -r ans
  case "$ans" in y|Y) return 0 ;; *) return 1 ;; esac
}

SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

# ---------- status store（bash 3.2 互換: 連想配列の代わりに変数名を合成） ----------
ITEMS="ffmpeg ffmpeg_features bun cjk_font wslu fontconfig curl brew"
set_status() { eval "ST_$1=\"\$2\""; eval "DT_$1=\"\$3\""; }
status_of()  { eval "printf '%s' \"\${ST_$1:-}\""; }
detail_of()  { eval "printf '%s' \"\${DT_$1:-}\""; }
reset_status() { for k in $ITEMS; do eval "ST_$k=''; DT_$k=''"; done; }
reset_status

# ---------- platform detection ----------
OS="$(uname -s)"; ARCH="$(uname -m)"; PLATFORM="unknown"; PKG=""; IS_WSL=0
# テスト用オーバーライド（INSTALL_DEPS_PLATFORM_OVERRIDE=linux|wsl|macos, INSTALL_DEPS_PKG_OVERRIDE=apt|...）
if [ -n "${INSTALL_DEPS_PLATFORM_OVERRIDE:-}" ]; then
  PLATFORM="$INSTALL_DEPS_PLATFORM_OVERRIDE"; PKG="${INSTALL_DEPS_PKG_OVERRIDE:-apt}"
  [ "$PLATFORM" = wsl ] && IS_WSL=1
  [ "$PLATFORM" = macos ] && PKG="brew"
else
  case "$OS" in
    Darwin) PLATFORM="macos"; PKG="brew" ;;
    Linux)
      PLATFORM="linux"
      if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; PLATFORM="wsl"; fi
      if   have apt-get; then PKG="apt"
      elif have dnf;     then PKG="dnf"
      elif have pacman;  then PKG="pacman"
      elif have zypper;  then PKG="zypper"
      elif have apk;     then PKG="apk"
      fi ;;
    *) die "unsupported OS: $OS (WSL2 / Linux / macOS の bash で実行してください)" ;;
  esac
fi
[ "$PRINT_STATIC" = 1 ] || log "platform: $PLATFORM ($OS $ARCH), package manager: ${PKG:-none}, bash: ${BASH_VERSION}"

# montash が探索する static ffmpeg の置き場所（docs/04 doctor / 08 locate.ts と一致させる）
MONTASH_FFMPEG_HOME="$HOME/.local/share/montash/ffmpeg"
LOCAL_BIN="$HOME/.local/bin"
export PATH="$LOCAL_BIN:$MONTASH_FFMPEG_HOME/bin:$HOME/.bun/bin:$PATH"

# ---------- version helpers ----------
ver_ge() { # ver_ge 6.1.1 6.0 → 0 if $1 >= $2
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<EOF
$1
EOF
  IFS=. read -r b1 b2 b3 <<EOF
$2
EOF
  a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}; b1=${b1:-0}; b2=${b2:-0}; b3=${b3:-0}
  a1=${a1//[!0-9]/}; a2=${a2//[!0-9]/}; a3=${a3//[!0-9]/}; b1=${b1//[!0-9]/}; b2=${b2//[!0-9]/}; b3=${b3//[!0-9]/}
  [ "${a1:-0}" -gt "${b1:-0}" ] && return 0; [ "${a1:-0}" -lt "${b1:-0}" ] && return 1
  [ "${a2:-0}" -gt "${b2:-0}" ] && return 0; [ "${a2:-0}" -lt "${b2:-0}" ] && return 1
  [ "${a3:-0}" -ge "${b3:-0}" ]
}
ffmpeg_version() { # "ffmpeg version 9.0.1 ..." / "ffmpeg version n7.1-latest ..." / "4.4.2-0ubuntu0.22.04.1" → 9.0.1 / 7.1 / 4.4.2（BSD/GNU sed 両対応）
  local v; v="$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
  v="${v#n}"; v="${v#N}"
  v="$(printf '%s' "$v" | sed -E 's/[^0-9.].*$//')"
  printf '%s' "${v:-0}"
}
ffmpeg_has_filter()  { ffmpeg -hide_banner -filters  2>/dev/null | awk '{print $2}' | grep -qx "$1"; }
ffmpeg_has_encoder() { ffmpeg -hide_banner -encoders 2>/dev/null | awk '{print $2}' | grep -qx "$1"; }

MIN_FFMPEG="4.4"          # これ未満は outdated
REC_FFMPEG="6.0"          # これ未満は動くが警告
MIN_BUN="1.2.0"

# ---------- checks ----------
# ffmpeg は機能検出で判定する。結果: missing | outdated | limited | ok
check_ffmpeg() {
  if ! have ffmpeg || ! have ffprobe; then set_status ffmpeg missing "ffmpeg/ffprobe not found"; miss "ffmpeg / ffprobe"; return; fi
  local v path; v="$(ffmpeg_version)"; path="$(command -v ffmpeg)"
  if ! ver_ge "${v:-0}" "$MIN_FFMPEG"; then set_status ffmpeg outdated "$v ($path)"; miss "ffmpeg $v (< $MIN_FFMPEG) at $path"; return; fi

  local req_ok="" req_ng="" rec_ng="" extra=""
  # 必須（無いと render 不可）
  ffmpeg_has_encoder libx264            && req_ok="$req_ok libx264"           || req_ng="$req_ng libx264"
  ffmpeg_has_encoder aac                && req_ok="$req_ok aac"               || req_ng="$req_ng aac"
  ffmpeg_has_filter  xfade              && req_ok="$req_ok xfade"             || req_ng="$req_ng xfade"
  ffmpeg_has_filter  concat             && req_ok="$req_ok concat"            || req_ng="$req_ng concat"
  ffmpeg_has_filter  overlay            && req_ok="$req_ok overlay"           || req_ng="$req_ng overlay"
  ffmpeg_has_filter  loudnorm           && req_ok="$req_ok loudnorm"          || req_ng="$req_ng loudnorm"
  ffmpeg_has_filter  sidechaincompress  && req_ok="$req_ok sidechaincompress" || req_ng="$req_ng sidechaincompress"
  # 推奨（無いと機能制限）
  ffmpeg_has_filter  subtitles          && req_ok="$req_ok subtitles(libass)" || rec_ng="$rec_ng subtitles(libass)"
  ffmpeg_has_filter  drawtext           && req_ok="$req_ok drawtext"          || rec_ng="$rec_ng drawtext(libfreetype)"
  # 任意
  ffmpeg_has_encoder libx265            && extra="$extra libx265"            || true
  ffmpeg_has_encoder h264_videotoolbox  && extra="$extra h264_videotoolbox"  || true
  ffmpeg_has_encoder h264_nvenc         && extra="$extra h264_nvenc"         || true
  ffmpeg_has_encoder h264_vaapi         && extra="$extra h264_vaapi"         || true
  req_ok="${req_ok# }"; req_ng="${req_ng# }"; rec_ng="${rec_ng# }"; extra="${extra# }"

  if [ -n "$req_ng" ]; then
    set_status ffmpeg limited "$v ($path) lacks required: $req_ng"
    set_status ffmpeg_features error "required missing: $req_ng | recommended missing: ${rec_ng:-none}"
    miss "ffmpeg $v lacks required features: $req_ng （フル機能ビルドが必要。Linux/WSL は --static）"
    return
  fi
  set_status ffmpeg ok "$v ($path)"
  if ver_ge "$v" "$REC_FFMPEG"; then ok "ffmpeg $v ($path)"; else ok "ffmpeg $v ($path)"; warn "ffmpeg $v は best effort（推奨 $REC_FFMPEG 以上。Linux/WSL は --static で最新を導入可）"; fi
  if [ -n "$rec_ng" ]; then
    set_status ffmpeg_features warn "has: $req_ok | recommended missing: $rec_ng | extra: $extra"
    if [ "$PLATFORM" = macos ]; then
      warn "ffmpeg lacks recommended: $rec_ng （テロップに必要。brew の素の ffmpeg は libass 無し → \`brew install ffmpeg-full\`。--static は macOS 非対応）"
    else
      warn "ffmpeg lacks recommended: $rec_ng （テロップは drawtext フォールバック／機能制限。--static でフル機能ビルドを導入可）"
    fi
  else
    set_status ffmpeg_features ok "has: $req_ok | extra: ${extra:-none}"
    ok "ffmpeg features: $req_ok${extra:+ + $extra}"
  fi
}

check_bun() {
  if ! have bun; then set_status bun missing "not found"; miss "bun"; return; fi
  local v; v="$(bun --version 2>/dev/null)"
  if ver_ge "$v" "$MIN_BUN"; then set_status bun ok "$v"; ok "bun $v"; else set_status bun outdated "$v"; miss "bun $v (< $MIN_BUN)"; fi
}

check_fonts() {
  local found=""
  if have fc-list; then
    found="$(fc-list : family 2>/dev/null | grep -iE 'Noto Sans CJK|Noto Sans JP|Hiragino|Yu Gothic|YuGothic|IPA(ex)?Gothic|Meiryo|Source Han Sans|BIZ UDPGothic|Takao' | head -1 || true)"
  elif [ "$PLATFORM" = macos ]; then
    if ls /System/Library/Fonts /Library/Fonts "$HOME/Library/Fonts" 2>/dev/null | grep -qiE 'Hiragino|ヒラギノ'; then found="Hiragino Sans"; fi
  fi
  if [ -z "$found" ] && [ "$IS_WSL" = 1 ] && ls /mnt/c/Windows/Fonts 2>/dev/null | grep -qiE 'YuGoth|meiryo|msgothic'; then found="Windows fonts via /mnt/c/Windows/Fonts"; fi
  if [ -n "$found" ]; then set_status cjk_font ok "$found"; ok "CJK font: $found"
  else set_status cjk_font missing "none"; miss "日本語フォント（Noto Sans CJK 等）— テロップが豆腐になります（--with-fonts で導入）"; fi
}

check_wsl_tools() {
  [ "$IS_WSL" = 1 ] || return 0
  if have wslview; then set_status wslu ok "wslview"; ok "wslu (wslview) — ブラウザ起動に使用"
  else set_status wslu missing "not found"; miss "wslu (wslview) — 無い場合は cmd.exe /c start にフォールバック"; fi
  if have fc-list; then set_status fontconfig ok "fc-list"; else set_status fontconfig missing "not found"; miss "fontconfig (fc-list) — フォント検出に使用"; fi
}

check_misc() {
  if have git; then ok "git $(git --version | awk '{print $3}')"; else warn "git が無い（開発時のみ必要）"; fi
  if have curl; then set_status curl ok "$(curl --version | head -1 | awk '{print $2}')"; else set_status curl missing "not found"; miss "curl（Bun / static ffmpeg のダウンロードに必要）"; fi
  if [ "$PLATFORM" = macos ]; then
    if have brew; then set_status brew ok "$(brew --version | head -1 | awk '{print $2}')"; else set_status brew missing "not found"; miss "Homebrew（macOS でのインストールに必要: https://brew.sh）"; fi
  fi
  if [ "$IS_WSL" = 1 ]; then case "$PWD" in /mnt/*) warn "プロジェクトが /mnt 配下です。I/O とファイル監視が遅くなります（ext4 側 ~/ を推奨）" ;; esac; fi
}

# ---------- static ffmpeg (Linux / WSL) : URL 解決 ----------
# BtbN の GPL ビルド（libx264 / libx265 / libass / libfreetype 同梱）。
# アセット名は "ffmpeg-n<line>-latest-linux64-gpl-<line>.tar.xz" 形式で、公開中の系列（n8.1, n9.0 …）は時期で変わるため
# GitHub API から最新系列を動的に解決する。API 不達時は FFMPEG_STATIC_LINE_FALLBACK を使い、それも失敗すれば johnvansickle。
FFMPEG_STATIC_LINE_FALLBACK="n8.1"
btbn_arch() { case "$ARCH" in x86_64|amd64) echo linux64 ;; aarch64|arm64) echo linuxarm64 ;; *) echo "" ;; esac; }
btbn_latest_asset() { # 出力: 最新系列のアセット名（無ければ空）
  local a; a="$(btbn_arch)"; [ -n "$a" ] || return 0
  curl -fsL --max-time 15 "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest" 2>/dev/null \
    | grep -o "ffmpeg-n[0-9.]*-latest-${a}-gpl-[0-9.]*\.tar\.xz" | sort -u | sort -t n -k 2 -V 2>/dev/null | tail -1
}
static_urls() { # 出力: 候補 URL を 1 行ずつ（優先順）
  local a asset jv
  a="$(btbn_arch)"
  case "$ARCH" in
    x86_64|amd64)  jv="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
    aarch64|arm64) jv="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" ;;
    *) echo ""; return 0 ;;
  esac
  asset="$(btbn_latest_asset || true)"
  [ -n "$asset" ] && echo "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${asset}"
  echo "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-${FFMPEG_STATIC_LINE_FALLBACK}-latest-${a}-gpl-${FFMPEG_STATIC_LINE_FALLBACK#n}.tar.xz"
  echo "$jv"
}

if [ "$PRINT_STATIC" = 1 ]; then
  ARCH="${INSTALL_DEPS_ARCH_OVERRIDE:-$ARCH}"
  static_urls
  exit 0
fi

log "checking..."
check_ffmpeg; check_bun; check_fonts; check_wsl_tools; check_misc

# ---------- summarize ----------
NEED=""
case "$(status_of ffmpeg)" in missing|outdated|limited) NEED="$NEED ffmpeg" ;; esac
# 推奨機能（libass）が無い場合も導入対象にする（macOS: ffmpeg-full、Linux/WSL: static）。--check では警告のみ。
if [ "$(status_of ffmpeg)" = ok ] && [ "$(status_of ffmpeg_features)" = warn ] && [ "$CHECK_ONLY" = 0 ]; then NEED="$NEED ffmpeg"; fi
[ "$FORCE_STATIC" = 1 ] && [ "$PLATFORM" != macos ] && case " $NEED " in *" ffmpeg "*) ;; *) NEED="$NEED ffmpeg" ;; esac
case "$(status_of bun)" in missing|outdated) NEED="$NEED bun" ;; esac
[ "$WITH_FONTS" = 1 ] && [ "$(status_of cjk_font)" = missing ] && NEED="$NEED cjk_font"
[ "$IS_WSL" = 1 ] && [ "$(status_of wslu)" = missing ] && NEED="$NEED wslu"
[ "$IS_WSL" = 1 ] && [ "$(status_of fontconfig)" = missing ] && NEED="$NEED fontconfig"
NEED="${NEED# }"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
emit_json() {
  printf '{ "platform": "%s", "package_manager": "%s", "wsl": %s, "bash": "%s", "ffmpeg_home": "%s", "items": {' "$PLATFORM" "$PKG" "$IS_WSL" "$BASH_VERSION" "$MONTASH_FFMPEG_HOME"
  local first=1 k
  for k in $ITEMS; do
    [ -n "$(status_of $k)" ] || continue
    [ $first = 1 ] || printf ','; first=0
    printf ' "%s": { "status": "%s", "detail": "%s" }' "$k" "$(status_of $k)" "$(json_escape "$(detail_of $k)")"
  done
  printf ' }, "needs_install": ['
  first=1
  for k in $NEED; do [ $first = 1 ] || printf ','; first=0; printf '"%s"' "$k"; done
  printf '] }\n'
}

if [ -z "$NEED" ]; then
  if [ "$JSON_OUT" = 1 ]; then emit_json; else log "all required dependencies are present."; fi
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  if [ "$JSON_OUT" = 1 ]; then emit_json; else log "missing: $NEED (run without --check to install)"; fi
  exit 1
fi

# ---------- macOS: keg-only の ffmpeg-full を montash の探索場所にリンク ----------
link_brew_ffmpeg_full() {
  local prefix; prefix="$(brew --prefix ffmpeg-full 2>/dev/null || true)"
  [ -n "$prefix" ] && [ -x "$prefix/bin/ffmpeg" ] || die "ffmpeg-full が見つかりません（brew install ffmpeg-full）"
  mkdir -p "$MONTASH_FFMPEG_HOME/bin"
  ln -sf "$prefix/bin/ffmpeg"  "$MONTASH_FFMPEG_HOME/bin/ffmpeg"
  ln -sf "$prefix/bin/ffprobe" "$MONTASH_FFMPEG_HOME/bin/ffprobe"
  "$MONTASH_FFMPEG_HOME/bin/ffmpeg" -version | head -1
  log "  linked ffmpeg-full → $MONTASH_FFMPEG_HOME/bin（montash はここを優先します。シェルから使うなら PATH に追加）"
}

# ---------- static ffmpeg (Linux / WSL) : 実行 ----------
install_static_ffmpeg() {
  have curl || die "curl が必要です"
  have tar  || die "tar が必要です"
  local tmp url ok=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/montash-ffmpeg.XXXXXX")"
  for url in $(static_urls); do
    [ -n "$url" ] || continue
    log "  downloading $url"
    if curl -fL --retry 3 -o "$tmp/ffmpeg.tar.xz" "$url"; then ok=1; break; fi
    warn "  download failed, trying next source"
  done
  [ "$ok" = 1 ] || { rm -rf "$tmp"; die "static ffmpeg のダウンロードに失敗しました（$ARCH）。https://ffmpeg.org/download.html から手動で導入してください"; }
  mkdir -p "$tmp/x" && tar -xJf "$tmp/ffmpeg.tar.xz" -C "$tmp/x"
  local ff fp
  ff="$(find "$tmp/x" -type f -name ffmpeg  | head -1)"; fp="$(find "$tmp/x" -type f -name ffprobe | head -1)"
  [ -n "$ff" ] && [ -n "$fp" ] || { rm -rf "$tmp"; die "アーカイブに ffmpeg/ffprobe が見つかりません"; }
  mkdir -p "$MONTASH_FFMPEG_HOME/bin" "$LOCAL_BIN"
  install -m 0755 "$ff" "$MONTASH_FFMPEG_HOME/bin/ffmpeg"
  install -m 0755 "$fp" "$MONTASH_FFMPEG_HOME/bin/ffprobe"
  ln -sf "$MONTASH_FFMPEG_HOME/bin/ffmpeg"  "$LOCAL_BIN/ffmpeg"
  ln -sf "$MONTASH_FFMPEG_HOME/bin/ffprobe" "$LOCAL_BIN/ffprobe"
  rm -rf "$tmp"
  "$MONTASH_FFMPEG_HOME/bin/ffmpeg" -version | head -1
  case ":$PATH:" in *":$LOCAL_BIN:"*) ;; *) log "  NOTE: $LOCAL_BIN が PATH にありません。montash は $MONTASH_FFMPEG_HOME/bin を直接探索しますが、シェルから使うには PATH に追加してください" ;; esac
}

# ---------- install plan ----------
CMDS=""
plan() { CMDS="${CMDS}${1}
"; }
needs() { case " $NEED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ffmpeg の導入経路を決める: macOS=brew / Linux,WSL = static を優先（ディストリ版が古い・機能不足の場合）、なければパッケージ
FFMPEG_ROUTE=""
if needs ffmpeg; then
  if [ "$PLATFORM" = macos ]; then FFMPEG_ROUTE="brew"
  elif [ "$FORCE_STATIC" = 1 ]; then FFMPEG_ROUTE="static"
  elif [ "$(status_of ffmpeg)" = ok ]; then FFMPEG_ROUTE="static"      # ok だが推奨機能が無い → static でフル機能に
  else
    case "$(status_of ffmpeg)" in
      outdated|limited|recommended_missing) FFMPEG_ROUTE="static" ;;   # ディストリ版が入っているが不十分 → static
      missing)
        case "$PKG" in
          apt) # Ubuntu 22.04 (4.4) / Debian 12 (5.1) は要件を満たしにくいので static を優先
               FFMPEG_ROUTE="static" ;;
          dnf) FFMPEG_ROUTE="static" ;;                                 # RPM Fusion 前提を避ける
          pacman|zypper|apk) FFMPEG_ROUTE="pkg" ;;                      # ローリング系は新しい
          *) FFMPEG_ROUTE="static" ;;
        esac ;;
    esac
  fi
fi

case "$PKG" in
  brew)
    have brew || die "Homebrew が必要です: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    # Homebrew の素の `ffmpeg` formula は libass / libfreetype を含まない（2026 年時点）。テロップに必要なので
    # `ffmpeg-full`（keg-only: PATH に入らない）を入れ、$MONTASH_FFMPEG_HOME/bin にリンクする。montash はそこを優先探索する。
    if [ "$FFMPEG_ROUTE" = brew ]; then
      if brew info --formula ffmpeg-full >/dev/null 2>&1; then
        plan "brew install ffmpeg-full"
        plan "link_brew_ffmpeg_full   # → $MONTASH_FFMPEG_HOME/bin（keg-only なのでリンクして montash から見えるようにする）"
      else
        plan "brew install ffmpeg"
      fi
    fi
    needs cjk_font && plan "brew install --cask font-noto-sans-cjk-jp"
    ;;
  apt)
    if needs cjk_font || needs wslu || needs fontconfig || [ "$FFMPEG_ROUTE" = pkg ] || ! have curl; then plan "$SUDO apt-get update"; fi
    [ "$FFMPEG_ROUTE" = pkg ] && plan "$SUDO apt-get install -y ffmpeg"
    needs cjk_font   && plan "$SUDO apt-get install -y fonts-noto-cjk"
    needs wslu       && plan "$SUDO apt-get install -y wslu"
    needs fontconfig && plan "$SUDO apt-get install -y fontconfig"
    have curl || plan "$SUDO apt-get install -y curl xz-utils"
    have xz   || plan "$SUDO apt-get install -y xz-utils"
    ;;
  dnf)
    [ "$FFMPEG_ROUTE" = pkg ] && plan "$SUDO dnf install -y ffmpeg || { echo 'Fedora は RPM Fusion が必要です: https://rpmfusion.org/Configuration'; exit 1; }"
    needs cjk_font   && plan "$SUDO dnf install -y google-noto-sans-cjk-jp-fonts"
    needs fontconfig && plan "$SUDO dnf install -y fontconfig"
    have xz || plan "$SUDO dnf install -y xz"
    ;;
  pacman)
    [ "$FFMPEG_ROUTE" = pkg ] && plan "$SUDO pacman -S --noconfirm ffmpeg"
    needs cjk_font   && plan "$SUDO pacman -S --noconfirm noto-fonts-cjk"
    needs fontconfig && plan "$SUDO pacman -S --noconfirm fontconfig"
    ;;
  zypper)
    [ "$FFMPEG_ROUTE" = pkg ] && plan "$SUDO zypper install -y ffmpeg"
    needs cjk_font   && plan "$SUDO zypper install -y noto-sans-cjk-fonts"
    needs fontconfig && plan "$SUDO zypper install -y fontconfig"
    ;;
  apk)
    [ "$FFMPEG_ROUTE" = pkg ] && plan "$SUDO apk add ffmpeg"
    needs cjk_font   && plan "$SUDO apk add font-noto-cjk"
    needs fontconfig && plan "$SUDO apk add fontconfig"
    have xz || plan "$SUDO apk add xz"
    ;;
  *)
    [ "$FFMPEG_ROUTE" = pkg ] && warn "パッケージマネージャを検出できません。static ビルドを使います" && FFMPEG_ROUTE="static" ;;
esac

[ "$FFMPEG_ROUTE" = static ] && plan "install_static_ffmpeg   # → $MONTASH_FFMPEG_HOME/bin, $LOCAL_BIN にリンク（sudo 不要）"

# Bun は公式インストーラ（全プラットフォーム共通）
if needs bun; then
  if [ "$(status_of bun)" = outdated ]; then plan "bun upgrade"; else plan "curl -fsSL https://bun.sh/install | bash"; fi
fi

[ -n "$CMDS" ] || die "インストール対象がありません（手動導入が必要）"

log ""; log "the following commands will run:"
printf '%s' "$CMDS" | while IFS= read -r c; do [ -n "$c" ] && log "  \$ $c"; done
log ""
if [ "$DRY_RUN" = 1 ]; then log "(dry-run) nothing executed."; exit 0; fi
confirm "proceed?" || { log "aborted."; exit 1; }

printf '%s' "$CMDS" | while IFS= read -r c; do
  [ -n "$c" ] || continue
  log "\$ $c"
  case "$c" in
    install_static_ffmpeg*) install_static_ffmpeg ;;
    link_brew_ffmpeg_full*) link_brew_ffmpeg_full ;;
    *) bash -c "$c" ;;
  esac
done

# Bun を今入れた場合は PATH の案内
if needs bun && ! have bun; then
  log ""
  log "bun は ~/.bun/bin にインストールされました。以下をシェルの rc に追加して再読み込みしてください:"
  log '  export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"'
fi

log ""; log "re-checking..."
reset_status
hash -r 2>/dev/null || true
check_ffmpeg; check_bun; check_fonts; check_wsl_tools
log "done. 次は: bun install && bun run doctor"
