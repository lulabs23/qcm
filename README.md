# Réviseur de QCM

Application web pour réviser des QCM générés par Claude. Aucune dépendance, aucun build, aucun réseau : trois fichiers statiques, les données restent dans le `localStorage` du navigateur.

## Lancer

Ouvre `app/index.html` dans un navigateur, ou sers le dossier :

```sh
python3 -m http.server -d app 8000   # puis http://localhost:8000
```

Pour publier sur GitHub Pages : Settings → Pages → branche `main`, dossier `/app` (ou déplace le contenu de `app/` à la racine).

## Utiliser

1. Demande un QCM à Claude avec la phrase type affichée dans l'écran d'import.
2. Enregistre sa réponse en fichier `.json`.
3. Importe le fichier (bouton ou glisser-déposer), vérifie ce qui a été lu, ajoute à la liste.
4. Lance une session : mode examen, mélange, ou reprise des seules questions ratées.

Un exemple prêt à importer : `app/exemples/restructurations.json`.

## Format attendu

```json
{
  "titre": "Restructurations — QCM 1",
  "matiere": "Fusion / Consolidation",
  "questions": [
    {
      "enonce": "…",
      "propositions": ["…", "…", "…"],
      "reponses": [0],
      "explication": "…",
      "theme": "…"
    }
  ]
}
```

La lecture est tolérante : blocs de code Markdown autour du JSON, tableau de questions seul, plusieurs QCM dans un tableau ou sous la clé `qcms`, et synonymes de clés (`question`/`enonce`, `options`/`propositions`, `answer`/`reponses`, `explanation`/`explication`). `reponses` accepte des index (`[0, 2]`), des lettres (`["A", "C"]`) ou le texte exact des propositions. Plusieurs bonnes réponses = question à réponses multiples. Une question sans énoncé, avec moins de deux propositions ou sans bonne réponse est ignorée et signalée à l'import.

## Comportement

- **Responsive** : sous 900 px, écrans successifs avec barre d'onglets et glissement entre questions ; au-delà, un plan de travail en trois colonnes (liste des QCM · question · correction et fiche de session).
- **Entraînement** : correction et explication après chaque question. **Examen** : aucun retour avant le bilan.
- **Bilan** : score, fiche de résultats dépliable, et relance des seules erreurs.
- **Questions ratées** mémorisées par QCM jusqu'à ce qu'elles soient réussies.
- **Clavier** (bureau) : `A`–`Z` pour choisir, `Entrée` pour valider, `←` `→` pour naviguer, `Échap` pour fermer un panneau.
- **Réglages** : correction immédiate, mélange, glissement, taille du texte, export JSON de tous les QCM, effacement des données.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `app/index.html` | Coque : trois panneaux + barre d'onglets + zone de dépôt |
| `app/styles.css` | Tout le style — jetons de couleur, composants, bascule 900 px |
| `app/app.js` | État, persistance, import tolérant, moteur de session, rendu |
| `app/exemples/restructurations.json` | QCM d'exemple (M2 CCA — fusion / consolidation) |

## Style

Flat, réglé, sans arrondi : Archivo, rouge unique `#ec3013` sur fond `#f3f2f2`, filets de 2 px entre sections, libellés alignés à gauche. Les jetons sont en haut de `styles.css`.
