# Prenotazioni tavoli festa

Web app locale per assegnare i tavoli della festa dagli organizzatori.

## Avvio

```powershell
npm.cmd install
npm.cmd start
```

Apri `http://127.0.0.1:8787`.

## File principali

- `tables.json`: numeri tavolo, capienza, interno/esterno e coordinate sulla piantina.
- `data/reservations.sqlite`: database SQLite con le prenotazioni.
- `public/assets/map-esterno.png` e `public/assets/map-interno.png`: immagini della piantina.

Per usare un tablet nella stessa rete:

```powershell
$env:HOST="0.0.0.0"; npm.cmd start
```

Poi apri dal tablet `http://IP_DEL_PC:8787`.

## Pubblicazione online

Ci sono due modalita' di pubblicazione.

### GitHub Pages

La cartella `docs/` contiene la versione statica per GitHub Pages:

```text
https://cinemabot-star.github.io/prenotazioni-tavoli-festa/
```

Su GitHub Pages le prenotazioni vengono salvate nel browser del dispositivo tramite `localStorage`. Restano presenti quando riapri il link dallo stesso browser, ma non sono condivise automaticamente tra dispositivi diversi.

### Render con SQLite persistente

Il progetto include `render.yaml` per pubblicare l'app come servizio Node.js su Render con disco persistente.

Il database SQLite online viene salvato in `/var/data/reservations.sqlite`, cioe' nel disco persistente configurato nel blueprint. Senza disco persistente i dati verrebbero persi a ogni riavvio o nuovo deploy.

Repository GitHub:

```text
https://github.com/CINEMABOT-star/prenotazioni-tavoli-festa
```

Deploy:

```text
https://render.com/deploy?repo=https://github.com/CINEMABOT-star/prenotazioni-tavoli-festa
```
