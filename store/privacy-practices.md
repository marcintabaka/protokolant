# Chrome Web Store – zakładka „Privacy practices”

Pola w tej zakładce czytają tylko weryfikatorzy Google, dlatego teksty do wklejenia są po angielsku; pod każdym jest polskie tłumaczenie do oceny. Treść musi się zgadzać z polityką prywatności (`https://protokolant.marcintabaka.pl/prywatnosc/`) i z tym, co robi kod.

## 1. Single purpose description

```text
Protokolant creates a text transcript of the user's own Google Meet calls and saves it as a Markdown file on the user's computer. It reads the live captions that Google Meet already delivers to the browser during a call (in Polish by default), adds speaker names, the meeting name and the user's chat messages, shows a live preview in the popup and saves the file to the Downloads folder when the call ends. Everything is processed locally; nothing is sent to the developer or any third party.
```

Protokolant tworzy tekstową transkrypcję spotkań użytkownika w Google Meet i zapisuje ją jako plik Markdown na jego komputerze. Odczytuje napisy na żywo, które Meet i tak przesyła do przeglądarki w trakcie rozmowy (domyślnie po polsku), dodaje nazwiska mówców, nazwę spotkania i wiadomości użytkownika z czatu, pokazuje podgląd w oknie dodatku i zapisuje plik w Pobranych po zakończeniu rozmowy. Wszystko jest przetwarzane lokalnie; nic nie jest wysyłane do autora ani podmiotów trzecich.

## 2. Permission justifications

### storage

```text
Keeps a local buffer of the transcripts of the last 30 meetings (so a transcript is not lost if the tab crashes or is closed before the file is saved, and so that rejoining the same meeting appends to the same transcript) and stores the extension settings (caption language, optional chat notice, debug mode). Data stays in chrome.storage.local on the user's device; storage.sync is not used.
```

Lokalny bufor transkrypcji 30 ostatnich spotkań (żeby transkrypcja nie zginęła, gdy karta się zamknie przed zapisem pliku, i żeby powrót na to samo spotkanie dopisywał do tej samej transkrypcji) oraz ustawienia dodatku. Dane zostają w `chrome.storage.local` na urządzeniu; `storage.sync` nie jest używany.

### downloads

```text
Saves the transcript as a Markdown (.md) file to the user's Downloads/Protokolant folder when the call ends, when the tab is closed, or when the user clicks "Save now" in the popup. When the same meeting is saved again, the extension removes the previous file it created for that meeting (chrome.downloads.removeFile) so the user keeps one up-to-date file instead of numbered copies.
```

Zapis transkrypcji jako pliku Markdown w folderze Pobrane/Protokolant po zakończeniu rozmowy, zamknięciu karty albo kliknięciu „Zapisz teraz”. Przy ponownym zapisie tego samego spotkania dodatek usuwa poprzedni plik, który sam utworzył, żeby zamiast kopii z numerami był jeden aktualny plik.

### Host permissions (meet.google.com, chat.google.com)

```text
meet.google.com: the extension's only purpose is transcribing Google Meet calls. A content script running in the page's main world at document_start wraps RTCPeerConnection so it can open the captions data channels that Google Meet uses to deliver live captions to the browser, decode the caption messages, and request captions in the user's chosen language (the same requests Meet makes when captions are turned on). A second content script detects the start and end of a call, reads the meeting name and participant names shown by Meet, builds the transcript and shows a small status indicator on the page. If the user enables the optional, off-by-default setting, it posts one short message to the meeting chat informing participants that the call is being transcribed.

chat.google.com: in some accounts Google Meet shows the in-call chat in an embedded chat.google.com frame. A content script runs only in that frame when it is embedded in meet.google.com, to capture the chat messages the user sends during the call and to post the optional transcription notice. It does not run on chat.google.com opened directly.

No data from these pages is sent anywhere except back to Google Meet as part of its normal operation described above.
```

meet.google.com: jedynym celem dodatku jest transkrypcja rozmów w Google Meet. Skrypt w świecie strony (od `document_start`) obudowuje `RTCPeerConnection`, żeby otworzyć kanały danych, którymi Meet przesyła napisy do przeglądarki, odczytać wiadomości z napisami i poprosić o napisy w wybranym języku (takie same żądania wysyła Meet po włączeniu napisów). Drugi skrypt wykrywa początek i koniec rozmowy, odczytuje nazwę spotkania i nazwiska uczestników wyświetlane przez Meet, składa transkrypcję i pokazuje mały wskaźnik stanu na stronie. Po włączeniu opcjonalnego (domyślnie wyłączonego) ustawienia wysyła jedną krótką wiadomość na czat spotkania z informacją o transkrypcji.

chat.google.com: na niektórych kontach Meet wyświetla czat w osadzonej ramce chat.google.com. Skrypt działa tylko w tej ramce, gdy jest osadzona w meet.google.com, żeby zapisać wiadomości wysłane przez użytkownika i wysłać opcjonalną informację o transkrypcji. Nie działa na samodzielnie otwartym chat.google.com.

Żadne dane z tych stron nie są wysyłane nigdzie poza samym Google Meet w ramach opisanego wyżej normalnego działania.

## 3. Remote code

Zaznacz: **„No, I am not using remote code”**. Dodatek nie wczytuje ani nie wykonuje kodu spoza paczki (wszystkie skrypty są w ZIP, brak `eval`, zewnętrznych skryptów i WebAssembly).

## 4. Data usage

### Typy danych

**Decyzja (2026-11-05): wariant A – niczego nie zaznaczać.** Dane są przetwarzane wyłącznie lokalnie i nic nie trafia do autora, więc dodatek nie „zbiera” danych. Jeśli weryfikacja odrzuci zgłoszenie z tego powodu, przełączamy na wariant B (tabela niżej) i wysyłamy ponownie – bez zmian w kodzie i polityce prywatności.

| Typ w formularzu | Wariant A: nic nie zaznaczać | Wariant B: zaznaczyć przetwarzane dane |
| --- | --- | --- |
| Personally identifiable information | – | ✔ (imiona i nazwiska uczestników) |
| Health information | – | – |
| Financial and payment information | – | – |
| Authentication information | – | – |
| Personal communications | – | ✔ (treść rozmowy i wiadomości z czatu) |
| Location | – | – |
| Web history | – | – |
| User activity | – | – |
| Website content | – | ✔ (tekst rozpoznany przez Meet, nazwa spotkania) |

### Oświadczenia (zaznaczyć wszystkie trzy – dodatek spełnia je w obu wariantach)

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

```text
https://protokolant.marcintabaka.pl/prywatnosc/
```
