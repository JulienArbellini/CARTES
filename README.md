# CARTES

Outil visuel pour:

1. importer un GeoJSON,
2. générer automatiquement des super-régions (OpenAI) ou les éditer manuellement,
3. prévisualiser la carte interactive avant envoi,
4. publier le GeoJSON final sur GitHub,
5. récupérer l'URL raw pour ton site.

## Lancer en local

```bash
npm install
npm run dev
```

Puis ouvre `http://localhost:3000`.

## Variables d'environnement

Copie `.env.example` vers `.env.local` et complète:

- `OPENAI_API_KEY`: clé API OpenAI
- `OPENAI_MODEL` (optionnel): défaut `gpt-4.1-mini`
- `GITHUB_TOKEN`: token GitHub avec `Contents: Read and write`
- `GITHUB_OWNER`: ex `JulienArbellini`
- `GITHUB_REPO`: ex `CARTES`
- `GITHUB_PUBLISH_BRANCH` (optionnel): défaut `generated-geojson`
- `GITHUB_BASE_BRANCH` (optionnel): défaut `main` (sert à créer la branche de publish si absente)

## Déploiement Vercel

1. Push le repo sur GitHub.
2. Import le projet dans Vercel.
3. Ajoute les variables d'environnement ci-dessus dans Vercel.
4. Deploy.

## Workflow UI

1. Importe ton `.geojson`.
2. (Optionnel) Renseigne un nombre cible de super-régions. Laisse vide pour laisser l'IA choisir un nombre naturel.
   Si tu renseignes une valeur (ex: 4), l'API essaie de rester exactement à ce nombre.
3. Clique `Generer les regles avec OpenAI` (tourisme culturel/activités + contiguïté spatiale).
4. Ajuste les règles si besoin.
5. Choisis le mode de sortie:
   - `assign-only` (recommandé): pas de fusion géométrique, juste une colonne de super-région.
   - `dissolve`: fusion géométrique réelle.
6. Vérifie la `Preview carte interactive` (source + résultat).
7. Clique `Generer super-regions`.
8. Clique `Publier et recuperer URL raw`.

## Endpoints API

- `POST /api/openai/suggest`
  - entrée: `{ regions, adjacencyGraph, style, superRegionCount?, countryHint? }`
  - sortie: `{ rules: [{source,target}], groupNames, chosenCount, notes, contiguity }`

- `POST /api/github/publish`
  - entrée: `{ path, branch?, baseBranch?, message, geojson }`
  - sortie: `{ rawUrl, path, branch, baseBranch, commitSha }`

## Scripts npm

- `npm run dev`: app Next.js
- `npm run build`: build production
- `npm run start`: run production
- `npm run superregions:init-mapping`: CLI template CSV
- `npm run superregions:build`: CLI merge GeoJSON

## CLI (optionnel)

```bash
npm run superregions:build -- \
  --input path/to/gadm41_THA_1.json \
  --mapping mappings/thailand_macro_regions.json \
  --output output/thailand_macro_regions.geojson \
  --merge-mode assign-only \
  --normalize
```
