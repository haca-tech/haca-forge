#!/usr/bin/env node
/**
 * Send one email through the configured driver (EMAIL_DRIVER), to check email works.
 *
 *   node scripts/send-test-email.js --to=<address> [--template=<name>]
 *
 * --template defaults to "test". Any template name from apps/api/src/lib/email/templates.js works;
 * it is sent with its sample data. Run with EMAIL_DRIVER=console to see it logged and sent nowhere.
 * See docs/EMAIL.md.
 */
import { fileURLToPath } from 'url';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  // Imported here so a bad environment (startup checks in config/env.js) fails with its own message.
  const { env } = await import('../src/config/env.js');
  const { sendEmail, TEMPLATES, TEMPLATE_NAMES } = await import('../src/lib/email/index.js');

  const to = String(args.to || '').trim();
  const template = String(args.template || 'test').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error('Usage: node scripts/send-test-email.js --to=<address> [--template=<name>]');
  }
  if (!TEMPLATES[template]) {
    throw new Error(`Unknown template "${template}". Templates: ${TEMPLATE_NAMES.join(', ')}`);
  }

  const data =
    template === 'test'
      ? { driver: env.EMAIL_DRIVER, sentAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' }
      : TEMPLATES[template].sample;

  const result = await sendEmail({ to, template, data });
  if (!result.ok) throw new Error(`Not sent (${env.EMAIL_DRIVER}): ${result.error}`);
  console.log(`Sent "${template}" to ${to} via ${env.EMAIL_DRIVER} (message id ${result.messageId})`);
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
