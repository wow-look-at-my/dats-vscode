# DATS VS Code Extension

# Build extension and package as .vsix
build: _compile
    mkdir -p "$BUILD_DIR"
    pnpm vsce package --no-dependencies --out "$BUILD_DIR/dats.vsix"

# Install extension in VS Code
install: build
    code --install-extension "$BUILD_DIR/dats.vsix" --force

# Update dependencies to latest versions
update: && _deps
    pnpm update --latest

# Run tests
test:
    pnpm vitest run --coverage

_compile: _deps && test
    pnpm esbuild src/extension.ts --bundle --minify --outfile=dist/extension.js --external:vscode --format=cjs --platform=node
    pnpm esbuild src/extension.ts --bundle --minify --outfile=dist/web/extension.js --external:vscode --format=cjs --platform=browser

_deps:
    pnpm install
