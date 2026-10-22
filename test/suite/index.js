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

	await check('diagnostics: imitator -mode checksyntax (command)', async () => {
		await vscode.commands.executeCommand('imitator.checkSyntax');
		await sleep(3000);
		const d = vscode.languages.getDiagnostics(broken.uri).filter(d => d.source === 'imitator');
		assert.ok(d.length >= 1, 'no imitator diagnostics (binary missing?)');
	});

	/************ Rename ************/
	await vscode.window.showTextDocument(model);

	await check('rename: location in model + property file', async () => {
		const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', model.uri, at(model, 'loc obs_bad').translate(0, 5), 'violation');
		const files = edit.entries().map(([uri, edits]) => `${path.basename(uri.fsPath)}:${edits.length}`).sort();
		assert.deepStrictEqual(files, ['train.imi:2', 'train.imiprop:1']);
	});

	await check('rename: action renames every declaration and sync', async () => {
		const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', model.uri, at(model, 'leave'), 'depart');
		assert.strictEqual(edit.get(model.uri).length, 4);
	});

	await check('rename: rejects property keyword, clash, built-in, keyword', async () => {
		const pos = at(model, 'loc near').translate(0, 5);
		for (const [name, reason] of [['EF', 'property'], ['far', 'already declared'], ['pow', 'built-in'], ['goto', 'keyword'], ['2x', 'valid']]) {
			let err = null;
			try { await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', model.uri, pos, name); }
			catch (e) { err = e; }
			assert.ok(err && String(err.message || err).includes(reason), `${name}: ${err}`);
		}
	});

	await check('rename: refuses a keyword position', async () => {
		let err = null;
		try { await vscode.commands.executeCommand('vscode.prepareRename', model.uri, at(model, 'goto')); }
		catch (e) { err = e; }
		assert.ok(err, 'prepareRename accepted `goto`');
	});

	/************ Semantic tokens ************/
	await check('semantic tokens: clock / parameter / discrete / constant / location', async () => {
		const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', model.uri);
		const tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', model.uri);
		const d = tokens.data;
		const found = {};
		let line = 0, char = 0;
		for (let i = 0; i < d.length; i += 5) {
			line += d[i];
			char = d[i] === 0 ? char + d[i + 1] : d[i + 1];
			const word = model.getText(new vscode.Range(line, char, line, char + d[i + 2]));
			found[word] = found[word] || legend.tokenTypes[d[i + 3]] + (d[i + 4] & 2 ? '.readonly' : '');
		}
		assert.strictEqual(found.xt, 'clock');
		assert.strictEqual(found.p_lower, 'modelParameter');
		assert.strictEqual(found.nb_cross, 'discreteVariable');
		assert.strictEqual(found.MAX_CROSS, 'variable.readonly');
		assert.strictEqual(found.crossing, 'enumMember');
		assert.strictEqual(found.approach, 'event');
	});

	await check('semantic tokens: default colors contributed', () => {
		const rules = vscode.workspace.getConfiguration('editor').get('semanticTokenColorCustomizations').rules || {};
		assert.ok(rules.clock && rules.modelParameter && rules.discreteVariable, JSON.stringify(rules));
	});

	/************ Signature help ************/
	await check('signature help: user function', async () => {
		const pos = at(model, 'succ(nb_cross)').translate(0, 5);
		const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', model.uri, pos);
		assert.strictEqual(help.signatures[0].label, 'succ(i : int) : int');
		assert.strictEqual(help.activeParameter, 0);
	});

	await check('signature help: built-in, 2nd argument, nested parentheses', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'imitator', content: 'var i : int;\nautomaton a\nloc l: invariant True\n\twhen True do {i := pow((i + 1), ' });
		const help = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', doc.uri, doc.positionAt(doc.getText().length));
		assert.ok(help.signatures[0].label.startsWith('pow('), help.signatures[0].label);
		assert.strictEqual(help.activeParameter, 1);
	});

	/************ Includes ************/
	const incMain = await vscode.workspace.openTextDocument(path.join(fixtures, 'include/main.imi'));

	await check('include: no false errors, definition jumps into the included file', async () => {
		await sleep(500);
		const errs = vscode.languages.getDiagnostics(incMain.uri).filter(d => d.source === 'imitator-ext');
		assert.strictEqual(errs.length, 0, errs.map(e => e.message).join('; '));
		const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', incMain.uri, at(incMain, 'counter]'));
		assert.strictEqual(path.basename(defs[0].uri.fsPath), 'part.imi');
		const loc = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', incMain.uri, at(incMain, 'zero'));
		assert.strictEqual(path.basename(loc[0].uri.fsPath), 'part.imi');
	});

	await check('include: references of an action span both files', async () => {
		const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', incMain.uri, at(incMain, 'tick'));
		const files = [...new Set(refs.map(r => path.basename(r.uri.fsPath)))].sort();
		assert.deepStrictEqual(files, ['main.imi', 'part.imi']);
		assert.strictEqual(refs.length, 5);  // main: decl + sync; part: decl + 2 syncs
	});

	await check('include: completion of locations of an included automaton', async () => {
		const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', incMain.uri, at(incMain, 'zero;').translate(0, -1));
		assert.deepStrictEqual(own(list).sort(), ['one', 'zero']);
	});

	/************ Quick fixes ************/
	await check('quick fixes: synclabs, while, undeclared action, unknown location', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'imitator', content:
			'var x : clock;\nautomaton a\nsynclabs: b;\nloc l1: while x <= 2\n\twhen True sync c goto l3;\n\twhen True sync b goto l1;\nend\n' });
		await vscode.window.showTextDocument(doc);
		await sleep(800);
		const diags = vscode.languages.getDiagnostics(doc.uri).filter(d => d.source === 'imitator-ext');
		assert.deepStrictEqual(diags.map(d => d.code).sort(), ['deprecated-synclabs', 'deprecated-while', 'undeclared-action', 'unknown-location']);
		const titles = [];
		// Apply one fix per diagnostic, last first so earlier offsets stay valid
		for (const d of diags.sort((a, b) => b.range.start.compareTo(a.range.start))) {
			const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, d.range, vscode.CodeActionKind.QuickFix.value);
			// The command does not always return `diagnostics`: match on this extension's titles
			const fix = actions.find(a => /^(Replace `|Declare action|Create location)/.test(a.title));
			assert.ok(fix, `no fix for ${d.code}: ${actions.map(a => a.title).join(', ')}`);
			titles.push(fix.title);
			await vscode.workspace.applyEdit(fix.edit);
		}
		assert.strictEqual(doc.getText(),
			'var x : clock;\nautomaton a\nactions: b, c;\nloc l1: invariant x <= 2\n\twhen True sync c goto l3;\n\twhen True sync b goto l1;\nloc l3: invariant True\nend\n');
		await sleep(800);
		assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).filter(d => d.source === 'imitator-ext').length, 0);
	});

	await check('quick fix: declare action when the automaton has no actions list', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'imitator', content: 'automaton a\nloc l1: invariant True\n\twhen True sync go goto l1;\nend\n' });
		await sleep(800);
		const d = vscode.languages.getDiagnostics(doc.uri).find(x => x.code === 'undeclared-action');
		const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, d.range);
		await vscode.workspace.applyEdit(actions.find(a => a.title.startsWith('Declare action')).edit);
		assert.strictEqual(doc.getText(), 'automaton a\nactions: go;\nloc l1: invariant True\n\twhen True sync go goto l1;\nend\n');
	});

	/************ Run ************/
	/************ Includers ************/
	const part = await vscode.workspace.openTextDocument(path.join(fixtures, 'include/part.imi'));

	await check('includers: part.imi alone is analyzed inside main.imi (references, rename)', async () => {
		await vscode.window.showTextDocument(part);
		await sleep(500);
		const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', part.uri, at(part, 'tick'));
		assert.deepStrictEqual([...new Set(refs.map(r => path.basename(r.uri.fsPath)))].sort(), ['main.imi', 'part.imi']);
		const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', part.uri, at(part, 'loc zero').translate(0, 5), 'zero_count');
		assert.deepStrictEqual(edit.entries().map(([u, e]) => `${path.basename(u.fsPath)}:${e.length}`).sort(), ['main.imi:1', 'part.imi:2']);
	});

	await check('includers: IMITATOR check of part.imi goes through main.imi (no false errors)', async () => {
		await vscode.commands.executeCommand('imitator.checkSyntax');
		await sleep(3000);
		const d = vscode.languages.getDiagnostics(part.uri);
		assert.strictEqual(d.length, 0, d.map(x => `${x.source}: ${x.message}`).join('; '));
	});

	/************ Init quick fixes ************/
	await check('quick fix: add missing loc[A] := (one, and all at once)', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'imitator', content:
			'var x : clock;\nautomaton a\nloc l1: invariant True\nend\nautomaton b\nloc m0: invariant True\nloc m1: invariant True\nend\nautomaton c\nloc n: invariant True\nend\ninit := {\n\tdiscrete =\n\t\tloc[a] := l1,\n\t;\n\tcontinuous = x = 0;\n}\n' });
		await vscode.window.showTextDocument(doc);
		await sleep(800);
		const diags = vscode.languages.getDiagnostics(doc.uri).filter(d => d.code === 'missing-initial-location');
		assert.strictEqual(diags.length, 2);
		const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, diags[0].range);
		const titles = actions.map(a => a.title);
		assert.ok(titles.includes('Add `loc[b] := …` to init') && titles.includes('Add `loc[c] := …` to init'), titles.join(', '));
		await vscode.workspace.applyEdit(actions.find(a => a.title === 'Add every missing initial location to init').edit);
		assert.ok(doc.getText().includes('discrete = loc[b] := m0, loc[c] := n,\n\t\tloc[a] := l1,'), doc.getText());
		await sleep(800);
		assert.strictEqual(vscode.languages.getDiagnostics(doc.uri).filter(d => d.source === 'imitator-ext').length, 0);
	});

	await check('quick fix: convert old init syntax', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'imitator', content:
			'var x : clock;\n\ti : int;\n\tp : parameter;\nautomaton a\nloc l1: invariant True\nend\ninit :=\n\t& loc[a] = l1\n\t(* a comment *)\n\t& i = 0\n\t& x = 0 & (p >= 0)\n;\nend\n' });
		await vscode.window.showTextDocument(doc);
		await sleep(800);
		const d = vscode.languages.getDiagnostics(doc.uri).find(x => x.code === 'deprecated-old-init');
		assert.ok(d, 'no old-init warning');
		const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, d.range);
		await vscode.workspace.applyEdit(actions.find(a => a.title.startsWith('Convert to')).edit);
		assert.strictEqual(doc.getText(), 'var x : clock;\n\ti : int;\n\tp : parameter;\nautomaton a\nloc l1: invariant True\nend\n' +
			'init := {\n\tdiscrete =\n\t\tloc[a] := l1,\n\t\ti := 0,\n\t;\n\tcontinuous =\n\t\t& x = 0\n\t\t& p >= 0\n\t;\n}\nend\n');
	});

	/************ Run and results ************/
	await check('run: IMITATOR on train.imi + train.imiprop, result panel', async () => {
		await vscode.window.showTextDocument(model);
		const code = await vscode.commands.executeCommand('imitator.run');
		assert.strictEqual(code, 0);
		const parsed = await vscode.commands.executeCommand('imitator.showResult');
		assert.deepStrictEqual(parsed.constraints, ['p_approach > p_lower\n& p_lower >= 0']);
		assert.strictEqual(parsed.fields['Constraint soundness'], 'exact');
	});

	await check('result: CodeLens on the property line', async () => {
		await sleep(500);
		const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', prop.uri);
		const titles = lenses.map(l => l.command && l.command.title);
		assert.ok(titles.some(t => t === 'Result: p_approach > p_lower & p_lower >= 0 (exact)'), titles.join(' | '));
	});

	await check('result: hover on a parameter shows its constraints; on the property line, the result', async () => {
		const h = await vscode.commands.executeCommand('vscode.executeHoverProvider', model.uri, at(model, 'p_lower', 3));
		const text = h.map(x => x.contents.map(c => c.value).join('\n')).join('\n');
		assert.ok(text.includes('p_lower >= 0') && text.includes('train.res'), text);
		const hp = await vscode.commands.executeCommand('vscode.executeHoverProvider', prop.uri, at(prop, 'AGnot'));
		const textp = hp.map(x => x.contents.map(c => c.value).join('\n')).join('\n');
		assert.ok(textp.includes('IMITATOR result') && textp.includes('p_approach > p_lower'), textp);
	});

	await check('result: CodeLens offers a run when there is no result', async () => {
		require('fs').unlinkSync(path.join(fixtures, 'train.res'));
		await sleep(500);
		const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', prop.uri);
		assert.deepStrictEqual(lenses.map(l => l.command.title), ['▶ Run IMITATOR']);
	});

	console.log('\n' + results.join('\n'));
	if (results.some(r => r.startsWith('FAIL'))) throw new Error('some checks failed');
}

module.exports = { run };
