import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /.*\/profile\.model\.js$/,
        replacement: path.resolve(__dirname, 'test/fixtures/profile.mock.js'),
      },
    ],
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 15000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/marketing_portal_test',
      // Test-only signing secrets, so a fresh checkout runs without a .env. They sign tokens
      // for the test database only and are never used anywhere else.
      JWT_SECRET: 'test-only-jwt-secret-not-for-any-real-environment-0001',
      JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-for-any-real-environment-0001',
      // Tests never reach a real Bunny account, whatever apps/api/.env says: local storage, and the
      // Bunny settings blanked (dotenv does not override values already set here). Bunny tests
      // build their own driver against a mock server (test/helpers/mockBunny.js).
      STORAGE_DRIVER: 'local',
      BUNNY_STORAGE_ZONE: '',
      BUNNY_STORAGE_HOST: '',
      BUNNY_STORAGE_KEY: '',
      BUNNY_CDN_URL: '',
      BUNNY_TOKEN_KEY: '',
    },
  },
});
