repo: lulabs23/qcm
branch: main

## Last sync

date: 2026-09-13T00:00:00Z
note: dépôt vide à la lecture (aucun commit sur main) — rien à importer ; le code de l'application a été écrit ici pour être committé côté GitHub.

### Updated in this project

- Application web autonome créée dans `app/` (HTML + CSS + JS, sans build)
- Import tolérant de fichiers .json générés par Claude, données en localStorage
- Mise en page responsive : écrans mobiles sous 900 px, plan de travail 3 colonnes au-delà
- README de dépôt et QCM d'exemple ajoutés

## Screen map

| Écran du projet | Fichiers du dépôt |
| --- | --- |
| Accueil / liste des QCM | app/index.html, app/app.js (viewHome, paneList), app/styles.css |
| Import d'un script .json | app/app.js (sheetImport, readPayload, ingestFiles) |
| Question en cours + correction | app/app.js (viewSession, validate, bindSwipe) |
| Bilan de session / revue des erreurs | app/app.js (viewResults, fiche, replayWrong) |
| Progression | app/app.js (viewStats, overall, bySubject) |
| Réglages | app/app.js (viewSettings) |
| Maquettes de référence | Réviseur QCM mobile.dc.html (non versionné côté dépôt) |
