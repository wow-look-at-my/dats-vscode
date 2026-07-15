import * as vscode from 'vscode';
import { parseDocument, isMap, isSeq, Scalar, YAMLMap, LineCounter } from 'yaml';

// The dats runner resolves only these two exit code names; any other EXIT_*
// string is rejected at parse time.
const EXIT_VAR_PATTERN = /^EXIT_(SUCCESS|FAILURE)$/;
// Go time.ParseDuration syntax (dats rejects negative timeouts, so no leading minus):
// optional +, then "0" or one or more <decimal number><unit> groups.
const GO_DURATION_PATTERN = /^\+?(0|((\d+(\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h))+)$/;

const UNKNOWN_KEY_SUFFIX = ' (dats will refuse to run this file)';

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
        if (!Number.isInteger(value) || value < 0 || value > 255) {
            diagnostics.push(new vscode.Diagnostic(range, 'Exit code must be an integer between 0 and 255', vscode.DiagnosticSeverity.Error));
        }
    } else if (typeof value === 'string') {
        if (!EXIT_VAR_PATTERN.test(value)) {
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
        if (!Number.isInteger(value) || value < 0) {
            diagnostics.push(new vscode.Diagnostic(range, 'Timeout must be a non-negative integer number of seconds or a Go duration string (e.g. "500ms", "1m30s")', vscode.DiagnosticSeverity.Error));
        }
    } else if (typeof value === 'string') {
        if (!GO_DURATION_PATTERN.test(value)) {
            diagnostics.push(new vscode.Diagnostic(range, `Timeout "${value}" must be a non-negative integer number of seconds or a Go duration string (e.g. "500ms", "1m30s")`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateInputs(inputs: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['stdin', 'files']);

    for (const item of inputs.items) {
        const key = item.key;
        if (key instanceof Scalar && !validKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown inputs property "${key.value}"${UNKNOWN_KEY_SUFFIX}`, vscode.DiagnosticSeverity.Error));
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
                    diagnostics.push(new vscode.Diagnostic(range, 'Line check keys are 0-indexed line numbers and must not be negative', vscode.DiagnosticSeverity.Error));
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
