import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const metadataProxyPort = Number(process.env.METADATA_PROXY_PORT ?? 4173);

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${metadataProxyPort}`,
          changeOrigin: true
        }
      }
    }
  };
});
