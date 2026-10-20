import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * Dev ports are configurable purely so a local machine with something already
 * on 3000 can still run the sim. Production is unaffected and always serves
 * everything from port 3000, which the Engine session contract requires.
 */
const DEV_PORT = Number(process.env.VITE_PORT || 3000);
const API_PORT = Number(process.env.API_PORT || 3001);
const API = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  root: './client',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    hmr: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/__mock': { target: API, changeOrigin: true },
      '/message': { target: API, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
