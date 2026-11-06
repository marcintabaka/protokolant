#!/usr/bin/env bash
# Renderuje obrazki strony domowej do store/site/protokolant/img/:
#   popup-podglad.png, popup-ustawienia.png – kadry prawdziwego extension/popup.html (atrapa chrome.* jak w grafikach do sklepu),
#   og-1200x630.png – obrazek Open Graph ze store/site/og.html.
# Dane: fikcyjne spotkanie ze store/images-src/sample.js (te same co w grafikach do sklepu).
# Wymaga chrome-headless-shell (Playwright), Pillow i czcionek Segoe UI z Windowsa (jak scripts/build-store-images.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
OUT="$ROOT/store/site/protokolant/img"
CHROME="$(ls -d ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | sort -V | tail -1)"
FONTDIR="${TMPDIR:-/tmp}/protokolant-fonts"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$FONTDIR" "$WORK/src/out"

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
}

cp store/images-src/sample.js store/images-src/stub.js "$WORK/src/"
cp -r extension "$WORK/src/out/stage"
python3 - "$WORK/src/out/stage/popup.html" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s = s.replace('<script src="common.js"></script>', '<script src="../../sample.js"></script><script src="../../stub.js"></script><script src="common.js"></script>')
s = s.replace('</style>', '  body { font-family: "Segoe UI", sans-serif; }\n  </style>', 1)
open(p, 'w', encoding='utf-8').write(s)
PY
shot "file://$WORK/src/out/stage/popup.html?scenario=live" 504 1000 2 "$WORK/live.png"
shot "file://$WORK/src/out/stage/popup.html?scenario=settings" 504 1000 2 "$WORK/settings.png"
shot "file://$ROOT/store/site/og.html" 1200 630 1 "$WORK/og.png"

# Kadry (piksele w skali 2x): podgląd – od góry do końca ramki transkrypcji; ustawienia – od „Ostatnie transkrypcje” do końca.
python3 - "$WORK" "$OUT" <<'PY'
import sys
from PIL import Image
W, OUT = sys.argv[1:]
def save(im, name):
    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f'{OUT}/{name}', optimize=True)
    print(f'  {name} {im.width}x{im.height}')
save(Image.open(f'{W}/live.png').convert('RGB').crop((0, 0, 1008, 996)), 'popup-podglad.png')
save(Image.open(f'{W}/settings.png').convert('RGB').crop((0, 1022, 1008, 1580)), 'popup-ustawienia.png')
Image.open(f'{W}/og.png').convert('RGB').save(f'{OUT}/og-1200x630.png', optimize=True)
print('  og-1200x630.png 1200x630')
PY
cp design/icons/B1/rec.svg design/icons/B1/dim.svg design/icons/B1/idle.svg design/icons/B1/warn.svg "$OUT/"
cp extension/icons/rec-32.png "$OUT/favicon-32.png"
cp extension/icons/rec-128.png "$OUT/icon-128.png"
