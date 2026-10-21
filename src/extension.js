'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const engine = require('./engine');
const { MODEL_DOCS, BUILTIN_DOCS, PROPERTY_DOCS } = require('./docs');

const MODEL = 'imitator';
const PROPERTY = 'imitator-property';

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
	const analysis = engine.analyzeModel(document.getText());
	cache.set(key, { version: document.version, analysis });
	return analysis;
}

// The model of a property file: same base name, else the only .imi of the folder
function modelFileForProperty(document) {
	const dir = path.dirname(document.uri.fsPath);
	const same = document.uri.fsPath.replace(/\.imiprop$/, '.imi');
	if (fs.existsSync(same)) return same;
	try {
		const imis = fs.readdirSync(dir).filter(f => f.endsWith('.imi'));
		if (imis.length === 1) return path.join(dir, imis[0]);
	} catch (e) { /* unreadable folder */ }
	return null;
}

function modelForProperty(document) {
	const file = modelFileForProperty(document);
	if (!file) return null;
	const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file);
	if (open) return Object.assign(analyze(open), { uri: open.uri, text: open.getText() });
	try {
		const text = fs.readFileSync(file, 'utf8');
		return Object.assign(engine.analyzeModel(text), { uri: vscode.Uri.file(file), text });
	} catch (e) {
		return null;
	}
}

// Range of [start, end) offsets in a text that may not be open as a document
function rangeIn(text, start, end) {
	const pos = off => {
		const before = text.slice(0, off);
		const line = before.split('\n').length - 1;
		return new vscode.Position(line, off - before.lastIndexOf('\n') - 1);
	};
	return new vscode.Range(pos(start), pos(end));
}

const docRange = (document, start, end) => new vscode.Range(document.positionAt(start), document.positionAt(end));

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
 * Hover, definition, references
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

// Returns {analysis, ref, target} where target = {uri, text?, document?, analysis} owning the definitions
function lookup(document, position) {
	const analysis = analyze(document);
	const ref = engine.refAt(analysis, document.offsetAt(position));
	if (!ref || !ref.key) return { analysis, ref };
	if (document.languageId === PROPERTY) {
		const model = modelForProperty(document);
		return { analysis, ref, target: model && { uri: model.uri, text: model.text, analysis: model } };
	}
	return { analysis, ref, target: { uri: document.uri, document, analysis } };
}

function targetRange(target, start, end) {
	return target.document ? docRange(target.document, start, end) : rangeIn(target.text, start, end);
}

function hover(document, position) {
	const wordRange = document.getWordRangeAtPosition(position);
	if (!wordRange) return null;
	const word = document.getText(wordRange);
	const { ref, target } = lookup(document, position);
	if (ref && ref.key && target) {
		const sym = target.analysis.defs.get(ref.key);
		if (sym) return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(describe(sym), MODEL), wordRange);
	}
	const docs = document.languageId === PROPERTY ? PROPERTY_DOCS : MODEL_DOCS;
	const text = docs[word] || BUILTIN_DOCS[word];
	return text ? new vscode.Hover(new vscode.MarkdownString(text), wordRange) : null;
}

function definition(document, position) {
	const { ref, target } = lookup(document, position);
	if (!ref || !ref.key || !target) return null;
	// Actions have one declaration per automaton: list them all
	const decls = target.analysis.refs.filter(r => r.key === ref.key && r.decl);
	return decls.map(d => new vscode.Location(target.uri, targetRange(target, d.start, d.end)));
}

function references(document, position, context) {
	const { ref, target } = lookup(document, position);
	if (!ref || !ref.key || !target) return null;
	const out = target.analysis.refs
		.filter(r => r.key === ref.key && (context.includeDeclaration || !r.decl))
		.map(r => new vscode.Location(target.uri, targetRange(target, r.start, r.end)));
	// From a property, also list the occurrences inside the property itself
	if (document.languageId === PROPERTY)
		for (const r of analyze(document).refs.filter(r => r.key === ref.key))
			out.push(new vscode.Location(document.uri, docRange(document, r.start, r.end)));
	return out;
}

function highlights(document, position) {
	const analysis = analyze(document);
	const ref = engine.refAt(analysis, document.offsetAt(position));
	if (!ref || !ref.key) return null;
	return analysis.refs.filter(r => r.key === ref.key).map(r => new vscode.DocumentHighlight(
		docRange(document, r.start, r.end),
		r.decl ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
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

function checkWithImitator(collection, document) {
	if (document.languageId !== MODEL || document.uri.scheme !== 'file') return;
	if (!vscode.workspace.getConfiguration('imitator').get('checkOnSave')) return;
	const file = document.uri.fsPath;
	cp.execFile(imitatorExecutable(), [path.basename(file), '-mode', 'checksyntax', '-no-output-result'],
		{ cwd: path.dirname(file), timeout: 30000 }, (err, stdout, stderr) => {
			if (err && err.code === 'ENOENT') {
				if (!warnedMissingBinary) {
					warnedMissingBinary = true;
					vscode.window.showInformationMessage('IMITATOR binary not found: set `imitator.executablePath` to enable checks on save.');
				}
				return;
			}
			const text = document.getText();
			const out = (stdout + '\n' + stderr).replace(/\x1b\[[0-9;]*m/g, '');
			const diags = [];
			for (const line of out.split('\n')) {
				const m = /\*\*\* (ERROR|WARNING): (.*)$/.exec(line);
				if (!m) continue;
				const msg = m[2].trim();
				if (/IMITATOR aborted|The input model contains errors|Please check it again/.test(msg)) continue;
				let range;
				const lm = /near `(.*)` at line (\d+)/.exec(msg);
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
 * Activation
 ************************************************************/
function activate(context) {
	const selector = [{ language: MODEL }, { language: PROPERTY }];
	const model = { language: MODEL };
	const sub = d => context.subscriptions.push(d);

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

	const live = vscode.languages.createDiagnosticCollection('imitator-ext');
	const checker = vscode.languages.createDiagnosticCollection('imitator');
	sub(live);
	sub(checker);
	const timers = new Map();
	sub(vscode.workspace.onDidChangeTextDocument(e => {
		const key = e.document.uri.toString();
		clearTimeout(timers.get(key));
		timers.set(key, setTimeout(() => engineDiagnostics(live, e.document), 300));
	}));
	sub(vscode.workspace.onDidOpenTextDocument(d => { engineDiagnostics(live, d); checkWithImitator(checker, d); }));
	sub(vscode.workspace.onDidSaveTextDocument(d => checkWithImitator(checker, d)));
	sub(vscode.workspace.onDidCloseTextDocument(d => {
		cache.delete(d.uri.toString());
		live.delete(d.uri);
		checker.delete(d.uri);
	}));
	for (const d of vscode.workspace.textDocuments) { engineDiagnostics(live, d); checkWithImitator(checker, d); }
}

function deactivate() { }

module.exports = { activate, deactivate };
