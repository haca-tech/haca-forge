import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { webContentSecurityPolicy } from '@mmp/shared';

// Frames the app may load (Published page embeds, Review Studio link viewer; FRAME_SRC_POLICY) and
// where files come from (the file CDN). Same policy as vercel.json (production) and helmet, plus
// this machine's hosts for development (a local mock Bunny server, the dev server's socket).
const securityHeaders = {
  'Content-Security-Policy': webContentSecurityPolicy(['http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*']),
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    headers: securityHeaders,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: {
                    code: 'SERVER_RESTARTING',
                    message: 'API server is momentarily restarting. Please retry in a moment.',
                  },
                })
              );
            }
          });
        },
      },
      '/uploads': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:8080',
        ws: true,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    headers: securityHeaders,
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
          'vendor-charts': ['recharts'],
          'vendor-video': ['video.js'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
});
