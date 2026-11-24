/**
 * apps/api/scripts/migrate-uploads-to-bunny-core.js (docs/STORAGE.md)
 *
 * Core logic for copying local uploads to Bunny Storage and updating document paths.
 * Reusable without shebang line so it can be imported safely by ESM tests and tools.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UPLOADS = path.resolve(HERE, '../uploads');
const REFUSED = ['marketing_portal_test'];

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

/** Stored file values to rewrite: collection, the fields holding one value, the arrays of sub-documents. */
export const FILE_FIELDS = [
  { collection: 'users', fields: ['avatarUrl'], storageId: 'avatarStorageId' },
  { collection: 'mediaitems', fields: ['url', 'thumbnailUrl'] },
  { collection: 'submissions', fields: ['fileUrl', 'linkUrl'], arrays: [['files', 'url']] },
  { collection: 'workitems', fields: ['deliverableUrl'] },
  { collection: 'chatmessages', fields: ['sharedMedia.thumbnailUrl', 'sharedMedia.previewUrl', 'sharedMedia.downloadUrl', 'sharedMedia.owner.avatarUrl'], arrays: [['attachments', 'storageUrl'], ['attachments', 'thumbnailUrl']] },
];

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = { confirm: false, allowRemote: false, dbName: null, uploadsDir: DEFAULT_UPLOADS };
  for (const arg of argv) {
    if (arg === '--confirm') flags.confirm = true;
    else if (arg === '--allow-remote') flags.allowRemote = true;
    else if (arg.startsWith('--db-name=')) flags.dbName = arg.slice('--db-name='.length);
    else if (arg.startsWith('--uploads-dir=')) flags.uploadsDir = path.resolve(arg.slice('--uploads-dir='.length));
    else throw new Error(`Unknown option: ${arg}`);
  }
  return flags;
}

const hostsOf = (uri) => {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(String(uri || ''));
  return m ? m[1].split(',').map((h) => (h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '')).toLowerCase()) : [];
};
const isLocalUri = (uri) => !/^mongodb\+srv:/i.test(String(uri || '')) && hostsOf(uri).length > 0 && hostsOf(uri).every((h) => ['localhost', '127.0.0.1', '::1'].includes(h));
const dbNameOf = (uri) => decodeURIComponent((/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/i.exec(String(uri || '')) || [])[1] || '');

/** Throws on anything unsafe. Returns { dbName, host, remote }. */
export function checkTarget({ uri, flags }) {
  const dbName = dbNameOf(uri);
  if (!dbName) throw new Error('Refusing: MONGODB_URI names no database.');
  if (REFUSED.includes(dbName)) throw new Error(`Refusing: "${dbName}" is the test database.`);
  const remote = !isLocalUri(uri);
  const host = hostsOf(uri).join(',');
  if (remote && !flags.allowRemote) throw new Error(`Refusing: "${host}" is a remote database. Add --allow-remote --db-name=${dbName} if this is the one to migrate.`);
  if ((remote || flags.confirm) && flags.dbName !== dbName) throw new Error(`Refusing: --db-name must equal the database in MONGODB_URI ("${dbName}").`);
  return { dbName, host, remote };
}

function listFiles(dir, root = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? listFiles(p, root) : [{ full: p, rel: path.relative(root, p).split(path.sep).join('/') }];
  });
}

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const isLegacy = (v) => typeof v === 'string' && v.startsWith('/uploads/');

export async function run({ argv = process.argv.slice(2), log = console.log } = {}) {
  const flags = parseArgs(argv);
  const mongoose = (await import('mongoose')).default;
  const { env, BUNNY_SETTINGS } = await import('../src/config/env.js');
  const { storageKeyOf } = await import('@mmp/shared');
  const { createBunnyDriver } = await import('../src/lib/storage/bunnyDriver.js');
  const uri = env.MONGODB_URI;
  const { dbName, host, remote } = checkTarget({ uri, flags });
  const missing = BUNNY_SETTINGS.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Refusing: these Bunny settings are missing: ${missing.join(', ')} (see docs/STORAGE.md).`);
  const bunny = createBunnyDriver({ storageZone: env.BUNNY_STORAGE_ZONE, storageHost: env.BUNNY_STORAGE_HOST, storageKey: env.BUNNY_STORAGE_KEY, cdnUrl: env.BUNNY_CDN_URL, tokenKey: env.BUNNY_TOKEN_KEY });

  log(`${flags.confirm ? 'MIGRATE' : `DRY RUN (nothing is written; add --confirm --db-name=${dbName}${remote ? ' --allow-remote' : ''})`}`);
  log(`  Database: ${dbName} on ${host}${remote ? ' (remote)' : ' (local)'}`);
  log(`  Files:    ${flags.uploadsDir}`);

  // 1. Files: which are already in Bunny (same key and size)?
  const files = listFiles(flags.uploadsDir).filter((f) => storageKeyOf(`uploads/${f.rel}`));
  const skippedOther = listFiles(flags.uploadsDir).length - files.length;
  const plan = [];
  for (const f of files) {
    const key = `uploads/${f.rel}`;
    const size = fs.statSync(f.full).size;
    const there = await bunny.stat(key);
    plan.push({ ...f, key, size, upload: !there || there.size !== size });
  }
  const toUpload = plan.filter((p) => p.upload);

  // 2. Records still holding "/uploads/..." values.
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 15000 });
  try {
    const db = mongoose.connection.db;
    if (db.databaseName !== dbName) throw new Error(`Refusing: connected to "${db.databaseName}", expected "${dbName}".`);
    const updates = [];
    for (const spec of FILE_FIELDS) {
      const or = [...spec.fields.map((f) => ({ [f]: /^\/uploads\// })), ...(spec.arrays || []).map(([a, f]) => ({ [`${a}.${f}`]: /^\/uploads\// }))];
      if (spec.storageId) or.push({ [spec.storageId]: { $regex: /^[^/]+$/ } });
      const docs = await db.collection(spec.collection).find({ $or: or }).toArray();
      for (const doc of docs) {
        const set = {};
        for (const f of spec.fields) {
          const v = getPath(doc, f);
          if (isLegacy(v) && storageKeyOf(v)) set[f] = storageKeyOf(v);
        }
        for (const [a, f] of spec.arrays || []) {
          const arr = doc[a];
          if (!Array.isArray(arr) || !arr.some((item) => isLegacy(item?.[f]))) continue;
          set[a] = (set[a] || arr).map((item) => (isLegacy(item?.[f]) && storageKeyOf(item[f]) ? { ...item, [f]: storageKeyOf(item[f]) } : item));
        }
        if (spec.storageId) {
          // Older photos kept only the file name: it becomes the key of that file.
          const id = doc[spec.storageId];
          if (typeof id === 'string' && /^[^/]+$/.test(id) && storageKeyOf(`uploads/${id}`)) set[spec.storageId] = `uploads/${id}`;
        }
        if (Object.keys(set).length) updates.push({ collection: spec.collection, _id: doc._id, set });
      }
    }

    log(`  Files to upload: ${toUpload.length} of ${plan.length} (${plan.length - toUpload.length} already in Bunny${skippedOther ? `; ${skippedOther} other files skipped` : ''})`);
    for (const p of toUpload.slice(0, 20)) log(`    ${p.key} (${p.size} bytes)`);
    if (toUpload.length > 20) log(`    ... and ${toUpload.length - 20} more`);
    const byCollection = {};
    for (const u of updates) byCollection[u.collection] = (byCollection[u.collection] || 0) + 1;
    log(`  Records to update: ${updates.length}${updates.length ? ` (${Object.entries(byCollection).map(([c, n]) => `${c} ${n}`).join(', ')})` : ''}`);

    if (!flags.confirm) return { mode: 'dry-run', files: plan.length, toUpload: toUpload.length, updates: updates.length };

    let uploaded = 0;
    for (const p of toUpload) {
      await bunny.put(p.key, p.full, { contentType: MIME[path.extname(p.key).toLowerCase()] || 'application/octet-stream' });
      uploaded += 1;
    }
    let updated = 0;
    for (const u of updates) {
      const res = await db.collection(u.collection).updateOne({ _id: u._id }, { $set: u.set });
      updated += res.modifiedCount;
    }
    log(`Done. Uploaded ${uploaded} file(s); updated ${updated} record(s). Local files were not deleted.`);
    return { mode: 'migrate', files: plan.length, uploaded, updated };
  } finally {
    await mongoose.disconnect();
  }
}
