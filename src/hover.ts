import * as vscode from 'vscode';

const FIELD_DOCS: Record<string, { summary: string; detail?: string }> = {
    tests: {
        summary: 'Array of test cases',
        detail: 'Each test case defines a command to run and expected outcomes.'
    },
    desc: {
        summary: 'Test description (optional)',
        detail: 'Human-readable name for the test. If omitted, the command is used as the test name.'
    },
    exit: {
        summary: 'Expected exit code (0-255, bare or quoted) or exit code name (default 0)',
        detail: 'Integer 0-255 (bare or quoted, e.g. "3") or exit code name EXIT_SUCCESS / EXIT_FAILURE. Floats are parse errors.'
    },
    timeout: {
        summary: 'Per-test timeout (optional)',
        detail: 'Integer number of seconds (bare or quoted, e.g. "5"), or a Go duration string (e.g. "500ms", "2s", "1m30s"). 0 or omitted means no timeout. Floats are parse errors -- write "1.5s", not 1.5.'
    },
    cmd: {
        summary: 'Command to execute',
        detail: 'Shell command to run. Use {inputs.filename} and {outputs.filename} placeholders to reference files.'
    },
    inputs: {
        summary: 'Input configuration',
        detail: 'Contains stdin content and input files to create before the test runs.'
    },
    stdin: {
        summary: 'Standard input content',
        detail: 'String to pipe to the command\'s stdin.'
    },
    files: {
        summary: 'Files map',
        detail: 'Under inputs: Map of filename to content. Under outputs: Map of filename to file checks; an empty check ({} or nothing) asserts the file must exist. File names must be relative paths that stay inside the test directory (nested names like sub/file.txt are allowed).'
    },
    env: {
        summary: 'Per-test environment variables',
        detail: 'Map of environment variable name to value, ADDED to the inherited environment (in sorted key order). Values go through the same {inputs.X}/{outputs.X} placeholder expansion as cmd.'
    },
    outputs: {
        summary: 'Output validations',
        detail: 'Define assertions for stdout, stderr, and output files.'
    },
    stdout: {
        summary: 'Standard output assertions',
        detail: 'List form: literal substrings that must each appear in stdout (not regexes). Map form: 0-indexed line number to regex matched against that line.'
    },
    stderr: {
        summary: 'Standard error assertions',
        detail: 'List form: literal substrings that must each appear in stderr (not regexes). Map form: 0-indexed line number to regex matched against that line.'
    },
    '!stdout': {
        summary: 'Negative stdout assertions',
        detail: 'List form: literal substrings that must NOT appear in stdout (not regexes). Map form: 0-indexed line number to regex that must NOT match that line.'
    },
    '!stderr': {
        summary: 'Negative stderr assertions',
        detail: 'List form: literal substrings that must NOT appear in stderr (not regexes). Map form: 0-indexed line number to regex that must NOT match that line.'
    },
    '!files': {
        summary: 'Negative file assertions',
        detail: 'Map of filename to checks, each inverted: exists: true means the file must NOT exist, match patterns must NOT match the contents, and notMatch patterns MUST match. An empty check ({} or nothing) asserts the file must NOT exist.'
    },
    json_output: {
        summary: 'Expected JSON value of the whole stdout',
        detail: 'Stdout must parse as a single JSON value that deep-equals this value: object keys are order-insensitive, array elements are order-sensitive, numbers compare by value. Any JSON value is allowed, including null.'
    },
    exists: {
        summary: 'File existence check',
        detail: 'true to assert file exists, false to assert it does not exist.'
    },
    match: {
        summary: 'File content patterns',
        detail: 'Array of regex patterns that must match in the file.'
    },
    notMatch: {
        summary: 'Negative file content patterns',
        detail: 'Array of regex patterns that must NOT match in the file.'
    }
};

export class DatsHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover | undefined {
        const line = document.lineAt(position).text;
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_!][a-zA-Z0-9_]*/);

        if (!wordRange) return undefined;

        const word = document.getText(wordRange);

        // Check if this looks like a YAML key (followed by colon)
        const afterWord = line.substring(wordRange.end.character);
        const beforeWord = line.substring(0, wordRange.start.character);

        // Is this a key? (has colon after, and is at start of meaningful content)
        // Keys like "!stdout" must be quoted in YAML, so allow a closing quote
        // between the word and the colon, and an opening quote before the word.
        const isKey = afterWord.match(/^"?\s*:/) && beforeWord.match(/^[\s-]*"?$/);

        if (!isKey) return undefined;

        const docs = FIELD_DOCS[word];
        if (!docs) return undefined;

        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${word}**\n\n`);
        markdown.appendMarkdown(docs.summary);
        if (docs.detail) {
            markdown.appendMarkdown(`\n\n${docs.detail}`);
        }

        return new vscode.Hover(markdown, wordRange);
    }
}
