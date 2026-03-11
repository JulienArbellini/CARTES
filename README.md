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
- `GITHUB_BRANCH` (optionnel): défaut `main`

## Déploiement Vercel

1. Push le repo sur GitHub.
2. Import le projet dans Vercel.
3. Ajoute les variables d'environnement ci-dessus dans Vercel.
4. Deploy.

## Workflow UI

1. Importe ton `.geojson`.
2. (Optionnel) Renseigne un nombre cible de super-régions. Laisse vide pour laisser l'IA choisir un nombre naturel.
3. Clique `Generer les regles avec OpenAI` (ou saisis tes lignes à la main).
4. Ajuste les règles si besoin.
5. Vérifie la `Preview carte interactive` (source + résultat).
6. Clique `Generer super-regions`.
7. Clique `Publier et recuperer URL raw`.

## Endpoints API

- `POST /api/openai/suggest`
  - entrée: `{ regions, style, superRegionCount?, countryHint? }`
  - sortie: `{ rules: [{source,target}], groupNames, chosenCount, notes }`

- `POST /api/github/publish`
  - entrée: `{ path, message, geojson }`
  - sortie: `{ rawUrl, path, branch, commitSha }`

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
  --normalize
```
