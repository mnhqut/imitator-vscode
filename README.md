# IMITATOR language support for VS Code

Editor support for IMITATOR models (`.imi`) and properties (`.imiprop`), version 3.4 syntax.

The extension is plain JavaScript with no runtime dependencies and no build step.

## Install

```sh
cd vscode-imitator
npx @vscode/vsce package                        # -> imitator-language-0.1.0.vsix
code --install-extension imitator-language-0.1.0.vsix
```

To try it without installing, open `vscode-imitator/` in VS Code and press F5 (Extension Development Host).

## Features

| Feature | Files | How it works |
|---|---|---|
| Syntax highlighting | `syntaxes/*.tmLanguage.json` | TextMate grammar. Nested `(* … *)` comments, keywords, types, `True`/`False`, integer, float and `0b…` numbers, operators, built-in functions, declared names (`automaton X`, `loc l`, `goto l`, `sync a`, `loc[A]`, `x'` in flows), and `#synth`/property keywords in `.imiprop` |
| Comment toggling | `language-configuration*.json` | Block comment `(* *)`. IMITATOR has no line comments, so <kbd>Ctrl</kbd>+<kbd>/</kbd> wraps the line in a block comment |
| Brackets | same | Matching, auto-closing, surrounding and colorized `()`, `[]`, `{}` |
| Auto-indentation | same | Indents after `var`, `loc …:`, `begin`, `then`, `else`, `do`, `{`; dedents on `loc`, `end`, `done`, `else`, `}` |
| Snippets | `snippets/*.json` | Model skeleton (`model`), `automaton`, `loc`, `urgent`, `accepting`, `locflow`, `when`, `whenn`, `do`, `if`, `for`, `while`, `function`, `template`, `instantiate`, `init`, `#include`, `controllable`, declarations. In properties: `property`, `EF`, `AGnot`, `EFpmin`, `EFtmin`, `EF_`, `until`, `CycleThrough`, `IM`, `BCcover`, `pattern`, `projectresult` |
| Keyword completion and documentation | `src/docs.js` | All lexer keywords and the 37 built-in functions, with one-line docs in completion and on hover |
| Outline and breadcrumbs | `src/engine.js` | `var` (each variable with its type), functions (parameters and locals), automata and templates (locations, with `urgent`/`accepting`), instantiations, `init` |
| Folding | engine | Automata, templates, locations, functions, `var`, `init`, comments, `(* region *)` markers |
| Context-aware completion | engine | after `goto`: locations of the enclosing automaton · after `sync`: its declared actions · `loc[`: automata · `loc[A] :=`: locations of `A` (template locations for instances) · `instantiate x :=`: templates · after `:` in `var`: types · elsewhere: variables, constants, functions, locals of the enclosing function, template parameters. In `.imiprop`: automata, locations, variables and actions from the model |
| Go to definition, find references, highlighting | engine | Variables, constants, functions and their locals, automata, templates and their parameters, locations (scoped per automaton), and actions (all `actions:` declarations). Works from a `.imiprop` into the model |
| Hover | engine + docs | The declaration of a symbol (`(parameter) p : parameter`, `(location) urgent loc l1`, …) or the doc of a keyword |
| Live diagnostics | engine | Unterminated comment, unexpected character, missing `end` of an automaton or function, duplicate location, `goto` to an unknown location, `sync` on an action missing from `actions:`, unexpected top-level text |
| Diagnostics on save | `src/extension.js` | Runs `imitator <file> -mode checksyntax -no-output-result` and maps its errors and warnings (parsing errors to their line, others to the first name quoted in the message) |

The model of a `.imiprop` is the `.imi` file with the same base name, or else the only `.imi` file in the folder.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `imitator.executablePath` | `imitator` | IMITATOR binary. If left at the default and the workspace contains `bin/imitator` (the IMITATOR repository), that binary is used |
| `imitator.checkOnSave` | `true` | Run IMITATOR on save |

## Design

The work follows the usual three levels of language support:

1. **Declarative extension (no code).** Grammar, language configuration and snippets. VS Code does the rest: bracket matching, comment toggling, indentation, word completion.
2. **Lightweight engine** (`src/engine.js`, ~600 lines). Only added for the features that need structure: outline, folding by blocks, scoped completion, navigation, diagnostics.
3. **Full semantic analysis.** Not reimplemented. IMITATOR's own parser and type checker already exist, so the extension calls `imitator -mode checksyntax` on save instead of duplicating them.

### Engine

The engine has no dependency on the `vscode` module, so it can be tested with plain Node.

- **Lexer.** Mirrors `src/lib/ModelLexer.mll` and `PropertyLexer.mll`: the same keyword sets, names `[a-zA-Z][a-zA-Z0-9_]*`, `0b…`, floats `[0-9]*.[0-9]+`, nested comments, `#include "…"`.
- **Scanner.** A single pass that follows the section order of `main` in `src/lib/ModelParser.mly`: `controllable actions`, `var`, `function`s, `template`s, `automaton`s, `instantiate`s, `init`, optional `end`. Each section has a small hand-written routine. The scanner is tolerant. It never throws. After an error it resumes at the next section keyword (`automaton`, `init`, …), so a half-typed file still produces a usable outline. Expressions are not parsed; the scanner only records the names inside them.
- **Symbols.** Each declaration has a key that fixes its scope: `var:x`, `fun:f`, `local:f/x`, `auto:a`, `tpl:t`, `tparam:t/x`, `loc:a/l`, `act:a`. Locations are scoped per automaton because two automata may reuse a location name. An instance (`instantiate p1 := proc(…)`) resolves its locations to `loc:proc/…`. Actions are global because synchronization is by name.
- **Resolution.** References are collected first and resolved after the whole file is scanned, because a `goto` may target a location defined later. Plain names are looked up in this order: function local or template parameter, global variable, function, action, built-in.
- **Caching.** One analysis per document version. Live diagnostics are debounced by 300 ms.

Two parts of the grammar decided how the scanner works:

- `end` closes automata, templates, functions and `if`. Inside an automaton, an `if` can only appear inside `do { … }`, so the scanner counts braces. Inside a function it counts `if`/`end` pairs.
- `var` starts the global section but also declares function locals (`var j : int = …`). It counts as a section keyword everywhere except inside a function body.

### Verification

| Test | Command | Result |
|---|---|---|
| Engine on every model in the repository (`benchmarks/`, `doc/`, `tests/`) | `node test/engine.test.js` | 629 models, 0 crashes, 0 false diagnostics. Only 7 old test files are flagged (they put `property :=` inside the model), and IMITATOR 3.4 rejects them too |
| Grammar on all 199 benchmark models | vscode-textmate + oniguruma (scratch script) | Every file ends outside a comment. Scopes checked by hand on representative lines |
| Integration in a real VS Code | `npm i -D @vscode/test-electron && node test/runTest.js [/path/to/code]` | 17/17 checks pass: language ids, outline, folding, the four context completions, general completion, definition (location, variable, function local, property→model), references (action, location), hover, property completion, engine diagnostics, IMITATOR diagnostics on save |
| Performance | — | About 300 ms for the largest model in the repository (2 MB, 400 k tokens, `accel-10000.imi`). Typical models take under 10 ms |

## Status and next steps

The difficulty scores are for this codebase as it stands now, with the engine already built.

| Feature | Status | Difficulty now | Notes |
|---|---|---|---|
| Syntax highlighting, comments, brackets, indentation, snippets, keyword completion, keyword docs | ✅ done | — | |
| Folding, outline | ✅ done | — | |
| Parse errors | ✅ done | — | Structural errors live from the engine; exact parse and type errors from IMITATOR on save |
| Completion from local declarations | ✅ done | — | |
| Go to definition, find references | ✅ done | — | |
| Rename symbol | ⏳ next | 2/10 | References already carry exact ranges and scoped keys. Remaining work: a `RenameProvider`, checking that the new name is not a model or property keyword (see the pitfalls in the manual), and editing the sibling `.imiprop` |
| Workspace-wide `#include` resolution | ⏳ | 3/10 | Analyze the included files and merge their symbol tables (the paths are already recorded in `analysis.includes`) |
| Semantic tokens (color clocks, parameters and discrete variables differently) | ⏳ | 2/10 | The symbol kinds are already known |
| Signature help for user and built-in functions | ⏳ | 3/10 | Needs argument-position tracking inside calls |
| Quick fixes (declare a missing action, `while`→`invariant`, `synclabs`→`actions`, add a missing `loc[A] :=` in `init`) | ⏳ | 3–4/10 | Diagnostics already exist; each fix is a text edit |
| Engine-level checks: unused variables and actions, missing initial location, `int` compared to a clock, disjunction over clocks | ⏳ | 4–6/10 | Needs an expression parser (precedence from `ModelParser.mly`) and the IMITATOR typing rules. Running IMITATOR on save already reports most of them |
| Full type checking in the editor | ⏳ | 7/10 | Re-implements `ParsingStructure` and the type checker. A better option is to make IMITATOR print machine-readable errors with positions (for example a JSON output) and keep calling it |
| Run or synthesize from the editor (command and result panel) | ⏳ | 3/10 | Run `imitator model.imi model.imiprop` and show the `.res` file |
