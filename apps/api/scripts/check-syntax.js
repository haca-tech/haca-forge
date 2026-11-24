import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../src');

function getJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = getJsFiles(srcDir);
if (files.length === 0) {
  console.log('@mmp/api: No JavaScript files found in src/');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--check', ...files], { stdio: 'inherit' });
if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`@mmp/api: Syntax check passed for ${files.length} JavaScript files.`);
