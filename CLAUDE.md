# Protokolant – zasady pracy

## Wersjonowanie dodatku

Po **każdej** zmianie w katalogu `extension/`, nawet najdrobniejszej, podbij wersję w `extension/manifest.json` (jedyne źródło wersji; `common.js` czyta ją przez `chrome.runtime.getManifest()`):

- poprawki i drobne zmiany: patch (`1.0.5` → `1.0.6`),
- nowe funkcje lub zmiany zachowania: minor (`1.0.x` → `1.1.0`).

Powód: po „Odśwież” w `chrome://extensions` numer wersji potwierdza, że załadował się najnowszy kod. W podsumowaniu zmian zawsze podaj nową wersję.

## Testy

Przed commitem uruchom: `node tests/format.test.js`, `node tests/chat-frame.sim.js`, `node tests/inject.sim.js`, `node tests/inject.foreign.sim.js`, `node tests/content.sim.js` oraz `node --check` dla plików w `extension/`.

## Paczka do Chrome Web Store

Dodatek jest opublikowany w Chrome Web Store (od listopada 2026). Identyfikator: `lhpjlgaeofddngnfdbheodoemmkpcdjb`; karta: `https://chromewebstore.google.com/detail/lhpjlgaeofddngnfdbheodoemmkpcdjb` (linkują do niej przyciski na stronie głównej i w `instalacja/`).

`python3 -I scripts/build-zip.py` sprawdza manifest, pliki, składnię i niechciane treści, uruchamia testy i buduje `dist/protokolant-<wersja>.zip`. Nie nadpisuje paczki istniejącej wersji – przed publikacją podbij wersję. Ikony: `scripts/build-icons.sh [B1|B2]`, grafiki do sklepu: `scripts/build-store-images.sh`.

## Strona domowa i polityka prywatności

Źródło: `store/site/protokolant/` (`index.html`, wspólny `style.css`, `img/`, instrukcja `instalacja/`, polityka `prywatnosc/`, tymczasowa `wersja-testowa/`), publikacja: https://protokolant.marcintabaka.pl/. Wgranie i weryfikacja: `scripts/deploy-site.sh` (serwer i katalog w lokalnym `.local.env`). Adresu polityki (`/prywatnosc/`) nie wolno zmieniać – jest podany w Chrome Web Store. Strona nie ładuje nic z zewnątrz (bez czcionek z sieci, CDN, analityki i ciasteczek). Obrazki strony: `store/site/build-images.sh`.

`wersja-testowa/` nie oferuje już paczki ZIP – to ukryta (bez linku w nawigacji, `noindex`) instrukcja dla osób z wersją testową: jak ją usunąć i zainstalować dodatek ze sklepu. Gdy przestanie być potrzebna, usuń wszystkie miejsca oznaczone `WERSJA TYMCZASOWA` (`grep -rn "WERSJA TYMCZASOWA" store/site scripts`), a na serwerze katalog `wersja-testowa/`.

## Publiczne repozytorium

Repozytorium jest publiczne (MIT). Nie commituj danych ze spotkań, logów debug, nazw prawdziwych spotkań i osób (w testach i grafikach tylko fikcyjne dane) ani lokalnych ścieżek i danych serwera – te trzymaj w plikach poza gitem (`.local.env`, `CLAUDE.local.md`).
