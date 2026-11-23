import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { DevQuickLogin, groupQuickLogins, parseQuickLogins, quickLoginLabel, type QuickLoginAccount } from '../components/DevQuickLogin';

const ROOT = path.resolve(__dirname, '../..');
const acc = (label: string, role: string, i: number, jobRole = ''): QuickLoginAccount => ({ label, role, jobRole, email: `${label.toLowerCase().replace(/\W/g, '')}${i}@demo.haca.local`, password: 'not-a-real-password' });
const ACCOUNTS = [
  acc('Admin', 'admin', 0),
  acc('Test Creative Manager', 'creative_lead', 1, 'Creative Manager (TL)'),
  acc('Test SM Manager', 'sm_manager', 2, 'Social Media Manager'),
  acc('Test Marketing Head', 'creative_head', 3),
  acc('Test Production Head', 'production_head', 4),
  acc('Test Marketing Growth Manager', 'growth_lead', 5),
  ...[['Test Writer One', 'Writer'], ['Test Writer Two', 'Writer'], ['Test Designer One', 'Graphic Designer'], ['Test Poster', '']].map(([l, j], i) => acc(l, 'executive', 10 + i, j)),
];
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

describe('Quick sign in (dev only)', () => {
  it('groups the buttons by the 8 roles, in order, each "Name · job role"', () => {
    const onPick = vi.fn();
    render(<DevQuickLogin accounts={ACCOUNTS} onPick={onPick} />);
    expect(screen.getByRole('region', { name: 'Quick sign in (dev only)' })).toBeInTheDocument();
    const groups = screen.getAllByTestId('quick-login-group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Admin', 'Marketing Head', 'Production Head', 'Creative Manager', 'Marketing Growth Manager', 'SM Manager', 'Executive', 'Viewer']);
    expect(within(groups[3]).getByRole('button').textContent).toBe('Test Creative Manager · Creative Manager (TL)');
    expect(within(groups[6]).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Test Writer One · Writer',
      'Test Writer Two · Writer',
      'Test Designer One · Graphic Designer',
      'Test Poster', // no job role: the name alone
    ]);
    within(groups[6]).getByRole('button', { name: 'Test Writer One · Writer' }).click();
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ email: 'testwriterone10@demo.haca.local', role: 'executive' }));
  });

  it('a role without a test account still has its row, saying so; unknown roles go under Other', () => {
    render(<DevQuickLogin accounts={[ACCOUNTS[0], { label: 'X', email: 'x@y.z', password: 'p', role: 'team_member' }]} onPick={vi.fn()} />);
    const groups = screen.getAllByTestId('quick-login-group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Admin', 'Marketing Head', 'Production Head', 'Creative Manager', 'Marketing Growth Manager', 'SM Manager', 'Executive', 'Viewer', 'Other']);
    expect(groups[2]).toHaveTextContent('No test account');
    expect(groupQuickLogins([]).length).toBe(8);
  });

  it('reads both list formats, and ignores a bad value', () => {
    expect(parseQuickLogins(b64({ v: 2, accounts: ACCOUNTS })).map((a) => a.email)).toEqual(ACCOUNTS.map((a) => a.email));
    expect(parseQuickLogins(b64(ACCOUNTS.slice(0, 2))).length).toBe(2);
    expect(parseQuickLogins('not base64 json')).toEqual([]);
    expect(parseQuickLogins(b64({ v: 2, accounts: [{ label: 'no password', email: 'a@b.c' }] }))).toEqual([]);
    expect(quickLoginLabel({ label: 'A', email: 'a', password: 'p', jobRole: '  ' })).toBe('A');
  });

  // Builds the app itself (temp folder) with a known list given through process env, which Vite
  // ranks above .env files: the result never depends on apps/web/.env.local, and it always runs.
  it('is absent from the production build: no code, text, emails or account list', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlbuild-'));
    const list = b64({ v: 2, accounts: ACCOUNTS });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('VITE_') && k !== 'NODE_ENV' && k !== 'MODE') env[k] = v;
    const res = spawnSync(process.execPath, [path.resolve(ROOT, '../../node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: ROOT,
      env: { ...env, VITE_QUICK_LOGINS: list },
      encoding: 'utf8',
    });
    try {
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(js|html|css|map)$/.test(e.name)) files.push(p);
        }
      };
      walk(outDir);
      expect(files.length).toBeGreaterThan(0);
      const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      for (const absent of ['Quick sign in', 'Switch account', 'dev-quick-login', 'dev-switch-account', 'No test account', 'VITE_QUICK_LOGINS', 'not-a-real-password', list]) {
        expect(text.includes(absent), absent.slice(0, 40)).toBe(false);
      }
      expect(text).not.toMatch(/@demo\.haca\.local/);
      // The list in .env.local, when present, is not in the bundle either.
      const envLocal = path.join(ROOT, '.env.local');
      const m = fs.existsSync(envLocal) ? fs.readFileSync(envLocal, 'utf8').match(/^VITE_QUICK_LOGINS=(.+)$/m) : null;
      if (m) expect(text.includes(m[1].trim())).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 180000);
});
