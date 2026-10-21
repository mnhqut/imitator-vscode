'use strict';
/*
 * Lightweight structural engine for IMITATOR models (.imi) and properties (.imiprop).
 *
 * It does NOT re-implement ModelParser.mly. It is a tolerant one-pass scanner
 * that mirrors the section order of the real grammar
 *   [controllable actions] var functions templates automata instantiates init [end]
 * and records declarations, references and folding ranges. Malformed input
 * never throws: the scanner re-synchronizes on top-level keywords.
 *
 * No dependency on the `vscode` module so it can be tested with plain Node.
 */

// Keywords of ModelLexer.mll
const MODEL_KEYWORDS = new Set([
	'accepting', 'action', 'actions', 'array', 'automaton', 'begin', 'binary', 'bool',
	'clock', 'constant', 'continuous', 'controllable', 'discrete', 'do', 'done', 'downto',
	'else', 'end', 'False', 'flow', 'fn', 'for', 'from', 'function', 'goto', 'if', 'in',
	'init', 'instantiate', 'int', 'inside', 'invariant', 'is', 'list', 'loc', 'not',
	'parameter', 'queue', 'rat', 'rational', 'return', 'stack', 'stop', 'sync', 'synclabs',
	'template', 'then', 'to', 'True', 'uncontrollable', 'urgent', 'var', 'void', 'wait',
	'when', 'while', 'inf', 'infinity',
]);

// Keywords of PropertyLexer.mll
const PROPERTY_KEYWORDS = new Set([
	'A', 'AccCycle', 'AcceptingCycle', 'AccLoop', 'AcceptingLoop', 'AF', 'AF_', 'AG', 'AGnot',
	'BCcover', 'BClearn', 'BCshuffle', 'BCborder', 'BCrandom', 'BCrandomseq', 'Cycle',
	'CycleThrough', 'DeadlockFree', 'E', 'EF', 'EF_', 'EFpmax', 'EFpmin', 'EFtmin', 'IM',
	'IMconvex', 'IMK', 'IMunion', 'InverseMethod', 'Loop', 'LoopThrough', 'NZCycle', 'PRP',
	'PRPC', 'R', 'R_', 'TracePreservation', 'U', 'U_', 'Valid', 'W', 'W_', 'inf', 'infinity',
	'accepting', 'always', 'and', 'before', 'eventually', 'everytime', 'False', 'happened',
	'has', 'if', 'in', 'is', 'loc', 'next', 'not', 'once', 'or', 'pattern', 'projectresult',
	'property', 'sequence', 'step', 'then', 'True', 'Win', 'within', 'list', 'stack', 'queue',
]);

const BUILTINS = new Set([
	'rational_of_int', 'pow', 'int_div', 'mod',
	'shift_left', 'shift_right', 'fill_left', 'fill_right', 'logand', 'logor', 'logxor', 'lognot',
	'array_copy', 'array_append', 'array_length', 'array_mem',
	'list_cons', 'list_hd', 'list_tl', 'list_rev', 'list_length', 'list_mem', 'list_is_empty',
	'stack_push', 'stack_pop', 'stack_clear', 'stack_top', 'stack_copy', 'stack_length', 'stack_is_empty',
	'queue_push', 'queue_pop', 'queue_clear', 'queue_top', 'queue_copy', 'queue_length', 'queue_is_empty',
]);

// Section starters: used to re-synchronize after a syntax error
const TOP_KEYWORDS = new Set(['var', 'function', 'fn', 'template', 'automaton', 'instantiate', 'init']);

const PUNCT = [':=', '<=', '>=', '<>', '&&', '||', '=>', '..',
	'<', '>', '=', '&', '|', '+', '-', '*', '/', '(', ')', '{', '}', '[', ']', "'", ':', ',', ';'];

/************************************************************
 * LEXER
 ************************************************************/

// Sticky regexes: match at an exact offset without slicing the text
const RE_BINARY = /0b[0-9]+/y;
const RE_NAME = /[a-zA-Z][a-zA-Z0-9_]*/y;
const RE_NUMBER = /[0-9]*\.[0-9]+|[0-9]+/y;
const RE_INCLUDE = /#include\s*"([^"\n]*)"/y;
const RE_DIRECTIVE = /#[a-zA-Z]+/y;

function match(re, text, i) {
	re.lastIndex = i;
	return re.exec(text);
}

// Token: {type, text, start, end}; type in name|keyword|number|binary|punct|directive|include|error
function tokenize(text, keywords) {
	const tokens = [];
	const comments = [];
	const errors = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		const c = text[i];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

		// Nested OCaml comments
		if (c === '(' && text[i + 1] === '*') {
			const start = i;
			let depth = 1;
			i += 2;
			while (i < n && depth > 0) {
				if (text[i] === '(' && text[i + 1] === '*') { depth++; i += 2; }
				else if (text[i] === '*' && text[i + 1] === ')') { depth--; i += 2; }
				else i++;
			}
			comments.push({ start, end: i });
			if (depth > 0) errors.push({ start, end: start + 2, message: 'Unterminated comment: missing `*)`.' });
			continue;
		}

		// #include "file"  (model)  /  #synth, #witness, ... (property)
		if (c === '#') {
			const m = match(RE_INCLUDE, text, i);
			if (m) {
				tokens.push({ type: 'include', text: m[0], file: m[1], start: i, end: i + m[0].length });
				i += m[0].length;
				continue;
			}
			const d = match(RE_DIRECTIVE, text, i);
			if (d) {
				tokens.push({ type: 'directive', text: d[0], start: i, end: i + d[0].length });
				i += d[0].length;
				continue;
			}
		}

		let m;
		if ((m = match(RE_BINARY, text, i))) {
			tokens.push({ type: 'binary', text: m[0], start: i, end: i + m[0].length });
		} else if ((m = match(RE_NAME, text, i))) {
			const type = keywords.has(m[0]) ? 'keyword' : 'name';
			tokens.push({ type, text: m[0], start: i, end: i + m[0].length });
		} else if ((m = match(RE_NUMBER, text, i))) {
			tokens.push({ type: 'number', text: m[0], start: i, end: i + m[0].length });
		} else {
			const p = PUNCT.find(s => text.startsWith(s, i));
			if (p) {
				tokens.push({ type: 'punct', text: p, start: i, end: i + p.length });
				m = [p];
			} else {
				errors.push({ start: i, end: i + 1, message: `Unexpected symbol \`${c}\`.` });
				m = [c];
			}
		}
		i += m[0].length;
	}
	return { tokens, comments, errors };
}

/************************************************************
 * MODEL SCANNER
 ************************************************************/

/*
 * Symbol keys (identity used for definition/references):
 *   var:x  fun:f  local:f/x  auto:a  tpl:t  tparam:t/x  loc:a/l  act:a
 * For an instantiated automaton, locations resolve to the template: loc:<template>/l
 */
function analyzeModel(text) {
	const { tokens, comments, errors } = tokenize(text, MODEL_KEYWORDS);
	const n = tokens.length;
	let p = 0;

	const symbols = [];          // outline tree (top level)
	const defs = new Map();      // key -> symbol
	const refs = [];             // {name, start, end, key?, ctx}
	const folds = comments.map(c => ({ start: c.start, end: c.end, comment: true }));
	const diagnostics = errors.map(e => Object.assign({ severity: 'error' }, e));
	const automata = new Map();  // name -> {locScope, actions:Set, templateOf?}
	const includes = [];

	const tok = (k = 0) => tokens[p + k];
	const is = (text, k = 0) => tokens[p + k] !== undefined && tokens[p + k].text === text && tokens[p + k].type !== 'name';
	const isName = (k = 0) => tokens[p + k] !== undefined && tokens[p + k].type === 'name';
	const atTop = () => p < n && tokens[p].type === 'keyword' && TOP_KEYWORDS.has(tokens[p].text);
	const lastEnd = () => (p > 0 ? tokens[p - 1].end : 0);

	function define(key, t, kind, detail, start, parent) {
		const sym = { key, name: t.text, kind, detail, nameStart: t.start, nameEnd: t.end, start, end: t.end, children: [] };
		if (!defs.has(key)) defs.set(key, sym);
		(parent ? parent.children : symbols).push(sym);
		refs.push({ name: t.text, start: t.start, end: t.end, key, decl: true });
		return sym;
	}
	// Reference resolved later (forward references are legal: `goto` a later location)
	function ref(t, ctx) {
		refs.push(Object.assign({ name: t.text, start: t.start, end: t.end }, ctx));
	}

	// Skip an expression until one of the stop tokens at bracket depth 0; record names
	function skipExpr(stops, ctx) {
		let depth = 0;
		while (p < n) {
			const t = tokens[p];
			if (depth === 0 && t.type !== 'name' && stops.has(t.text)) return;
			if (depth === 0 && atTop()) return;
			if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
			else if (t.text === ')' || t.text === ']' || t.text === '}') depth = Math.max(0, depth - 1);
			else if (t.type === 'name') ref(t, ctx);
			p++;
		}
	}

	function parseControllable() {
		const start = tok().start;
		p++;                                  // (un)controllable
		if (is('actions')) p++;
		if (is(':')) p++;
		while (p < n && !is(';') && !atTop()) {
			if (isName()) ref(tok(), { ctx: 'action' });
			p++;
		}
		if (is(';')) p++;
		folds.push({ start, end: lastEnd() });
	}

	function parseVar() {
		const section = { key: null, name: 'var', kind: 'namespace', detail: 'declarations', nameStart: tok().start, nameEnd: tok().end, start: tok().start, end: tok().end, children: [] };
		symbols.push(section);
		p++;
		while (p < n && !atTop() && !is('end')) {
			const group = [];
			const groupStart = tok().start;
			while (p < n && !is(':') && !is(';') && !atTop()) {
				if (isName()) {
					const t = tok();
					p++;
					let hasInit = false;
					if (is('=')) { hasInit = true; p++; skipExpr(new Set([',', ':', ';']), { ctx: 'ident' }); }
					group.push({ t, hasInit });
				} else p++;              // ',' or garbage
			}
			let type = '';
			if (is(':')) {
				p++;
				const tstart = p;
				while (p < n && !is(';') && !atTop()) p++;
				type = tokens.slice(tstart, p).map(t => t.text).join(' ').replace(/ \( /g, '(').replace(/ \)/g, ')');
			}
			if (is(';')) p++;
			for (const { t, hasInit } of group) {
				const kind = type === 'clock' ? 'clock'
					: type === 'parameter' ? 'parameter'
						: (type === 'constant' || hasInit) ? 'constant' : 'discrete';
				const sym = define('var:' + t.text, t, kind, type, groupStart, section);
				sym.end = lastEnd();
			}
		}
		section.end = lastEnd();
		folds.push({ start: section.start, end: section.end });
	}

	// function NAME ( params ) : type begin body [return e] end
	function parseFunction() {
		const start = tok().start;
		p++;
		if (!isName()) { skipToTop(); return; }
		const fname = tok().text;
		const sym = define('fun:' + fname, tok(), 'function', '', start);
		p++;
		const scope = { kind: 'function', name: fname, locals: new Set() };
		const sig = [];
		if (is('(')) {
			p++;
			while (p < n && !is(')') && !atTop()) {
				if (isName() && is(':', 1)) {
					const pt = tok();
					p += 2;
					const ts = p;
					while (p < n && !is(',') && !is(')') && !atTop()) p++;
					const ptype = tokens.slice(ts, p).map(t => t.text).join(' ');
					scope.locals.add(pt.text);
					define(`local:${fname}/${pt.text}`, pt, 'parameter-of', ptype, pt.start, sym);
					sig.push(`${pt.text} : ${ptype}`);
				} else p++;
			}
			if (is(')')) p++;
		}
		let ret = '';
		if (is(':')) {
			p++;
			const ts = p;
			while (p < n && !is('begin') && !atTop()) p++;
			ret = tokens.slice(ts, p).map(t => t.text).join(' ');
		}
		sym.detail = `(${sig.join(', ')}) : ${ret}`;
		if (is('begin')) p++;
		parseCodeBlock(scope, sym, () => is('end'));
		if (is('end')) p++;
		else diagnostics.push({ start: sym.nameStart, end: sym.nameEnd, severity: 'error', message: `Missing \`end\` for function \`${fname}\`.` });
		sym.end = lastEnd();
		folds.push({ start, end: sym.end });
	}

	// Sequence of instructions; `if ... end` nesting is tracked so the caller sees its own `end`
	function parseCodeBlock(scope, parent, isClosing) {
		let ifDepth = 0;
		while (p < n && (is('var') || !atTop())) {
			if (ifDepth === 0 && isClosing()) return;
			const t = tok();
			if (t.type === 'keyword') {
				if (t.text === 'if') ifDepth++;
				else if (t.text === 'end') ifDepth--;
				else if (t.text === 'var' && isName(1) && scope && scope.kind === 'function') {
					// local declaration: var NAME : type = expr
					const lt = tok(1);
					scope.locals.add(lt.text);
					define(`local:${scope.name}/${lt.text}`, lt, 'local', '', t.start, parent);
					p += 2;
					continue;
				} else if (t.text === 'for' && isName(1)) {
					// loop variable: local to the loop, treated as function-local
					if (scope && scope.kind === 'function') {
						scope.locals.add(tok(1).text);
						refs.push({ name: tok(1).text, start: tok(1).start, end: tok(1).end, key: `local:${scope.name}/${tok(1).text}`, decl: true });
						if (!defs.has(`local:${scope.name}/${tok(1).text}`)) defs.set(`local:${scope.name}/${tok(1).text}`, { key: `local:${scope.name}/${tok(1).text}`, name: tok(1).text, kind: 'local', detail: 'loop index', nameStart: tok(1).start, nameEnd: tok(1).end, start: t.start, end: tok(1).end, children: [] });
					} else ref(tok(1), { ctx: 'ident', scope });
					p += 2;
					continue;
				}
			} else if (t.type === 'name') ref(t, { ctx: 'ident', scope });
			p++;
		}
	}

	// automaton NAME prolog locations end   /   template NAME(params) prolog locations end
	function parseAutomaton(isTemplate) {
		const start = tok().start;
		p++;
		if (!isName()) { skipToTop(); return; }
		const aname = tok().text;
		const sym = define((isTemplate ? 'tpl:' : 'auto:') + aname, tok(), isTemplate ? 'template' : 'automaton', '', start);
		p++;
		const scope = { kind: isTemplate ? 'template' : 'automaton', name: aname, locals: new Set() };
		const info = { name: aname, locScope: aname, actions: new Set(), actionToks: [], locations: new Map(), isTemplate };
		if (isTemplate && is('(')) {
			p++;
			const sig = [];
			while (p < n && !is(')') && !atTop()) {
				if (isName() && is(':', 1)) {
					const pt = tok();
					p += 2;
					const ts = p;
					while (p < n && !is(',') && !is(')') && !atTop()) p++;
					const ptype = tokens.slice(ts, p).map(t => t.text).join(' ');
					scope.locals.add(pt.text);
					define(`tparam:${aname}/${pt.text}`, pt, 'parameter-of', ptype, pt.start, sym);
					sig.push(`${pt.text} : ${ptype}`);
				} else p++;
			}
			if (is(')')) p++;
			sym.detail = `(${sig.join(', ')})`;
		}
		if (!isTemplate) automata.set(aname, info);
		else info.template = true, templates.set(aname, info);

		let braceDepth = 0;
		let curLoc = null;
		const closeLoc = () => { if (curLoc) { curLoc.end = lastEnd(); folds.push({ start: curLoc.start, end: curLoc.end }); curLoc = null; } };
		while (p < n) {
			const t = tok();
			if (braceDepth === 0 && is('end')) break;
			if (braceDepth === 0 && atTop()) break;
			if (t.type === 'keyword') {
				switch (t.text) {
					case 'actions':
					case 'synclabs':
						p++;
						if (is(':')) p++;
						while (p < n && !is(';') && !atTop() && !is('loc')) {
							if (isName()) {
								if (scope.locals.has(tok().text)) ref(tok(), { ctx: 'ident', scope });
								else {
									info.actions.add(tok().text);
									info.actionToks.push(tok());
									refs.push({ name: tok().text, start: tok().start, end: tok().end, key: 'act:' + tok().text, decl: true });
									if (!defs.has('act:' + tok().text)) defs.set('act:' + tok().text, { key: 'act:' + tok().text, name: tok().text, kind: 'action', detail: 'action', nameStart: tok().start, nameEnd: tok().end, start: tok().start, end: tok().end, children: [] });
								}
							}
							p++;
						}
						if (is(';')) p++;
						continue;
					case 'urgent':
					case 'accepting':
					case 'loc': {
						const lstart = t.start;
						const flags = [];
						while (is('urgent') || is('accepting')) { flags.push(tok().text); p++; }
						if (!is('loc')) continue;
						p++;
						if (!isName()) continue;
						closeLoc();
						const lt = tok();
						curLoc = define(`loc:${aname}/${lt.text}`, lt, 'location', flags.join(' '), lstart, sym);
						if (info.locations.has(lt.text))
							diagnostics.push({ start: lt.start, end: lt.end, severity: 'error', message: `Location \`${lt.text}\` is defined twice in \`${aname}\`.` });
						info.locations.set(lt.text, curLoc);
						p++;
						continue;
					}
					case 'goto':
						p++;
						if (isName()) { ref(tok(), { ctx: 'location', automaton: aname, template: isTemplate }); p++; }
						continue;
					case 'sync':
						p++;
						if (isName()) {
							if (scope.locals.has(tok().text)) ref(tok(), { ctx: 'ident', scope });
							else ref(tok(), { ctx: 'action', automaton: aname, info });
							p++;
						}
						continue;
				}
			} else if (t.text === '{') braceDepth++;
			else if (t.text === '}') braceDepth = Math.max(0, braceDepth - 1);
			else if (t.type === 'name') ref(t, { ctx: 'ident', scope });
			p++;
		}
		closeLoc();
		if (is('end')) p++;
		else diagnostics.push({ start: sym.nameStart, end: sym.nameEnd, severity: 'error', message: `Missing \`end\` for ${isTemplate ? 'template' : 'automaton'} \`${aname}\`.` });
		sym.end = lastEnd();
		folds.push({ start, end: sym.end });
	}

	// instantiate NAME := TEMPLATE(args);
	function parseInstantiate() {
		const start = tok().start;
		p++;
		if (!isName()) { skipToTop(); return; }
		const it = tok();
		p++;
		if (is(':=')) p++;
		let tname = null;
		if (isName()) { tname = tok().text; ref(tok(), { ctx: 'template' }); p++; }
		const sym = define('auto:' + it.text, it, 'automaton', tname ? `instance of ${tname}` : '', start);
		automata.set(it.text, { name: it.text, locScope: tname, actions: null, locations: null, templateOf: tname });
		skipExpr(new Set([';']), { ctx: 'ident' });
		if (is(';')) p++;
		sym.end = lastEnd();
	}

	// init := { discrete = ...; continuous = ...; }   or old  init := ... ;
	function parseInit() {
		const start = tok().start;
		const sym = { key: null, name: 'init', kind: 'init', detail: 'initial state', nameStart: tok().start, nameEnd: tok().end, start, end: tok().end, children: [] };
		symbols.push(sym);
		p++;
		if (is(':=')) p++;
		const braced = is('{');
		if (braced) p++;
		while (p < n) {
			if (braced && is('}')) { p++; break; }
			if (!braced && is(';')) { p++; break; }
			if (is('end') || atTop()) break;
			if (is('loc') && is('[', 1) && isName(2)) {
				// loc[A] := l   /   loc[A] = l
				const at = tok(2);
				ref(at, { ctx: 'automaton' });
				p += 3;
				if (is(']')) p++;
				if (is(':=') || is('=')) p++;
				if (isName()) { ref(tok(), { ctx: 'location', automatonName: at.text }); p++; }
				continue;
			}
			if (isName() && is('is', 1) && is('in', 2) && isName(3)) {
				ref(tok(), { ctx: 'automaton' });
				ref(tok(3), { ctx: 'location', automatonName: tok().text });
				p += 4;
				continue;
			}
			if (isName()) ref(tok(), { ctx: 'ident' });
			p++;
		}
		if (is(';')) p++;
		sym.end = lastEnd();
		folds.push({ start, end: sym.end });
	}

	function skipToTop() {
		while (p < n && !atTop()) p++;
	}

	const templates = new Map();

	while (p < n) {
		const t = tok();
		if (t.type === 'include') { includes.push(t); p++; if (is(';')) p++; continue; }
		if (t.type === 'keyword') {
			switch (t.text) {
				case 'controllable':
				case 'uncontrollable': parseControllable(); continue;
				case 'var': parseVar(); continue;
				case 'function':
				case 'fn': parseFunction(); continue;
				case 'template': parseAutomaton(true); continue;
				case 'automaton': parseAutomaton(false); continue;
				case 'instantiate': parseInstantiate(); continue;
				case 'init': parseInit(); continue;
				case 'end': p++; continue;
			}
		}
		if (t.type === 'name') ref(t, { ctx: 'ident' });
		diagnostics.push({ start: t.start, end: t.end, severity: 'error', message: `Unexpected \`${t.text}\` at top level.` });
		p++;
	}

	/************ Resolution ************/
	const unresolvedLocations = [];
	for (const r of refs) {
		if (r.key) continue;
		switch (r.ctx) {
			case 'location': {
				let scopeName;
				if (r.automaton) scopeName = r.automaton;
				else {
					const a = automata.get(r.automatonName);
					scopeName = a ? a.locScope : null;
				}
				const key = `loc:${scopeName}/${r.name}`;
				if (defs.has(key)) r.key = key;
				else if (r.automaton) unresolvedLocations.push(r);
				break;
			}
			case 'action':
				r.key = 'act:' + r.name;
				if (r.info && !r.info.actions.has(r.name))
					diagnostics.push({ start: r.start, end: r.end, severity: 'error', message: `Action \`${r.name}\` is not declared in the \`actions:\` list of \`${r.automaton}\`.` });
				break;
			case 'automaton':
				if (defs.has('auto:' + r.name)) r.key = 'auto:' + r.name;
				break;
			case 'template':
				if (defs.has('tpl:' + r.name)) r.key = 'tpl:' + r.name;
				break;
			default: {
				const s = r.scope;
				const candidates = [];
				if (s && s.locals.has(r.name)) candidates.push(s.kind === 'function' ? `local:${s.name}/${r.name}` : `tparam:${s.name}/${r.name}`);
				candidates.push('var:' + r.name, 'fun:' + r.name, 'act:' + r.name);
				r.key = candidates.find(k => defs.has(k)) || (BUILTINS.has(r.name) ? 'builtin:' + r.name : null);
			}
		}
	}
	for (const r of unresolvedLocations)
		diagnostics.push({ start: r.start, end: r.end, severity: 'error', message: `Target location \`${r.name}\` does not exist in \`${r.automaton}\`.` });

	return { kind: 'model', tokens, comments, symbols, defs, refs, folds, diagnostics, automata, templates, includes };
}

/************************************************************
 * PROPERTY SCANNER (only references to model names)
 ************************************************************/
function analyzeProperty(text, model) {
	const { tokens, comments, errors } = tokenize(text, PROPERTY_KEYWORDS);
	const refs = [];
	const diagnostics = errors.map(e => Object.assign({ severity: 'error' }, e));
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== 'name') continue;
		const prev = tokens[i - 1], prev2 = tokens[i - 2];
		const r = { name: t.text, start: t.start, end: t.end, key: null };
		if (prev && prev.text === '[' && prev2 && prev2.text === 'loc') r.ctx = 'automaton';
		else if (prev && (prev.text === '=' || prev.text === '<>') && prev2 && prev2.text === ']') {
			const a = tokens[i - 3];
			r.ctx = 'location'; r.automatonName = a && a.text;
		} else if (prev && prev.text === 'in' && prev2 && prev2.text === 'is') {
			r.ctx = 'location'; r.automatonName = tokens[i - 3] && tokens[i - 3].text;
		} else if (prev && prev.text === 'in' && prev2 && prev2.text === 'not' && tokens[i - 3] && tokens[i - 3].text === 'is') {
			r.ctx = 'location'; r.automatonName = tokens[i - 4] && tokens[i - 4].text;
		} else r.ctx = 'ident';
		if (model) {
			if (r.ctx === 'automaton' && model.defs.has('auto:' + r.name)) r.key = 'auto:' + r.name;
			else if (r.ctx === 'location') {
				const a = model.automata.get(r.automatonName);
				const k = a && `loc:${a.locScope}/${r.name}`;
				if (k && model.defs.has(k)) r.key = k;
			} else if (r.ctx === 'ident') r.key = ['var:' + r.name, 'act:' + r.name].find(k => model.defs.has(k)) || null;
		}
		refs.push(r);
	}
	return { kind: 'property', tokens, comments, refs, diagnostics, folds: comments.map(c => ({ start: c.start, end: c.end, comment: true })) };
}

/************************************************************
 * QUERIES
 ************************************************************/

function refAt(analysis, offset) {
	return analysis.refs.find(r => r.start <= offset && offset <= r.end) || null;
}

function referencesOf(analysis, key) {
	return analysis.refs.filter(r => r.key === key);
}

// Innermost automaton/template enclosing an offset
function enclosingAutomaton(analysis, offset) {
	return analysis.symbols.find(s => (s.kind === 'automaton' || s.kind === 'template') && s.start <= offset && offset <= s.end) || null;
}

function enclosingFunction(analysis, offset) {
	return analysis.symbols.find(s => s.kind === 'function' && s.start <= offset && offset <= s.end) || null;
}

module.exports = {
	MODEL_KEYWORDS, PROPERTY_KEYWORDS, BUILTINS,
	tokenize, analyzeModel, analyzeProperty, refAt, referencesOf, enclosingAutomaton, enclosingFunction,
};
