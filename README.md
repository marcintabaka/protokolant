# Protokolant – transkrypcje dla Google Meet™

Dodatek do Chrome, który zapisuje transkrypcje spotkań Google Meet™ po polsku do plików Markdown na Twoim komputerze. Za darmo, bez konta i bez wysyłania danych – wszystko dzieje się w przeglądarce.

- Strona: https://protokolant.marcintabaka.pl/
- Instrukcja instalacji: https://protokolant.marcintabaka.pl/instalacja/
- Polityka prywatności: https://protokolant.marcintabaka.pl/prywatnosc/
- Chrome Web Store: w trakcie weryfikacji; do tego czasu [wersja testowa z paczki ZIP](https://protokolant.marcintabaka.pl/wersja-testowa/)

Protokolant jest niezależnym projektem i nie jest powiązany z Google LLC ani przez nią wspierany. Google Meet jest znakiem towarowym Google LLC.

## Co robi

- Startuje sam, gdy dołączasz do spotkania – napisów w Meet nie trzeba włączać.
- Pokazuje transkrypcję na żywo w oknie dodatku.
- Po spotkaniu (albo po kliknięciu „Zapisz teraz”) zapisuje plik `Pobrane/Protokolant/<data>_<godzina>_<kod>.md` z nazwą spotkania, listą uczestników i wypowiedziami w formacie `[czas] Osoba: tekst`. Kolejne wypowiedzi tej samej osoby łączy w akapity, a wiadomości z czatu oznacza jako `(czat)`.
- Opcjonalnie (domyślnie wyłączone) wysyła na czat spotkania krótką informację, że rozmowa jest transkrybowana.

## Prywatność

Dodatek nie ma serwera i nie wysyła nigdzie treści spotkań. Transkrypcje trafiają tylko do pamięci przeglądarki (`chrome.storage.local`, 30 ostatnich spotkań) i do plików w folderze Pobrane. Jedyny ruch sieciowy to komunikacja z samym Google Meet, z którym przeglądarka i tak jest połączona: prośba o napisy w wybranym języku i potwierdzanie ich odbioru (tak samo robi Meet po włączeniu napisów) oraz opcjonalna wiadomość na czacie. Szczegóły: [polityka prywatności](https://protokolant.marcintabaka.pl/prywatnosc/).

## Jak to działa

`extension/inject.js` działa w świecie strony (`world: MAIN`, `document_start`) i obudowuje `RTCPeerConnection`. Na głównym połączeniu Meet (tym z kanałem `collections`) otwiera własne kanały danych `captions` i `captions_v2` (albo biernie słucha kanału otwartego przez Meet lub inny dodatek), dekoduje wiadomości protobuf z napisami (`extension/proto.js`) i potwierdza pakiety `captions_v2`. Język napisów ustawia pakietem na kanale `media-session`. Nazwiska uczestników bierze z kanału `collections` i z odpowiedzi `SyncMeetingSpaceCollections`. Każda wypowiedź ma identyfikator i wersję, więc deduplikacja sprowadza się do podmiany tekstu na nowszą wersję.

Protokół kanałów danych Meet nie jest publicznie udokumentowany – schematy w `extension/proto.js` ustalono na podstawie ruchu i mogą przestać działać, gdy Google go zmieni.

## Struktura

- `extension/manifest.json` – manifest MV3 i **jedyne źródło wersji**; uprawnienia: `storage`, `downloads`, hosty `meet.google.com` i `chat.google.com` (ramka czatu osadzona w Meet).
- `extension/inject.js` + `extension/proto.js` – obudowa WebRTC i dekodowanie napisów (świat strony).
- `extension/chat-frame.js` – skrypt w ramce Google Chat osadzonej w Meet: przechwytuje własne wysłane wiadomości i wysyła opcjonalne powiadomienie o transkrypcji.
- `extension/content.js` – wykrywanie rozmowy, składanie wypowiedzi, bufor w `chrome.storage.local`, pasek statusu na stronie.
- `extension/background.js` – service worker: zapis plików (`chrome.downloads`), ikona i znaczek na pasku, zapis po zamknięciu karty, sprzątanie bufora.
- `extension/popup.*` – okno dodatku: stan, „Zapisz teraz”, podgląd transkrypcji, lista spotkań, ustawienia.
- `extension/common.js` – format pliku Markdown i wspólne funkcje.
- `design/icons/` – źródła SVG ikon (`scripts/build-icons.sh` generuje z nich `extension/icons/`).
- `store/` – opis do Chrome Web Store, odpowiedzi „Privacy practices”, grafiki (`images-src/` → `scripts/build-store-images.sh`) i strona domowa (`site/`).
- `tests/` – testy formatu i symulacje w Node (bez przeglądarki).

## Uruchomienie ze źródeł

1. `chrome://extensions` → włącz „Tryb dewelopera” → „Załaduj rozpakowane” → wskaż katalog `extension/`.
2. Przypnij ikonę Protokolanta do paska narzędzi i dołącz do spotkania w Meet.
3. Po każdej zmianie kodu kliknij „Odśwież” przy dodatku w `chrome://extensions`, a potem odśwież kartę Meet (F5).

Diagnostyka: logi w konsoli karty Meet mają prefiks `[Protokolant]`, `[Protokolant/page]` i `[Protokolant/chat]`, a service workera `[Protokolant/sw]`. Tryb debug (w oknie dodatku, sekcja „Diagnostyka”) zbiera surowe pakiety z kanałów napisów. Logi debug zawierają treść spotkań – nie wrzucaj ich do zgłoszeń bez anonimizacji.

## Rozwój

Wymagany Node 18+ (testy) i Python 3 (budowanie paczki).

```bash
node tests/format.test.js
node tests/chat-frame.sim.js
node tests/inject.sim.js
node tests/inject.foreign.sim.js
node tests/content.sim.js
python3 -I scripts/build-zip.py   # sprawdza manifest i kod, uruchamia testy, buduje dist/protokolant-<wersja>.zip
```

Po każdej zmianie w `extension/` podbij wersję w `extension/manifest.json`.

## Zgłoszenia

To prywatny projekt rozwijany po godzinach. Błędy i pomysły zgłaszaj w Issues albo na protokolant@marcintabaka.pl – odpowiadam, kiedy mogę.

## Licencja

[MIT](LICENSE) © 2026 Marcin Tabaka
