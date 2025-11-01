## Windows Activity Tracker (Electron + TypeScript)

Cross-platform desktop activity tracker per `spec.md`.

### Scripts

- `npm run dev`: TypeScript watch + start Electron
- `npm run build`: Compile to `dist` and run with `npm start`
- `npm start`: Run Electron using built output

### Setup

1. Install Node.js 18+
2. `npm install`
3. `npm run dev`

Config written to `~/.windows-activity-tracker/config.json` on first run.

### Notes

- Active window detection uses `active-win` on Windows/macOS/Linux when available.
  - macOS fallback: AppleScript
  - Windows/Linux fallback: best-effort via `systeminformation`
- Screenshots use Electron `desktopCapturer`. Controlled via config and rate-limited.
- API endpoints:
  - POST `/collect-activity` with `{ events: ActivityEvent[] }`
  - POST `/collect-screenshot` with `{ deviceId, domain, username, screenshot }`


