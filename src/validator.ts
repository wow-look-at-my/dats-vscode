import * as vscode from 'vscode';
import { parseDocument, isMap, isSeq, Scalar, YAMLMap, LineCounter } from 'yaml';
import { normalizeDats, firstIndentationError, DialectSource } from './dialect';

// The dats runner resolves only these two exit code names; any other EXIT_*
// string is rejected at parse time.
const EXIT_VAR_PATTERN = /^EXIT_(SUCCESS|FAILURE)$/;
// Go time.ParseDuration syntax (dats rejects negative timeouts, so no leading minus):
// optional +, then "0" or one or more <decimal number><unit> groups.
const GO_DURATION_PATTERN = /^\+?(0|((\d+(\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h))+)$/;

const UNKNOWN_KEY_SUFFIX = ' (dats will refuse to run this file)';
// {matrix.X} references, including the malformed empty-name form {matrix.}
// so validation can reject it (the CLI's matrixPlaceholderRe).
const MATRIX_PLACEHOLDER_PATTERN = /\{matrix\.([^}]*)\}/g;
// The allowed shape of a matrix variable name (the CLI's matrixNameRe).
const MATRIX_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A bare or quoted integer: accepted for exit (0-255) and timeout (seconds).
const INTEGER_PATTERN = /^[-+]?[0-9]+$/;
// A shell heredoc (<<WORD) and a herestring (<<<) are both rejected in cmd
// and in hook commands; the first "<<" decides which (the CLI's
// bannedRedirect).
const HEREDOC_BAN = 'must not use a shell heredoc (<<WORD) -- write the file and pull it in with inputs.files/inputs.copy or shared.files/shared.copy instead';
const HERESTRING_BAN = 'must not use a shell herestring (<<<) -- use inputs.stdin (or a pipe within cmd) instead of redirecting from the end of the line';
// Number scalars written in float form ("1.5", "2.0", "1e3"). yaml resolves
// "2.0" to the integer 2, so the source text is checked, not just the value.
const FLOAT_SOURCE_PATTERN = /\.|^[-+]?[0-9]+[eE]/;

// Raw source text of a scalar as written in the file (falls back to the
// resolved value when the node was not produced by the parser).
function scalarSource(node: Scalar): string {
    return typeof node.source === 'string' ? node.source : String(node.value);
}

// Mirrors Go's filepath.IsLocal: fixture file names must be relative paths
// that stay inside the test directory (no absolute paths, no ".." escapes;
// nested names like "sub/file.txt" are fine).
function isLocalRelativePath(name: string): boolean {
    if (name === '' || name.startsWith('/')) return false;
    let depth = 0;
    for (const part of name.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            depth--;
            if (depth < 0) return false;
        } else {
            depth++;
        }
    }
    return true;
}

function isNullScalar(node: unknown): boolean {
    return node instanceof Scalar && node.value === null;
}

// The boolean a scalar decodes to, or undefined when it is not one. Only real
// booleans qualify: yaml-fixed resolves the YAML 1.1 spellings (yes/no/on/off)
// and a quoted "true" to plain strings, and the CLI rejects those wherever it
// wants a bool.
function scalarBoolValue(node: Scalar): boolean | undefined {
    return typeof node.value === 'boolean' ? node.value : undefined;
}

// Whether a timeout scalar means zero. Any non-zero duration contains a digit
// 1-9, whatever its units ("0", "0s", "0.0ms" are all zero).
function isZeroDuration(node: Scalar): boolean {
    const text = typeof node.value === 'number' ? String(node.value) : typeof node.value === 'string' ? node.value : '';
    return text !== '' && !/[1-9]/.test(text);
}

// Why s is rejected as a command, if at all (the CLI's bannedRedirect).
function bannedRedirect(s: string): string | undefined {
    const idx = s.indexOf('<<');
    if (idx === -1) return undefined;
    return s[idx + 2] === '<' ? HERESTRING_BAN : HEREDOC_BAN;
}

// Mirrors the CLI's findMatrixPlaceholder: the name of the first {matrix.X}
// reference in s (possibly ""), or undefined when there is none.
function findMatrixPlaceholder(s: string): string | undefined {
    const [match] = s.matchAll(MATRIX_PLACEHOLDER_PATTERN);
    return match?.[1];
}

export function validateDatsDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const parseCounter = new LineCounter();

    // Indentation is the dialect's own rule and the CLI's first gate: a
    // space-indented file parses as ordinary YAML, so nothing below would ever
    // notice that the runner refuses to run it.
    const indentation = firstIndentationError(text);
    if (indentation) {
        const range = new vscode.Range(indentation.line, indentation.col, indentation.line, indentation.endCol);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, indentation.message, vscode.DiagnosticSeverity.Error));
    }

    // yaml parses standard YAML, so the tab indentation and bare "!stdout:"
    // keys of the dialect have to be rewritten first; every position the parser
    // reports then comes back through the mapper.
    const source = normalizeDats(text);
    if (source.flowError) {
        const range = new vscode.Range(source.flowError.line, source.flowError.col, source.flowError.line, source.flowError.endCol);
        // Mirrors the CLI's parse error: the block parser reads a line at a time
        diagnostics.push(new vscode.Diagnostic(range, source.flowError.message, vscode.DiagnosticSeverity.Error));
    }

    // parseDocument does not throw on malformed input; it reports via doc.errors
    const doc = parseDocument(source.text, { lineCounter: parseCounter });
    const lineCounter = sourceLineCounter(parseCounter, source);

    // Check for YAML parse errors
    for (const error of doc.errors) {
        const pos = error.linePos?.[0];
        if (pos) {
            const col = source.toSourceCol(pos.line - 1, pos.col - 1);
            const range = new vscode.Range(pos.line - 1, col, pos.line - 1, col + 11);
            diagnostics.push(new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error));
        }
    }

    const root = doc.contents;
    if (!isMap(root)) {
        if (root && !isNullScalar(root)) {
            const range = nodeRange(root, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, 'Document root must be a mapping', vscode.DiagnosticSeverity.Error));
        } else if (diagnostics.length === 0) {
            // Empty document: same hard error the CLI reports
            diagnostics.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'no tests defined', vscode.DiagnosticSeverity.Error));
        }
        return diagnostics;
    }

    // Check for unknown top-level keys ($schema is accepted by the CLI too)
    const topLevelKeys = new Set(['tests', 'shared', 'setup', 'teardown', 'sandbox', '$schema']);
    for (const item of root.items) {
        const key = item.key;
        if (key instanceof Scalar && !topLevelKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown property "${key.value}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
        }
    }

    // Validate file-level setup/teardown hooks and shared fixtures before the
    // tests checks below, so a hooks-only file still gets these diagnostics
    // alongside "no tests defined"
    for (const hookKey of ['setup', 'teardown'] as const) {
        const hookNode = root.get(hookKey, true);
        if (hookNode !== undefined) {
            validateCommandList(hookNode, hookKey, lineCounter, document, diagnostics);
        }
    }
    const sharedNode = root.get('shared', true);
    if (sharedNode !== undefined) {
        validateShared(sharedNode, lineCounter, document, diagnostics);
    }
    const sandboxNode = root.get('sandbox', true);
    if (sandboxNode !== undefined) {
        validateSandbox(sandboxNode, lineCounter, document, diagnostics);
    }

    // Validate tests array
    const testsNode = root.get('tests', true);
    if (!testsNode || isNullScalar(testsNode)) {
        const range = testsNode ? nodeRange(testsNode, lineCounter, document) : new vscode.Range(0, 0, 0, 1);
        diagnostics.push(new vscode.Diagnostic(range, 'no tests defined', vscode.DiagnosticSeverity.Error));
        return diagnostics;
    }

    if (!isSeq(testsNode)) {
        const range = nodeRange(testsNode, lineCounter, document);
        diagnostics.push(new vscode.Diagnostic(range, '"tests" must be an array', vscode.DiagnosticSeverity.Error));
        return diagnostics;
    }

    if (testsNode.items.length === 0) {
        const range = nodeRange(testsNode, lineCounter, document);
        diagnostics.push(new vscode.Diagnostic(range, 'no tests defined', vscode.DiagnosticSeverity.Error));
        return diagnostics;
    }

    // Validate each test
    for (const [index, testNode] of testsNode.items.entries()) {
        if (!isMap(testNode)) {
            const range = nodeRange(testNode, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, 'Each test must be a mapping', vscode.DiagnosticSeverity.Error));
            continue;
        }

        // 1-based, so a message naming the test reads like the CLI's
        validateTest(testNode as YAMLMap, index + 1, lineCounter, document, diagnostics);
    }

    return diagnostics;
}

// Mirrors the CLI's CommandList: a file-level setup/teardown value is a
// single command string or a list of command strings. Alias values are left
// to the CLI (it resolves them; the walker cannot).
function validateCommandList(node: any, key: 'setup' | 'teardown', lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    // `setup:` with no value is fine (no commands), like the CLI
    if (node === null || isNullScalar(node)) return;

    if (node instanceof Scalar) {
        // The single-string form counts as command 1 in the CLI's errors
        validateCommand(node, key, 'command', 1, lineCounter, document, diagnostics);
        return;
    }

    if (isSeq(node)) {
        if (node.items.length === 0) {
            const range = nodeRange(node, lineCounter, document);
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `${key}: must list at least one command`, vscode.DiagnosticSeverity.Error));
            return;
        }
        node.items.forEach((item: unknown, i: number) => {
            validateHookEntry(item, key, `command ${i + 1}`, i + 1, lineCounter, document, diagnostics);
        });
        return;
    }

    if (isMap(node)) {
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error (only a LIST's items may be mappings,
        // so a lone `setup: {cmd: ...}` is still the wrong shape)
        diagnostics.push(new vscode.Diagnostic(range, `${key} must be a command string or a list of command strings`, vscode.DiagnosticSeverity.Error));
    }
}

// Mirrors the CLI's hookCommandFromValue: one setup/teardown entry is a bare
// command string or a mapping of cmd plus optional env, stdin_file and
// timeout. The mapping form is only reachable from a list item.
function validateHookEntry(node: any, key: 'setup' | 'teardown', label: string, index: number, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    if (isSeq(node)) {
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label} must be a command string or a mapping (cmd, env, stdin_file, timeout)`, vscode.DiagnosticSeverity.Error));
        return;
    }
    if (!isMap(node)) {
        validateCommand(node, key, label, index, lineCounter, document, diagnostics);
        return;
    }

    let hasCmd = false;
    for (const pair of node.items) {
        const entryKey = pair.key;
        if (!(entryKey instanceof Scalar)) continue;
        const keyStr = String(entryKey.value);
        const value = pair.value;
        const range = nodeRange(value ?? entryKey, lineCounter, document);

        switch (keyStr) {
            case 'cmd':
                hasCmd = true;
                validateCommand(value, key, label, index, lineCounter, document, diagnostics);
                break;
            case 'env':
                if (!isMap(value)) {
                    // Mirrors the CLI's parse error
                    diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label}: env must be a mapping of variable name to value`, vscode.DiagnosticSeverity.Error));
                    break;
                }
                for (const envPair of value.items) {
                    const envValue = envPair.value;
                    if (!(envPair.key instanceof Scalar)) continue;
                    const envName = String(envPair.key.value);
                    if (!(envValue instanceof Scalar) || typeof envValue.value !== 'string') {
                        // Mirrors the CLI's parse error
                        diagnostics.push(new vscode.Diagnostic(nodeRange(envValue ?? envPair.key, lineCounter, document), `${key}: ${label}: env: "${envName}" must be a string`, vscode.DiagnosticSeverity.Error));
                        continue;
                    }
                    const envRef = findMatrixPlaceholder(envValue.value);
                    if (envRef !== undefined) {
                        // Mirrors the CLI's parse error
                        diagnostics.push(new vscode.Diagnostic(nodeRange(envValue, lineCounter, document), `${key} command ${index}: env "${envName}": {matrix.${envRef}} is not available outside tests`, vscode.DiagnosticSeverity.Error));
                    }
                }
                break;
            case 'stdin_file': {
                if (!(value instanceof Scalar) || typeof value.value !== 'string' || value.value === '') {
                    // Mirrors the CLI's parse error
                    diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label}: stdin_file must be a non-empty string`, vscode.DiagnosticSeverity.Error));
                    break;
                }
                const stdinRef = findMatrixPlaceholder(value.value);
                if (stdinRef !== undefined) {
                    // Mirrors the CLI's parse error
                    diagnostics.push(new vscode.Diagnostic(range, `${key} command ${index}: stdin_file: {matrix.${stdinRef}} is not available outside tests`, vscode.DiagnosticSeverity.Error));
                }
                break;
            }
            case 'timeout':
                validateTimeout(value, lineCounter, document, diagnostics, `${key}: ${label}: `);
                // A hook always has a bound, so unlike a test's timeout an
                // explicit 0 is rejected rather than meaning "unbounded"
                if (value instanceof Scalar && isZeroDuration(value)) {
                    // Mirrors the CLI's parse error
                    diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label}: timeout must be greater than 0 (omit it to use the default 30s)`, vscode.DiagnosticSeverity.Error));
                }
                break;
            default:
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(nodeRange(entryKey, lineCounter, document), `${key}: ${label}: unknown key "${keyStr}" (allowed: cmd, env, stdin_file, timeout)`, vscode.DiagnosticSeverity.Error));
        }
    }

    if (!hasCmd) {
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label}: must set cmd`, vscode.DiagnosticSeverity.Error));
    }
}

// Mirrors the CLI's commandFromValue: only true strings are commands (a bare
// 123 is never coerced), blank commands are rejected, and a heredoc or
// herestring is rejected outright. Valid commands are then checked for
// {matrix.X}, which can never resolve in file-level hooks.
function validateCommand(node: any, key: 'setup' | 'teardown', label: string, index: number, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const range = nodeRange(node, lineCounter, document);
    if (!(node instanceof Scalar) || typeof node.value !== 'string') {
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label} must be a string`, vscode.DiagnosticSeverity.Error));
        return;
    }
    if (node.value.trim() === '') {
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label} must not be empty`, vscode.DiagnosticSeverity.Error));
        return;
    }
    const banned = bannedRedirect(node.value);
    if (banned) {
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, `${key}: ${label}: ${banned}`, vscode.DiagnosticSeverity.Error));
        return;
    }
    const ref = findMatrixPlaceholder(node.value);
    if (ref !== undefined) {
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, `${key} command ${index}: {matrix.${ref}} is not available outside tests`, vscode.DiagnosticSeverity.Error));
    }
}

// Mirrors the CLI's SandboxSpec.UnmarshalYAML: a scalar bool, or a mapping of
// enabled/network/image that has to state at least one of them.
function validateSandbox(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    // `sandbox:` with no value leaves every decision to the CLI, like an
    // absent key
    if (node === null || isNullScalar(node)) return;

    const shapeError = 'sandbox: must be true, false, or a mapping (enabled, network, image)';
    if (!isMap(node)) {
        if (node instanceof Scalar && scalarBoolValue(node) !== undefined) return;
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, shapeError, vscode.DiagnosticSeverity.Error));
        return;
    }

    if (node.items.length === 0) {
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, 'sandbox: mapping must set at least one of enabled, network, image', vscode.DiagnosticSeverity.Error));
        return;
    }

    for (const pair of node.items) {
        const key = pair.key;
        if (!(key instanceof Scalar)) continue;
        const keyStr = String(key.value);
        const value = pair.value;

        if (keyStr === 'enabled' || keyStr === 'network') {
            const flag = value instanceof Scalar ? scalarBoolValue(value) : undefined;
            if (flag === undefined) {
                const range = nodeRange(value ?? key, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `sandbox: ${keyStr} must be a boolean`, vscode.DiagnosticSeverity.Error));
            }
            continue;
        }
        if (keyStr === 'image') {
            if (!(value instanceof Scalar) || typeof value.value !== 'string' || value.value === '') {
                const range = nodeRange(value ?? key, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, 'sandbox: image must be a non-empty string', vscode.DiagnosticSeverity.Error));
                continue;
            }
            // The sandbox is resolved once per file, before any instance
            // exists, so a matrix reference in the image can never resolve
            const ref = findMatrixPlaceholder(value.value);
            if (ref !== undefined) {
                const range = nodeRange(value, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `sandbox image: {matrix.${ref}} is not available outside tests`, vscode.DiagnosticSeverity.Error));
            }
            continue;
        }
        const range = nodeRange(key, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, `sandbox: unknown key "${keyStr}" (allowed: enabled, network, image)`, vscode.DiagnosticSeverity.Error));
    }
}

function validateShared(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    // `shared:` with no value is fine (no shared files), like the CLI
    if (node === null || isNullScalar(node)) return;

    if (!isMap(node)) {
        // Alias values are left to the CLI (it resolves them; the walker cannot)
        if (node instanceof Scalar || isSeq(node)) {
            const range = nodeRange(node, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, '"shared" must be a mapping with a "files" or "copy" key', vscode.DiagnosticSeverity.Error));
        }
        return;
    }

    for (const item of node.items) {
        const key = item.key;
        if (key instanceof Scalar && key.value !== 'files' && key.value !== 'copy') {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown shared property "${key.value}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
        }
    }

    const filesNode = node.get('files', true);
    const copyNode = node.get('copy', true);
    const declares = (fixtures: unknown) => isMap(fixtures) && fixtures.items.length > 0;
    if (!declares(filesNode) && !declares(copyNode)) {
        const range = nodeRange(filesNode ?? copyNode ?? node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, 'shared: must declare at least one file under files or copy', vscode.DiagnosticSeverity.Error));
        return;
    }

    if (isMap(copyNode)) {
        validateCopyBlock(copyNode as YAMLMap, isMap(filesNode) ? (filesNode as YAMLMap) : undefined, 'shared', lineCounter, document, diagnostics);
        // A shared copy source is resolved once per file, before any instance
        // exists, so a matrix reference in it can never resolve
        for (const item of copyNode.items) {
            const source = item.value;
            if (!(item.key instanceof Scalar) || !(source instanceof Scalar) || typeof source.value !== 'string') continue;
            const ref = findMatrixPlaceholder(source.value);
            if (ref !== undefined) {
                const range = nodeRange(source, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `shared copy "${item.key.value}": {matrix.${ref}} is not available outside tests`, vscode.DiagnosticSeverity.Error));
            }
        }
    }
    if (!isMap(filesNode)) return;

    validateFixtureNames(filesNode as YAMLMap, 'shared', lineCounter, document, diagnostics);

    // {matrix.X} can never resolve in shared file contents: they are written
    // once per file, where no test instance exists
    for (const item of filesNode.items) {
        const value = item.value;
        if (!(item.key instanceof Scalar) || !(value instanceof Scalar) || typeof value.value !== 'string') continue;
        const ref = findMatrixPlaceholder(value.value);
        if (ref !== undefined) {
            const range = nodeRange(value, lineCounter, document);
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `shared file "${item.key.value}": {matrix.${ref}} is not available outside tests`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateTest(test: YAMLMap, testNumber: number, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['desc', 'exit', 'cmd', 'timeout', 'matrix', 'inputs', 'outputs']);

    // Check for unknown keys
    for (const item of test.items) {
        const key = item.key;
        if (key instanceof Scalar && !validKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown property "${key.value}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
        }
    }

    // cmd is required and must be non-empty (the CLI treats null/"" as missing)
    const cmdNode = test.get('cmd', true);
    if (!cmdNode) {
        const range = nodeRange(test, lineCounter, document);
        diagnostics.push(new vscode.Diagnostic(range, 'Test is missing required property "cmd"', vscode.DiagnosticSeverity.Error));
    } else if (cmdNode instanceof Scalar && (cmdNode.value === null || cmdNode.value === '')) {
        const range = nodeRange(cmdNode, lineCounter, document);
        diagnostics.push(new vscode.Diagnostic(range, '"cmd" must be a non-empty string', vscode.DiagnosticSeverity.Error));
    } else if (cmdNode instanceof Scalar && typeof cmdNode.value === 'string') {
        const banned = bannedRedirect(cmdNode.value);
        if (banned) {
            const range = nodeRange(cmdNode, lineCounter, document);
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `test ${testNumber}: cmd: ${banned}`, vscode.DiagnosticSeverity.Error));
        }
    }

    // Validate exit code
    const exitPair = test.items.find(item => item.key instanceof Scalar && item.key.value === 'exit');
    if (exitPair && exitPair.value) {
        validateExitCode(exitPair.value, lineCounter, document, diagnostics);
    }

    // Validate timeout
    const timeoutPair = test.items.find(item => item.key instanceof Scalar && item.key.value === 'timeout');
    if (timeoutPair && timeoutPair.value) {
        validateTimeout(timeoutPair.value, lineCounter, document, diagnostics);
    }

    // Validate inputs if present
    const inputsNode = test.get('inputs', true);
    if (inputsNode && isMap(inputsNode)) {
        validateInputs(inputsNode as YAMLMap, testNumber, lineCounter, document, diagnostics);
    }

    // Validate outputs if present
    const outputsNode = test.get('outputs', true);
    if (outputsNode && isMap(outputsNode)) {
        validateOutputs(outputsNode as YAMLMap, lineCounter, document, diagnostics);
    }

    // Validate the matrix block and every {matrix.X} reference in the test's
    // substitution scope (an explicit null matrix means absent, like the CLI)
    const matrixNode = test.get('matrix', true);
    const hasMatrix = matrixNode !== undefined && matrixNode !== null && !isNullScalar(matrixNode);
    const declared = hasMatrix ? validateMatrix(matrixNode, lineCounter, document, diagnostics) : null;
    validateMatrixRefs(test, hasMatrix, declared, lineCounter, document, diagnostics);
}

// Mirrors the CLI's Matrix.UnmarshalYAML. Returns the declared variable
// names in declaration order, or null when the block's shape prevents
// collecting them (the shape diagnostic already flags the file, so reference
// checks are skipped rather than cascading).
function validateMatrix(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): string[] | null {
    if (!isMap(node)) {
        // Alias values are left to the CLI (it resolves them; the walker cannot)
        if (node instanceof Scalar || isSeq(node)) {
            const range = nodeRange(node, lineCounter, document);
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, 'matrix must be a mapping of variable names to value lists', vscode.DiagnosticSeverity.Error));
        }
        return null;
    }
    if (node.items.length === 0) {
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, 'matrix must declare at least one variable', vscode.DiagnosticSeverity.Error));
        return null;
    }

    const declared: string[] = [];
    const seen = new Set<string>();
    for (const pair of node.items) {
        const key = pair.key;
        if (!(key instanceof Scalar)) continue;
        const name = String(key.value);
        const keyRange = nodeRange(key, lineCounter, document);

        if (!MATRIX_NAME_PATTERN.test(name)) {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(keyRange, `matrix variable name "${name}" must match ^[A-Za-z_][A-Za-z0-9_]*$`, vscode.DiagnosticSeverity.Error));
        }
        if (seen.has(name)) {
            // Mirrors the CLI's parse error (the yaml parser reports the
            // duplicate mapping key as its own diagnostic too)
            diagnostics.push(new vscode.Diagnostic(keyRange, `matrix variable "${name}" declared more than once`, vscode.DiagnosticSeverity.Error));
        } else {
            seen.add(name);
            declared.push(name);
        }

        const value = pair.value;
        if (!isSeq(value)) {
            // A null value lands here too, matching the CLI; alias values are
            // left to the CLI
            if (value == null || value instanceof Scalar || isMap(value)) {
                const range = nodeRange(value ?? key, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `matrix variable "${name}" must list its values as a sequence`, vscode.DiagnosticSeverity.Error));
            }
            continue;
        }
        if (value.items.length === 0) {
            const range = nodeRange(value, lineCounter, document);
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `matrix variable "${name}" must list at least one value`, vscode.DiagnosticSeverity.Error));
            continue;
        }
        const seenValues = new Set<string>();
        value.items.forEach((item: unknown, i: number) => {
            if (!(item instanceof Scalar) || item.value === null) {
                const range = nodeRange(item ?? value, lineCounter, document);
                // Mirrors the CLI's parse error (null has no substitution text)
                diagnostics.push(new vscode.Diagnostic(range, `matrix variable "${name}" value ${i + 1}: values must be scalar strings, numbers, or booleans`, vscode.DiagnosticSeverity.Error));
                return;
            }
            // The CLI compares values after stringification (the literal
            // scalar text): 1.50 and "1.50" produce byte-identical instances
            const text = typeof item.value === 'string' ? item.value : scalarSource(item);
            if (seenValues.has(text)) {
                const range = nodeRange(item, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `matrix variable "${name}" lists duplicate value "${text}"`, vscode.DiagnosticSeverity.Error));
            } else {
                seenValues.add(text);
            }
        });
    }
    return declared;
}

// Mirrors the CLI's validateMatrixRefs: every {matrix.X} reference in the
// test's substitution scope must name a variable declared by THIS test's
// matrix. declared is null when the matrix block was malformed; only the
// empty-name form is reported then.
function validateMatrixRefs(test: YAMLMap, hasMatrix: boolean, declared: string[] | null, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    scanMatrixScope(test, node => {
        for (const match of (node.value as string).matchAll(MATRIX_PLACEHOLDER_PATTERN)) {
            const name = match[1];
            let message: string | undefined;
            if (name === '') {
                // Mirrors the CLI's parse error
                message = '{matrix.} must name a matrix variable';
            } else if (!hasMatrix) {
                // Mirrors the CLI's parse error
                message = `{matrix.${name}} is used but the test declares no matrix`;
            } else if (declared && !declared.includes(name)) {
                // Mirrors the CLI's parse error
                message = `{matrix.${name}} is not a declared matrix variable (declared: ${declared.join(', ')})`;
            }
            if (message) {
                const range = nodeRange(node, lineCounter, document);
                diagnostics.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error));
            }
        }
    });
}

// Calls visit on every string scalar in the test's matrix substitution
// scope: desc, cmd, inputs.stdin, inputs.files contents, inputs.copy sources,
// inputs.env values,
// every output pattern (list and line-map forms, files/!files match/notMatch
// entries), and every string scalar inside json_output (mapping keys
// included). Fixture file names, env var names, exit, timeout, and the
// matrix block itself are out of scope, exactly like the CLI's
// applyToMatrixScope. Alias nodes are not followed (the CLI follows them
// inside json_output; the walker under-reports there rather than guessing).
function scanMatrixScope(test: YAMLMap, visit: (node: Scalar) => void) {
    const visitString = (node: unknown) => {
        if (node instanceof Scalar && typeof node.value === 'string') visit(node);
    };

    visitString(test.get('desc', true));
    visitString(test.get('cmd', true));

    const inputs = test.get('inputs', true);
    if (isMap(inputs)) {
        visitString(inputs.get('stdin', true));
        for (const mapKey of ['files', 'copy', 'env']) {
            const valueMap = inputs.get(mapKey, true);
            if (!isMap(valueMap)) continue;
            for (const pair of valueMap.items) visitString(pair.value);
        }
    }

    const outputs = test.get('outputs', true);
    if (!isMap(outputs)) return;
    for (const checkKey of ['stdout', 'stderr', '!stdout', '!stderr']) {
        const check = outputs.get(checkKey, true);
        if (isSeq(check)) {
            for (const item of check.items) visitString(item);
        } else if (isMap(check)) {
            for (const pair of check.items) visitString(pair.value);
        }
    }
    for (const filesKey of ['files', '!files']) {
        const filesMap = outputs.get(filesKey, true);
        if (!isMap(filesMap)) continue;
        for (const filePair of filesMap.items) {
            if (!isMap(filePair.value)) continue;
            for (const patternsKey of ['match', 'notMatch']) {
                const patterns = (filePair.value as YAMLMap).get(patternsKey, true);
                if (!isSeq(patterns)) continue;
                for (const item of patterns.items) visitString(item);
            }
        }
    }
    visitJsonOutputStrings(outputs.get('json_output', true), visitString);
}

// Every string scalar in the json_output node tree, mapping keys included.
function visitJsonOutputStrings(node: unknown, visitString: (node: unknown) => void) {
    if (node instanceof Scalar) {
        visitString(node);
    } else if (isMap(node)) {
        for (const pair of node.items) {
            visitJsonOutputStrings(pair.key, visitString);
            visitJsonOutputStrings(pair.value, visitString);
        }
    } else if (isSeq(node)) {
        for (const item of node.items) visitJsonOutputStrings(item, visitString);
    }
}

function validateExitCode(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    if (!(node instanceof Scalar)) return;

    const value = node.value;
    const range = nodeRange(node, lineCounter, document);

    if (typeof value === 'number') {
        const raw = scalarSource(node);
        if (!Number.isInteger(value) || FLOAT_SOURCE_PATTERN.test(raw)) {
            // Mirrors the CLI's parse error: floats are rejected, not truncated
            diagnostics.push(new vscode.Diagnostic(range, `exit code must be an integer in range 0-255, got float ${raw}`, vscode.DiagnosticSeverity.Error));
        } else if (value < 0 || value > 255) {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `exit code ${value} must be in range 0-255`, vscode.DiagnosticSeverity.Error));
        }
    } else if (typeof value === 'string') {
        if (INTEGER_PATTERN.test(value)) {
            // A quoted integer (e.g. "3") counts as its numeric value
            const intVal = parseInt(value, 10);
            if (intVal < 0 || intVal > 255) {
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `exit code ${intVal} must be in range 0-255`, vscode.DiagnosticSeverity.Error));
            }
        } else if (!EXIT_VAR_PATTERN.test(value)) {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `exit "${value}" is not a recognized exit code name (use EXIT_SUCCESS, EXIT_FAILURE, or an integer 0-255)`, vscode.DiagnosticSeverity.Error));
        }
    }
}

// prefix names the hook entry a timeout belongs to ("setup: command 1: ");
// a test's own timeout carries none.
function validateTimeout(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[], prefix = '') {
    if (!(node instanceof Scalar)) return;

    const value = node.value;
    const range = nodeRange(node, lineCounter, document);

    if (typeof value === 'number') {
        const raw = scalarSource(node);
        if (!Number.isInteger(value) || FLOAT_SOURCE_PATTERN.test(raw)) {
            // Mirrors the CLI's parse error: floats are rejected, not truncated
            // (fractional seconds are written as a duration string instead)
            diagnostics.push(new vscode.Diagnostic(range, `${prefix}timeout must be an integer number of seconds or a duration string (e.g. "900ms", "1.5s"), got float ${raw}`, vscode.DiagnosticSeverity.Error));
        } else if (value < 0) {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `${prefix}timeout ${value} must not be negative`, vscode.DiagnosticSeverity.Error));
        }
    } else if (typeof value === 'string') {
        if (INTEGER_PATTERN.test(value)) {
            // A quoted bare integer (e.g. "5") means seconds, like the unquoted form
            const intVal = parseInt(value, 10);
            if (intVal < 0) {
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `${prefix}timeout ${intVal} must not be negative`, vscode.DiagnosticSeverity.Error));
            }
        } else if (!GO_DURATION_PATTERN.test(value)) {
            diagnostics.push(new vscode.Diagnostic(range, `${prefix}Timeout "${value}" must be a non-negative integer number of seconds or a Go duration string (e.g. "500ms", "1m30s")`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateInputs(inputs: YAMLMap, testNumber: number, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['stdin', 'files', 'copy', 'env']);

    for (const item of inputs.items) {
        const key = item.key;
        if (!(key instanceof Scalar)) continue;

        const keyStr = key.value as string;
        if (!validKeys.has(keyStr)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown inputs property "${keyStr}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
        }

        if (keyStr === 'files' && item.value && isMap(item.value)) {
            validateFixtureNames(item.value as YAMLMap, 'input', lineCounter, document, diagnostics);
        }

        if (keyStr === 'copy' && item.value && isMap(item.value)) {
            const filesNode = inputs.get('files', true);
            validateCopyBlock(item.value as YAMLMap, isMap(filesNode) ? (filesNode as YAMLMap) : undefined, `test ${testNumber}`, lineCounter, document, diagnostics);
        }

        if (keyStr === 'env' && item.value) {
            validateEnv(item.value, lineCounter, document, diagnostics);
        }
    }
}

function validateEnv(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    // `env:` with no value is fine (no variables), like a null output check
    if (isNullScalar(node)) return;

    if (!isMap(node)) {
        const range = nodeRange(node, lineCounter, document);
        diagnostics.push(new vscode.Diagnostic(range, '"env" must be a map of environment variable names to string values', vscode.DiagnosticSeverity.Error));
        return;
    }

    for (const pair of node.items) {
        const value = pair.value;
        // A null value decodes to the empty string, which the CLI accepts
        if (!value || isNullScalar(value)) continue;
        if (!(value instanceof Scalar) || typeof value.value !== 'string') {
            const range = nodeRange(value, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, 'env values must be strings', vscode.DiagnosticSeverity.Error));
        }
    }
}

// Mirrors the CLI's validateCopyBlock: a copy destination is a local relative
// name like a files name, it needs a non-empty source, and it may not also be
// declared under files -- a name has one source of content. context names the
// block the CLI would name ("shared" or "test N"; the walker has no test
// index, so it says "test" -- see testContext).
function validateCopyBlock(copyMap: YAMLMap, filesMap: YAMLMap | undefined, context: string, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const declaredFiles = new Set<string>();
    for (const item of filesMap?.items ?? []) {
        if (item.key instanceof Scalar) declaredFiles.add(String(item.key.value));
    }

    for (const item of copyMap.items) {
        const key = item.key;
        if (!(key instanceof Scalar)) continue;
        const name = String(key.value);
        const range = nodeRange(key, lineCounter, document);

        if (!isLocalRelativePath(name)) {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `${context}: copy destination "${name}" must be a relative path that stays inside the fixture directory`, vscode.DiagnosticSeverity.Error));
            continue;
        }
        // A non-string source still decodes (5 becomes "5"); only a blank or
        // absent one is rejected
        const source = item.value;
        const sourceText = source instanceof Scalar && source.value !== null ? String(source.value) : '';
        if (sourceText.trim() === '') {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `${context}: copy destination "${name}" must name a non-empty source path`, vscode.DiagnosticSeverity.Error));
            continue;
        }
        if (declaredFiles.has(name)) {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `${context}: "${name}" is declared under both files and copy`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateFixtureNames(filesMap: YAMLMap, kind: 'input' | 'output' | 'shared', lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const dir = kind === 'shared' ? 'shared' : 'test';
    for (const item of filesMap.items) {
        const key = item.key;
        if (!(key instanceof Scalar)) continue;
        const name = String(key.value);
        if (!isLocalRelativePath(name)) {
            const range = nodeRange(key, lineCounter, document);
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `${kind} file name "${name}" must be a relative path that stays inside the ${dir} directory`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateOutputs(outputs: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['stdout', 'stderr', '!stdout', '!stderr', 'files', '!files', 'snapshot', 'json_output']);
    const outputCheckKeys = new Set(['stdout', 'stderr', '!stdout', '!stderr']);

    for (const item of outputs.items) {
        const key = item.key;
        if (!(key instanceof Scalar)) continue;

        const keyStr = key.value as string;
        if (!validKeys.has(keyStr)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown outputs property "${keyStr}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
        }

        // Validate stdout/stderr/!stdout/!stderr shape
        if (outputCheckKeys.has(keyStr) && item.value) {
            validateOutputCheck(item.value, lineCounter, document, diagnostics);
        }

        // Validate files and !files maps
        if ((keyStr === 'files' || keyStr === '!files') && item.value && isMap(item.value)) {
            const filesMap = item.value as YAMLMap;
            validateFixtureNames(filesMap, 'output', lineCounter, document, diagnostics);
            for (const fileItem of filesMap.items) {
                if (fileItem.value && isMap(fileItem.value)) {
                    validateFileCheck(fileItem.value as YAMLMap, lineCounter, document, diagnostics);
                }
            }
        }

        // Validate the snapshot (golden-file) assertion shape
        if (keyStr === 'snapshot' && item.value) {
            validateSnapshot(item.value, lineCounter, document, diagnostics);
        }
    }
}

// Mirrors the CLI's SnapshotCheck.UnmarshalYAML: a scalar boolean (true
// snapshots stdout; false is the documented toggle-off, same as omitting the
// key, and so is an explicit null) or a mapping of stream names (stdout,
// stderr) to booleans, of which at least one must be true. An alias at the
// snapshot key itself is left to the CLI (it resolves them; the walker
// cannot); alias VALUES inside the mapping are flagged, because the CLI's
// manual mapping walk rejects them the same way.
function validateSnapshot(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    if (node instanceof Scalar) {
        // An explicit null is the same as an absent key, like the CLI
        if (isNullScalar(node)) return;
        if (scalarBoolValue(node) === undefined) {
            const range = nodeRange(node, lineCounter, document);
            // Mirrors the CLI's parse error (only true/false resolve to a
            // boolean: a quoted "true" and the YAML 1.1 spellings yes/on/off
            // are plain strings to yaml-fixed)
            diagnostics.push(new vscode.Diagnostic(range, 'snapshot: must be true, false, or a mapping of stream booleans (stdout, stderr)', vscode.DiagnosticSeverity.Error));
        }
        return;
    }

    if (isMap(node)) {
        const seen = new Set<string>();
        let enabled = false;
        let errored = false;
        for (const pair of node.items) {
            const key = pair.key;
            if (!(key instanceof Scalar)) continue;
            const keyStr = String(key.value);
            if (keyStr !== 'stdout' && keyStr !== 'stderr') {
                const range = nodeRange(key, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `snapshot: unknown key "${keyStr}" (allowed: stdout, stderr)`, vscode.DiagnosticSeverity.Error));
                errored = true;
                continue;
            }
            if (seen.has(keyStr)) {
                const range = nodeRange(key, lineCounter, document);
                // Mirrors the CLI's parse error (the yaml parser reports the
                // duplicate mapping key as its own diagnostic too)
                diagnostics.push(new vscode.Diagnostic(range, `snapshot: ${keyStr} declared more than once`, vscode.DiagnosticSeverity.Error));
                errored = true;
                continue;
            }
            seen.add(keyStr);
            const value = pair.value;
            // A missing value (`stdout:`) decodes to false, like the CLI
            const streamOn = value == null ? false : value instanceof Scalar ? scalarBoolValue(value) : undefined;
            if (streamOn === undefined) {
                const range = nodeRange(value ?? key, lineCounter, document);
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `snapshot: ${keyStr} must be a boolean`, vscode.DiagnosticSeverity.Error));
                errored = true;
                continue;
            }
            if (streamOn) enabled = true;
        }
        // The CLI reports its first error and stops, so its enables-nothing
        // check is only reached when every entry was accepted
        if (!errored && !enabled) {
            const range = nodeRange(node, lineCounter, document);
            // Mirrors the CLI's parse error (empty and all-false mappings)
            diagnostics.push(new vscode.Diagnostic(range, 'snapshot: must enable at least one of stdout, stderr', vscode.DiagnosticSeverity.Error));
        }
        return;
    }

    if (isSeq(node)) {
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, 'snapshot: must be true, false, or a mapping of stream booleans (stdout, stderr)', vscode.DiagnosticSeverity.Error));
    }
}

function validateOutputCheck(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    if (isSeq(node)) {
        // List form: literal substring patterns
        for (const el of node.items) {
            if (!(el instanceof Scalar) || typeof el.value !== 'string') {
                const range = nodeRange(el, lineCounter, document);
                diagnostics.push(new vscode.Diagnostic(range, 'Output check patterns must be strings', vscode.DiagnosticSeverity.Error));
            }
        }
        return;
    }

    if (isMap(node)) {
        // Map form: 0-indexed line number to regex
        const seenLines = new Set<number>();
        for (const pair of node.items) {
            const key = pair.key;
            if (key instanceof Scalar) {
                const kv = key.value;
                const isInteger =
                    (typeof kv === 'number' && Number.isInteger(kv)) ||
                    (typeof kv === 'string' && /^-?[0-9]+$/.test(kv));
                if (!isInteger) {
                    const range = nodeRange(key, lineCounter, document);
                    // Mirrors the CLI's parse error
                    diagnostics.push(new vscode.Diagnostic(range, `line check key must be an integer, got "${kv}"`, vscode.DiagnosticSeverity.Error));
                } else if (Number(kv) < 0) {
                    const range = nodeRange(key, lineCounter, document);
                    // Mirrors the CLI's parse error
                    diagnostics.push(new vscode.Diagnostic(range, `line number must be >= 0, got ${Number(kv)}`, vscode.DiagnosticSeverity.Error));
                } else if (seenLines.has(Number(kv))) {
                    const range = nodeRange(key, lineCounter, document);
                    // Mirrors the CLI's parse error (bare 0 and quoted "0" collide)
                    diagnostics.push(new vscode.Diagnostic(range, `duplicate line number ${Number(kv)} in output check`, vscode.DiagnosticSeverity.Error));
                } else {
                    seenLines.add(Number(kv));
                }
            }
            const value = pair.value;
            if (value && (!(value instanceof Scalar) || typeof value.value !== 'string')) {
                const range = nodeRange(value, lineCounter, document);
                diagnostics.push(new vscode.Diagnostic(range, 'Line check values must be regex strings', vscode.DiagnosticSeverity.Error));
            }
        }
        return;
    }

    if (node instanceof Scalar) {
        // `stdout:` with no value is accepted by the CLI (no checks); anything
        // else scalar is a hard parse error there.
        if (node.value === null) return;
        const range = nodeRange(node, lineCounter, document);
        // Mirrors the CLI's parse error
        diagnostics.push(new vscode.Diagnostic(range, 'output check must be a list of patterns or map of line checks', vscode.DiagnosticSeverity.Error));
    }
}

function validateFileCheck(fileCheck: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['exists', 'match', 'notMatch']);

    for (const item of fileCheck.items) {
        const key = item.key;
        if (!(key instanceof Scalar)) continue;
        if (!validKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown file check property "${key.value}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
            continue;
        }
        // The CLI decodes exists into a *bool and reports a generic decode
        // error ("cannot decode string into bool") for anything else; an
        // absent value is false, as it is there.
        if (key.value === 'exists' && item.value instanceof Scalar && !isNullScalar(item.value) && scalarBoolValue(item.value) === undefined) {
            const range = nodeRange(item.value, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, '"exists" must be a boolean (dats will refuse to run this file)', vscode.DiagnosticSeverity.Error));
        }
    }
}

// The parser counts lines in the normalized text, so its columns are the
// normalized ones. Wrapping linePos (nodeRange's only use of the counter) puts
// every range back on the source columns without threading the mapper through
// every validate* signature.
function sourceLineCounter(counter: LineCounter, source: DialectSource): LineCounter {
    return {
        ...counter,
        linePos: (offset: number) => {
            const pos = counter.linePos(offset);
            return { line: pos.line, col: source.toSourceCol(pos.line - 1, pos.col - 1) + 1 };
        },
    } as LineCounter;
}

function nodeRange(node: any, lineCounter: LineCounter, document: vscode.TextDocument): vscode.Range {
    if (node?.range) {
        const start = lineCounter.linePos(node.range[0]);
        const end = lineCounter.linePos(node.range[1]);
        return new vscode.Range(start.line - 1, start.col - 1, end.line - 1, end.col - 1);
    }
    return new vscode.Range(0, 0, 0, 1);
}
