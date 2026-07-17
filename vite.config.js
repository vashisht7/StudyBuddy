import { defineConfig } from 'vite';

const localAIProxy = {
  '/api/ollama': {
    target: 'http://localhost:11434',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/ollama/, ''),
  },
};

export default defineConfig({
  server: {
    proxy: localAIProxy,
  },
  preview: {
    proxy: localAIProxy,
  },
});
