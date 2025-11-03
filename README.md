# Windows Activity Tracker

A lightweight, cross-platform desktop activity tracker built with Electron and TypeScript. Runs in the background, captures user activity signals (active window usage, clipboard events, screenshots), and sends structured telemetry to a server for analytics and review.

## Features

- ✅ **Activity Tracking**: Monitors active window changes, focused duration, and idle states
- ✅ **Clipboard Monitoring**: Detects clipboard changes with content type inference
- ✅ **Screenshot Capture**: Optional rate-limited screenshots on window change or click
- ✅ **Multi-User Support**: Automatically detects logged-in user for shared remote desktops
- ✅ **Event Batching**: Buffers events and sends in batches to reduce network overhead
- ✅ **System Tray Integration**: Runs in background with tray menu for Start/Stop/Show/Hide/Quit
- ✅ **Cross-Platform**: Works on Windows, macOS, and Linux
- ✅ **Configurable**: JSON config file with live updates (no restart required)

See `spec.md` for complete specification.

### Scripts

- `npm run dev`: TypeScript watch + start Electron
- `npm run build`: Compile TypeScript to `dist`
- `npm start`: Run Electron using built output
- `npm run dist`: Build for all platforms
- `npm run dist:win`: Build Windows executable (.exe)
- `npm run dist:mac`: Build macOS app (.app, .dmg)

### Setup

1. Install Node.js 18+
2. `npm install`
3. `npm run dev`

Config written to `~/.windows-activity-tracker/config.json` on first run.

### Configuration

The app stores configuration at `~/.windows-activity-tracker/config.json`. You can edit this file directly or the app will create it with defaults on first run.

**Key settings:**

- `serverUrl`: Backend API URL
  - Defaults to `http://localhost:4000` in development
  - Defaults to `https://tracker-dashboard-zw8l.onrender.com` in production builds
- `trackingInterval`: Polling interval in ms (default: 10000)
- `trackClipboard`: Enable clipboard monitoring (default: true)
- `trackScreenshots`: Enable screenshot capture (default: false)
- `screenshotOnWindowChange`: Capture screenshot on window change (default: true)
- `screenshotOnClick`: Capture screenshot on mouse click (default: false)
- `minScreenshotInterval`: Minimum time between screenshots in ms (default: 60000)
- `batchSize`: Number of events to buffer before sending (default: 20)

See the config file for all available options.

### Building Windows Executable

To create a Windows `.exe` file:

1. Install dependencies (if not already done):

   ```bash
   npm install
   ```

2. Build the executable:
   ```bash
   npm run dist:win
   ```

This creates two Windows outputs in the `release/` directory:

- **NSIS Installer**: `Windows Activity Tracker Setup 0.1.0.exe` - Full installer with options
- **Portable**: `Windows-Activity-Tracker-0.1.0-portable.exe` - Standalone executable (no installation needed)

**Note:** Building on macOS/Linux for Windows requires Wine (for NSIS). The portable build works cross-platform without Wine.

For testing, the portable `.exe` is recommended as it requires no installation.

### Building macOS App

To create a macOS `.app` bundle and `.dmg`:

1. Install dependencies (if not already done):

   ```bash
   npm install
   ```

2. Build the macOS app:
   ```bash
   npm run dist:mac
   ```

This creates macOS outputs in the `release/` directory:

- **DMG**: `Windows Activity Tracker-0.1.0-x64.dmg` and `Windows Activity Tracker-0.1.0-arm64.dmg` - Installer disk images
- **ZIP**: `Windows Activity Tracker-0.1.0-x64-mac.zip` and `Windows Activity Tracker-0.1.0-arm64-mac.zip` - App bundles (ready to use)

**Note:**

- Building on macOS for macOS is straightforward.
- Building on Windows/Linux for macOS requires a macOS machine or a CI service.
- Universal builds (both x64 and arm64) are created automatically.
- After first run, grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording.

For testing, the ZIP file contains the `.app` bundle that can be run directly (may need to right-click → Open if macOS Gatekeeper blocks it).

### Multi-User Remote Desktop Deployment

The app automatically detects the current logged-in user for each event, making it suitable for shared remote desktops (Windows RDP, macOS screen sharing, etc.).

**How it works:**

- Each event includes the username of the user who triggered it (detected dynamically via `os.userInfo().username`).
- Events are tagged with the actual logged-in user, not a static hostname or config value.
- Supports per-user tracking when multiple users share the same remote desktop.

**Deployment options:**

1. **Per-User Installation (Recommended):**

   - Each user installs/runs the app in their own session.
   - Config stored in each user's home directory: `~/.windows-activity-tracker/config.json`.
   - Events automatically tagged with the correct username.

2. **System-Wide Installation:**
   - Install once for all users (e.g., in Program Files on Windows).
   - Each user gets their own config file in their home directory.
   - App detects the current user dynamically per event.

**Backend events include:**

- `username`: Actual logged-in user (detected at event time).
- `deviceId`: Unique identifier per installation.
- `domain`: "windows-desktop".
- `type`: "window_activity", "clipboard", or "screenshot".

This allows your backend to track activity per user on shared remote desktops.

## API Integration

### Endpoints

The app sends data to your backend at the configured `serverUrl`:

**POST `/collect-activity`**

- Body: `{ events: ActivityEvent[] }`
- Usage: Sends buffered activity events (window changes, clipboard, screenshot metadata)
- Frequency: Every `trackingInterval` ms or when `batchSize` is reached

**POST `/collect-screenshot`**

- Body: `{ deviceId, domain: 'windows-desktop', username, screenshot: 'data:image/png;base64,...' }`
- Usage: Uploads screenshot image data after local capture
- Frequency: Immediately after capture (rate-limited by `minScreenshotInterval`)

### Event Format

All events include:

- `username`: Current logged-in user (detected dynamically)
- `deviceId`: Unique identifier per installation
- `domain`: `"windows-desktop"`
- `timestamp`: ISO 8601 timestamp
- `type`: `"window_activity"` | `"clipboard"` | `"screenshot"`
- `data`: Event-specific data object

See `src/types/events.ts` for complete type definitions.

## Technical Details

### Active Window Detection

- **Primary**: `active-win` library (cross-platform, accurate)
- **macOS fallback**: AppleScript
- **Windows/Linux fallback**: Best-effort via `systeminformation`

### Screenshot Capture

- **Primary**: `screenshot-desktop` (main process, no permissions needed)
- **Fallback**: Electron `desktopCapturer` (requires screen recording permissions)
- **Rate limiting**: Controlled by `minScreenshotInterval` config
- **Storage**: Screenshots saved locally to `~/.windows-activity-tracker/screenshots/`

### Performance

- Lightweight background process
- Event buffering reduces network overhead
- Configurable polling intervals
- Graceful shutdown flushes buffers before exit

## Troubleshooting

### White Screen on Windows

- Ensure the HTML file is copied correctly: `npm run build` should include `dist/renderer/index.html`
- Check console logs for file path errors
- DevTools open automatically on load failures (check for errors)

### Screenshots Not Working

- **macOS**: Grant Screen Recording permission in System Settings → Privacy & Security → Screen Recording
- Check config: `trackScreenshots` and `screenshotOnWindowChange` must be `true`
- Check logs for screenshot capture errors
- Verify `minScreenshotInterval` isn't too high for testing

### No Events Sent to Backend

- Verify `serverUrl` is correct in config file
- Check network connectivity
- Review console logs for API errors
- Ensure tracking is started (check tray menu: "Start Tracking")

### Permission Issues

- **macOS**: Screen Recording permission required for screenshots
- **Windows**: No special permissions needed for most features
- **Linux**: May require specific desktop environment permissions

## Development

### Project Structure

```
src/
├── main/          # Electron main process
│   ├── main.ts    # App entry point
│   ├── config.ts  # Configuration management
│   ├── activityTracker.ts
│   ├── clipboardMonitor.ts
│   ├── screenshotter.ts
│   └── ...
├── renderer/      # UI (HTML/JS)
│   ├── index.html
│   └── index.ts
├── preload/       # IPC bridge
│   └── preload.ts
└── types/          # TypeScript definitions
    └── events.ts
```

### Building from Source

1. Clone the repository
2. Install dependencies: `npm install`
3. Build TypeScript: `npm run build`
4. Run in dev mode: `npm run dev`
5. Build executables: `npm run dist:win` or `npm run dist:mac`

## License

MIT
