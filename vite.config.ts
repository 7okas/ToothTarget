import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/ToothTarget/',
  build: {
    rollupOptions: {
      input: {
        /*
          Two independent pages, per Vite's standard multi-page-app
          pattern: the normal ToothTarget app (index.html -> main.tsx,
          unchanged), and the dedicated MSAL popup redirect bridge
          (src/redirect.html -> src/redirect.ts) that the Microsoft
          login popup navigates to - it never renders any part of the
          app, so it must be its own entry, not a route inside it.
        */
        main: 'index.html',
        redirect: 'src/redirect.html',
      },
    },
  },
})
