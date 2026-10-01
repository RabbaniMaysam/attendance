// Checks that the inline scripts of the pages in docs/ parse and reference no undeclared names
// (eslint no-undef; the first run downloads eslint through npx).  node test/check_pages.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const PAGES = ['index.html', 'admin.html', 'attendance.html', 'attendance_admin.html'];
const BROWSER = ['window', 'document', 'location', 'history', 'navigator', 'fetch', 'sessionStorage', 'localStorage', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'Intl', 'Promise', 'FileReader', 'Blob', 'URL', 'URLSearchParams', 'google',
  'encodeURIComponent', 'decodeURIComponent', 'console', 'Date', 'JSON', 'Math', 'Number', 'String', 'Object', 'Array', 'Error', 'isNaN',
  'alert', 'confirm', 'prompt'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagecheck-'));
let bad = 0;
for (const page of PAGES) {
  const html = fs.readFileSync(new URL('../docs/' + page, import.meta.url), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');
  try { new vm.Script(code, { filename: page }); console.log(page, 'parses,', code.split('\n').length, 'lines'); }
  catch (e) { bad++; console.log(page, 'FAILED:', e.message); }
  fs.writeFileSync(path.join(dir, page.replace('.html', '.js')), code);
}
const globals = Object.fromEntries(BROWSER.map(g => [g, 'readonly']));
fs.writeFileSync(path.join(dir, 'eslint.config.mjs'),
  'export default [{ files: ["*.js"], languageOptions: { ecmaVersion: 2020, sourceType: "script", globals: ' + JSON.stringify(globals) +
  ' }, rules: { "no-undef": "error" } }];\n');
const r = spawnSync('npx', ['--yes', 'eslint@9', '.'], { cwd: dir, shell: true, encoding: 'utf8' });
const out = (r.stdout + r.stderr).split('\n').filter(l => !/npm warn/i.test(l)).join('\n').trim();
if (r.status !== 0) { bad++; console.log('undeclared names:\n' + out); } else console.log('no undeclared names');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
