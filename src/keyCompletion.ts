import * as vscode from 'vscode';
import { parseDocument, isMap, isSeq, YAMLMap, LineCounter, Pair, Scalar } from 'yaml';

interface KeyDef {
    key: string;
    description: string;
    insertText?: string;
    isSnippet?: boolean;
}

const ROOT_KEYS: KeyDef[] = [
    { key: 'tests', description: 'Array of test cases', insertText: 'tests:\n  - ' }
];

const ROOT_SNIPPETS: KeyDef[] = [
    {
        key: 'dats',
        description: 'Create a new DATS test file',
        insertText: 'tests:\n  - desc: ${1:test description}\n    exit: ${2:0}\n    cmd: ${3:echo hello}\n    outputs:\n      stdout:\n        - "${4:expected output}"',
        isSnippet: true
    }
];

const TEST_KEYS: KeyDef[] = [
    { key: 'desc', description: 'Test description (optional)' },
    { key: 'exit', description: 'Expected exit code (0-255 or EXIT_*)' },
    { key: 'cmd', description: 'Command to execute' },
    { key: 'inputs', description: 'Input configuration', insertText: 'inputs:\n      ' },
    { key: 'outputs', description: 'Output validations', insertText: 'outputs:\n      ' }
];

const INPUTS_KEYS: KeyDef[] = [
    { key: 'stdin', description: 'Standard input content' },
    { key: 'files', description: 'Input files to create', insertText: 'files:\n        ' }
];

const TESTS_ARRAY_SNIPPETS: KeyDef[] = [
    {
        key: 'test',
        description: 'Add a new test case',
        insertText: '- desc: ${1:test description}\n  exit: ${2:0}\n  cmd: ${3:command}\n  outputs:\n    stdout:\n      - "${4:expected}"',
        isSnippet: true
    },
    {
        key: 'test-input',
        description: 'Add a test with input file',
        insertText: '- desc: ${1:test description}\n  exit: ${2:0}\n  inputs:\n    ${3:input.txt}: |\n      ${4:file content}\n  cmd: ${5:cat} {inputs.$3}\n  outputs:\n    stdout:\n      - "${6:expected}"',
        isSnippet: true
    },
    {
        key: 'test-stdin',
        description: 'Add a test with stdin',
        insertText: '- desc: ${1:test description}\n  exit: ${2:0}\n  stdin: "${3:input data}"\n  cmd: ${4:cat}\n  outputs:\n    stdout:\n      - "${5:expected}"',
        isSnippet: true
    }
];

const OUTPUT_KEYS: KeyDef[] = [
    { key: 'stdout', description: 'Regex patterns to match in stdout', insertText: 'stdout:\n        - ' },
    { key: 'stderr', description: 'Regex patterns to match in stderr', insertText: 'stderr:\n        - ' },
    { key: '!stdout', description: 'Regex patterns that must NOT appear in stdout', insertText: '"!stdout":\n        - ' },
    { key: '!stderr', description: 'Regex patterns that must NOT appear in stderr', insertText: '"!stderr":\n        - ' },
    { key: 'files', description: 'Output files to validate', insertText: 'files:\n        ' },
    { key: '!files', description: 'Negative output file assertions', insertText: '"!files":\n        ' }
];

const FILE_CHECK_KEYS: KeyDef[] = [
    { key: 'exists', description: 'File existence check (true/false)' },
    { key: 'match', description: 'Regex patterns that must match in file', insertText: 'match:\n          - ' },
    { key: 'notMatch', description: 'Regex patterns that must NOT match in file', insertText: 'notMatch:\n          - ' }
];

type Context = {
    type: 'root' | 'tests-array' | 'test' | 'inputs' | 'outputs' | 'file-check' | 'unknown';
    existingKeys: Set<string>;
};

export class DatsKeyCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] | undefined {
        const lineText = document.lineAt(position).text;
        const textBeforeCursor = lineText.substring(0, position.character);

        // Only provide completions at the start of a line (after whitespace/dash)
        if (!this.isKeyPosition(textBeforeCursor)) {
            return undefined;
        }

        const context = this.determineContext(document, position);

        let availableKeys: KeyDef[] = [];
        let availableSnippets: KeyDef[] = [];

        switch (context.type) {
            case 'root':
                availableKeys = ROOT_KEYS;
                availableSnippets = ROOT_SNIPPETS;
                break;
            case 'tests-array':
                availableSnippets = TESTS_ARRAY_SNIPPETS;
                break;
            case 'test':
                availableKeys = TEST_KEYS;
                break;
            case 'inputs':
                availableKeys = INPUTS_KEYS;
                break;
            case 'outputs':
                availableKeys = OUTPUT_KEYS;
                break;
            case 'file-check':
                availableKeys = FILE_CHECK_KEYS;
                break;
            default:
                return undefined;
        }

        // Filter out keys that already exist
        const filteredKeys = availableKeys.filter(k => !context.existingKeys.has(k.key));

        const completions: vscode.CompletionItem[] = [];

        // Add key completions
        for (const keyDef of filteredKeys) {
            const item = new vscode.CompletionItem(keyDef.key, vscode.CompletionItemKind.Property);
            item.detail = keyDef.description;
            item.insertText = keyDef.insertText || `${keyDef.key}: `;
            item.sortText = '!' + keyDef.key; // Sort before other suggestions
            item.preselect = filteredKeys.length === 1 && availableSnippets.length === 0;
            completions.push(item);
        }

        // Add snippet completions
        for (const snippetDef of availableSnippets) {
            const item = new vscode.CompletionItem(snippetDef.key, vscode.CompletionItemKind.Snippet);
            item.detail = snippetDef.description;
            item.insertText = new vscode.SnippetString(snippetDef.insertText!);
            item.sortText = '~' + snippetDef.key; // Sort after keys
            completions.push(item);
        }

        return completions;
    }

    private isKeyPosition(textBeforeCursor: string): boolean {
        // Key position: start of line, after whitespace, or after "- "
        return /^(\s*-?\s*)$/.test(textBeforeCursor) || /^(\s*-?\s*)[a-zA-Z!]*$/.test(textBeforeCursor);
    }

    private determineContext(document: vscode.TextDocument, position: vscode.Position): Context {
        const text = document.getText();
        const lineCounter = new LineCounter();
        const offset = document.offsetAt(position);

        let doc;
        try {
            doc = parseDocument(text, { lineCounter, keepSourceTokens: true });
        } catch {
            return { type: 'unknown', existingKeys: new Set() };
        }

        const root = doc.contents;
        if (!isMap(root)) {
            return { type: 'root', existingKeys: new Set() };
        }

        // Check if we're at root level (before or outside tests)
        const testsNode = root.get('tests', true);
        if (!testsNode || !isSeq(testsNode)) {
            return { type: 'root', existingKeys: this.getMapKeys(root) };
        }

        // Check if cursor is before tests array content
        if (testsNode.range && offset < testsNode.range[0]) {
            return { type: 'root', existingKeys: this.getMapKeys(root) };
        }

        // Find which test item we're in
        for (let i = 0; i < testsNode.items.length; i++) {
            const testItem = testsNode.items[i];
            if (!isMap(testItem)) continue;

            const testMap = testItem as YAMLMap;
            const range = testMap.range;
            if (!range) continue;

            // Check if cursor is within this test item's range
            // We need to also check if we're between this item and the next
            const nextItem = testsNode.items[i + 1];
            const nextStart = nextItem && isMap(nextItem) && (nextItem as YAMLMap).range
                ? (nextItem as YAMLMap).range![0]
                : Infinity;

            if (offset >= range[0] && offset < nextStart) {
                // We're in this test - now determine if we're at test level, outputs level, etc.
                return this.determineTestContext(testMap, offset, lineCounter);
            }
        }

        // We're in the tests array but not in a specific test item (e.g., adding a new test)
        return { type: 'tests-array', existingKeys: new Set() };
    }

    private determineTestContext(testMap: YAMLMap, offset: number, _lineCounter: LineCounter): Context {
        // Check if we're inside outputs
        const outputsNode = testMap.get('outputs', true);
        if (outputsNode && isMap(outputsNode)) {
            const outputsMap = outputsNode as YAMLMap;
            if (outputsMap.range && offset >= outputsMap.range[0] && offset <= outputsMap.range[1]) {
                // Check if we're inside files or !files map
                for (const item of outputsMap.items) {
                    if (!(item instanceof Pair)) continue;
                    const key = item.key;
                    if (!(key instanceof Scalar)) continue;
                    const keyStr = String(key.value);

                    // Check if we're inside files or !files
                    if (keyStr === 'files' || keyStr === '!files') {
                        const filesMap = item.value;
                        if (filesMap && isMap(filesMap)) {
                            const fm = filesMap as YAMLMap;
                            if (fm.range && offset >= fm.range[0] && offset <= fm.range[1]) {
                                // Check if we're inside a specific file check
                                for (const fileItem of fm.items) {
                                    if (!(fileItem instanceof Pair)) continue;
                                    const fileValue = fileItem.value;
                                    if (fileValue && isMap(fileValue)) {
                                        const fileCheckMap = fileValue as YAMLMap;
                                        if (fileCheckMap.range && offset >= fileCheckMap.range[0] && offset <= fileCheckMap.range[1]) {
                                            return { type: 'file-check', existingKeys: this.getMapKeys(fileCheckMap) };
                                        }
                                    }
                                }
                                // We're in files/!files but not inside a specific file check
                                return { type: 'unknown', existingKeys: new Set() };
                            }
                        }
                    }
                }

                return { type: 'outputs', existingKeys: this.getMapKeys(outputsMap) };
            }
        }

        // Check if we're inside inputs
        const inputsNode = testMap.get('inputs', true);
        if (inputsNode && isMap(inputsNode)) {
            const inputsMap = inputsNode as YAMLMap;
            if (inputsMap.range && offset >= inputsMap.range[0] && offset <= inputsMap.range[1]) {
                // Check if we're inside the files map
                const filesNode = inputsMap.get('files', true);
                if (filesNode && isMap(filesNode)) {
                    const filesMap = filesNode as YAMLMap;
                    if (filesMap.range && offset >= filesMap.range[0] && offset <= filesMap.range[1]) {
                        // We're inside inputs/files - no key suggestions (user defines filenames)
                        return { type: 'unknown', existingKeys: new Set() };
                    }
                }
                // We're in inputs but not in files
                return { type: 'inputs', existingKeys: this.getMapKeys(inputsMap) };
            }
        }

        // We're at the test level
        return { type: 'test', existingKeys: this.getMapKeys(testMap) };
    }

    private getMapKeys(map: YAMLMap): Set<string> {
        const keys = new Set<string>();
        for (const item of map.items) {
            if (item instanceof Pair && item.key instanceof Scalar) {
                keys.add(String(item.key.value));
            }
        }
        return keys;
    }
}
