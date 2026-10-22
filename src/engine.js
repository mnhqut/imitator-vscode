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

// Names reserved by ModelLexer.mll (used internally by IMITATOR)
const RESERVED = new Set(['automatically_generated_observer', 'automatically_generated_x_obs', 'nosync_obs', 'special_0_clock']);

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
 *
 * scanModel only collects declarations and unresolved references of ONE file;
 * analyzeModel adds the #included files and resolves the references.
 */
function scanModel(text) {
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
	let init = null;             // init section info (quick fixes)

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
		info.headerEnd = lastEnd();
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
						if (t.text === 'synclabs')
							diagnostics.push({ start: t.start, end: t.end, severity: 'warning', code: 'deprecated-synclabs', message: '`synclabs` is deprecated since IMITATOR 3.4: use `actions`.' });
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
						if (is(';')) { info.actionsSemicolon = tok().start; p++; }
						continue;
					case 'while':
						// At brace depth 0, `while` can only be the deprecated form of `invariant`
						if (braceDepth === 0)
							diagnostics.push({ start: t.start, end: t.end, severity: 'warning', code: 'deprecated-while', message: '`while` is deprecated in a location: use `invariant`.' });
						break;
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
		info.endStart = is('end') ? tok().start : lastEnd();
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
		const info = { start, keywordEnd: tok().end, assigned: new Set(), conjuncts: [], discreteAt: null, braceAt: null };
		init = info;
		p++;
		if (is(':=')) p++;
		const braced = is('{');
		info.style = braced ? 'new' : 'old';
		if (braced) { info.braceAt = tok().end; p++; }
		// Old style: split the conjunction at depth-0 `&`
		let depth = 0, conjStart = p;
		const closeConjunct = () => {
			let i = conjStart, j = p - 1;
			// Strip parentheses around the whole conjunct: ( loc[A] = l )
			while (j > i && tokens[i].text === '(' && tokens[j].text === ')' && matching(i) === j) { i++; j--; }
			if (j >= i) info.conjuncts.push(tokens.slice(i, j + 1));
		};
		while (p < n) {
			if (braced && is('}')) { p++; break; }
			if (!braced && depth === 0 && is(';')) { closeConjunct(); info.end = tok().end; p++; break; }
			if (is('end') || atTop()) break;
			if (!braced) {
				if (is('(') || is('[')) depth++;
				else if (is(')') || is(']')) depth--;
				else if (depth === 0 && (is('&') || is('&&'))) { closeConjunct(); p++; conjStart = p; continue; }
			}
			if (braced && is('discrete') && is('=', 1)) { info.discreteAt = tok(1).end; p += 2; continue; }
			if (is('loc') && is('[', 1) && isName(2)) {
				// loc[A] := l   /   loc[A] = l
				const at = tok(2);
				ref(at, { ctx: 'automaton' });
				info.assigned.add(at.text);
				p += 3;
				if (is(']')) p++;
				if (is(':=') || is('=')) p++;
				if (isName()) { ref(tok(), { ctx: 'location', automatonName: at.text }); p++; }
				continue;
			}
			if (isName() && is('is', 1) && is('in', 2) && isName(3)) {
				ref(tok(), { ctx: 'automaton' });
				info.assigned.add(tok().text);
				ref(tok(3), { ctx: 'location', automatonName: tok().text });
				p += 4;
				continue;
			}
			if (isName()) ref(tok(), { ctx: 'ident' });
			p++;
		}
		if (is(';')) p++;
		sym.end = lastEnd();
		if (info.end === undefined) info.end = sym.end;
		folds.push({ start, end: sym.end });
	}

	// Index of the token closing the bracket opened at token i
	function matching(i) {
		let depth = 0;
		for (let k = i; k < n; k++) {
			if (tokens[k].text === '(' || tokens[k].text === '[') depth++;
			else if (tokens[k].text === ')' || tokens[k].text === ']') { depth--; if (depth === 0) return k; }
		}
		return -1;
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

	if (init && init.style === 'old')
		diagnostics.push({ start: init.start, end: init.keywordEnd, severity: 'warning', code: 'deprecated-old-init', message: 'Old `init :=` syntax (before IMITATOR 3.1): use `init := { discrete = …; continuous = …; }`.' });
	return { kind: 'model', text, tokens, comments, symbols, defs, refs, folds, diagnostics, automata, templates, includes, init };
}

/*
 * options.file        : path of `text` (null for an unsaved document)
 * options.readInclude : (fromFile, includePath) -> {file, text} | null
 * The result is the analysis of the main file, with the symbol tables merged
 * over all included files and `units` = [main, included...] (each with .file and .refs).
 */
function analyzeModel(text, options = {}) {
	const main = scanModel(text);
	main.file = options.file || null;
	const units = [main];
	const seen = new Set([main.file]);
	for (let i = 0; i < units.length; i++) {
		const u = units[i];
		for (const inc of u.includes) {
			const loaded = options.readInclude ? options.readInclude(u.file, inc.file) : null;
			if (!loaded) {
				if (options.readInclude)
					u.diagnostics.push({ start: inc.start, end: inc.end, severity: 'warning', message: `Included file \`${inc.file}\` not found.` });
				continue;
			}
			inc.resolved = loaded.file;
			if (seen.has(loaded.file)) continue;
			seen.add(loaded.file);
			const sub = scanModel(loaded.text);
			sub.file = loaded.file;
			units.push(sub);
		}
	}

	// Merged tables; the main file wins on duplicates
	const defs = new Map(), automata = new Map(), templates = new Map();
	for (const u of units) {
		for (const [k, sym] of u.defs) { sym.file = u.file; if (!defs.has(k)) defs.set(k, sym); }
		for (const [k, a] of u.automata) if (!automata.has(k)) automata.set(k, Object.assign(a, { file: u.file }));
		for (const [k, t] of u.templates) if (!templates.has(k)) templates.set(k, Object.assign(t, { file: u.file }));
	}
	for (const u of units) resolve(u, defs, automata, u.diagnostics);
	const missingInclude = units.some(u => u.includes.some(inc => !inc.resolved));
	// init sections of included files are merged by IMITATOR (ModelParser.mly, unzip)
	const assigned = new Set();
	for (const u of units) if (u.init) for (const a of u.init.assigned) assigned.add(a);
	let reported = false;
	for (const u of units) if (u.init) reported = initChecks(u, defs, automata, assigned, missingInclude || reported) || reported;
	return Object.assign(main, { defs, automata, templates, units });
}

// View of an included file inside the analysis of a model that includes it:
// the file's own tokens, references and diagnostics, with the model's symbol tables
function focusOn(analysis, file) {
	const unit = analysis.units.find(u => u.file === file);
	if (!unit || unit === analysis) return null;
	return Object.assign({}, unit, { defs: analysis.defs, automata: analysis.automata, templates: analysis.templates, units: analysis.units, rootFile: analysis.file });
}

// First location of an automaton (of its template for an instance)
function firstLocation(automata, defs, name) {
	const a = automata.get(name);
	if (!a) return null;
	const scope = a.locScope || name;
	let best = null;
	for (const sym of defs.values())
		if (sym.key.startsWith(`loc:${scope}/`) && (!best || (sym.file === best.file && sym.nameStart < best.nameStart))) best = sym;
	return best ? best.name : null;
}

// Every automaton needs an initial location (`assigned`: over all files); old syntax converted to the 3.1 syntax
// Returns true when the missing initial locations were reported in this unit
function initChecks(unit, defs, automata, assigned, skipMissing) {
	const info = unit.init;
	let reported = false;
	if (info.style === 'new' && !skipMissing) {
		reported = true;
		for (const name of automata.keys()) {
			if (assigned.has(name)) continue;
			const loc = firstLocation(automata, defs, name) || 'l';
			const fix = info.discreteAt !== null
				? { at: info.discreteAt, text: ` loc[${name}] := ${loc},` }
				: { at: info.braceAt, text: `\n\tdiscrete = loc[${name}] := ${loc};` };
			unit.diagnostics.push({ start: info.start, end: info.keywordEnd, severity: 'error', code: 'missing-initial-location', fix, automaton: name, message: `No initial location for automaton \`${name}\`: add \`loc[${name}] := …\` to \`discrete\`.` });
		}
	}
	if (info.style === 'old') {
		const d = unit.diagnostics.find(x => x.code === 'deprecated-old-init');
		if (d) d.fix = { at: info.start, end: info.end, text: convertOldInit(unit.text, info, defs) };
	}
	return reported;
}

// Old  init := & loc[A] = l & i = 0 & x = 0 & p >= 0;  ->  new  init := { discrete = …; continuous = …; }
function convertOldInit(text, info, defs) {
	const discrete = [], continuous = [];
	const src = toks => text.slice(toks[0].start, toks[toks.length - 1].end).replace(/\s*\n\s*/g, ' ');
	for (const c of info.conjuncts) {
		const t = c.map(x => x.text);
		if (t.length === 6 && t[0] === 'loc' && t[1] === '[' && t[3] === ']' && t[4] === '=')
			discrete.push(`loc[${t[2]}] := ${t[5]}`);
		else if (t.length === 4 && t[1] === 'is' && t[2] === 'in')
			discrete.push(`loc[${t[0]}] := ${t[3]}`);
		else if (t.length >= 3 && c[0].type === 'name' && t[1] === '=' && defs.has('var:' + t[0]) && defs.get('var:' + t[0]).kind === 'discrete')
			discrete.push(`${t[0]} := ${src(c.slice(2))}`);
		else
			continuous.push(src(c));
	}
	let out = 'init := {\n\tdiscrete =\n';
	out += discrete.map(d => `\t\t${d},\n`).join('');
	out += '\t;\n';
	if (continuous.length) out += '\tcontinuous =\n' + continuous.map(c => `\t\t& ${c}\n`).join('') + '\t;\n';
	return out + '}';
}

function resolve(unit, defs, automata, diagnostics) {
	const unresolvedLocations = [];
	for (const r of unit.refs) {
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
				if (r.info && !r.info.actions.has(r.name)) {
					const info = r.info;
					// Quick fix: append to the `actions:` list, or create one after the header
					const fix = info.actionsSemicolon !== undefined
						? { at: info.actionsSemicolon, text: (info.actions.size ? ', ' : '') + r.name }
						: { at: info.headerEnd, text: `\nactions: ${r.name};` };
					diagnostics.push({ start: r.start, end: r.end, severity: 'error', code: 'undeclared-action', fix, message: `Action \`${r.name}\` is not declared in the \`actions:\` list of \`${r.automaton}\`.` });
				}
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
	for (const r of unresolvedLocations) {
		const info = unit.automata.get(r.automaton) || unit.templates.get(r.automaton);
		diagnostics.push({
			start: r.start, end: r.end, severity: 'error', code: 'unknown-location',
			fix: info && { at: info.endStart, text: `loc ${r.name}: invariant True\n` },
			message: `Target location \`${r.name}\` does not exist in \`${r.automaton}\`.`,
		});
	}
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

// Index of the last token starting before `offset` (binary search)
function tokenIndexBefore(tokens, offset) {
	let lo = 0, hi = tokens.length - 1, res = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (tokens[mid].start < offset) { res = mid; lo = mid + 1; } else hi = mid - 1;
	}
	return res;
}

/*
 * Call around `offset`, for signature help: {name, argIndex, instantiate}
 * Walks back over the tokens to the unmatched `(` and counts the commas at depth 0.
 */
function callAt(analysis, offset) {
	const tokens = analysis.tokens;
	let argIndex = 0, depth = 0;
	for (let i = tokenIndexBefore(tokens, offset); i >= 0; i--) {
		const t = tokens[i];
		if (t.type === 'punct') {
			if (t.text === ')' || t.text === ']' || t.text === '}') depth++;
			else if (t.text === '[' || t.text === '{') { if (depth === 0) return null; depth--; }
			else if (t.text === '(') {
				if (depth > 0) { depth--; continue; }
				const callee = tokens[i - 1];
				if (!callee || callee.type !== 'name') return null;
				const instantiate = tokens[i - 2] && tokens[i - 2].text === ':=' && tokens[i - 4] && tokens[i - 4].text === 'instantiate';
				return { name: callee.text, argIndex, instantiate };
			} else if (t.text === ',' && depth === 0) argIndex++;
			else if (t.text === ';' && depth === 0) return null;
		} else if (t.type === 'keyword' && depth === 0 && (TOP_KEYWORDS.has(t.text) || t.text === 'when' || t.text === 'goto')) return null;
	}
	return null;
}

// A valid new name: identifier syntax, not a model or property keyword, not a built-in
function checkNewName(name) {
	if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) return `\`${name}\` is not a valid IMITATOR name.`;
	if (MODEL_KEYWORDS.has(name)) return `\`${name}\` is a keyword of the model language.`;
	if (PROPERTY_KEYWORDS.has(name)) return `\`${name}\` is a keyword of the property language: the property file would not parse.`;
	if (BUILTINS.has(name)) return `\`${name}\` is a built-in function.`;
	if (RESERVED.has(name)) return `\`${name}\` is reserved by IMITATOR.`;
	return null;
}

// Keys a new name would clash with, for a symbol of key `key`
function clashKeys(key, newName) {
	const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
	const scope = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : null;
	switch (kind) {
		case 'loc': return [`loc:${scope}/${newName}`];
		case 'act': return [`act:${newName}`];
		case 'auto': case 'tpl': return [`auto:${newName}`, `tpl:${newName}`];
		case 'local': return [`local:${scope}/${newName}`, `var:${newName}`, `fun:${newName}`];
		case 'tparam': return [`tparam:${scope}/${newName}`, `var:${newName}`, `fun:${newName}`];
		default: return [`var:${newName}`, `fun:${newName}`];
	}
}

module.exports = {
	MODEL_KEYWORDS, PROPERTY_KEYWORDS, BUILTINS,
	tokenize, scanModel, analyzeModel, focusOn, analyzeProperty, refAt, referencesOf, enclosingAutomaton, enclosingFunction,
	callAt, checkNewName, clashKeys,
};
