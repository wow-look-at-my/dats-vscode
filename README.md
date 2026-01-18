# DATS - Declarative Automated Testing System

Language support for `.dats` test definition files.

DATS is a declarative YAML format for defining command-line tests that compile to [BATS](https://github.com/bats-core/bats-core) (Bash Automated Testing System).

## Features

- Syntax highlighting for `.dats` files
- JSON Schema validation with inline error reporting
- Code snippets for common test patterns

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
      input.txt: |
        Hello, world!
    cmd: cat {inputs.input.txt}
    outputs:
      stdout:
        - "Hello, world!"

  - desc: grep returns 1 when not found
    exit: 1
    stdin: "hello world"
    cmd: grep -q "notfound"
```

## Snippets

| Prefix | Description |
|--------|-------------|
| `test` | Basic test case |
| `test-stdin` | Test with stdin input |
| `test-file` | Test with input file |

## Requirements

To run the generated tests, install the [dats CLI](https://github.com/mhaynie/bats-declarative) and BATS:

```bash
# Generate BATS tests
dats tests.dats output/

# Run tests
bats output/*.gen.bats
```

## Links

- [DATS CLI & Documentation](https://github.com/mhaynie/bats-declarative)
- [BATS Core](https://github.com/bats-core/bats-core)
