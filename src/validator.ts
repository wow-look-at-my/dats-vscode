import * as vscode from 'vscode';
import { parseDocument, YAMLParseError, isMap, isSeq, Scalar, YAMLMap, YAMLSeq, LineCounter } from 'yaml';

const EXIT_VAR_PATTERN = /^EXIT_[A-Z_]+$/;

export function validateDatsDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const lineCounter = new LineCounter();

    let doc;
    try {
        doc = parseDocument(text, { lineCounter });
    } catch (e) {
        if (e instanceof YAMLParseError) {
            const pos = e.linePos?.[0];
            if (pos) {
                const range = new vscode.Range(pos.line - 1, pos.col - 1, pos.line - 1, pos.col);
                diagnostics.push(new vscode.Diagnostic(range, e.message, vscode.DiagnosticSeverity.Error));
            }
        }
        return diagnostics;
    }

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
        if (root) {
            const range = nodeRange(root, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, 'Document root must be a mapping', vscode.DiagnosticSeverity.Error));
        }
        return diagnostics;
    }

    // Check for unknown top-level keys
    for (const item of root.items) {
        const key = item.key;
        if (key instanceof Scalar && key.value !== 'tests') {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown property "${key.value}"`, vscode.DiagnosticSeverity.Warning));
        }
    }

    // Validate tests array
    const testsNode = root.get('tests', true);
    if (!testsNode) {
        return diagnostics;
    }

    if (!isSeq(testsNode)) {
        const range = nodeRange(testsNode, lineCounter, document);
        diagnostics.push(new vscode.Diagnostic(range, '"tests" must be an array', vscode.DiagnosticSeverity.Error));
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
    const validKeys = new Set(['desc', 'exit', 'cmd', 'inputs', 'outputs']);

    // Check for unknown keys
    for (const item of test.items) {
        const key = item.key;
        if (key instanceof Scalar && !validKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown property "${key.value}"`, vscode.DiagnosticSeverity.Warning));
        }
    }

    // cmd is required
    const cmdNode = test.get('cmd', true);
    if (!cmdNode) {
        const range = nodeRange(test, lineCounter, document);
        diagnostics.push(new vscode.Diagnostic(range, 'Test is missing required property "cmd"', vscode.DiagnosticSeverity.Error));
    }

    // Validate exit code
    const exitPair = test.items.find(item => item.key instanceof Scalar && item.key.value === 'exit');
    if (exitPair && exitPair.value) {
        validateExitCode(exitPair.value, lineCounter, document, diagnostics);
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
            diagnostics.push(new vscode.Diagnostic(range, `Exit code "${value}" must be an integer (0-255) or EXIT_* variable name`, vscode.DiagnosticSeverity.Error));
        }
    }
}

function validateInputs(inputs: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['stdin', 'files']);

    for (const item of inputs.items) {
        const key = item.key;
        if (key instanceof Scalar && !validKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown inputs property "${key.value}"`, vscode.DiagnosticSeverity.Warning));
        }
    }
}

function validateOutputs(outputs: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['stdout', 'stderr', '!stdout', '!stderr', 'files', '!files']);

    for (const item of outputs.items) {
        const key = item.key;
        if (!(key instanceof Scalar)) continue;

        const keyStr = key.value as string;
        if (!validKeys.has(keyStr)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown outputs property "${keyStr}"`, vscode.DiagnosticSeverity.Warning));
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

function validateFileCheck(fileCheck: YAMLMap, lineCounter: LineCounter, document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
    const validKeys = new Set(['exists', 'match', 'notMatch']);

    for (const item of fileCheck.items) {
        const key = item.key;
        if (key instanceof Scalar && !validKeys.has(key.value as string)) {
            const range = nodeRange(key, lineCounter, document);
            diagnostics.push(new vscode.Diagnostic(range, `Unknown file check property "${key.value}"`, vscode.DiagnosticSeverity.Warning));
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
