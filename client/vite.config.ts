import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1000,
  },
});
