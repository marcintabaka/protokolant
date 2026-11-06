#!/usr/bin/env bash
# Generuje ikony PNG dodatku z plików SVG w design/icons/<kształt>/.
# Użycie: scripts/build-icons.sh [B1|B2]   (domyślnie B1)
# Stany: idle (szara kropka), rec (czerwona), dim (przygaszona – druga klatka mrugania), warn (pomarańczowa).
# Ikona w sklepie i na stronie rozszerzeń: rec (pełna czerwona kropka); na pasku domyślnie idle.
# 16 px renderujemy z uproszczonego pliku *-small.svg, większe z pełnego.
set -euo pipefail
cd "$(dirname "$0")/.."
SHAPE="${1:-B1}"
SRC="design/icons/$SHAPE"
OUT="extension/icons"
mkdir -p "$OUT"
rm -f "$OUT"/*.png
# ikony paska narzędzi (wszystkie stany): 16 i 32 px
for st in idle rec dim warn; do
  rsvg-convert -w 16 -h 16 "$SRC/$st-small.svg" -o "$OUT/$st-16.png"
  rsvg-convert -w 32 -h 32 "$SRC/$st.svg" -o "$OUT/$st-32.png"
done
# ikona dodatku (strona rozszerzeń, Chrome Web Store): czerwona kropka, 48 i 128 px
for s in 48 128; do
  rsvg-convert -w "$s" -h "$s" "$SRC/rec.svg" -o "$OUT/rec-$s.png"
done
echo "Ikony ($SHAPE) zapisane w $OUT"
