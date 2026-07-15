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
