import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

import { DASHBOARD_CSP } from './src/csp'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    // The production policy, so the browser suite runs under it (R3-03).
    headers: {
      'Content-Security-Policy': DASHBOARD_CSP,
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})