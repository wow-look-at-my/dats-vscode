# DATS - Declarative Automated Testing System

Language support for `.dats` test definition files.

DATS is a declarative YAML format for defining command-line tests, executed natively by the [dats runner](https://github.com/wow-look-at-my/dats).

## Features

- Syntax highlighting for `.dats` files, including shell highlighting of `cmd` values and `{inputs.X}` / `{outputs.X}` placeholders
- Inline diagnostics from a built-in validator that mirrors the runner's strict parsing: unknown keys, missing/empty `cmd`, exit code and timeout validation, output check and `outputs.snapshot` shapes, `no tests defined`, file-level `setup`/`teardown`/`shared` and per-test `matrix` validation
- Context-aware completions for test keys, whole-test snippets, and `{inputs.X}` / `{outputs.X}` placeholders (suggesting the files declared in the current test)
- Hover documentation for test fields
- Understands the runner's YAML dialect: tab indentation and bare `!stdout` / `!stderr` / `!files` keys

## Example

```yaml
tests:
	- desc: echo test
	  cmd: echo Hello World
	  outputs:
		stdout:
			- "Hello World"

	- desc: no error on the happy path
	  cmd: echo Hello World
	  outputs:
		!stdout:
			- "error"

	- desc: grep returns 1 when not found
	  exit: 1
	  inputs:
		stdin: "hello world"
	  cmd: grep -q "notfound"
```

Indentation is tabs -- one per level, spaces only to align past a `- ` marker -- and the
negated keys (`!stdout`, `!stderr`, `!files`) are written bare.

## Requirements

To run tests, install the [dats runner](https://github.com/wow-look-at-my/dats):

```bash
# Run tests
dats test tests.dats

# Validate syntax without running
dats syntax tests.dats
```

## Schema Provenance

The bundled [`schema.json`](https://github.com/wow-look-at-my/dats-vscode/blob/master/schema.json) mirrors the canonical
[`schema.json`](https://github.com/wow-look-at-my/dats/blob/master/schema.json) in the
[dats runner](https://github.com/wow-look-at-my/dats) repository, which is the source of
truth for `.dats` semantics. The extension does not load it at runtime - diagnostics come
from the built-in validator - but it is bundled for reference and future schema-driven
validation, and can be wired into a YAML language server manually. When the runner's
schema changes, re-copy it here; it must stay byte-identical to the runner's master copy.

Current copy: synced from
[wow-look-at-my/dats@5b67ca8](https://github.com/wow-look-at-my/dats/commit/5b67ca8b511c88e560bc34b6b05e077460be1413)
(the file-level `sandbox` block, hook commands in the mapping form, and `inputs.copy` /
`shared.copy` fixtures).

## Links

- [DATS Runner & Documentation](https://github.com/wow-look-at-my/dats)
