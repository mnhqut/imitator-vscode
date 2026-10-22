'use strict';
/*
 * Parser of IMITATOR result files (.res), see src/lib/ResultProcessor.ml:
 *   header comment (Model, Generated, Command), `Key : value` lines,
 *   BEGIN CONSTRAINT … END CONSTRAINT blocks, BEGIN RESULT … END RESULT blocks.
 * No dependency on the `vscode` module.
 */

function parseResult(text) {
	const result = { header: {}, fields: {}, constraints: [], results: [] };

	const header = /^\(\*+([\s\S]*?)\*+\)/.exec(text);
	if (header)
		for (const line of header[1].split('\n')) {
			const m = /^\s*\*\s*([A-Za-z ]+?)\s*:\s*(.*)$/.exec(line);
			if (m) result.header[m[1]] = m[2].trim().replace(/^'(.*)'$/, '$1');
		}

	const blocks = /\nBEGIN (CONSTRAINT|RESULT)\n([\s\S]*?)\nEND \1\n?/g;
	let m;
	while ((m = blocks.exec(text)))
		(m[1] === 'CONSTRAINT' ? result.constraints : result.results).push(m[2].trim());

	// `Key   : value` lines outside the blocks; the first occurrence wins
	const outside = text.replace(blocks, '\n');
	for (const line of outside.split('\n')) {
		const f = /^([A-Za-z][^:\n]*?)\s+:\s(.*)$/.exec(line);
		if (f && !(f[1] in result.fields)) result.fields[f[1].trim()] = f[2].trim();
	}
	return result;
}

// One-line form of a constraint: " p > q\n& q >= 0" -> "p > q & q >= 0"
function oneLine(constraint) {
	return constraint.replace(/\s*\n\s*/g, ' ').trim();
}

// Lines (conjuncts) of the constraints that mention `name`
function conjunctsMentioning(result, name) {
	const re = new RegExp(`\\b${name}\\b`);
	const out = [];
	for (const c of result.constraints)
		for (const line of c.split('\n')) {
			const conj = line.replace(/^\s*(&|OR)?\s*/, '').trim();
			if (re.test(conj) && !out.includes(conj)) out.push(conj);
		}
	return out;
}

module.exports = { parseResult, oneLine, conjunctsMentioning };
