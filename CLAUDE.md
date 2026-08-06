# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension providing language support for `.dats` test files (DATS - Declarative Automated Testing System): syntax highlighting, diagnostics, completions, and hover docs. Pure language tooling - there is no test-runner integration. The CLI runner lives in [wow-look-at-my/dats](https://github.com/wow-look-at-my/dats) and is the source of truth for `.dats` semantics.

## Build Commands

pnpm is pinned via package.json's `packageManager` field - run `corepack enable` once so the pinned version is used.

```bash
pnpm install          # install dependencies
pnpm run test         # vitest with coverage
pnpm run typecheck    # tsc --noEmit
pnpm run build        # esbuild bundles: dist/extension.js (node) + dist/web/extension.js (browser)
pnpm run package      # vsce package -> build/dats.vsix (create build/ first)

just build            # deps + tests + typecheck + bundles + package .vsix into build/
just test             # run tests
just typecheck        # typecheck only
just install          # build, then install the .vsix into local VS Code
```

CI (`.github/workflows/ci.yml`) runs the same package.json scripts in a single `all-builds` job (the org's required status check name) and uploads the `.vsix` artifact. The justfile and CI both call the package.json scripts - change behavior there, not in two places.

## Architecture

- `src/extension.ts` - activation: wires the diagnostics collection (validator), the `{inputs.X}`/`{outputs.X}`/`{shared.X}` placeholder completion provider (parser helpers), key completion, and hover providers for language `dats`. `package.json` also defaults `[dats]` editing to tabs (`editor.insertSpaces: false`, detection off) -- a space-indented file is one the runner refuses to run
- `src/dialect.ts` - `normalizeDats`: rewrites a `.dats` file into standard YAML before the `yaml` package sees it (tab indentation -> spaces, bare `!stdout:` keys -> quoted), plus the position mappers both ways. Every parse of a document goes through it -- see `docs/dialect.md`
- `src/validator.ts` - hand-rolled YAML-AST validator (uses the `yaml` package) producing diagnostics. Intentionally mirrors the CLI's strict parser: unknown keys are Errors (the CLI parses with KnownFields and refuses to run such files), several messages mirror CLI wording verbatim. NOT driven by schema.json.
- `src/parser.ts` - pure line/regex helpers for placeholder completion: test boundary detection and fixture-name extraction for `{inputs.X}` (files AND copy), `{outputs.X}` and file-level `{shared.X}`. Indentation is measured as dialect DEPTH (leading tabs), never characters -- `\t\tfiles:` has fewer characters than the `\t  inputs:` holding it
- `src/keyCompletion.ts` - context-aware key and snippet completion via the yaml AST. Multi-line insert texts use indentation RELATIVE to the current line and are inserted as snippets (the editor prepends the line's indentation to continuation lines): one TAB per deeper level, two spaces to align across a `- `. A key typed on an aligned line (`inputs:`/`outputs:`) gets no continuation -- a tab may not follow alignment spaces
- `src/hover.ts` - static `FIELD_DOCS`-keyed hover docs; the key-detection regexes accept the bare `!stdout` spelling and the quoted one
- `syntaxes/dats.tmLanguage.json` - TextMate grammar: includes `source.yaml` and layers the cmd-line and `#hook-command-line` shell rules, placeholder scopes (`{inputs.X}`/`{outputs.X}`/`{shared.X}`/`{matrix.X}`) and the `#dialect` rules (tab-indented `- ` and bare `!key:`, which the built-in grammar scopes `invalid.illegal` and as a tag) via grammar-local `injections` (`L:source.dats`). The injection is REQUIRED: the built-in YAML grammar claims whole-document regions, so plain sibling top-level patterns would never match after line 1.
- `testdata/corpus/` - one `.dats` file per behaviour worth pinning plus `verdicts.txt`, what the REAL CLI does with each (`just corpus` re-records it by shelling out to `dats syntax`). `src/corpus.test.ts` asserts the validator predicts every verdict, so drift from the runner fails the build
- `schema.json` - bundled copy of the canonical dats schema. Loaded by no code at runtime; packaged for reference and future schema-driven validation.
- `testdata/yaml-grammar/` - the built-in VS Code YAML grammar, vendored as a test fixture (not packaged); `src/grammar.test.ts` tokenizes samples against it to prove the injection reaches through the real yaml grammar

## Testing

- vitest; unit tests mock `vscode` (no extension host or display needed)
- `src/grammar.test.ts` uses vscode-textmate + vscode-oniguruma to tokenize samples with BOTH the dats grammar and the real built-in YAML grammar registered - any grammar change must keep it green
- validator tests pin CLI-verified behaviors. If you change validator.ts, verify against the real CLI (`dats syntax` on a probe file), not intuition, and add the probe to `testdata/corpus/` + `just corpus`. A prebuilt binary is available from `https://dl.pazer.build/dats?os=linux&arch=amd64`.
- Write new test fixtures in the dialect (tabs, bare `!stdout`). The space-indented ones predate it and still pass, since a file with no tab indentation goes through `normalizeDats` untouched.

## Rules

- **schema.json must stay byte-identical to the dats repo's master schema.json.** It is synced here, not owned here. Never hand-edit it; re-copy from the runner repo and update the README provenance note (commit SHA) when it changes.
- The VSIX contents are governed by the `files` whitelist in package.json - keep test fixtures, testdata/ and coverage out of it, and check `pnpm run package`'s file listing after touching packaging.
- The dats CLI defines validation semantics. Extension diagnostics should match what `dats syntax` accepts and rejects: floats for exit/timeout are parse errors (never truncated), quoted integer exit codes/timeouts are accepted, fixture file names must be local relative paths, and duplicate or negative line-map keys are errors. If the schema and CLI ever diverge, follow the CLI and report the drift.
