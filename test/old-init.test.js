// Checks the "convert old init syntax" quick fix against IMITATOR itself:
// for every repository model written with the old `init :=` syntax, the converted model
// must regenerate (imitator -imi2IMI) to exactly the same model as the original.
//   node test/old-init.test.js [path/to/imitator] [work-dir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const engine = require('../src/engine');

const root = path.resolve(__dirname, '../..');
const imitator = path.resolve(process.argv[2] || path.join(root, 'bin/imitator'));
const work = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'imitator-old-init-'));

function* walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (e.name.endsWith('.imi')) yield p;
	}
}

// Regenerated model without the header comment (dates, file names)
function regenerate(file) {
	cp.spawnSync(imitator, [path.basename(file), '-imi2IMI'], { cwd: path.dirname(file), timeout: 60000 });
	const out = file.replace(/\.imi$/, '-regenerated.imi');
	if (!fs.existsSync(out)) return null;
	const text = fs.readFileSync(out, 'utf8');
	return text.slice(text.indexOf('*)') + 2);
}

let total = 0, same = 0, skipped = 0;
const failures = [];
for (const dir of ['benchmarks', 'tests', 'doc']) {
	for (const f of walk(path.join(root, dir))) {
		const text = fs.readFileSync(f, 'utf8');
		const a = engine.analyzeModel(text);
		const d = a.diagnostics.find(x => x.code === 'deprecated-old-init');
		if (!d) continue;
		if (a.includes.length) { skipped++; continue; }
		total++;
		const converted = text.slice(0, d.fix.at) + d.fix.text + text.slice(d.fix.end);
		const orig = path.join(work, 'orig.imi'), conv = path.join(work, 'conv.imi');
		fs.writeFileSync(orig, text);
		fs.writeFileSync(conv, converted);
		const r1 = regenerate(orig), r2 = regenerate(conv);
		if (r1 === null) { skipped++; total--; continue; }   // original rejected by IMITATOR
		if (r1 === r2) same++;
		else failures.push(path.relative(root, f));
		for (const g of ['orig', 'conv']) fs.rmSync(path.join(work, `${g}-regenerated.imi`), { force: true });
	}
}
for (const f of failures) console.log('DIFFERENT', f);
console.log(`${total} old-init models converted, ${same} regenerate identically, ${failures.length} differ, ${skipped} skipped (includes or rejected by IMITATOR)`);
process.exit(failures.length ? 1 : 0);
