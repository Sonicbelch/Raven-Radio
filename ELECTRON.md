# Running Raven Radio as a Desktop App

Electron removes the CORS restriction that prevents Talk Killer from analysing BBC HLS streams.

## Setup

```bash
npm install
```

## Development

```bash
npm run electron:dev
```

Builds the app then launches it in Electron.

## Package (distributable)

```bash
npm run electron:build
```

Outputs a `.dmg` (macOS) or `.AppImage` (Linux) in the `dist-electron/` folder.
