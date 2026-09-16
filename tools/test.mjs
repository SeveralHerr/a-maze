// Runs every module test file (src/*/*.test.mjs) plus tools/__none__.mjs, each in its own
// Node process so a module's registry/state singletons never leak into the next file.
// `npm test` — exit code is non-zero when any file fails. `node tools/test.mjs --quiet` prints
// only the summary lines.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

const files = [];
for (const dir of fs.readdirSync(path.join(ROOT, 'src'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(ROOT, 'src', dir.name))) {
    if (f.endsWith('.test.mjs')) files.push(path.join('src', dir.name, f));
  }
}
files.sort();
if (fs.existsSync(path.join(ROOT, 'tools/__none__.mjs'))) files.push(path.join('tools', 'save-test.mjs'));

let failed = 0;
const t0 = Date.now();
for (const file of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  const out = (r.stdout || '') + (r.stderr || '');
  // node:test summarises with a marker that differs per reporter: TAP prints "# pass N", the
  // default spec reporter prints "ℹ pass N". Accept any non-digit prefix so the tally column keeps
  // working whichever reporter a Node version defaults to. Plain scripts print their own summary.
  const pass = /^\D*pass (\d+)\s*$/m.exec(out)?.[1];
  const fail = /^\D*fail (\d+)\s*$/m.exec(out)?.[1];
  const tally = pass !== undefined ? `${pass} passed${fail && fail !== '0' ? `, ${fail} failed` : ''}` : (out.trim().split('\n').pop() || '').slice(0, 80);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file.padEnd(40)} ${tally} (${Date.now() - t} ms)`);
  if (!ok && !QUIET) console.log(out);
}
console.log(`\n${files.length - failed}/${files.length} test files passed in ${Date.now() - t0} ms`);
process.exit(failed ? 1 : 0);
