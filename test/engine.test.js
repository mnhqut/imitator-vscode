// Engine regression test on every model of the repository (plain Node, no VS Code):
//   node test/engine.test.js
// Expected: no crash, and diagnostics only on the few files IMITATOR itself rejects.
const fs = require('fs');
const path = require('path');
const engine = require('../src/engine');

const root = path.resolve(__dirname, '../..');
// Old test files that still contain a `property :=` inside the model: rejected by IMITATOR 3.4 too
const KNOWN_INVALID = /MergeTests\/test_merge[12]\.imi|example-include-(1c|2c|1-equivalent|2-equivalent|3-equivalent)\.imi/;

function* walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (e.name.endsWith('.imi')) yield p;
	}
}

let files = 0, failures = 0;
for (const dir of ['benchmarks', 'doc', 'tests']) {
	if (!fs.existsSync(path.join(root, dir))) continue;
	for (const f of walk(path.join(root, dir))) {
		files++;
		const text = fs.readFileSync(f, 'utf8');
		let a;
		try { a = engine.analyzeModel(text); }
		catch (e) { failures++; console.log(`CRASH ${f}: ${e.stack}`); continue; }
		if (a.diagnostics.length && !KNOWN_INVALID.test(f)) {
			failures++;
			const d = a.diagnostics[0];
			console.log(`FALSE POSITIVE ${path.relative(root, f)}:${text.slice(0, d.start).split('\n').length}: ${d.message}`);
		}
	}
}
console.log(`${files} models analyzed, ${failures} failures`);
process.exit(failures ? 1 : 0);
