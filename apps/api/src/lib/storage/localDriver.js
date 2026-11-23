import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** apps/api/uploads: where the local driver keeps files (served at /uploads, as before). */
export const LOCAL_UPLOADS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../uploads');

/** The file on disk for a key ("uploads/<rest>"), never outside the uploads folder. */
export function localPathOf(key, root = LOCAL_UPLOADS_ROOT) {
  const rest = String(key).replace(/^uploads\//, '');
  const full = path.resolve(root, rest);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Refusing a path outside the uploads folder');
  return full;
}

/**
 * The local driver: today's behaviour. Files live in apps/api/uploads and are served by the API
 * at /uploads/<rest>, so a key's URL is "/" + key and never expires.
 */
export function createLocalDriver({ root = LOCAL_UPLOADS_ROOT } = {}) {
  return {
    name: 'local',
    root,
    /** Moves the uploaded temp file into place. */
    async put(key, sourcePath) {
      const target = localPathOf(key, root);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (path.resolve(sourcePath) === target) return;
      try {
        fs.renameSync(sourcePath, target);
      } catch {
        fs.copyFileSync(sourcePath, target);
        fs.unlinkSync(sourcePath);
      }
    },
    async remove(key) {
      try {
        fs.unlinkSync(localPathOf(key, root));
      } catch {
        // Already gone.
      }
    },
    async stat(key) {
      try {
        const st = fs.statSync(localPathOf(key, root));
        return st.isFile() ? { size: st.size } : null;
      } catch {
        return null;
      }
    },
    url(key) {
      return `/${key}`;
    },
  };
}
