# Remote Desk Hub

Pannello web locale per gestire file e aprire app consentite sul PC.

## Avvio

```powershell
node server.mjs
```

Apri `http://127.0.0.1:8787` e usa la password stampata nel terminale.
Se non imposti una password, viene creata in `data/admin-password.txt`.

## Accesso da un altro dispositivo

Usa una VPN privata o una rete affidabile. Per ascoltare anche sulla rete:

```powershell
$env:HOST="0.0.0.0"; node server.mjs
```

Non esporre questa porta direttamente su Internet. Il pannello non esegue
comandi arbitrari e non eleva privilegi di sistema.
