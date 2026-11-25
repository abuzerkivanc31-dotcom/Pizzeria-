# Pizza & Baguettehaus am Königspalast

Website für das Pizza & Baguettehaus am Königspalast, Westparkstraße 102, 47803 Krefeld.

## Ordner

| Ordner / Datei | Inhalt |
| --- | --- |
| `public/` | Die Website: `index.html`, `impressum.html`, `datenschutz.html`, Eventtage (`events.js`, `events.json`), Bilder in `public/img/` |
| `netlify/functions/` | `api.mjs` speichert Status, Preisumschaltung und Preise des Inhabers. `events-refresh.mjs` aktualisiert alle 6 Stunden die Eventtage der YAYLA Arena. |
| `tools/` | Hilfsskripte für den eigenen PC: Testserver (`serve.ps1`, `serve-lan.ps1`) und Termine von Hand einlesen (`update-events.ps1`). `archiv/` enthält die alte Cloudflare-Variante. |
| `netlify.toml` | Netlify-Einstellungen (Website liegt in `public`) |
| `package.json` | Benötigtes Paket für die Funktionen (`@netlify/blobs`) |

## Netlify einrichten

- **Umgebungsvariable `OWNER_PIN`** (als Secret, Bereich Functions): die PIN des Inhabers für den Inhaber-Login.
- Repository mit Netlify verbinden: Branch `main`, Build command leer, Publish directory `public` (steht auch in `netlify.toml`).

## Lokal ansehen

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Dann `http://localhost:8080` öffnen. Ohne Netlify-Funktionen läuft der Inhaber-Login im Testmodus (PIN 1234, gilt nur im eigenen Browser).
