# Telewizja (tv-pilot)

Moduł do [TizenBrew](https://github.com/reisxd/TizenBrew), który dodaje pełną obsługę zwykłym pilotem telewizora Samsung do serwisu z telewizją w przeglądarce (adres strony jest w `package.json`).

## Co daje

- Start od razu na ostatnio oglądanym kanale, obraz na pełnym ekranie.
- Zmiana kanałów przyciskami CH+ / CH− (albo strzałkami ▲▼), wybór numerem jak w zwykłej telewizji.
- Lista kanałów pod przyciskiem OK, pasek z nazwą programu i postępem.
- Całe menu serwisu da się obsłużyć strzałkami, a żółta ramka pokazuje, co jest zaznaczone.

## Instalacja

1. Na telewizorze otwórz TizenBrew → menedżer modułów → dodaj moduł z GitHuba: `nazwa-użytkownika/tv-pilot`.
2. Uruchom „Telewizja” i za pierwszym razem zaloguj się na stronie serwisu (sesja zostaje zapamiętana w telewizorze).

## Pilot

| Przycisk | W trybie telewizji | W menu |
|---|---|---|
| CH+ / CH−, ▲ / ▼ | następny / poprzedni kanał | ▲▼ poruszanie się po menu |
| cyfry (przycisk 123) | kanał o tym numerze | kanał o tym numerze |
| OK | lista kanałów | wybór zaznaczonego elementu |
| ◀ | lista kanałów | poruszanie się po menu |
| ▶ / Info | informacja o programie | poruszanie się po menu |
| Wstecz | menu serwisu | powrót (na stronie telewizji: do pełnego ekranu) |
| przytrzymanie Wstecz | wyjście z aplikacji | wyjście z aplikacji |
| Play/Pauza | pauza / wznowienie | pauza / wznowienie |
| czerwony / zielony / żółty / niebieski | strona główna / EPG / VOD / telewizja | to samo |

## Aktualizacja

Po zmianie plików na GitHubie podbij `version` w `package.json`. jsDelivr, z którego TizenBrew pobiera moduł, może trzymać starą wersję do kilku godzin.
