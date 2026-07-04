# DATS - Declarative Automated Testing System

Language support for `.dats` test definition files.

DATS is a declarative YAML format for defining command-line tests, executed natively by the [dats runner](https://github.com/wow-look-at-my/dats).

## Features

- Syntax highlighting for `.dats` files
- JSON Schema validation with inline error reporting
- Completions for test keys and `{inputs.X}` / `{outputs.X}` placeholders
- Hover documentation for test fields

## Example

```yaml
tests:
  - desc: echo test
    cmd: echo Hello World
    outputs:
      stdout:
        - "Hello World"

  - desc: cat reads file
    inputs:
      files:
        input.txt: |
          Hello, world!
    cmd: cat {inputs.input.txt}
    outputs:
      stdout:
        - "Hello, world!"

  - desc: grep returns 1 when not found
    exit: 1
    inputs:
      stdin: "hello world"
    cmd: grep -q "notfound"
```

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
truth for `.dats` semantics. When the runner's schema changes, re-copy it here.

Current copy: synced from [wow-look-at-my/dats#17](https://github.com/wow-look-at-my/dats/pull/17)
(enforced-semantics schema, pending merge) at commit `66973ca`.

## Links

- [DATS Runner & Documentation](https://github.com/wow-look-at-my/dats)
