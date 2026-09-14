#!/usr/bin/env bash
# テスト素材の生成（docs/08 §6）。src/ffmpeg/fixtures.ts と同じ内容を bash で再現する。
# 使い方: bash scripts/make-fixtures.sh [出力ディレクトリ=tests/fixtures]
# ffmpeg の探索: $MONTASH_FFMPEG → ~/.local/share/montash/ffmpeg/bin/ffmpeg → PATH
set -euo pipefail

OUT_DIR="${1:-tests/fixtures}"

if [[ -n "${MONTASH_FFMPEG:-}" ]]; then
  FFMPEG="$MONTASH_FFMPEG"
elif [[ -x "$HOME/.local/share/montash/ffmpeg/bin/ffmpeg" ]]; then
  FFMPEG="$HOME/.local/share/montash/ffmpeg/bin/ffmpeg"
elif command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG="$(command -v ffmpeg)"
else
  echo "ffmpeg not found. Run scripts/install-deps.sh or set MONTASH_FFMPEG." >&2
  exit 3
fi

mkdir -p "$OUT_DIR"

X264=(-c:v libx264 -preset ultrafast -pix_fmt yuv420p)
AAC=(-c:a aac -b:a 128k -ac 2 -ar 48000)

# gen <ファイル名> <ffmpeg 引数...>  — 既に存在すればスキップ。一時名に書いて mv する
gen() {
  local file="$1"; shift
  local out="$OUT_DIR/$file"
  if [[ -e "$out" ]]; then
    echo "skip  $out (exists)"
    return 0
  fi
  local fmt
  case "$file" in
    *.mp4) fmt=mp4 ;;
    *.wav) fmt=wav ;;
    *.png) fmt=image2 ;;
    *.mov) fmt=mov ;;
    *) echo "unknown extension: $file" >&2; return 1 ;;
  esac
  local tmp="$OUT_DIR/.$file.tmp.$$"
  echo "make  $out"
  if ! "$FFMPEG" -hide_banner -loglevel error -nostats -y "$@" -f "$fmt" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" "$out"
}

# a.mp4: testsrc2 5s 30fps 640x360 + sine 440Hz
gen a.mp4 \
  -f lavfi -i "testsrc2=s=640x360:r=30:d=5" \
  -f lavfi -i "sine=f=440:r=48000:d=5" \
  "${X264[@]}" -g 30 "${AAC[@]}" -frames:v 150 -t 5 -movflags +faststart

# a2997.mp4: 29.97fps 版
gen a2997.mp4 \
  -f lavfi -i "testsrc2=s=640x360:r=30000/1001:d=5" \
  -f lavfi -i "sine=f=440:r=48000:d=5" \
  "${X264[@]}" -g 30 "${AAC[@]}" -frames:v 150 -t 5 -movflags +faststart

# tone.wav: 音声のみ 10s
gen tone.wav \
  -f lavfi -i "sine=f=440:r=48000:d=10" -ac 2 -c:a pcm_s16le -t 10

# logo.png: アルファ付き静止画
gen logo.png \
  -f lavfi -i "testsrc2=s=256x128:alpha=128:d=1,format=rgba" -frames:v 1 -c:v png

# b60.mp4: 3s 1280x720 60fps + sine 880Hz
gen b60.mp4 \
  -f lavfi -i "testsrc2=s=1280x720:r=60:d=3" \
  -f lavfi -i "sine=f=880:r=48000:d=3" \
  "${X264[@]}" -g 60 "${AAC[@]}" -frames:v 180 -t 3 -movflags +faststart

echo "done: $OUT_DIR"
