// The API's route table, read from the real routers: every route with its method, full path and
// permission guards (each guard is an any-of list of catalog keys). Used by the permission matrix
// (T1: no unguarded route outside the allow-list), the per-route guard snapshot (T2) and
// scripts/snapshot-route-guards.js. Mounts are found whatever the quote style, and routers mounted
// inside routers (router.use('/x', subRouter)) are walked too.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/** `app.use('/api/x', a, b)` mounts in server.js, with the imported router they point to. */
export function mountsOf(srcDir) {
  const server = fs.readFileSync(path.join(srcDir, 'server.js'), 'utf8');
  const imports = {};
  for (const m of server.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from\s+["'`]\.\/(modules\/[^"'`]+)["'`]/g)) imports[m[1]] = { file: m[2], name: 'default' };
  for (const m of server.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+["'`]\.\/(modules\/[^"'`]+)["'`]/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig) imports[(alias || orig).trim()] = { file: m[2], name: orig.trim() };
    }
  }
  const mounts = [];
  for (const m of server.matchAll(/app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*([^)]*)\)/g)) {
    const args = m[2].split(',').map((x) => x.trim()).filter(Boolean);
    const routerName = args[args.length - 1];
    const imp = imports[routerName];
    if (imp) mounts.push({ prefix: m[1], ...imp });
  }
  return mounts;
}

/** A sub-router's mount path from its Express layer (Express 5 keeps it in layer.matchers / regexp). */
function layerPath(layer) {
  if (typeof layer.path === 'string' && layer.path) return layer.path;
  const src = layer.regexp?.source || '';
  const m = src.match(/^\^\\?(\/[^\\?(]*)/);
  return m ? m[1].replace(/\\\//g, '/') : '';
}

function walk(router, prefix, inherited, out) {
  const guards = [...inherited];
  for (const layer of router.stack || []) {
    if (!layer.route) {
      if (layer.handle?.permissionKeys) {
        // A router-wide guard applies to the routes after it (Express order).
        guards.push(layer.handle.permissionKeys);
      } else if (layer.handle?.stack) {
        walk(layer.handle, prefix + layerPath(layer), guards, out);
      }
      continue;
    }
    const routeGuards = layer.route.stack.map((l) => l.handle?.permissionKeys).filter(Boolean);
    const handlers = layer.route.stack.map((l) => l.name || l.handle?.name || 'anonymous');
    for (const method of Object.keys(layer.route.methods).filter((x) => x !== '_all')) {
      for (const p of [].concat(layer.route.path)) {
        out.push({ method, path: `${prefix}${p === '/' ? '' : p}` || '/', guards: [...guards, ...routeGuards], handlers });
      }
    }
  }
}

/**
 * Every route under /api, once per router (a router mounted twice, e.g. /api/x and /x, is listed
 * under its first /api mount). Returns [{ method, path, guards, handlers }].
 */
export async function routeTable(srcDir) {
  // server.js attaches some routes at start (work item submission and clip routes): load it first.
  // Under NODE_ENV=test it does not listen.
  await import(pathToFileURL(path.join(srcDir, 'server.js')).href);
  const out = [];
  const seen = new Set();
  for (const { prefix, file, name } of mountsOf(srcDir)) {
    if (!prefix.startsWith('/api')) continue;
    const key = `${file}#${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mod = await import(pathToFileURL(path.join(srcDir, file)).href);
    const router = mod[name];
    if (!router?.stack) continue;
    walk(router, prefix, [], out);
  }
  // Swagger docs: guarded inside a wrapper outside development (server.js).
  for (const r of out) if (r.path.startsWith('/api/docs') && !r.guards.length) r.guards = [['settings.manage']];
  return out;
}

export const routeKey = (r) => `${r.method.toUpperCase()} ${r.path}`;

/**
 * The per-route guard snapshot (T2): "METHOD /api/path" → { guards, roles }, sorted, for every
 * guarded route. `roles`: the system roles the guards admit (every guard must pass).
 */
export async function guardSnapshotOf(routes) {
  const { ROLE_KEYS, can } = await import('@mmp/shared');
  const out = {};
  for (const r of [...routes].filter((x) => x.guards.length).sort((a, b) => routeKey(a).localeCompare(routeKey(b)))) {
    const roles = ROLE_KEYS.filter((role) => r.guards.every((keys) => keys.some((k) => can({ role, status: 'active' }, k))));
    out[routeKey(r)] = { guards: r.guards, roles };
  }
  return out;
}
