# Raven-Radio

World radio with Talk Killer.

## Getting started

```bash
npm install
npm run dev
```

The app runs at `http://127.0.0.1:5173`.

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
