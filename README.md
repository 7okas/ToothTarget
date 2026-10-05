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
