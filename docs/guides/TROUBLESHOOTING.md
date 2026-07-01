# Troubleshooting

Fixes for common problems running, building, and packaging the API Workbench desktop app (`apps/desktop`). Commands run from the repository root unless noted.

## `Error: Electron uninstall` when starting the dev server

### Symptom

`npm run dev` (or `npm run start`) fails immediately, before any window opens, with a stack trace through `electron-vite`:

```
Error: Electron uninstall
    at getElectronPath (file:///<folder-path>/API-Workbench/node_modules/electron-vite/dist/chunks/lib-BmEkZIgk.mjs:129:19)
    at startElectron (file:///<folder-path>/API-Workbench/node_modules/electron-vite/dist/chunks/lib-BmEkZIgk.mjs:198:26)
    at createServer (file:///<folder-path>/API-Workbench/node_modules/electron-vite/dist/chunks/lib-t2ExBjL5.mjs:74:14)
    at async CAC.<anonymous> (file:///<folder-path>/API-Workbench/node_modules/electron-vite/dist/cli.mjs:67:9)
npm error Lifecycle script `dev` failed with error:
npm error code 1
npm error workspace @api-workbench/desktop@0.1.0
npm error location \API-Workbench\apps\desktop
```

### Cause

The `electron` npm package is installed, but its **native binary was never downloaded**. The `electron` package ships only JavaScript; a `postinstall` script (`node_modules/electron/install.js`) downloads the matching Electron runtime into `node_modules/electron/dist/` and writes `node_modules/electron/path.txt`. When that step is skipped or fails, `electron-vite` can't resolve the executable and aborts with `Electron uninstall`.

The postinstall is commonly skipped or broken when:

- `npm install` ran with `--ignore-scripts` (or a global / `.npmrc` `ignore-scripts=true`),
- the binary download failed behind a proxy / firewall, timed out, or had no network access,
- `node_modules/electron/dist/` was partially deleted or never extracted.

### Fix

Re-run Electron's own installer, which downloads and extracts the binary and writes `path.txt`:

```bash
node node_modules/electron/index.js
```

`index.js` calls `getElectronPath()`; when the `dist` binary is missing it invokes `install.js` to download it. Equivalently you can run the installer directly:

```bash
node node_modules/electron/install.js
```

Then start the app again:

```bash
npm run dev
```

### If it still fails

The download itself is failing (network/proxy). Delete the broken install and reinstall cleanly:

```bash
# remove the broken electron install and re-fetch
rm -rf node_modules/electron
npm install
```

Behind a corporate proxy or firewall, point Electron at a reachable mirror before reinstalling, e.g.:

```bash
# bash / Git Bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node node_modules/electron/install.js
```

```powershell
# PowerShell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```

### Verify

The install is healthy when both of these exist:

- `node_modules/electron/path.txt` — contains `electron.exe` on Windows, `electron` on Linux, `Electron.app/Contents/MacOS/Electron` on macOS.
- `node_modules/electron/dist/` — the extracted runtime (contains `electron.exe` on Windows).

## App crashes on launch with `Cannot read properties of undefined (reading 'isPackaged')`

### Symptom

The renderer dev server starts fine (`http://localhost:5173`), but the moment Electron's main process launches it crashes — no window opens:

```
const isDev = !electron.app.isPackaged;
                            ^
TypeError: Cannot read properties of undefined (reading 'isPackaged')
```

Blanking the variable instead of removing it produces a different crash from the same root cause:

```
Assertion failed: (isolate_data->snapshot_data()) != nullptr
npm error code 134
```

### Cause

The `ELECTRON_RUN_AS_NODE` environment variable is set (to `1`, or even to an empty string). When present, it forces the Electron binary to run as **plain Node.js**, so Electron's own APIs are never injected — `require('electron')` returns the path string instead of the module, and `electron.app` is `undefined`. Some shells/terminals (and some tooling harnesses) export this on every new session, so it comes back even after you `unset` it.

### Fix

Remove the variable entirely from the child process — don't just blank it (an empty-but-present value still triggers the crash):

```bash
# bash / Git Bash — remove it only for this command
env -u ELECTRON_RUN_AS_NODE npm run dev
```

```powershell
# PowerShell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
```

If it keeps coming back, whatever sets it lives in your shell profile or terminal configuration — remove the `ELECTRON_RUN_AS_NODE` export there for a permanent fix.

### Verify

```bash
# should print nothing (variable absent)
env -u ELECTRON_RUN_AS_NODE bash -c 'echo "[${ELECTRON_RUN_AS_NODE:-unset}]"'
```

A healthy launch logs `Application ready` and then `Main window shown`.
