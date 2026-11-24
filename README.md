# TempChat

Tymczasowe pokoje do rozmów i przenoszenia projektów między komputerami. Administrator tworzy pokój, a uczestnicy dołączają nickiem i kodem w formacie `123 - 456` lub linkiem.

- Czat z wyróżnieniem własnych wiadomości, rozwijanym podglądem długiego tekstu i licznikiem uczestników otwierającym ich listę.
- Osobna galeria z nazwanymi fragmentami kodu, plikami i całymi folderami. Wyszukiwanie w galerii obejmuje nazwy zasobów i ścieżki w ich najnowszych wersjach. Przeglądarka zasobów ma też wyszukiwanie w wybranym folderze, podgląd tabel CSV i TSV oraz pobieranie pojedynczych plików i folderów jako ZIP.
- Historia wersji i porównanie tekstu w dwóch kolumnach lub w jednym widoku. Przywrócenie zapisuje kolejną wersję.
- Edytor kodu z numerami linii, kolorowaniem składni i ligaturami Fira Code. Pliki tekstowe UTF-8 do 256 KiB można edytować w najnowszej wersji folderu. Zapis zmienionego pliku tworzy kolejną wersję folderu. Jeśli ktoś wcześniej zapisze nową wersję, edytor pozwala przejść do aktualnej wersji.
- Panel administratora pod `/admin` pozwala utworzyć pokój, zmienić czas przechowywania i zamknąć pokój z natychmiastowym usunięciem danych.

Pokój pozostaje dostępny po rozłączeniu ostatniego uczestnika. Domyślnie wygasa po 24 godzinach bez osób online. Pole retencji w panelu przyjmuje wartości od 1 do 8760 godzin. Zamknięcie lub wygaśnięcie usuwa z bazy wiadomości, fragmenty kodu, pliki, wersje i sesje uczestników. Pobrane kopie pozostają na urządzeniach uczestników. Pełne puste katalogi można przesłać przez przeciągnięcie folderu lub systemowy wybór katalogu w przeglądarkach obsługujących File System Access API. Zastępczy selektor folderu opiera się na liście plików, więc pomija puste katalogi.

Limit jednej przesyłki wynosi 64 MiB danych i 10 000 elementów. Lista ścieżek może zajmować dodatkowe 4 MiB. Limit unikatowej zawartości plikowej wynosi 512 MiB na pokój. Dane są zapisywane w lokalnym SQLite na nazwanym wolumenie Dockera.

## Portainer na Docker Standalone

1. W Portainerze przejdź do **Stacks → Add stack → Web editor**. Nazwij stack `rooms`.
2. Wklej zawartość [`portainer.yaml`](portainer.yaml). Docker pobierze źródła z gałęzi `main` publicznego repozytorium.
3. Dodaj w **Environment variables** zmienną `ADMIN_PASSWORD` z własnym hasłem administratora o długości od 12 do 1024 znaków. Wygeneruj je np. poleceniem `openssl rand -hex 24`.
4. Wybierz **Deploy the stack**. Docker zbuduje obraz ze źródeł i udostępni aplikację na porcie `3087` hosta.

Domyślny adres aplikacji to `https://tempchat.wiaderek.xyz`. Przy innej domenie ustaw `APP_URL` w zmiennych stacka na dokładny adres publiczny z protokołem, np. `https://chat.example.org`. Przy zmianie adresu zapisz ustawienia i wdróż ponownie istniejący stack.

W trybie **Git repository** wskaż `https://github.com/WiaderekB/TempChat.git`, gałąź `refs/heads/main` i plik `compose.yaml`. Publiczne repozytorium jest dostępne bez logowania.

Jeśli Portainer zarządza zdalnym Dockerem i odrzuca krok budowania, wykonaj poniższe polecenia przy pierwszym uruchomieniu w klonie repozytorium na hoście Dockera.

```sh
printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
chmod 600 .env
docker compose -p rooms up -d --build
```

Przy aktualizacji przez Git pobierz zmiany i ponownie zbuduj obrazy. Zachowaj wolumen `rooms_data`, aby przenieść istniejące pokoje do nowego kontenera. W edytorze Portainera zastąp zawartość stacka aktualnym `portainer.yaml`, aby dodać usługę `tex`.

## LaTeX

Otwórz główny plik `.tex` projektu albo kompletny fragment LaTeX w galerii zasobów. Wybierz **pdfLaTeX** lub **XeLaTeX** i kliknij **Render PDF**. Możesz wyświetlić wynik, otworzyć go w osobnej karcie albo pobrać. Kompilacja używa plików z otwartej wersji folderu. Pliki dołączane przez dokument mogą znajdować się obok niego lub w katalogu głównym projektu.

Obraz TeX Live zawiera m.in. AMS, `graphicx`, TikZ, pakiety naukowe, polskie wzorce dzielenia wyrazów i BibTeX. Własne pliki `.sty`, `.cls`, `.bib` oraz grafiki dodaj do folderu. Dostępne są pakiety z obrazu i z folderu. Usługa kompiluje bez dostępu do sieci, poleceń powłoki i wolumenu pokoi. Limit to 35 sekund na kompilację i 16 MiB na PDF. Bibliografie uruchamiane przez Biber oraz pakiety wymagające uruchamiania poleceń powłoki są poza obsługiwanym zestawem.

Opcja **Render PDF** jest dostępna po uruchomieniu stacka w Dockerze. Samo uruchomienie lokalnego serwera Pythona udostępnia podgląd źródła.

## Nginx Proxy Manager

Dodaj **Proxy Host** z następującymi ustawieniami:

| Pole | Wartość |
| --- | --- |
| Domain Names | `tempchat.wiaderek.xyz` |
| Scheme | `http` |
| Forward Hostname / IP | Adres LAN hosta Dockera |
| Forward Port | `3087` |
| Websockets Support | Wyłączone. TempChat odświeża rozmowę przez HTTP. |
| SSL | Certyfikat dla `tempchat.wiaderek.xyz` i włączone **Force SSL** |

W zakładce **Advanced** dodaj dyrektywę umożliwiającą przesłanie 64 MiB danych z listą ścieżek.

```nginx
client_max_body_size 69m;
```

Rekord DNS `tempchat` skieruj na adres używany przez Nginx Proxy Manager. Publiczny ruch kieruj do NPM na porty 80 i 443. Portu 3087 używa NPM do połączenia z hostem Dockera. Jeśli chcesz liczyć limity prób osobno dla adresów klientów, ustaw opcjonalne `TRUSTED_PROXY` na adres lub CIDR zaufanego NPM widziany przez kontener. Proxy musi ustawiać `X-Real-IP` na adres klienta.

Po wdrożeniu sprawdź `https://tempchat.wiaderek.xyz/api/health`, a następnie zaloguj się na `https://tempchat.wiaderek.xyz/admin` i utwórz pierwszy pokój.

[Dokumentacja stacków w Portainerze](https://docs.portainer.io/user/docker/stacks/add)

## Uruchomienie lokalne i testy

Wymagany Python 3.12 lub nowszy.

```sh
ADMIN_PASSWORD="$(openssl rand -hex 24)"
printf 'Hasło do lokalnego panelu: %s\n' "$ADMIN_PASSWORD"
export ADMIN_PASSWORD
python3 server.py
```

Aplikacja lokalna działa pod `http://localhost:3087`. Testy używają tymczasowej bazy:

```sh
python3 -m unittest discover -s tests -v
```
