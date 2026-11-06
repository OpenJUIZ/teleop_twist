#!/bin/sh
# プラグインをビルドし、app/plugins/<ホストの target triple>/ に置く(app/app.conf を開発中に動かすため)
# 使い方: scripts/dev_plugin.sh [--release]
set -eu
cd "$(dirname "$0")/.."
profile=debug
if [ "${1:-}" = "--release" ]; then
  profile=release
  cargo build --release
else
  cargo build
fi
target=$(rustc -vV | sed -n 's/^host: //p')
case "$target" in
  *apple-darwin) lib=libteleop_twist.dylib ;;
  *windows*) lib=teleop_twist.dll ;;
  *) lib=libteleop_twist.so ;;
esac
mkdir -p "app/plugins/$target"
cp "target/$profile/$lib" "app/plugins/$target/"
echo "app/plugins/$target/$lib"
