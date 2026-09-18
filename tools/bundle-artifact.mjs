// Build the playable-artifact manifest: walk the real import graph from the page's entry points and
// list exactly the files a browser would fetch, with nothing from `tools/`, no test and no preview
// harness. Prints a JSON object mapping published path -> source path, which is what the Artifact
// tool's `files` input takes.
//
//   node tools/bundle-artifact.mjs [--out logs/artifact-files.json] [--print]
//
// The three roots are the two module scripts `index.html` loads plus `src/maze/worker.js`, which is
// reached through `new URL('./worker.js', import.meta.url)` rather than a static import and so is
// invisible to a graph walk. If the worker is ever renamed, this is the file that has to know.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const OUT = arg('out', 'logs/artifact-files.json');

/** Entry points a browser starts from. */
const ROOTS = ['src/main.js', 'src/splash.js', 'src/maze/worker.js'];

const slash = (p) => p.split(path.sep).join('/');
const seen = new Set();
const missing = [];
const queue = [...ROOTS];

while (queue.length > 0) {
  const file = slash(queue.shift());
  if (seen.has(file)) continue;
  if (!fs.existsSync(file)) {
    missing.push(file);
    continue;
  }
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  // Static `from '...'`, dynamic `import('...')`, and the worker's own `new URL('./x.js', ...)`.
  const patterns = [/from\s+'([^']+)'/g, /import\s*\(\s*'([^']+)'/g, /new URL\(\s*'([^']+)'/g];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (!spec || !spec.startsWith('.')) continue;
      queue.push(slash(path.join(dir, spec)));
    }
  }
}

const files = [...seen].sort();
const banned = files.filter((f) => /\.test\.mjs$|test-util|preview/.test(f));
let bytes = 0;
for (const f of files) bytes += fs.statSync(f).size;

/** @type {Record<string, string>} */
const manifest = {};
for (const f of files) manifest[f] = f;
manifest['styles.css'] = 'styles.css';
manifest['images/jamcraft_logo.png'] = 'images/jamcraft_logo.png';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));

console.log(`${files.length} modules, ${(bytes / 1024).toFixed(0)} kB`);
console.log(`${Object.keys(manifest).length} published files -> ${OUT}`);
if (missing.length) console.log(`MISSING (import that does not resolve): ${missing.join(', ')}`);
if (banned.length) console.log(`WARNING — a harness reached the shipped graph: ${banned.join(', ')}`);
if (args.includes('--print')) console.log(files.join('\n'));
