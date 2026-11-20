import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guard: the web app never uses the browser's alert, confirm or prompt ("localhost says…").
 * Use toast / confirmDialog / promptDialog from src/lib/uiFeedback instead.
 * Test files are skipped (they may mention "javascript:alert(1)" as unsafe input).
 */
const SRC = path.resolve(__dirname, '..');
// alert( / confirm( / prompt(, bare or on window / globalThis / self, not as part of another name
// (e.g. confirmDialog(, promptDialog(, onConfirm() or a method like x.confirm().
const CALL = /(?<![\w$.'"`:])(?:(?:window|globalThis|self)\s*\.\s*)?(alert|confirm|prompt)\s*\(/g;
const MEMBER = /\b(?:window|globalThis|self)\s*\.\s*(alert|confirm|prompt)\b/g;

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

/** Drops comments and string contents so text like "javascript:alert(1)" or a doc comment is not counted. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

describe('No browser popups in the web app', () => {
  it('finds no window.alert, window.confirm or window.prompt (bare or on window)', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const code = codeOnly(fs.readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (CALL.test(line) || MEMBER.test(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        CALL.lastIndex = 0;
        MEMBER.lastIndex = 0;
      });
    }
    expect(hits).toEqual([]);
  });

  it('the guard itself catches each form', () => {
    const caught = (s: string) => {
      const r = CALL.test(codeOnly(s)) || MEMBER.test(codeOnly(s));
      CALL.lastIndex = 0;
      MEMBER.lastIndex = 0;
      return r;
    };
    for (const bad of ['alert("x")', 'window.alert(msg)', 'if (!confirm(`Delete?`)) return;', 'window.confirm("x")', 'const v = prompt("Name")', 'globalThis.prompt()', 'const f = window.confirm;']) {
      expect(caught(bad), bad).toBe(true);
    }
    for (const ok of ['toast.error(msg)', 'await confirmDialog({ title: "x" })', 'promptDialog({})', 'onConfirm()', 'dialog.confirm()', "const bad = 'javascript:alert(1)';", '// never use alert() here']) {
      expect(caught(ok), ok).toBe(false);
    }
  });
});
