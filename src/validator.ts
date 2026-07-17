import * as vscode from 'vscode';
import { parseDocument, isMap, isSeq, Scalar, YAMLMap, LineCounter } from 'yaml';

// The dats runner resolves only these two exit code names; any other EXIT_*
// string is rejected at parse time.
const EXIT_VAR_PATTERN = /^EXIT_(SUCCESS|FAILURE)$/;
// Go time.ParseDuration syntax (dats rejects negative timeouts, so no leading minus):
// optional +, then "0" or one or more <decimal number><unit> groups.
const GO_DURATION_PATTERN = /^\+?(0|((\d+(\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h))+)$/;

const UNKNOWN_KEY_SUFFIX = ' (dats will refuse to run this file)';
// A bare or quoted integer: accepted for exit (0-255) and timeout (seconds).
const INTEGER_PATTERN = /^[-+]?[0-9]+$/;
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

export function validateDatsDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const lineCounter = new LineCounter();

    // parseDocument does not throw on malformed input; it reports via doc.errors
    const doc = parseDocument(text, { lineCounter });

    // Check for YAML parse errors
    for (const error of doc.errors) {
        const pos = error.linePos?.[0];
        if (pos) {
            const range = new vscode.Range(pos.line - 1, pos.col - 1, pos.line - 1, pos.col + 10);
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

    // Check for unknown top-level keys
    for (const item of root.items) {
        const key = item.key;
        if (key instanceof Scalar && key.value !== 'tests') {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown property "${key.value}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
        }
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
    for (const testNode of testsNode.items) {
        if (!isMap(testNode)) {
            const range = nodeRange(testNode, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, 'Each test must be a mapping', vscode.DiagnosticSeverity.Error));
            continue;
        }

        validateTest(testNode as YAMLMap, lineCounter, document, diagnostics);
    }

    return diagnostics;
}

function validateTest(test: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['desc', 'exit', 'cmd', 'timeout', 'inputs', 'outputs']);

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
        validateInputs(inputsNode as YAMLMap, lineCounter, document, diagnostics);
    }

    // Validate outputs if present
    const outputsNode = test.get('outputs', true);
    if (outputsNode && isMap(outputsNode)) {
        validateOutputs(outputsNode as YAMLMap, lineCounter, document, diagnostics);
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

function validateTimeout(node: any, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    if (!(node instanceof Scalar)) return;

    const value = node.value;
    const range = nodeRange(node, lineCounter, document);

    if (typeof value === 'number') {
        const raw = scalarSource(node);
        if (!Number.isInteger(value) || FLOAT_SOURCE_PATTERN.test(raw)) {
            // Mirrors the CLI's parse error: floats are rejected, not truncated
            // (fractional seconds are written as a duration string instead)
            diagnostics.push(new vscode.Diagnostic(range, `timeout must be an integer number of seconds or a duration string (e.g. "900ms", "1.5s"), got float ${raw}`, vscode.DiagnosticSeverity.Error));
        } else if (value < 0) {
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `timeout ${value} must not be negative`, vscode.DiagnosticSeverity.Error));
        }
    } else if (typeof value === 'string') {
        if (INTEGER_PATTERN.test(value)) {
            // A quoted bare integer (e.g. "5") means seconds, like the unquoted form
            const intVal = parseInt(value, 10);
            if (intVal < 0) {
                // Mirrors the CLI's parse error
                diagnostics.push(new vscode.Diagnostic(range, `timeout ${intVal} must not be negative`, vscode.DiagnosticSeverity.Error));
            }
        } else if (!GO_DURATION_PATTERN.test(value)) {
            diagnostics.push(new vscode.Diagnostic(range, `Timeout "${value}" must be a non-negative integer number of seconds or a Go duration string (e.g. "500ms", "1m30s")`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateInputs(inputs: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['stdin', 'files', 'env']);

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

function validateFixtureNames(filesMap: YAMLMap, kind: 'input' | 'output', lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    for (const item of filesMap.items) {
        const key = item.key;
        if (!(key instanceof Scalar)) continue;
        const name = String(key.value);
        if (!isLocalRelativePath(name)) {
            const range = nodeRange(key, lineCounter, document);
            // Mirrors the CLI's parse error
            diagnostics.push(new vscode.Diagnostic(range, `${kind} file name "${name}" must be a relative path that stays inside the test directory`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateOutputs(outputs: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['stdout', 'stderr', '!stdout', '!stderr', 'files', '!files', 'json_output']);
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
        if (key instanceof Scalar && !validKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown file check property "${key.value}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function nodeRange(node: any, lineCounter: LineCounter, document: vscode.TextDocument): vscode.Range {
    if (node.range) {
        const start = lineCounter.linePos(node.range[0]);
        const end = lineCounter.linePos(node.range[1]);
        return new vscode.Range(start.line - 1, start.col - 1, end.line - 1, end.col - 1);
    }
    return new vscode.Range(0, 0, 0, 1);
}
