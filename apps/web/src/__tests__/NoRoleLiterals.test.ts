import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guard (Access Phase C3): screens decide with useAccess() / roleAccess() (permissions and role
 * attributes from the access resolver), never by comparing role names. This fails if app code:
 * - calls the old role helpers (isApprover, isWorker, isReadOnlyViewer, canDecide, ...);
 * - compares a role with a role key (role === 'admin', 'sm_manager' !== user.role, ...);
 * - uses the role-group lists (APPROVER_ROLES, READ_ONLY_VIEWER_ROLES, LEADERSHIP_ROLES) or a
 *   literal list of role keys (['admin', 'sm_manager']);
 * - uses the retired portal.view key.
 * Role definitions, labels and pickers (ROLE_KEYS, ROLE_LABELS, a form's default WORKER_ROLE)
 * are fine. Allow-listed: Quick sign in (dev only) groups accounts by role key.
 */
const SRC = path.resolve(__dirname, '..');
const ALLOW = new Set(['components/DevQuickLogin.tsx']);
const KEYS = 'admin|sm_manager|creative_lead|growth_lead|executive|creative_head|production_head';
const RULES: Array<[string, RegExp]> = [
  ['old role helper', /\b(isApprover|isWorker|isReadOnlyViewer|canDecide|canDecideOn|decisionCalendarsFor|canReview|canSeeContactDetails|canManageOperationalFields|canViewProfileReport)\s*\(/],
  ['role compared with a role key', new RegExp(`role\\)?\\s*[!=]==?\\s*['"\`](${KEYS})['"\`]|['"\`](${KEYS})['"\`]\\s*[!=]==?\\s*[\\w?.]*role\\b`)],
  ['role compared with WORKER_ROLE', /role\s*[!=]==?\s*WORKER_ROLE|WORKER_ROLE\s*[!=]==?\s*[\w?.]*role\b/],
  ['role-group list', /\b(APPROVER_ROLES|READ_ONLY_VIEWER_ROLES|LEADERSHIP_ROLES)\b/],
  ['literal list of role keys', new RegExp(`\\[\\s*['"](${KEYS})['"]\\s*,`)],
  ['retired portal.view', /['"]portal\.view['"]/],
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Comments out (role words in comments are fine); string contents stay, role keys are strings. */
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const hitsIn = (code: string) =>
  withoutComments(code)
    .split('\n')
    .flatMap((line, i) => RULES.filter(([, re]) => re.test(line)).map(([name]) => `${i + 1}: ${name}: ${line.trim()}`));

describe('No role-name checks in the web app', () => {
  it('app code decides by permission and role attributes, not by role keys', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (ALLOW.has(rel)) continue;
      for (const h of hitsIn(fs.readFileSync(file, 'utf8'))) hits.push(`${rel}:${h}`);
    }
    expect(hits).toEqual([]);
  });

  it('the guard catches each form and leaves labels, pickers and access checks alone', () => {
    for (const bad of [
      "if (user?.role === 'admin') {}",
      "const x = role !== 'sm_manager';",
      "'creative_lead' === user.role",
      'isApprover(user?.role)',
      'canDecide(role, cal)',
      "['admin', ...APPROVER_ROLES].includes(user.role)",
      "const leads = ['creative_lead', 'growth_lead'];",
      "hasPermission('portal.view')",
      'if (user.role === WORKER_ROLE) {}',
    ]) {
      expect(hitsIn(bad), bad).not.toEqual([]);
    }
    for (const ok of [
      "access.can('review.decide', { calendar })",
      'ROLE_LABELS[user.role as UserRole]',
      '{ROLE_KEYS.map((rk) => <option key={rk}>{ROLE_LABELS[rk]}</option>)}',
      "useState<UserRole>(WORKER_ROLE)",
      "member.role === 'owner'",
      "// role === 'admin' in a comment",
    ]) {
      expect(hitsIn(ok), ok).toEqual([]);
    }
  });
});
