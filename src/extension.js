'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const engine = require('./engine');
const result = require('./result');
const { MODEL_DOCS, BUILTIN_DOCS, PROPERTY_DOCS } = require('./docs');

const MODEL = 'imitator';
const PROPERTY = 'imitator-property';

/************************************************************
 * Files: open documents first, then the disk
 ************************************************************/
function openDocument(file) {
	return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === file) || null;
}

function readText(file) {
	const doc = openDocument(file);
	if (doc) return doc.getText();
	try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

// `#include` paths are relative to the including file (as in ModelLexer.mll)
function readInclude(fromFile, includePath) {
	if (!fromFile) return null;
	const file = path.resolve(path.dirname(fromFile), includePath);
	const text = readText(file);
	return text === null ? null : { file, text };
}

// Range of [start, end) offsets in a file that may not be open
function rangeInFile(file, start, end) {
	const doc = openDocument(file);
	if (doc) return docRange(doc, start, end);
	const text = readText(file) || '';
	const pos = off => {
		const before = text.slice(0, off);
		return new vscode.Position(before.split('\n').length - 1, off - before.lastIndexOf('\n') - 1);
	};
	return new vscode.Range(pos(start), pos(end));
}

const docRange = (document, start, end) => new vscode.Range(document.positionAt(start), document.positionAt(end));

/************************************************************
 * Include index: which files include which (to analyze an included file in its model)
 ************************************************************/
const includeIndex = new Map();   // includer file -> [included files]
const indexedDirs = new Set();

function indexText(file, text) {
	if (!text.includes('#include')) { includeIndex.delete(file); return; }
	const included = engine.tokenize(text, engine.MODEL_KEYWORDS).tokens
		.filter(t => t.type === 'include')
		.map(t => path.resolve(path.dirname(file), t.file));
	if (included.length) includeIndex.set(file, included);
	else includeIndex.delete(file);
}

// Files outside the workspace: index their folder on first use
function indexDirectory(dir) {
	if (indexedDirs.has(dir)) return;
	indexedDirs.add(dir);
	try {
		for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.imi'))) {
			const text = readText(path.join(dir, f));
			if (text !== null) indexText(path.join(dir, f), text);
		}
	} catch (e) { /* unreadable folder */ }
}

async function indexWorkspace() {
	const uris = await vscode.workspace.findFiles('**/*.imi', '**/{node_modules,.vscode-test,.git}/**');
	for (const uri of uris) {
		const doc = openDocument(uri.fsPath);
		try { indexText(uri.fsPath, doc ? doc.getText() : await fs.promises.readFile(uri.fsPath, 'utf8')); }
		catch (e) { /* deleted meanwhile */ }
		indexedDirs.add(path.dirname(uri.fsPath));
	}
}

function includersOf(file) {
	indexDirectory(path.dirname(file));
	return [...includeIndex].filter(([, included]) => included.includes(file)).map(([f]) => f).sort();
}

// Top-most model including `file` (following includers upwards), or null
function rootModelOf(file) {
	const seen = new Set([file]);
	let cur = file;
	for (;;) {
		const next = includersOf(cur).find(f => !seen.has(f));
		if (!next) return cur === file ? null : cur;
		seen.add(next);
		cur = next;
	}
}

/************************************************************
 * Analysis cache (one analysis per document version)
 ************************************************************/
const cache = new Map();

function analyze(document) {
	// A property analysis depends on its model file: never cached
	if (document.languageId === PROPERTY)
		return engine.analyzeProperty(document.getText(), modelForProperty(document));
	const key = document.uri.toString();
	const hit = cache.get(key);
	if (hit && hit.version === document.version) return hit.analysis;
	const file = document.uri.scheme === 'file' ? document.uri.fsPath : null;
	let analysis = null;
	// An included file is analyzed inside the model that includes it
	const root = file && rootModelOf(file);
	if (root) {
		const text = readText(root);
		if (text !== null) analysis = engine.focusOn(engine.analyzeModel(text, { file: root, readInclude }), file);
	}
	if (!analysis) analysis = engine.analyzeModel(document.getText(), { file, readInclude });
	analysis.uri = document.uri;
	cache.set(key, { version: document.version, analysis });
	return analysis;
}

// The model of a property file: same base name, else the only .imi of the folder
function modelFileForProperty(file) {
	const same = file.replace(/\.imiprop$/, '.imi');
	if (fs.existsSync(same)) return same;
	try {
		const imis = fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.imi'));
		if (imis.length === 1) return path.join(path.dirname(file), imis[0]);
	} catch (e) { /* unreadable folder */ }
	return null;
}

// Property files whose model is `modelFile` (inverse of modelFileForProperty)
function propertyFilesForModel(modelFile) {
	try {
		return fs.readdirSync(path.dirname(modelFile))
			.filter(f => f.endsWith('.imiprop'))
			.map(f => path.join(path.dirname(modelFile), f))
			.filter(f => modelFileForProperty(f) === modelFile);
	} catch (e) {
		return [];
	}
}

function modelForProperty(document) {
	if (document.uri.scheme !== 'file') return null;
	const file = modelFileForProperty(document.uri.fsPath);
	if (!file) return null;
	const open = openDocument(file);
	if (open) return analyze(open);
	const text = readText(file);
	if (text === null) return null;
	return Object.assign(engine.analyzeModel(text, { file, readInclude }), { uri: vscode.Uri.file(file) });
}

// Uri of a unit of a model analysis (the main unit of an unsaved document has no file)
function unitUri(model, unit) {
	return unit.file ? vscode.Uri.file(unit.file) : model.uri;
}

function unitRange(model, unit, start, end) {
	if (!unit.file) {
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === model.uri.toString());
		return docRange(doc, start, end);
	}
	return rangeInFile(unit.file, start, end);
}

/************************************************************
 * Outline
 ************************************************************/
const SYMBOL_KINDS = {
	namespace: vscode.SymbolKind.Namespace,
	clock: vscode.SymbolKind.Variable,
	discrete: vscode.SymbolKind.Variable,
	parameter: vscode.SymbolKind.TypeParameter,
	constant: vscode.SymbolKind.Constant,
	function: vscode.SymbolKind.Function,
	'parameter-of': vscode.SymbolKind.TypeParameter,
	local: vscode.SymbolKind.Variable,
	automaton: vscode.SymbolKind.Class,
	template: vscode.SymbolKind.Interface,
	location: vscode.SymbolKind.EnumMember,
	init: vscode.SymbolKind.Constructor,
};

function toDocumentSymbol(document, s) {
	const range = docRange(document, s.start, Math.max(s.end, s.nameEnd));
	const selection = docRange(document, s.nameStart, s.nameEnd);
	const ds = new vscode.DocumentSymbol(s.name, s.detail || '', SYMBOL_KINDS[s.kind] || vscode.SymbolKind.Object, range, selection);
	ds.children = s.children.map(c => toDocumentSymbol(document, c));
	return ds;
}

/************************************************************
 * Completion
 ************************************************************/
const TYPE_WORDS = ['clock', 'parameter', 'constant', 'int', 'rational', 'rat', 'bool', 'binary', 'array', 'list', 'stack', 'queue', 'void'];

function item(label, kind, doc, detail) {
	const it = new vscode.CompletionItem(label, kind);
	if (doc) it.documentation = new vscode.MarkdownString(doc);
	if (detail) it.detail = detail;
	return it;
}

function symbolItems(syms, kind) {
	return syms.map(s => item(s.name, kind, null, s.detail));
}

function locationsOf(analysis, automatonName) {
	const a = analysis.automata.get(automatonName) || analysis.templates.get(automatonName);
	if (!a) return [];
	const scope = a.locScope || automatonName;
	const owner = analysis.automata.get(scope) || analysis.templates.get(scope);
	return owner && owner.locations ? [...owner.locations.values()] : [];
}

function modelCompletions(document, position) {
	const analysis = analyze(document);
	const offset = document.offsetAt(position);
	const before = document.lineAt(position).text.slice(0, position.character);
	const K = vscode.CompletionItemKind;
	let m;

	if (/\bgoto\s+\w*$/.test(before)) {
		const a = engine.enclosingAutomaton(analysis, offset);
		return a ? symbolItems(locationsOf(analysis, a.name), K.EnumMember) : [];
	}
	if (/\bsync\s+\w*$/.test(before)) {
		const a = engine.enclosingAutomaton(analysis, offset);
		const info = a && (analysis.automata.get(a.name) || analysis.templates.get(a.name));
		return info && info.actions ? [...info.actions].map(n => item(n, K.Event, null, 'action')) : [];
	}
	if ((m = /\bloc\s*\[\s*(\w+)\s*\]\s*:?=\s*\w*$/.exec(before)))
		return symbolItems(locationsOf(analysis, m[1]), K.EnumMember);
	if (/\bloc\s*\[\s*\w*$/.test(before))
		return [...analysis.automata.keys()].map(n => item(n, K.Class, null, 'automaton'));
	if (/\binstantiate\s+\w+\s*:=\s*\w*$/.test(before))
		return [...analysis.templates.keys()].map(n => item(n, K.Interface, null, 'template'));
	const varSection = analysis.symbols.find(s => s.kind === 'namespace' && s.start <= offset && offset <= s.end + 1);
	if (/:\s*[\w ]*$/.test(before) && !/:=/.test(before) && (varSection || /^\s*\w+\s*:\s*\w*$/.test(before)))
		return TYPE_WORDS.map(t => item(t, K.TypeParameter, MODEL_DOCS[t]));

	const items = [];
	for (const [k, doc] of Object.entries(MODEL_DOCS)) items.push(item(k, K.Keyword, doc));
	for (const [k, doc] of Object.entries(BUILTIN_DOCS)) items.push(item(k, K.Function, doc, 'built-in'));
	for (const s of analysis.defs.values()) {
		if (s.key.startsWith('var:')) items.push(item(s.name, s.kind === 'constant' ? K.Constant : K.Variable, null, `${s.kind} : ${s.detail}`));
		else if (s.key.startsWith('fun:')) items.push(item(s.name, K.Function, null, s.detail));
	}
	// Names only visible in the enclosing function / template
	const f = engine.enclosingFunction(analysis, offset) || engine.enclosingAutomaton(analysis, offset);
	if (f) {
		const prefix = f.kind === 'function' ? `local:${f.name}/` : `tparam:${f.name}/`;
		for (const s of analysis.defs.values())
			if (s.key.startsWith(prefix)) items.push(item(s.name, K.Variable, null, s.detail));
	}
	return items;
}

function propertyCompletions(document, position) {
	const before = document.lineAt(position).text.slice(0, position.character);
	const model = modelForProperty(document);
	const K = vscode.CompletionItemKind;
	let m;
	if (model) {
		if ((m = /\bloc\s*\[\s*(\w+)\s*\]\s*(=|<>)\s*\w*$/.exec(before)) || (m = /\b(\w+)\s+is\s+(not\s+)?in\s+\w*$/.exec(before)))
			return symbolItems(locationsOf(model, m[1]), K.EnumMember);
		if (/\bloc\s*\[\s*\w*$/.test(before))
			return [...model.automata.keys()].map(n => item(n, K.Class, null, 'automaton'));
	}
	const items = Object.entries(PROPERTY_DOCS).map(([k, doc]) => item(k, k.startsWith('#') ? K.Keyword : K.Function, doc));
	if (model) {
		for (const s of model.defs.values()) {
			if (s.key.startsWith('var:')) items.push(item(s.name, K.Variable, null, `${s.kind} : ${s.detail}`));
			else if (s.key.startsWith('act:')) items.push(item(s.name, K.Event, null, 'action'));
		}
	}
	return items;
}

/************************************************************
 * Hover, definition, references, rename
 ************************************************************/
function describe(sym) {
	switch (sym.kind) {
		case 'clock': case 'parameter': case 'discrete': case 'constant': return `(${sym.kind}) ${sym.name} : ${sym.detail}`;
		case 'function': return `function ${sym.name}${sym.detail}`;
		case 'parameter-of': case 'local': return `(local) ${sym.name}${sym.detail ? ' : ' + sym.detail : ''}`;
		case 'location': return `(location) ${sym.detail ? sym.detail + ' ' : ''}loc ${sym.name}`;
		case 'automaton': return `automaton ${sym.name}${sym.detail ? ' — ' + sym.detail : ''}`;
		case 'template': return `template ${sym.name}${sym.detail}`;
		case 'action': return `(action) ${sym.name}`;
		default: return sym.name;
	}
}

// {ref, model}: the reference under the cursor and the model analysis owning its definition
function lookup(document, position) {
	const ref = engine.refAt(analyze(document), document.offsetAt(position));
	if (!ref || !ref.key) return { ref };
	const model = document.languageId === PROPERTY ? modelForProperty(document) : analyze(document);
	return { ref, model };
}

// Every occurrence of `key`: in the model, its included files, and the property files of the model
function occurrences(model, key, withProperties) {
	const out = [];
	for (const unit of model.units)
		for (const r of unit.refs)
			if (r.key === key) out.push({ uri: unitUri(model, unit), range: unitRange(model, unit, r.start, r.end), decl: !!r.decl });
	if (withProperties && model.units[0].file && /^(var|act|auto|loc):/.test(key)) {
		for (const file of propertyFilesForModel(model.units[0].file)) {
			const text = readText(file);
			if (text === null) continue;
			for (const r of engine.analyzeProperty(text, model).refs)
				if (r.key === key) out.push({ uri: vscode.Uri.file(file), range: rangeInFile(file, r.start, r.end), decl: false });
		}
	}
	return out;
}

function hover(document, position) {
	const wordRange = document.getWordRangeAtPosition(position);
	if (!wordRange) return null;
	const word = document.getText(wordRange);
	const { ref, model } = lookup(document, position);
	if (ref && ref.key && model) {
		const sym = model.defs.get(ref.key);
		if (sym) {
			const md = new vscode.MarkdownString().appendCodeblock(describe(sym), MODEL);
			const here = document.languageId === PROPERTY ? model.file : analyze(document).file;
			if (sym.file && sym.file !== here) md.appendMarkdown(`Declared in \`${path.basename(sym.file)}\`\n\n`);
			if (sym.kind === 'parameter') appendResultForParameter(md, model, sym.name);
			return new vscode.Hover(md, wordRange);
		}
	}
	const docs = document.languageId === PROPERTY ? PROPERTY_DOCS : MODEL_DOCS;
	const text = docs[word] || BUILTIN_DOCS[word];
	// On the property line of a .imiprop: the last result after the keyword doc
	const res = document.languageId === PROPERTY && /^\s*(property\b|#)/.test(document.lineAt(position).text) && lastResult(document);
	if (res) return new vscode.Hover([new vscode.MarkdownString(text || ''), resultMarkdown(res)], wordRange);
	return text ? new vscode.Hover(new vscode.MarkdownString(text), wordRange) : null;
}

function definition(document, position) {
	const { ref, model } = lookup(document, position);
	if (!ref || !ref.key || !model) return null;
	// Actions have one declaration per automaton: list them all
	return occurrences(model, ref.key, false).filter(o => o.decl).map(o => new vscode.Location(o.uri, o.range));
}

function references(document, position, context) {
	const { ref, model } = lookup(document, position);
	if (!ref || !ref.key || !model) return null;
	return occurrences(model, ref.key, true)
		.filter(o => context.includeDeclaration || !o.decl)
		.map(o => new vscode.Location(o.uri, o.range));
}

function highlights(document, position) {
	const analysis = analyze(document);
	const ref = engine.refAt(analysis, document.offsetAt(position));
	if (!ref || !ref.key) return null;
	return analysis.refs.filter(r => r.key === ref.key).map(r => new vscode.DocumentHighlight(
		docRange(document, r.start, r.end),
		r.decl ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
}

function prepareRename(document, position) {
	const { ref, model } = lookup(document, position);
	if (!ref) throw new Error('Nothing to rename here.');
	if (!ref.key || !model || !model.defs.has(ref.key)) throw new Error(`\`${ref.name}\` is not declared in the model: it cannot be renamed.`);
	return docRange(document, ref.start, ref.end);
}

function rename(document, position, newName) {
	const { ref, model } = lookup(document, position);
	if (!ref || !ref.key || !model || !model.defs.has(ref.key)) return null;
	const problem = engine.checkNewName(newName);
	if (problem) throw new Error(problem);
	const clash = engine.clashKeys(ref.key, newName).find(k => model.defs.has(k));
	if (clash) throw new Error(`\`${newName}\` is already declared (${model.defs.get(clash).kind}).`);
	const edit = new vscode.WorkspaceEdit();
	for (const o of occurrences(model, ref.key, true)) edit.replace(o.uri, o.range, newName);
	return edit;
}

/************************************************************
 * Semantic tokens: clocks, parameters, discrete variables… in distinct colors
 ************************************************************/
const TOKEN_TYPES = ['clock', 'modelParameter', 'discreteVariable', 'variable', 'function', 'parameter', 'enumMember', 'event', 'class', 'interface'];
const TOKEN_MODIFIERS = ['declaration', 'readonly', 'defaultLibrary'];
const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

function tokenTypeOf(sym) {
	switch (sym.kind) {
		case 'clock': return ['clock'];
		case 'parameter': return ['modelParameter'];
		case 'discrete': return ['discreteVariable'];
		case 'constant': return ['variable', 'readonly'];
		case 'function': return ['function'];
		case 'parameter-of': return ['parameter'];
		case 'local': return ['variable'];
		case 'location': return ['enumMember'];
		case 'action': return ['event'];
		case 'automaton': return ['class'];
		case 'template': return ['interface'];
		default: return null;
	}
}

function semanticTokens(document) {
	const analysis = analyze(document);
	const model = document.languageId === PROPERTY ? modelForProperty(document) : analysis;
	const builder = new vscode.SemanticTokensBuilder(legend);
	const refs = [...analysis.refs].sort((a, b) => a.start - b.start);
	for (const r of refs) {
		if (!r.key) continue;
		let type, mods = [];
		if (r.key.startsWith('builtin:')) { type = 'function'; mods = ['defaultLibrary']; }
		else {
			const sym = model && model.defs.get(r.key);
			const t = sym && tokenTypeOf(sym);
			if (!t) continue;
			[type, ...mods] = t;
		}
		if (r.decl) mods = mods.concat('declaration');
		builder.push(docRange(document, r.start, r.end), type, mods);
	}
	return builder.build();
}

/************************************************************
 * Signature help
 ************************************************************/
// "`pow(x, e : int)` — x int or rational." -> {label, params, doc}
function builtinSignature(name) {
	const m = /^`([^`]*)`\s*(?:—\s*)?(.*)$/.exec(BUILTIN_DOCS[name] || '');
	if (!m) return null;
	// Split the arguments at depth-1 commas: `fill_left(w : binary(n), i : int)`
	const params = [];
	let depth = 0, cur = '';
	for (const c of m[1].slice(m[1].indexOf('('))) {
		if (c === '(' && depth++ === 0) continue;
		if (c === ')' && --depth === 0) break;
		if (c === ',' && depth === 1) { params.push(cur.trim()); cur = ''; continue; }
		cur += c;
	}
	if (cur.trim()) params.push(cur.trim());
	return { label: m[1], params, doc: m[2] };
}

function userSignature(analysis, call) {
	const sym = analysis.defs.get((call.instantiate ? 'tpl:' : 'fun:') + call.name);
	if (!sym) return null;
	const params = sym.children.filter(c => c.kind === 'parameter-of').map(c => `${c.name} : ${c.detail}`);
	return { label: sym.name + sym.detail, params, doc: call.instantiate ? 'template' : 'user function' };
}

function signatureHelp(document, position) {
	const analysis = analyze(document);
	const call = engine.callAt(analysis, document.offsetAt(position));
	if (!call) return null;
	const sig = (!call.instantiate && builtinSignature(call.name)) || userSignature(analysis, call);
	if (!sig) return null;
	const info = new vscode.SignatureInformation(sig.label, new vscode.MarkdownString(sig.doc));
	let from = sig.label.indexOf('(') + 1;
	info.parameters = sig.params.map(p => {
		const start = sig.label.indexOf(p, from);
		from = start + p.length;
		return new vscode.ParameterInformation([start, start + p.length]);
	});
	const help = new vscode.SignatureHelp();
	help.signatures = [info];
	help.activeSignature = 0;
	help.activeParameter = Math.min(call.argIndex, Math.max(0, sig.params.length - 1));
	return help;
}

/************************************************************
 * Quick fixes
 ************************************************************/
function codeActions(document, range, context) {
	const analysis = analyze(document);
	const actions = [];
	for (const diag of context.diagnostics) {
		if (diag.source !== 'imitator-ext' || !diag.code) continue;
		const start = document.offsetAt(diag.range.start);
		// Several `missing-initial-location` share the `init` range: match the message too
		const d = analysis.diagnostics.find(x => x.code === diag.code && x.start === start && x.message === diag.message);
		if (!d) continue;
		const name = document.getText(diag.range);
		let title, edit = new vscode.WorkspaceEdit();
		switch (d.code) {
			case 'deprecated-synclabs':
				title = 'Replace `synclabs` with `actions`';
				edit.replace(document.uri, diag.range, 'actions');
				break;
			case 'deprecated-while':
				title = 'Replace `while` with `invariant`';
				edit.replace(document.uri, diag.range, 'invariant');
				break;
			case 'undeclared-action':
				title = `Declare action \`${name}\``;
				edit.insert(document.uri, document.positionAt(d.fix.at), d.fix.text);
				break;
			case 'unknown-location':
				if (!d.fix) continue;
				title = `Create location \`${name}\``;
				edit.insert(document.uri, document.positionAt(d.fix.at), d.fix.text);
				break;
			case 'missing-initial-location':
				title = `Add \`loc[${d.automaton}] := …\` to init`;
				edit.insert(document.uri, document.positionAt(d.fix.at), d.fix.text);
				break;
			case 'deprecated-old-init':
				if (!d.fix) continue;
				title = 'Convert to the `init := { discrete = …; continuous = …; }` syntax';
				edit.replace(document.uri, docRange(document, d.fix.at, d.fix.end), d.fix.text);
				break;
			default:
				continue;
		}
		const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
		action.edit = edit;
		action.diagnostics = [diag];
		action.isPreferred = d.code.startsWith('deprecated');
		actions.push(action);
	}
	// All missing initial locations at once
	const missing = analysis.diagnostics.filter(d => d.code === 'missing-initial-location');
	if (missing.length > 1 && actions.some(a => a.title.startsWith('Add `loc['))) {
		const all = new vscode.CodeAction('Add every missing initial location to init', vscode.CodeActionKind.QuickFix);
		all.edit = new vscode.WorkspaceEdit();
		all.edit.insert(document.uri, document.positionAt(missing[0].fix.at), missing.map(d => d.fix.text).join(''));
		actions.push(all);
	}
	// Fix every deprecated keyword of the file at once
	const deprecated = analysis.diagnostics.filter(d => d.code === 'deprecated-synclabs' || d.code === 'deprecated-while');
	if (deprecated.length > 1 && actions.some(a => a.isPreferred)) {
		const all = new vscode.CodeAction('Replace all deprecated `synclabs` / `while` in this file', vscode.CodeActionKind.QuickFix);
		all.edit = new vscode.WorkspaceEdit();
		for (const d of deprecated)
			all.edit.replace(document.uri, docRange(document, d.start, d.end), d.code === 'deprecated-synclabs' ? 'actions' : 'invariant');
		actions.push(all);
	}
	return actions;
}

/************************************************************
 * Diagnostics: (1) engine, live  (2) imitator -mode checksyntax, on save
 ************************************************************/
function engineDiagnostics(collection, document) {
	if (document.languageId !== MODEL && document.languageId !== PROPERTY) return;
	const analysis = analyze(document);
	collection.set(document.uri, analysis.diagnostics.map(d => {
		const diag = new vscode.Diagnostic(docRange(document, d.start, d.end), d.message,
			d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
		diag.source = 'imitator-ext';
		if (d.code) diag.code = d.code;
		if (d.code && d.code.startsWith('deprecated')) diag.tags = [vscode.DiagnosticTag.Deprecated];
		return diag;
	}));
}

function imitatorExecutable() {
	const configured = vscode.workspace.getConfiguration('imitator').get('executablePath') || 'imitator';
	if (configured !== 'imitator') return configured;
	// Inside the IMITATOR repository: use the freshly built binary
	for (const folder of vscode.workspace.workspaceFolders || []) {
		for (const candidate of ['bin/imitator', '../bin/imitator']) {
			const p = path.join(folder.uri.fsPath, candidate);
			if (fs.existsSync(p)) return p;
		}
	}
	return configured;
}

let warnedMissingBinary = false;

function warnMissingBinary() {
	if (warnedMissingBinary) return;
	warnedMissingBinary = true;
	vscode.window.showInformationMessage('IMITATOR binary not found: set `imitator.executablePath`.');
}

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// IMITATOR warnings already reported (with a precise range) by the engine
const DUPLICATED_WARNINGS = /The syntax `(synclabs|while \[invariant\])` is deprecated|Old syntax detected for the initial state definition|is not given any initial location/;

function checkWithImitator(collection, document, force) {
	if (document.languageId !== MODEL || document.uri.scheme !== 'file') return;
	if (!force && !vscode.workspace.getConfiguration('imitator').get('checkOnSave')) return;
	const file = document.uri.fsPath;
	// An included fragment is checked through the model that includes it; only the
	// messages about this file are kept (parse errors naming it, or names found in it)
	const root = rootModelOf(file);
	const target = root || file;
	cp.execFile(imitatorExecutable(), [path.basename(target), '-mode', 'checksyntax', '-no-output-result'],
		{ cwd: path.dirname(target), timeout: 30000 }, (err, stdout, stderr) => {
			if (err && err.code === 'ENOENT') { warnMissingBinary(); return; }
			const text = document.getText();
			const out = stripAnsi(stdout + '\n' + stderr);
			const diags = [];
			for (const line of out.split('\n')) {
				const m = /\*\*\* (ERROR|WARNING): (.*)$/.exec(line);
				if (!m) continue;
				const msg = m[2].trim();
				if (/IMITATOR aborted|The input model contains errors|Please check it again/.test(msg) || DUPLICATED_WARNINGS.test(msg)) continue;
				let range;
				const lm = /near `(.*)` at line (\d+)/.exec(msg);
				if (root) {
					const fm = /in file `([^`]*)`/.exec(msg);
					if (lm && !(fm && path.resolve(path.dirname(target), fm[1]) === file)) continue;
					if (!lm) {
						const nm = /`([a-zA-Z][a-zA-Z0-9_]*)`/.exec(msg);
						if (!nm || text.search(new RegExp(`\\b${nm[1]}\\b`)) < 0) continue;
					}
				}
				if (lm) {
					const lineNo = Math.min(parseInt(lm[2], 10) - 1, document.lineCount - 1);
					const col = document.lineAt(lineNo).text.indexOf(lm[1]);
					range = col >= 0 ? new vscode.Range(lineNo, col, lineNo, col + lm[1].length) : document.lineAt(lineNo).range;
				} else {
					// Point at the first occurrence of the first `name` quoted in the message
					const nm = /`([a-zA-Z][a-zA-Z0-9_]*)`/.exec(msg);
					const idx = nm ? text.search(new RegExp(`\\b${nm[1]}\\b`)) : -1;
					range = idx >= 0 ? docRange(document, idx, idx + nm[1].length) : new vscode.Range(0, 0, 0, 0);
				}
				const diag = new vscode.Diagnostic(range, msg,
					m[1] === 'ERROR' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
				diag.source = 'imitator';
				diags.push(diag);
			}
			collection.set(document.uri, diags);
		});
}

/************************************************************
 * Run IMITATOR on model + property
 ************************************************************/
let output;

// Model and property for the active editor (asks when several properties fit)
async function pickRunFiles(document) {
	if (document.languageId === PROPERTY) {
		const model = modelFileForProperty(document.uri.fsPath);
		if (!model) throw new Error(`No model found for ${path.basename(document.uri.fsPath)} (expected ${path.basename(document.uri.fsPath, '.imiprop')}.imi).`);
		return { model, property: document.uri.fsPath };
	}
	const props = propertyFilesForModel(document.uri.fsPath);
	if (props.length === 0) throw new Error(`No property file found for ${path.basename(document.uri.fsPath)} (expected ${path.basename(document.uri.fsPath, '.imi')}.imiprop).`);
	if (props.length === 1) return { model: document.uri.fsPath, property: props[0] };
	const pick = await vscode.window.showQuickPick(props.map(p => path.basename(p)), { placeHolder: 'Property file to check' });
	return pick && { model: document.uri.fsPath, property: path.join(path.dirname(document.uri.fsPath), pick) };
}

async function runImitator() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || (editor.document.languageId !== MODEL && editor.document.languageId !== PROPERTY) || editor.document.uri.scheme !== 'file') {
		vscode.window.showWarningMessage('Open a saved .imi or .imiprop file to run IMITATOR.');
		return;
	}
	let files;
	try { files = await pickRunFiles(editor.document); }
	catch (e) { vscode.window.showErrorMessage(e.message); return; }
	if (!files) return;
	for (const f of [files.model, files.property]) {
		const doc = openDocument(f);
		if (doc && doc.isDirty) await doc.save();
	}

	const cwd = path.dirname(files.model);
	const extra = vscode.workspace.getConfiguration('imitator').get('runArguments') || [];
	const args = [path.basename(files.model), path.relative(cwd, files.property), ...extra];
	const exe = imitatorExecutable();
	output.clear();
	output.show(true);
	output.appendLine(`$ cd ${cwd}`);
	output.appendLine(`$ ${exe} ${args.join(' ')}`);
	output.appendLine('');

	const code = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `IMITATOR: ${path.basename(files.model)} + ${path.basename(files.property)}`,
		cancellable: true,
	}, (progress, token) => new Promise(resolve => {
		const child = cp.spawn(exe, args, { cwd });
		token.onCancellationRequested(() => { child.kill(); output.appendLine('\n[cancelled]'); });
		child.stdout.on('data', b => output.append(stripAnsi(b.toString())));
		child.stderr.on('data', b => output.append(stripAnsi(b.toString())));
		child.on('error', err => {
			if (err.code === 'ENOENT') warnMissingBinary();
			output.appendLine(String(err));
			resolve(-1);
		});
		child.on('close', resolve);
	}));

	// IMITATOR writes <model>.res next to the model (default -output-prefix)
	const res = resultFileFor(files.model);
	if (code === 0 && fs.existsSync(res) && !extra.includes('-no-output-result')) {
		const show = vscode.workspace.getConfiguration('imitator').get('showResult') || 'panel';
		if (show !== 'file') showResultPanel(files.model, files.property);
		if (show !== 'panel') {
			const doc = await vscode.workspace.openTextDocument(res);
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
		}
		codeLensChanged.fire();
	} else if (code !== 0 && code !== null) {
		vscode.window.showErrorMessage(`IMITATOR exited with code ${code}: see the IMITATOR output.`);
	}
	return code;
}

/************************************************************
 * Results: panel, CodeLens on the property, hover
 ************************************************************/
const resultFileFor = model => path.join(path.dirname(model), path.basename(model, '.imi') + '.res');

// {file, parsed, stale, property} for a model or property document, or null
function lastResult(document) {
	if (document.uri.scheme !== 'file') return null;
	const fsPath = document.uri.fsPath;
	const model = document.languageId === PROPERTY ? modelFileForProperty(fsPath) : (rootModelOf(fsPath) || fsPath);
	if (!model) return null;
	return readResult(model, document.languageId === PROPERTY ? fsPath : null);
}

function readResult(model, property) {
	const file = resultFileFor(model);
	let stat;
	try { stat = fs.statSync(file); } catch (e) { return null; }
	const parsed = result.parseResult(fs.readFileSync(file, 'utf8'));
	// Stale when the model or the property changed after the run
	const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };
	const stale = mtime(model) > stat.mtimeMs || (property && mtime(property) > stat.mtimeMs);
	// The command line in the header tells which property was checked
	const command = parsed.header.Command || '';
	const checked = (/\S+\.imiprop\b/.exec(command) || [null])[0];
	return { file, model, property, parsed, stale, checked, time: new Date(stat.mtimeMs) };
}

function resultMarkdown(res) {
	const p = res.parsed;
	const md = new vscode.MarkdownString();
	md.appendMarkdown(`**IMITATOR result** — ${p.fields.Property || ''} (${p.fields.Algorithm || ''})${res.stale ? ' — ⚠ *stale: files changed after the run*' : ''}\n\n`);
	for (const c of p.constraints) md.appendCodeblock(c, 'text');
	if (!p.constraints.length && p.results.length) md.appendCodeblock(p.results[0].slice(0, 2000), 'text');
	const facts = ['Constraint soundness', 'Termination', 'Number of states', 'Total computation time']
		.filter(k => p.fields[k]).map(k => `${k}: ${p.fields[k]}`);
	md.appendMarkdown(facts.join(' · '));
	return md;
}

function appendResultForParameter(md, model, name) {
	const res = model.units[0].file && readResult(model.units[0].file, null);
	if (!res) return;
	const lines = result.conjunctsMentioning(res.parsed, name);
	if (!lines.length) return;
	md.appendMarkdown(`\n\nIn the last result (\`${path.basename(res.file)}\`${res.stale ? ', stale' : ''}):\n`);
	md.appendCodeblock(lines.join('\n'), 'text');
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let panel = null;

function resultHtml(res) {
	const p = res.parsed;
	const row = k => (p.fields[k] ? `<tr><th>${esc(k)}</th><td>${esc(p.fields[k])}</td></tr>` : '');
	const constraints = p.constraints.length
		? p.constraints.map(c => `<pre class="constraint">${esc(c)}</pre>`).join('')
		: (p.results.length ? `<pre>${esc(p.results.join('\n\n'))}</pre>` : '<p><i>No constraint in this result.</i></p>');
	return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px; }
pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-textCodeBlock-background); padding: 8px 12px; white-space: pre-wrap; }
.constraint { border-left: 3px solid var(--vscode-charts-green); }
.stale { color: var(--vscode-editorWarning-foreground); }
th { text-align: left; font-weight: normal; color: var(--vscode-descriptionForeground); padding-right: 16px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; margin-right: 8px; cursor: pointer; }
</style></head><body>
<h2>${esc(path.basename(res.model))}${res.checked ? ' + ' + esc(res.checked) : ''}</h2>
<p>${esc(p.fields.Property || '')} — ${esc(p.fields.Algorithm || '')} · ${esc(res.time.toLocaleString())}
${res.stale ? '<br><span class="stale">⚠ The model or the property changed after this run.</span>' : ''}</p>
<h3>Constraint</h3>
${constraints}
<table>${['Constraint soundness', 'Constraint nature', 'Termination', 'Number of states', 'Number of transitions', 'Total computation time', 'Number of parameters', 'Number of clocks'].map(row).join('')}</table>
<p><button onclick="post('open')">Open .res file</button><button onclick="post('run')">Run again</button></p>
<script>const vscode = acquireVsCodeApi(); function post(c) { vscode.postMessage(c); }</script>
</body></html>`;
}

// Shows (or refreshes) the result panel; returns the parsed result
function showResultPanel(model, property) {
	const res = readResult(model, property);
	if (!res) {
		vscode.window.showInformationMessage(`No result yet for ${path.basename(model)}: run IMITATOR first.`);
		return null;
	}
	if (!panel) {
		panel = vscode.window.createWebviewPanel('imitatorResult', 'IMITATOR result', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
		panel.onDidDispose(() => { panel = null; });
		panel.webview.onDidReceiveMessage(async msg => {
			const state = panel && panel.imitatorFiles;
			if (!state) return;
			if (msg === 'open') vscode.window.showTextDocument(await vscode.workspace.openTextDocument(resultFileFor(state.model)), vscode.ViewColumn.Beside);
			if (msg === 'run') {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(state.property || state.model), vscode.ViewColumn.One);
				vscode.commands.executeCommand('imitator.run');
			}
		});
	}
	panel.imitatorFiles = { model, property };
	panel.title = `Result: ${path.basename(model)}`;
	panel.webview.html = resultHtml(res);
	panel.reveal(vscode.ViewColumn.Beside, true);
	return res.parsed;
}

function showResultCommand() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file') return null;
	const doc = editor.document;
	if (doc.languageId === PROPERTY) {
		const model = modelFileForProperty(doc.uri.fsPath);
		return model ? showResultPanel(model, doc.uri.fsPath) : null;
	}
	if (doc.languageId === MODEL) {
		const model = rootModelOf(doc.uri.fsPath) || doc.uri.fsPath;
		return showResultPanel(model, propertyFilesForModel(model)[0] || null);
	}
	return null;
}

const codeLensChanged = new vscode.EventEmitter();

// Above `property :=`: the last synthesized constraint, or a run button
function codeLenses(document) {
	const line = document.getText().split('\n').findIndex(l => /^\s*(property\b|#(synth|witness|exhibit|exemplify))/.test(l));
	if (line < 0) return [];
	const range = new vscode.Range(line, 0, line, 0);
	const res = lastResult(document);
	if (!res || (res.checked && path.basename(res.checked) !== path.basename(document.uri.fsPath)))
		return [new vscode.CodeLens(range, { title: '▶ Run IMITATOR', command: 'imitator.run' })];
	const p = res.parsed;
	let summary = p.constraints.length ? p.constraints.map(result.oneLine).join(' | ') : (p.fields.Termination || 'no constraint');
	if (summary.length > 100) summary = summary.slice(0, 97) + '…';
	const soundness = p.fields['Constraint soundness'] ? ` (${p.fields['Constraint soundness']})` : '';
	return [
		new vscode.CodeLens(range, { title: `${res.stale ? '⚠ stale · ' : ''}Result: ${summary}${soundness}`, command: 'imitator.showResult' }),
		new vscode.CodeLens(range, { title: '▶ Run', command: 'imitator.run' }),
	];
}

/************************************************************
 * Activation
 ************************************************************/
function activate(context) {
	const selector = [{ language: MODEL }, { language: PROPERTY }];
	const model = { language: MODEL };
	const sub = d => context.subscriptions.push(d);

	output = vscode.window.createOutputChannel('IMITATOR');
	sub(output);

	sub(vscode.languages.registerDocumentSymbolProvider(model, {
		provideDocumentSymbols: document => analyze(document).symbols.map(s => toDocumentSymbol(document, s)),
	}));
	sub(vscode.languages.registerFoldingRangeProvider(selector, {
		provideFoldingRanges: document => analyze(document).folds
			.map(f => new vscode.FoldingRange(document.positionAt(f.start).line, document.positionAt(f.end).line,
				f.comment ? vscode.FoldingRangeKind.Comment : undefined))
			.filter(f => f.end > f.start),
	}));
	sub(vscode.languages.registerCompletionItemProvider(model, { provideCompletionItems: modelCompletions }, '['));
	sub(vscode.languages.registerCompletionItemProvider({ language: PROPERTY }, { provideCompletionItems: propertyCompletions }, '[', '#'));
	sub(vscode.languages.registerHoverProvider(selector, { provideHover: hover }));
	sub(vscode.languages.registerDefinitionProvider(selector, { provideDefinition: definition }));
	sub(vscode.languages.registerReferenceProvider(selector, { provideReferences: references }));
	sub(vscode.languages.registerDocumentHighlightProvider(selector, { provideDocumentHighlights: highlights }));
	sub(vscode.languages.registerRenameProvider(selector, { prepareRename, provideRenameEdits: rename }));
	sub(vscode.languages.registerDocumentSemanticTokensProvider(selector, { provideDocumentSemanticTokens: semanticTokens }, legend));
	sub(vscode.languages.registerSignatureHelpProvider(model, { provideSignatureHelp: signatureHelp }, { triggerCharacters: ['(', ','], retriggerCharacters: [','] }));
	sub(vscode.languages.registerCodeActionsProvider(model, { provideCodeActions: codeActions }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

	const live = vscode.languages.createDiagnosticCollection('imitator-ext');
	const checker = vscode.languages.createDiagnosticCollection('imitator');
	sub(live);
	sub(checker);

	sub(vscode.commands.registerCommand('imitator.run', runImitator));
	sub(vscode.commands.registerCommand('imitator.showResult', showResultCommand));
	sub(vscode.languages.registerCodeLensProvider({ language: PROPERTY }, { provideCodeLenses: codeLenses, onDidChangeCodeLenses: codeLensChanged.event }));
	const resWatcher = vscode.workspace.createFileSystemWatcher('**/*.res');
	resWatcher.onDidChange(() => codeLensChanged.fire());
	resWatcher.onDidCreate(() => codeLensChanged.fire());
	resWatcher.onDidDelete(() => codeLensChanged.fire());
	sub(resWatcher);
	sub(codeLensChanged);

	// Include index: whole workspace once, then per edited / created / deleted file
	const refreshAll = () => {
		cache.clear();
		for (const d of vscode.workspace.textDocuments) engineDiagnostics(live, d);
	};
	indexWorkspace().then(refreshAll, () => { /* no workspace */ });
	const imiWatcher = vscode.workspace.createFileSystemWatcher('**/*.imi');
	imiWatcher.onDidCreate(uri => { const t = readText(uri.fsPath); if (t !== null) indexText(uri.fsPath, t); refreshAll(); });
	imiWatcher.onDidDelete(uri => { includeIndex.delete(uri.fsPath); refreshAll(); });
	sub(imiWatcher);
	sub(vscode.commands.registerCommand('imitator.checkSyntax', () => {
		const editor = vscode.window.activeTextEditor;
		if (editor) checkWithImitator(checker, editor.document, true);
	}));

	const timers = new Map();
	sub(vscode.workspace.onDidChangeTextDocument(e => {
		if (e.document.languageId !== MODEL && e.document.languageId !== PROPERTY) return;
		// An edit may change an included file of another model: drop every cached analysis
		cache.clear();
		if (e.document.languageId === MODEL && e.document.uri.scheme === 'file') {
			const before = JSON.stringify(includeIndex.get(e.document.uri.fsPath) || []);
			indexText(e.document.uri.fsPath, e.document.getText());
			// Includes changed: other open files may now belong to another model
			if (JSON.stringify(includeIndex.get(e.document.uri.fsPath) || []) !== before)
				for (const d of vscode.workspace.textDocuments) if (d !== e.document) engineDiagnostics(live, d);
		}
		const key = e.document.uri.toString();
		clearTimeout(timers.get(key));
		timers.set(key, setTimeout(() => engineDiagnostics(live, e.document), 300));
	}));
	sub(vscode.workspace.onDidOpenTextDocument(d => { engineDiagnostics(live, d); checkWithImitator(checker, d); }));
	sub(vscode.workspace.onDidSaveTextDocument(d => { checkWithImitator(checker, d); if (d.languageId === PROPERTY) codeLensChanged.fire(); }));
	sub(vscode.workspace.onDidCloseTextDocument(d => {
		cache.delete(d.uri.toString());
		live.delete(d.uri);
		checker.delete(d.uri);
	}));
	for (const d of vscode.workspace.textDocuments) { engineDiagnostics(live, d); checkWithImitator(checker, d); }
}

function deactivate() { }

module.exports = { activate, deactivate, runImitator };

