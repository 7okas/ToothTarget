import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  /*
    Only the production build (npm run build, which also runs before
    the GitHub Pages deploy) is served from the /ToothTarget/ subpath.
    Local dev (npm run dev / command === 'serve') stays at the root
    path, exactly as before this base path was introduced - otherwise
    import.meta.env.BASE_URL changes locally too, which changes
    authConfig.ts's computed redirectUri to a URL that was never
    registered in the Entra app registration for local testing,
    breaking sign-in with an invalid_request/redirect_uri error.
  */
  base: command === 'build' ? '/ToothTarget/' : '/',
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
}))
