# DATS VS Code Extension

export BUILD_DIR := justfile_directory() / "build"

# Build extension and package as .vsix
build: _compile
    mkdir -p "$BUILD_DIR"
    pnpm run package

# Install extension in VS Code
install: build
    code --install-extension "$BUILD_DIR/dats.vsix" --force

# Update dependencies to latest versions
update: && _deps
    pnpm update --latest

# Run tests
test:
    pnpm run test

# Typecheck without emitting
typecheck:
    pnpm run typecheck

_compile: _deps && test typecheck
    pnpm run build

_deps:
    pnpm install

# Re-record testdata/corpus verdicts with the real dats CLI (see docs/dialect.md)
corpus:
    #!/usr/bin/env bash
    set -euo pipefail
    command -v dats >/dev/null || { echo "install the dats CLI first: curl -fL https://dl.pazer.build/dats?os=linux&arch=amd64 -o /usr/local/bin/dats && chmod +x /usr/local/bin/dats" >&2; exit 1; }
    cd testdata/corpus
    for f in *.dats; do
        if dats syntax "$f" >/dev/null 2>&1; then echo "$f ACCEPT"; else echo "$f REJECT"; fi
    done > verdicts.txt
    echo "re-recorded $(wc -l < verdicts.txt) verdicts"
