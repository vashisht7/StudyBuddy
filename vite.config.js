import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Proxy local Ollama requests to bypass browser CORS restrictions
      '/api/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ollama/, ''),
      },
    },
  },
});
