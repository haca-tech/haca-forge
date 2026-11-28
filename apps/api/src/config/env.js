import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const blankToUndefined = (value) => (value === '' || value == null ? undefined : value);

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_DOMAIN: z.string().optional(),
  // Proxies in front of the API that add X-Forwarded-For (Render = 1; Vercel's /api rewrite + Render = 2).
  // Sets Express 'trust proxy', so req.ip (rate limits, session IP) is the visitor, not the proxy.
  // Unset: 2 in production (the Cloudflare Pages Function that forwards /api + Render), 1 elsewhere.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  // Email (docs/EMAIL.md). "console" logs each email and sends nothing (dev and tests);
  // "smtp" sends through Nodemailer; "resend" sends through the Resend API.
  EMAIL_DRIVER: z.enum(['console', 'smtp', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_LOGO_URL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional()),
  SMTP_SECURE: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Phone verification codes go to the user's registered email. "sms" needs a provider (none yet).
  PHONE_OTP_CHANNEL: z.enum(['email', 'sms']).default('email'),
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

/** With EMAIL_DRIVER=smtp every one of these is required. Names only; values are never printed. */
export const SMTP_SETTINGS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];

/** With EMAIL_DRIVER=resend every one of these is required. Names only; values are never printed. */
export const RESEND_SETTINGS = ['RESEND_API_KEY', 'EMAIL_FROM'];

/**
 * Email and phone-OTP configuration problems, as readable lines (never values). Empty when fine.
 * Takes the raw environment so a missing SMTP_PORT is caught even though it is optional in the schema.
 */
export function emailSettingsProblems(values) {
  const problems = [];
  const driver = values.EMAIL_DRIVER || 'console';
  if (driver === 'smtp') {
    for (const name of SMTP_SETTINGS) {
      if (!String(values[name] ?? '').trim()) problems.push(`${name} is missing or empty`);
    }
  }
  if (driver === 'resend') {
    for (const name of RESEND_SETTINGS) {
      if (!String(values[name] ?? '').trim()) problems.push(`${name} is missing or empty`);
    }
  }
  if ((values.PHONE_OTP_CHANNEL || 'email') === 'sms') {
    problems.push('PHONE_OTP_CHANNEL=sms has no SMS provider yet; use email');
  }
  const logo = String(values.EMAIL_LOGO_URL ?? '').trim();
  if (logo && /\.svg(\?|#|$)/i.test(logo)) {
    problems.push('EMAIL_LOGO_URL must be a PNG (SVG does not show in most email apps)');
  }
  return problems;
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

const emailProblems = emailSettingsProblems(process.env);
if (emailProblems.length) {
  console.error('\n❌ CRITICAL: Email settings are incomplete:');
  console.error(emailProblems.map((line) => ` - ${line}`).join('\n'));
  console.error('\nSee docs/EMAIL.md. Use EMAIL_DRIVER=console to log emails instead of sending them.\n');
  process.exit(1);
}

export const env = parsed.data;
