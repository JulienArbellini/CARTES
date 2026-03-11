# CARTES

GeoJSON tools + visual web app to build super-regions and publish output to GitHub.

## Main goal

1. import a GeoJSON from the browser,
2. add only a few assignment lines (`source region` -> `super region`),
3. generate merged GeoJSON,
4. publish file to GitHub,
5. copy raw URL and use it in your travel website.

The source GeoJSON is never modified.

## Visual app (Vercel-ready)

### Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Deploy on Vercel

1. Push this repo to GitHub.
2. Import project in Vercel.
3. Add environment variables from `.env.example`:

- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH` (optional, default `main`)

4. Deploy.

The app has a server route at `app/api/github/publish/route.js` that commits generated GeoJSON into your repo and returns a raw URL.

## How the UI works

1. Upload a `.geojson`/`.json` file.
2. Pick source field (`NAME_1` by default).
3. Add only needed lines in the visual table:
- source region: `ChiangMai`
- super region: `North`
4. Click `Generate super-regions`.
5. Click `Publish and get raw URL`.

Default behavior for unmapped regions is `keep-source`.

## NPM scripts

- `npm run dev`: run Next.js app
- `npm run build`: production build
- `npm run start`: run production app
- `npm run superregions:init-mapping`: CLI template generator
- `npm run superregions:build`: CLI super-region builder

## CLI mode (optional)

If you want batch/offline processing without UI:

```bash
npm run superregions:build -- \
  --input path/to/gadm41_THA_1.json \
  --mapping mappings/thailand_macro_regions.json \
  --output output/thailand_macro_regions.geojson \
  --normalize
```

Supported mapping formats:

- JSON object: `{"ChiangMai":"North"}`
- JSON compact: `{"North":["ChiangMai","ChiangRai"]}`
- JSON list: `[{"source":"ChiangMai","target":"North"}]`
- CSV: `source,target`

## Existing sample mapping

- `mappings/thailand_macro_regions.json`
