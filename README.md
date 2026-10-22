# IMITATOR language support for VS Code

Editor support for IMITATOR models (`.imi`) and properties (`.imiprop`), version 3.4 syntax.

The extension is plain JavaScript with no runtime dependencies and no build step.

## Install

```sh
cd vscode-imitator
npx @vscode/vsce package                        # -> imitator-language-0.3.0.vsix
code --install-extension imitator-language-0.3.0.vsix
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
| Live diagnostics | engine | Unterminated comment, unexpected character, missing `end` of an automaton or function, duplicate location, `goto` to an unknown location, `sync` on an action missing from `actions:`, unexpected top-level text, included file not found. Warnings (shown struck through) for deprecated `synclabs` and location `while` |
| Diagnostics on save | `src/extension.js` | Runs `imitator <file> -mode checksyntax -no-output-result` and maps its errors and warnings (parsing errors to their line, others to the first name quoted in the message). Also available as the command **IMITATOR: Check model syntax** |
| `#include` | engine | Included files (paths relative to the including file, recursively, cycles ignored) are scanned and their symbols merged: no false errors, and definition, references, completion, hover and rename reach into them |
| Rename (<kbd>F2</kbd>) | engine | Renames every occurrence in the model, its included files and its `.imiprop` files. Refuses keywords at the cursor, undeclared names, built-ins, invalid names, model **and property** keywords (`A`, `E`, `EF`, `next`, … would break the property file), and names already declared in the same scope |
| Semantic coloring | engine | Clocks, parameters (bold) and discrete variables each get their own color; constants, functions, locations, actions, automata and templates use the theme's colors for their kind. Colors can be changed with `editor.semanticTokenColorCustomizations` (token types `clock`, `modelParameter`, `discreteVariable`) |
| Signature help | engine | Inside the parentheses of a user function, a built-in function or a template in `instantiate`: signature and current argument |
| Quick fixes (<kbd>Ctrl</kbd>+<kbd>.</kbd>) | engine | `synclabs` → `actions`; `while` → `invariant`; replace every deprecated keyword of the file at once; declare an undeclared action (appends to `actions:` or creates the list); create a missing `goto` target location; add a missing `loc[A] := …` to `init` (one automaton, or all at once; uses the automaton's first location); convert the old `init := … ;` syntax to `init := { discrete = …; continuous = …; }` |
| Run IMITATOR | `src/extension.js` | **IMITATOR: Run** (▶ button in the editor title, <kbd>Ctrl</kbd>+<kbd>F5</kbd>) on a `.imi` or `.imiprop`: saves both files, runs `imitator model.imi model.imiprop [imitator.runArguments]` with progress and cancel, streams the output to the *IMITATOR* output panel, then shows the result (`imitator.showResult`). If several `.imiprop` files fit the model, it asks which one |
| Results | `src/result.js` | Parses the `.res` file. **Result panel** (command **IMITATOR: Show last result**, also in the editor title): constraint(s), soundness, termination, states, time, *Open .res* and *Run again* buttons. **CodeLens** above `property :=`: the constraint on one line, or *▶ Run IMITATOR* when there is no result. **Hover**: on the property line, the whole result; on a parameter, the conjuncts of the constraint that mention it. A result older than the model or the property is marked stale |
| Included files opened alone | `src/extension.js` | An index of `#include`s (whole workspace at start, then each edit, creation and deletion; folders outside the workspace on first use) finds the model that includes a file. The file is then analyzed inside that model: references, rename and diagnostics see the whole model, and the IMITATOR check runs on the including model, keeping only the messages about this file |

The model of a `.imiprop` is the `.imi` file with the same base name, or else the only `.imi` file in the folder.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `imitator.executablePath` | `imitator` | IMITATOR binary. If left at the default and the workspace contains `bin/imitator` (the IMITATOR repository), that binary is used |
| `imitator.checkOnSave` | `true` | Run IMITATOR on save |
| `imitator.runArguments` | `[]` | Extra options for **IMITATOR: Run**, e.g. `["-merge", "none"]` |
| `imitator.showResult` | `panel` | After a run: `panel`, `file` (open the `.res`), or `both` |

## Design

The work follows the usual three levels of language support:

1. **Declarative extension (no code).** Grammar, language configuration and snippets. VS Code does the rest: bracket matching, comment toggling, indentation, word completion.
2. **Lightweight engine** (`src/engine.js`, ~820 lines). Only added for the features that need structure: outline, folding by blocks, scoped completion, navigation, rename, coloring by kind, signature help, diagnostics and their quick fixes.
3. **Full semantic analysis.** Not reimplemented. IMITATOR's own parser and type checker already exist, so the extension calls `imitator -mode checksyntax` on save instead of duplicating them.

### Engine

The engine has no dependency on the `vscode` module, so it can be tested with plain Node.

- **Lexer.** Mirrors `src/lib/ModelLexer.mll` and `PropertyLexer.mll`: the same keyword sets, names `[a-zA-Z][a-zA-Z0-9_]*`, `0b…`, floats `[0-9]*.[0-9]+`, nested comments, `#include "…"`.
- **Scanner.** A single pass that follows the section order of `main` in `src/lib/ModelParser.mly`: `controllable actions`, `var`, `function`s, `template`s, `automaton`s, `instantiate`s, `init`, optional `end`. Each section has a small hand-written routine. The scanner is tolerant. It never throws. After an error it resumes at the next section keyword (`automaton`, `init`, …), so a half-typed file still produces a usable outline. Expressions are not parsed; the scanner only records the names inside them.
- **Symbols.** Each declaration has a key that fixes its scope: `var:x`, `fun:f`, `local:f/x`, `auto:a`, `tpl:t`, `tparam:t/x`, `loc:a/l`, `act:a`. Locations are scoped per automaton because two automata may reuse a location name. An instance (`instantiate p1 := proc(…)`) resolves its locations to `loc:proc/…`. Actions are global because synchronization is by name.
- **Resolution.** References are collected first and resolved after the whole file is scanned, because a `goto` may target a location defined later. Plain names are looked up in this order: function local or template parameter, global variable, function, action, built-in.
- **Includes.** `scanModel` reads one file; `analyzeModel` also scans the `#include`d files, merges the symbol tables (the main file wins on duplicates) and resolves the references of every file against the merged table. Each symbol remembers its file, so navigation can open the included file.
- **Caching.** One analysis per document version; any edit of an IMITATOR document drops the whole cache, since it may be included by another model. Live diagnostics are debounced by 300 ms.

Two parts of the grammar decided how the scanner works:

- `end` closes automata, templates, functions and `if`. Inside an automaton, an `if` can only appear inside `do { … }`, so the scanner counts braces. Inside a function it counts `if`/`end` pairs.
- `var` starts the global section but also declares function locals (`var j : int = …`). It counts as a section keyword everywhere except inside a function body.

### Verification

| Test | Command | Result |
|---|---|---|
| Engine on every model in the repository (`benchmarks/`, `doc/`, `tests/`) | `node test/engine.test.js` | 629 models (and 9 included files), 0 crashes, 0 false errors. Only 7 old test files are flagged (they put `property :=` inside the model), and IMITATOR 3.4 rejects them too. 397 deprecation warnings, and 3 missing includes, all in the `example-include-nonexisting-*` tests |
| Grammar on all 199 benchmark models | vscode-textmate + oniguruma (scratch script) | Every file ends outside a comment. Scopes checked by hand on representative lines |
| Integration in a real VS Code | `npm i -D @vscode/test-electron && node test/runTest.js [/path/to/code]` | 38/38 checks pass: language ids, outline, folding, completions, definition, references, hover, diagnostics, IMITATOR check, rename (model + property, actions, 5 refusals), semantic tokens and their default colors, signature help (user and built-in), includes (definition, references, completion), an included file opened alone (references, rename, IMITATOR check), every quick fix applied to a real buffer, a full run on `train.imi` + `train.imiprop`, and the result (panel data, CodeLens, hovers) |
| Old `init` conversion against IMITATOR | `node test/old-init.test.js [imitator] [work-dir]` | All 207 repository models written with the old syntax (without includes) are converted, and `imitator -imi2IMI` regenerates exactly the same model from the original and the converted file |
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
| Rename symbol | ✅ done | — | |
| `#include` resolution | ✅ done | — | |
| Semantic coloring of clocks, parameters, discrete variables | ✅ done | — | |
| Signature help | ✅ done | — | |
| Quick fixes (`synclabs`, `while`, undeclared action, missing location) | ✅ done | — | |
| Run IMITATOR from the editor | ✅ done | — | |
| Included files opened alone | ✅ done | — | |
| `init` quick fixes (missing `loc[A] :=`, old syntax) | ✅ done | — | |
| Result panel, CodeLens and hover | ✅ done | — | |
| Results of `#exemplify` (runs) and cartography (many tiles) shown graphically | ⏳ | 4/10 | The panel lists them as text today |
| Engine-level checks: unused variables and actions, missing initial location, `int` compared to a clock, disjunction over clocks | ⏳ | 4–6/10 | Needs an expression parser (precedence from `ModelParser.mly`) and the IMITATOR typing rules. Running IMITATOR on save already reports most of them |
| Full type checking in the editor | ⏳ | 7/10 | Re-implements `ParsingStructure` and the type checker. A better option is to make IMITATOR print machine-readable errors with positions (for example a JSON output) and keep calling it |
