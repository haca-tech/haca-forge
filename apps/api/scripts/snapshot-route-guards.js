#!/usr/bin/env node
/**
 * Writes test/fixtures/route_guard_snapshot.json: for every requirePermission /
 * requireAnyPermission guard in the API route files (by file and order), the roles it admits.
 * Generated once from the pre-Phase-C2 routes (v1 keys, admin bypass); the route parity test
 * then checks that the v2 guards admit exactly the same roles. Re-run only on purpose.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROLE_KEYS, ROLE_PERMISSIONS } from '@mmp/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src/modules');
const OUT = path.resolve(HERE, '../test/fixtures/route_guard_snapshot.json');

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/routes\.js$/.test(e.name)) files.push(p);
  }
};
walk(SRC);

const snapshot = {};
for (const f of files.sort()) {
  const rel = path.relative(SRC, f).replace(/\\/g, '/');
  const guards = [];
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/require(?:Any)?Permission\(([^)]*)\)/g)) {
    const keys = [...m[1].matchAll(/['"]([a-z_.]+)['"]/g)].map((x) => x[1]);
    if (!keys.length) continue;
    const roles = ROLE_KEYS.filter((role) => role === 'admin' || keys.some((k) => (ROLE_PERMISSIONS[role] || []).includes(k)));
    guards.push({ keys, roles });
  }
  if (guards.length) snapshot[rel] = guards;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(`Wrote ${OUT}: ${Object.values(snapshot).reduce((n, g) => n + g.length, 0)} guards in ${Object.keys(snapshot).length} files`);
