#!/usr/bin/env bash
# Wgrywa stronę dodatku i politykę prywatności na https://protokolant.marcintabaka.pl/ przez ssh/rsync.
# Serwer i katalog podaj w .local.env (poza gitem): DEPLOY_SSH=<alias ssh>, DEPLOY_PATH=<katalog public_html na serwerze>.
# Źródło: store/site/protokolant/ (.htaccess, index.html, style.css, instalacja/index.html, prywatnosc/index.html, wersja-testowa/index.html + paczka z dist/, img/; obrazki odtwarza store/site/build-images.sh).
# Adres https://protokolant.marcintabaka.pl/prywatnosc/ jest podany w Chrome Web Store – nie zmieniać.
# Adres do weryfikacji można nadpisać: BASE=http://protokolant.marcintabaka.pl/ scripts/deploy-site.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=store/site/protokolant
DEPLOY_SSH=""; DEPLOY_PATH=""; [ -f .local.env ] && . ./.local.env
[ -n "$DEPLOY_SSH" ] && [ -n "$DEPLOY_PATH" ] || { echo "BŁĄD: ustaw DEPLOY_SSH i DEPLOY_PATH w .local.env" >&2; exit 1; }
REMOTE=$DEPLOY_PATH
BASE=${BASE:-https://protokolant.marcintabaka.pl/}

# WERSJA TYMCZASOWA: paczka do pobrania na /wersja-testowa/ – nazwę bierzemy ze strony, plik z dist/ (scripts/build-zip.py).
TEST_ZIP=$(grep -oE 'protokolant-[0-9]+\.[0-9]+\.[0-9]+\.zip' "$SRC/wersja-testowa/index.html" | sort -u)
[ "$(echo "$TEST_ZIP" | wc -l)" = 1 ] || { echo "BŁĄD: strona wersji testowej wskazuje różne paczki: $TEST_ZIP" >&2; exit 1; }
[ -f "dist/$TEST_ZIP" ] || { echo "BŁĄD: brak dist/$TEST_ZIP – zbuduj paczkę (python3 -I scripts/build-zip.py) albo popraw stronę" >&2; exit 1; }
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp "$SRC/wersja-testowa/index.html" "dist/$TEST_ZIP" "$STAGE/"

ssh -o BatchMode=yes "$DEPLOY_SSH" "test -d $REMOTE && mkdir -p $REMOTE/img $REMOTE/instalacja $REMOTE/prywatnosc $REMOTE/wersja-testowa"
scp -q "$SRC/.htaccess" "$SRC/index.html" "$SRC/style.css" "$DEPLOY_SSH:$REMOTE/"
scp -q "$SRC/instalacja/index.html" "$DEPLOY_SSH:$REMOTE/instalacja/index.html"
scp -q "$SRC/prywatnosc/index.html" "$DEPLOY_SSH:$REMOTE/prywatnosc/index.html"
rsync -rt --delete --chmod=D755,F644 -e 'ssh -o BatchMode=yes' "$SRC/img/" "$DEPLOY_SSH:$REMOTE/img/"
rsync -rt --delete --chmod=D755,F644 -e 'ssh -o BatchMode=yes' "$STAGE/" "$DEPLOY_SSH:$REMOTE/wersja-testowa/"
ssh -o BatchMode=yes "$DEPLOY_SSH" "chmod 755 $REMOTE/img $REMOTE/instalacja $REMOTE/prywatnosc && chmod 644 $REMOTE/.htaccess $REMOTE/index.html $REMOTE/style.css $REMOTE/instalacja/index.html $REMOTE/prywatnosc/index.html $REMOTE/img/*"

fail=0
TMP=$(mktemp); trap 'rm -rf "$TMP" "$STAGE"' EXIT
check() { # url [plik lokalny do porównania]
  local code
  code=$(curl -s -o "$TMP" -w '%{http_code}' "$1")
  if [ "$code" != 200 ]; then echo "BŁĄD: $1 → $code" >&2; fail=1; return; fi
  if [ -n "${2:-}" ] && ! cmp -s "$TMP" "$2"; then echo "BŁĄD: $1 → 200, ale treść różni się od $2" >&2; fail=1; return; fi
  echo "OK: $1 (200${2:+, treść zgodna z $2})"
}
check "$BASE" "$SRC/index.html"
check "${BASE}style.css" "$SRC/style.css"
check "${BASE}instalacja/" "$SRC/instalacja/index.html"
check "${BASE}prywatnosc/" "$SRC/prywatnosc/index.html"
check "${BASE}wersja-testowa/" "$SRC/wersja-testowa/index.html"
check "${BASE}wersja-testowa/$TEST_ZIP" "dist/$TEST_ZIP"
for f in "$SRC"/img/*; do check "${BASE}img/$(basename "$f")" "$f"; done
ctype=$(curl -s -o /dev/null -w '%{content_type}' "${BASE}prywatnosc/")
case "$ctype" in *[Uu][Tt][Ff]-8*) echo "OK: kodowanie $ctype" ;; *) echo "BŁĄD: Content-Type bez UTF-8: $ctype" >&2; fail=1 ;; esac
exit $fail
