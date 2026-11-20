import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import path from 'path';
import { DevQuickLogin, groupQuickLogins, type QuickLoginAccount } from '../components/DevQuickLogin';

const ROOT = path.resolve(__dirname, '../..');
const acc = (label: string, role: string, i: number): QuickLoginAccount => ({ label, role, email: `${label.toLowerCase().replace(/\W/g, '')}${i}@demo.haca.local`, password: 'not-a-real-password' });
const ACCOUNTS = [
  acc('Admin', 'admin', 0),
  acc('Creative Lead', 'creative_lead', 1),
  acc('SM Manager', 'sm_manager', 2),
  acc('Creative Head', 'creative_head', 3),
  ...['Writer 1', 'Writer 2', 'Designer 1', 'Designer 2', 'Shooter', 'Editor 1', 'Editor 2', 'Poster', 'All-rounder'].map((l, i) => acc(l, 'executive', 10 + i)),
];

describe('Quick sign in (dev, and test builds only)', () => {
  it('groups the accounts by role, one click each', () => {
    const onPick = vi.fn();
    render(<DevQuickLogin accounts={ACCOUNTS} onPick={onPick} />);
    const groups = screen.getAllByTestId('quick-login-group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Admin', 'Creative Head', 'Creative Lead', 'SM Manager', 'Executive']);
    expect(within(groups[4]).getAllByRole('button')).toHaveLength(9);
    within(groups[4]).getByRole('button', { name: 'Poster' }).click();
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ label: 'Poster', role: 'executive' }));
  });

  it('accounts without a role still show, under Other', () => {
    expect(groupQuickLogins([{ label: 'X', email: 'x@y.z', password: 'p' }]).map((g) => g.title)).toEqual(['Other']);
  });

  // These build the app themselves (into a temp folder), with the switch set through process env,
  // which Vite ranks above .env files: the result never depends on apps/web/.env.local, and the
  // "absent" check always runs.
  const VITE_BIN = path.resolve(ROOT, '../../node_modules/vite/bin/vite.js');
  const envLocalList = (() => {
    const envLocal = path.join(ROOT, '.env.local');
    const m = fs.existsSync(envLocal) ? fs.readFileSync(envLocal, 'utf8').match(/^VITE_QUICK_LOGINS=(.+)$/m) : null;
    return m ? m[1].trim() : '';
  })();
  const FAKE_LIST = Buffer.from(JSON.stringify(ACCOUNTS.slice(0, 2))).toString('base64');

  function build(vars: Record<string, string>) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlbuild-'));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // A clean slate: no VITE_* or deploy hints from the shell running the tests.
      if (v !== undefined && !k.startsWith('VITE_') && k !== 'VERCEL_ENV' && k !== 'NODE_ENV' && k !== 'MODE') env[k] = v;
    }
    const res = spawnSync(process.execPath, [VITE_BIN, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: ROOT,
      env: { ...env, ...vars },
      encoding: 'utf8',
    });
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|html|css|map)$/.test(e.name)) files.push(p);
      }
    };
    if (res.status === 0) walk(outDir);
    const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    fs.rmSync(outDir, { recursive: true, force: true });
    return { status: res.status, output: `${res.stdout}\n${res.stderr}`, files: files.length, text };
  }

  it('is absent from the production build (switch forced off, whatever .env.local says)', () => {
    const b = build({ VITE_QUICK_LOGIN_IN_BUILD: 'false', VITE_QUICK_LOGINS: FAKE_LIST });
    expect(b.status, b.output).toBe(0);
    expect(b.files).toBeGreaterThan(0);
    expect(b.text).not.toContain('Quick sign in');
    expect(b.text).not.toContain('Local development only');
    expect(b.text).not.toContain('Testing only: remove before hosting');
    expect(b.text).not.toMatch(/@demo\.haca\.local/);
    expect(b.text).not.toContain('VITE_QUICK_LOGINS');
    expect(b.text).not.toContain(FAKE_LIST);
    if (envLocalList) expect(b.text.includes(envLocalList)).toBe(false);
  }, 180000);

  it('with the switch on, a non-production build includes it; a production build fails', () => {
    const staging = build({ VITE_QUICK_LOGIN_IN_BUILD: 'true', VITE_DEPLOY_TARGET: 'staging', VITE_QUICK_LOGINS: FAKE_LIST });
    expect(staging.status, staging.output).toBe(0);
    expect(staging.text).toContain('Quick sign in');
    expect(staging.text).toContain('Testing only: remove before hosting');
    expect(staging.text).toContain(FAKE_LIST);
    // The list given to this build replaced the one in .env.local.
    if (envLocalList) expect(staging.text.includes(envLocalList)).toBe(false);

    const prod = build({ VITE_QUICK_LOGIN_IN_BUILD: 'true', VITE_DEPLOY_TARGET: 'production', VITE_QUICK_LOGINS: FAKE_LIST });
    expect(prod.status).not.toBe(0);
    expect(prod.output).toContain('VITE_QUICK_LOGIN_IN_BUILD=true');
    expect(prod.files).toBe(0);

    // A Vercel production deploy counts as production even without VITE_DEPLOY_TARGET.
    const vercel = build({ VITE_QUICK_LOGIN_IN_BUILD: 'true', VERCEL_ENV: 'production', VITE_QUICK_LOGINS: FAKE_LIST });
    expect(vercel.status).not.toBe(0);
  }, 300000);
});
