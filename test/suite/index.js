const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const fixtures = path.resolve(__dirname, '../fixtures');
const results = [];

async function check(name, fn) {
	try { await fn(); results.push(`PASS  ${name}`); }
	catch (e) { results.push(`FAIL  ${name}: ${e.message}`); }
}

// Items from this extension only (VS Code adds snippets and word-based items)
const own = list => list.items
	.filter(i => i.kind !== vscode.CompletionItemKind.Snippet && i.kind !== vscode.CompletionItemKind.Text)
	.map(i => (typeof i.label === 'string' ? i.label : i.label.label));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Position of the n-th occurrence of `word` (cursor inside it)
function at(doc, word, n = 1) {
	let idx = -1;
	for (let i = 0; i < n; i++) idx = doc.getText().indexOf(word, idx + 1);
	return doc.positionAt(idx + 1);
}

async function run() {
	const binary = path.resolve(__dirname, '../../../bin/imitator');
	await vscode.workspace.getConfiguration('imitator').update('executablePath', binary, vscode.ConfigurationTarget.Global);
	const model = await vscode.workspace.openTextDocument(path.join(fixtures, 'train.imi'));
	const prop = await vscode.workspace.openTextDocument(path.join(fixtures, 'train.imiprop'));
	const broken = await vscode.workspace.openTextDocument(path.join(fixtures, 'broken.imi'));
	await vscode.window.showTextDocument(model);

	await check('language ids', () => {
		assert.strictEqual(model.languageId, 'imitator');
		assert.strictEqual(prop.languageId, 'imitator-property');
	});

	await check('outline: var, function, 3 automata with locations, init', async () => {
		const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', model.uri);
		assert.deepStrictEqual(syms.map(s => s.name), ['var', 'succ', 'train', 'gate', 'observer', 'init']);
		assert.deepStrictEqual(syms[2].children.map(s => s.name), ['far', 'near', 'crossing']);
		assert.strictEqual(syms[0].children.length, 6);
	});

	await check('folding ranges for automata/function/init', async () => {
		const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', model.uri);
		assert.ok(folds.length >= 5, `got ${folds.length}`);
	});

	await check('completion after goto = locations of enclosing automaton', async () => {
		const pos = at(model, 'goto near');
		const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', model.uri, pos.translate(0, 4));
		const labels = own(list);
		for (const l of ['far', 'near', 'crossing']) assert.ok(labels.includes(l), l);
		assert.ok(!labels.includes('up'), 'gate location leaked');
	});

	await check('completion after sync = actions of automaton', async () => {
		const pos = at(model, 'sync lower_done goto down');
		const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', model.uri, pos.translate(0, 4));
		const labels = own(list);
		assert.deepStrictEqual(labels.sort(), ['approach', 'leave', 'lower_done']);
	});

	await check('completion in init loc[gate] := … = gate locations', async () => {
		const pos = at(model, 'loc[gate] := up');
		const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', model.uri, pos.translate(0, 12));
		assert.deepStrictEqual(own(list).sort(), ['down', 'lowering', 'up']);
	});

	await check('general completion has keywords, builtins, variables, function', async () => {
		const pos = at(model, 'nb_cross < MAX');
		const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', model.uri, pos.translate(0, -1));
		const labels = own(list);
		for (const l of ['when', 'rational_of_int', 'p_lower', 'MAX_CROSS', 'succ']) assert.ok(labels.includes(l), l);
	});

	await check('go to definition: goto target -> location', async () => {
		const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', model.uri, at(model, 'goto crossing').translate(0, 6));
		assert.strictEqual(defs.length, 1);
		assert.strictEqual(model.getText(defs[0].range), 'crossing');
		assert.strictEqual(defs[0].range.start.line, at(model, 'loc crossing').line);
	});

	await check('go to definition: variable -> var declaration', async () => {
		const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', model.uri, at(model, 'p_lower', 3));
		assert.strictEqual(defs[0].range.start.line, 3);
	});

	await check('go to definition: function local', async () => {
		const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', model.uri, at(model, 'return j').translate(0, 7));
		assert.strictEqual(defs[0].range.start.line, at(model, 'var j').line);
	});

	await check('go to definition from property into model', async () => {
		const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', prop.uri, at(prop, 'obs_bad'));
		assert.strictEqual(defs[0].uri.fsPath, model.uri.fsPath);
		assert.strictEqual(defs[0].range.start.line, at(model, 'loc obs_bad').line);
	});

	await check('references: action `leave` in both automata', async () => {
		const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', model.uri, at(model, 'leave'));
		assert.strictEqual(refs.length, 4);  // 2 declarations + 2 syncs
	});

	await check('references: location `far` (decl, goto, init)', async () => {
		const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', model.uri, at(model, 'loc far').translate(0, 4));
		assert.strictEqual(refs.length, 3);
	});

	await check('hover: keyword, builtin-free symbol', async () => {
		const h1 = await vscode.commands.executeCommand('vscode.executeHoverProvider', model.uri, at(model, 'invariant'));
		assert.ok(h1[0].contents[0].value.includes('convex'));
		const h2 = await vscode.commands.executeCommand('vscode.executeHoverProvider', model.uri, at(model, 'p_lower', 3));
		assert.ok(h2[0].contents[0].value.includes('(parameter) p_lower : parameter'), h2[0].contents[0].value);
	});

	await check('property completion: loc[ -> automata', async () => {
		const pos = at(prop, 'observer');
		const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', prop.uri, pos.translate(0, -1));
		assert.deepStrictEqual(own(list).sort(), ['gate', 'observer', 'train']);
	});

	await check('diagnostics: valid model has none, broken has 2 engine errors', async () => {
		await vscode.window.showTextDocument(broken);
		await sleep(1500);
		const ok = vscode.languages.getDiagnostics(model.uri).filter(d => d.source === 'imitator-ext');
		assert.strictEqual(ok.length, 0);
		const bad = vscode.languages.getDiagnostics(broken.uri).filter(d => d.source === 'imitator-ext').map(d => d.message);
		assert.strictEqual(bad.length, 2, bad.join('; '));
	});

	await check('diagnostics: imitator -mode checksyntax on save', async () => {
		await vscode.window.activeTextEditor.edit(e => e.insert(new vscode.Position(0, 0), ' '));
		await broken.save();
		await sleep(3000);
		const d = vscode.languages.getDiagnostics(broken.uri).filter(d => d.source === 'imitator');
		assert.ok(d.length >= 1, 'no imitator diagnostics (binary missing?)');
	});

	console.log('\n' + results.join('\n'));
	if (results.some(r => r.startsWith('FAIL'))) throw new Error('some checks failed');
}

module.exports = { run };
