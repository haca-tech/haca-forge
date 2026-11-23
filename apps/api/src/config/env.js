import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_DOMAIN: z.string().optional(),
  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend']).default('console'),
  MAIL_FROM: z.string().default('Marketing Portal <no-reply@example.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  ADMIN_SEED_EMAIL: z.string().email().optional(),
  ADMIN_SEED_PASSWORD: z.string().min(8).optional(),

  // File storage (docs/STORAGE.md): "local" keeps files in apps/api/uploads; "bunny" stores them on
  // Bunny Storage and serves them through a Bunny Pull Zone with token authentication.
  STORAGE_DRIVER: z.enum(['local', 'bunny']).default('local'),
  BUNNY_STORAGE_ZONE: z.string().optional(),
  BUNNY_STORAGE_HOST: z.string().optional(),
  BUNNY_STORAGE_KEY: z.string().optional(),
  BUNNY_CDN_URL: z.string().optional(),
  BUNNY_TOKEN_KEY: z.string().optional(),
});

/** With STORAGE_DRIVER=bunny every Bunny setting is required. Names only; values are never printed. */
export const BUNNY_SETTINGS = ['BUNNY_STORAGE_ZONE', 'BUNNY_STORAGE_HOST', 'BUNNY_STORAGE_KEY', 'BUNNY_CDN_URL', 'BUNNY_TOKEN_KEY'];
export function missingStorageSettings(values) {
  if (values.STORAGE_DRIVER !== 'bunny') return [];
  return BUNNY_SETTINGS.filter((name) => !String(values[name] || '').trim());
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => ` - [${issue.path.join('.')}]: ${issue.message}`)
    .join('\n');
  console.error('\n❌ CRITICAL: Environment configuration validation failed:');
  console.error(issues);
  console.error('\nPlease check your .env file against .env.example\n');
  process.exit(1);
}

const missingStorage = missingStorageSettings(parsed.data);
if (missingStorage.length) {
  console.error('\n❌ CRITICAL: STORAGE_DRIVER=bunny needs these settings, which are missing or empty:');
  console.error(missingStorage.map((name) => ` - ${name}`).join('\n'));
  console.error('\nSee docs/STORAGE.md. Use STORAGE_DRIVER=local to keep files on this machine.\n');
  process.exit(1);
}

export const env = parsed.data;
