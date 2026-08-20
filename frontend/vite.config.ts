import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The app calls /api/... same-origin, so the dev server has to forward those to FastAPI.
  // host: true also exposes the dev server on the LAN for testing on a real field device.
  server: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
    // Field crews bring whatever tablet or phone they own, so the browser floor has
    // to be wide rather than whatever the toolchain happens to default to.
    //
    // Left unpinned, esbuild minifies media queries into range syntax:
    //     @media (max-width: 768px)  ->  @media (width<=768px)
    // Chrome <104, Safari <16.4 and Firefox <102 do not parse that and discard the
    // whole at-rule - which silently takes every mobile rule in index.css with it and
    // leaves a phone rendering the desktop layout. The landing page survives that
    // because it is fluid by default; the dashboard and field app do not.
    cssTarget: ['chrome87', 'safari14', 'firefox78', 'edge88'],
  }
})
