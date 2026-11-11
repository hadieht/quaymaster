import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { InlineConfig } from 'vitest/node';

// Dev: the SPA runs on 5173 and proxies /api to the Quaymaster server. The server checks the Origin header
// of mutating requests, so the proxy rewrites it to the target's own origin.
const target = process.env['QM_DEV_API'] ?? 'http://127.0.0.1:8787';

export default defineConfig({
  // two vite majors are installed (root: vitest 2 for the server, web: vite 6), so the plugin types differ
  plugins: [react() as never],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@quaymaster/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin')) req.setHeader('origin', target);
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: { charts: ['recharts'], vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
