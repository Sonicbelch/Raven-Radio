# Raven-Radio

World radio with Talk Killer.

## Getting started

```bash
npm install
npm run dev
```

The app runs at `http://127.0.0.1:5173`.

### Metadata proxy (optional)

The app can use a lightweight metadata proxy to avoid CORS issues with station
metadata JSON endpoints. The proxy only handles metadata JSON (not audio
streams).

**Development**

`npm run dev` now starts both Vite and a local proxy server. Vite forwards
`/api/metadata` requests to the proxy, which listens on port `4173` by default.
You can change the proxy port with `METADATA_PROXY_PORT=1234 npm run dev`.

**Production**

Set `VITE_METADATA_PROXY=true` at build time to enable proxy usage in the
frontend.

**Vercel**

Deploy the repo as a Vercel project. The serverless function at
`/api/metadata` is included in `api/metadata.js`. Once deployed, set
`VITE_METADATA_PROXY=true` in the Vercel project environment variables.

**Netlify**

Deploy the repo to Netlify. The function lives in
`netlify/functions/metadata.js`, and `netlify.toml` maps `/api/metadata` to the
function automatically. Set `VITE_METADATA_PROXY=true` in the Netlify build
environment.

## Features

- Station directory with search/filter by name, country, and tags.
- Player with native `<audio>` playback, volume, and error handling.
- Favourites and Fallback lists stored in `localStorage`.
- Talk Killer speech-ish detection with auto-switching and a live debug meter.

## Known limitations

- Some streams do not allow audio analysis (CORS/tainted media). When that happens,
  Talk Killer disables itself for that station while playback still works.
- Stream metadata is best-effort. Only stations with metadata endpoints will show
  now-playing details.

## Adding stations

Edit `src/stations.json` and add a new object with:

- `id`: unique string
- `name`: display name
- `country`
- `tags`: array of tag strings
- `url`: stream URL (MP3/AAC Icecast/Shoutcast preferred)
- `codec`: display hint (MP3/AAC)
- `metadataUrl` (optional): JSON endpoint for now-playing metadata
