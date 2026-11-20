import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { FRAME_SRC_POLICY } from '@mmp/shared';

// Frames the app may load (Published page embeds, Review Studio link viewer). Same policy as
// vercel.json (production) and helmet.
const securityHeaders = { 'Content-Security-Policy': FRAME_SRC_POLICY };

/**
 * Quick sign in in a build (VITE_QUICK_LOGIN_IN_BUILD=true) puts the listed passwords in the
 * bundle. It is for test builds only: a production build with it on fails here.
 * The deploy target is VITE_DEPLOY_TARGET, or "production" on a Vercel production deploy.
 */
export function quickLoginGuard(): Plugin {
  return {
    name: 'quick-login-guard',
    config(_config, { command, mode }) {
      if (command !== 'build') return;
      const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...pick(process.env, ['VITE_QUICK_LOGIN_IN_BUILD', 'VITE_DEPLOY_TARGET']) };
      const target = env.VITE_DEPLOY_TARGET || (process.env.VERCEL_ENV === 'production' ? 'production' : '');
      if (env.VITE_QUICK_LOGIN_IN_BUILD === 'true' && target === 'production') {
        throw new Error(
          'Quick sign in is on (VITE_QUICK_LOGIN_IN_BUILD=true) for a production build (VITE_DEPLOY_TARGET=production). ' +
            'It would put passwords in the bundle. Remove VITE_QUICK_LOGIN_IN_BUILD from apps/web/.env.local and build again.'
        );
      }
    },
  };
}
const pick = (src: Record<string, string | undefined>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, String(src[k])]));

export default defineConfig({
  plugins: [react(), quickLoginGuard()],
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
