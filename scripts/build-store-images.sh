#!/usr/bin/env bash
# Renderuje grafiki do Chrome Web Store ze źródeł w store/images-src/:
#   store/images/screenshot-{1..4}.png (1280x800), store/images/tile-440x280.png i store/images/marquee-1400x560.png (transparent promocyjny).
# Wszystkie PNG zapisujemy jako 24-bitowe RGB bez kanału alfa (wymóg sklepu).
# Popup to prawdziwy extension/popup.html z atrapą chrome.* (stub.js) i fikcyjnymi danymi (sample.js).
# Wymaga chrome-headless-shell (Playwright) i czcionek Segoe UI/Consolas z Windowsa (kopiowane do /tmp, nie do repo).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
SRC="$ROOT/store/images-src"
OUT="$ROOT/store/images"
WORK="$SRC/out"
CHROME="$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | sort -V | tail -1)"
FONTDIR="${TMPDIR:-/tmp}/protokolant-fonts"
mkdir -p "$OUT" "$WORK" "$FONTDIR"

# Czcionki jak w Chrome na Windowsie
for f in segoeui.ttf segoeuib.ttf segoeuisl.ttf seguisb.ttf seguiemj.ttf seguisym.ttf consola.ttf consolab.ttf; do
  [ -f "/mnt/c/Windows/Fonts/$f" ] && cp -n "/mnt/c/Windows/Fonts/$f" "$FONTDIR/" || true
done
cat > "$FONTDIR/fonts.conf" <<CONF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>
<dir>$FONTDIR</dir><dir>/usr/share/fonts</dir><cachedir>$FONTDIR/cache</cachedir>
<alias><family>sans-serif</family><prefer><family>Segoe UI</family><family>Segoe UI Emoji</family><family>Segoe UI Symbol</family></prefer></alias>
<alias><family>system-ui</family><prefer><family>Segoe UI</family></prefer></alias>
<alias><family>monospace</family><prefer><family>Consolas</family></prefer></alias>
</fontconfig>
CONF
export FONTCONFIG_FILE="$FONTDIR/fonts.conf" TZ=Europe/Warsaw

shot() { # url width height scale out
  "$CHROME" --no-sandbox --hide-scrollbars --disable-gpu --virtual-time-budget=5000 \
    --force-device-scale-factor="$4" --window-size="$2,$3" --screenshot="$5" "$1" >/dev/null 2>&1
  echo "  $(basename "$5")"
}

# Popup z atrapą API
rm -rf "$WORK/stage" && cp -r "$ROOT/extension" "$WORK/stage"
python3 - "$WORK/stage/popup.html" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s = s.replace('<script src="common.js"></script>', '<script src="../../sample.js"></script><script src="../../stub.js"></script><script src="common.js"></script>')
s = s.replace('</style>', '  body { font-family: "Segoe UI", sans-serif; }\n  </style>', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
echo "Popup:"
shot "file://$WORK/stage/popup.html?scenario=live" 504 1000 2 "$WORK/popup-live.png"
shot "file://$WORK/stage/popup.html?scenario=settings" 504 1000 2 "$WORK/popup-settings.png"
# obcinamy pusty dół okna (popup jest niższy niż okno renderu)
python3 - "$WORK"/popup-*.png <<'PY'
import sys
from PIL import Image, ImageChops
for p in sys.argv[1:]:
    im = Image.open(p).convert('RGB')
    bbox = ImageChops.difference(im, Image.new('RGB', im.size, (255, 255, 255))).getbbox()
    if bbox:
        im.crop((0, 0, im.width, min(im.height, bbox[3] + 24))).save(p)
PY

echo "Grafiki:"
for i in 1 2 3 4; do shot "file://$SRC/shot$i.html" 1280 800 1 "$OUT/screenshot-$i.png"; done
shot "file://$SRC/tile.html" 440 280 1 "$OUT/tile-440x280.png"
shot "file://$SRC/marquee.html" 1400 560 1 "$OUT/marquee-1400x560.png"
python3 - "$OUT"/*.png <<'PY'
import sys
from PIL import Image
for p in sys.argv[1:]:
    im = Image.open(p)
    if im.mode != 'RGB':
        im.convert('RGB').save(p)
PY

# Opcjonalna kopia (np. na dysk Windows): COPY_DIR w .local.env (poza gitem)
COPY_DIR=""; [ -f .local.env ] && . ./.local.env
if [ -n "$COPY_DIR" ] && [ -d "$(dirname "$COPY_DIR")" ]; then
  mkdir -p "$COPY_DIR/grafiki" && cp "$OUT"/*.png "$COPY_DIR/grafiki/" && echo "Skopiowano do $COPY_DIR/grafiki"
fi
