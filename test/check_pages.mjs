// Checks that the inline scripts of the pages in docs/ parse.  node test/check_pages.mjs
import fs from 'node:fs';
import vm from 'node:vm';

let bad = 0;
for (const page of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(new URL('../docs/' + page, import.meta.url), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');
  try { new vm.Script(code, { filename: page }); console.log(page, 'parses,', code.split('\n').length, 'lines'); }
  catch (e) { bad++; console.log(page, 'FAILED:', e.message); }
}
process.exit(bad ? 1 : 0);
