// @vitest-environment node
// The dev-only email preview page (/dev/emails) must not be in a production build: a real
// `vite build` into a temporary folder, then every emitted file is searched for the page.

import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe('/dev/emails in the production build', () => {
  it('is absent: no route, no page code, no call to /api/dev/emails', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-prod-build-'));
    try {
      await build({
        root: WEB_ROOT,
        configFile: path.join(WEB_ROOT, 'vite.config.ts'),
        mode: 'production',
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
      const files = filesUnder(outDir).filter((f) => /\.(js|html|css)$/.test(f));
      expect(files.some((f) => f.endsWith('.js'))).toBe(true);
      const bundle = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      expect(bundle).toContain('/set-password'); // sanity: the real app is in the bundle
      expect(bundle).not.toContain('/dev/emails');
      expect(bundle).not.toContain('/api/dev/emails');
      expect(bundle).not.toContain('Email previews');
      expect(files.some((f) => /EmailPreview/i.test(path.basename(f)))).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 240_000);
});
