# ToothTarget - OneDrive safety copies

When this device and OneDrive both change and the app asks you to resolve
the differences, it saves a safety copy of BOTH sides before applying
anything, so a wrong choice can be undone.

## Where the files are

In the OneDrive **App Folder** for ToothTarget (OneDrive > Apps > the
ToothTarget folder), next to `toothtarget-sync.json` and the
`toothtarget-backup-A/B/C-<date>.json` backups. Two files per resolution:

- `toothtarget-resolution-<date-time>-device.json` - this device's data as it was
- `toothtarget-resolution-<date-time>-cloud.json` - OneDrive's data as it was, before it was replaced

The `<date-time>` is when it was saved (for example `2026-10-06T01-20-45-123Z`).
They are kept for the **last 5 resolutions** (10 files); older ones are removed
automatically. This device keeps the last 2. There is no time limit. The A/B/C
backups are separate and are never touched by this.

## Undo from inside the app

Settings > Microsoft Account > **Safety copies** lists them. Pick one, read the
warning, and confirm - it replaces this device's data with that copy (after
saving what is on this device now), marks the device as having unsynced
changes, and the app then syncs normally. If OneDrive has changed since, you
are taken back to the screen that compares the two sides.

## Recover one by hand (without the app)

1. Open the file in OneDrive (or download it). It is plain JSON.
2. The records are inside the `document` field: `patients`, `savedTreatments`,
   `customTemplates` and `customProcedures`.
3. To put the whole thing back: in the app, use **Safety copies** above - that
   is the safe way. To read a single patient or treatment, open the file in any
   text editor and search for the name.
4. Do not rename, edit or upload these files back into the App Folder as
   `toothtarget-sync.json` - the app expects its own format and checks it.

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Offline use and updates (service worker)

ToothTarget installs a small hand-written service worker (`public/sw.js`)
that keeps a copy of the whole app on the device, so it opens with no
network. The page side is `src/appUpdate.ts`; the build step that stamps
each build is `scripts/swBuild.ts`.

- **One set per build.** Every file of a build is saved together under one
  name (`toothtarget-<build id>`). If any file fails to download, the new
  version is not installed and the old one keeps running, so the app never
  mixes files from two builds.
- **Never touched by the worker:** other sites (Microsoft login, Graph /
  OneDrive), anything that is not a plain GET, `src/redirect.html` and its
  script, any address carrying sign-in parameters (`code=`, `state=`,
  `error=`, `id_token=` ...), and `sw.js` itself.
- **Updates never reload the page by themselves.** A new version installs in
  the background and waits. An "Update available - reload" banner appears;
  it is hidden while the timer screen has an active treatment and shows up
  once you leave it. Nothing happens until you press **Reload**.
- **Settings > App Version** shows the version (`date · build id`), and
  the update button when a new version is waiting. The worker also
  re-checks for a new version whenever the app returns to the foreground.
- Patients, treatments, templates and sign-in live in the browser's
  localStorage. The service worker, the update banner and Reset app cache
  never read or write it.

### The first deploy of this worker (what to expect)

The worker that is live today (network-first for the page, calls
`skipWaiting`) is replaced by this one the next time a device opens the app.
Be aware this is **not** instant and **not** silent:

1. The browser fetches the new `sw.js` and installs it in the background.
   The new worker does NOT call `skipWaiting`, so it waits.
2. The app keeps working exactly as before until the new worker takes over.
   It takes over when you press **Reload** on the banner, or after the app
   has been fully closed and reopened (on an iPad: swipe it away, then open
   it again).
3. The page opened after the deploy is already the new build (the old worker
   loads the page from the network), so it contains the banner code and will
   show "Update available - reload" for that one waiting worker. Pressing
   Reload then reloads once and the offline copy is in place.
4. If you never press it, nothing breaks: the old behaviour continues until
   the next full close and reopen.

This is expected behaviour from reading the code and the headless check
below; it has not been observed on a real iPad yet.

### Service worker kill switch (if a bad worker ever ships)

Pick the first one that works:

1. **In the app:** Settings > App Version > **Reset app cache**. It removes
   the worker and the service worker's own caches only, then reloads once.
   Your data is not touched.
2. **If the app will not even load:** replace `public/sw.js` with the
   contents of `public/sw.kill.js`, then deploy (merge to `main`). Browsers
   re-fetch `sw.js` on every visit, so each device removes its worker and
   clears the `toothtarget-*` caches the next time it opens the app. After
   that, restore the real `sw.js` in a later deploy.
3. **Last resort on a device:** iPad Settings > Safari > Advanced > Website
   Data > remove the site. This also clears that site's localStorage, so
   export a backup first if the data is not synced.

### Checking it locally

```
npm run build
npm run preview -- --base /ToothTarget/
```

Open `http://localhost:4173/ToothTarget/` (the `--base` flag matters: without
it the preview serves from `/` and does not match the real deployment).
`npm run dev` does not register the worker.

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
