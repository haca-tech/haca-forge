#!/usr/bin/env node
/**
 * Writes test/fixtures/route_guard_snapshot.json: one entry per guarded API route,
 * "METHOD /api/path" → its guards (each an any-of list of catalog keys) and the roles they admit.
 * The parity test compares the live route table with it, so a guard that is added, removed,
 * moved to another route, or that admits different roles fails until this is re-run on purpose
 * (and the diff reviewed).
 *
 *   node apps/api/scripts/snapshot-route-guards.js
 *
 * Loads the routers only (NODE_ENV=test: the server does not listen or connect to a database).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.NODE_ENV = 'test';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const OUT = path.resolve(HERE, '../test/fixtures/route_guard_snapshot.json');

const { routeTable, guardSnapshotOf } = await import(pathToFileURL(path.resolve(HERE, '../test/helpers/routeTable.js')).href);
const snapshot = await guardSnapshotOf(await routeTable(SRC));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(`Wrote ${OUT}: ${Object.keys(snapshot).length} guarded routes`);
process.exit(0);
