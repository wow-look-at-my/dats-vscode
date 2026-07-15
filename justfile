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
