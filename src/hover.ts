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
        summary: 'Expected exit code',
        detail: 'Integer (0-255) or EXIT_* variable name (e.g., EXIT_SUCCESS, EXIT_FAILURE).'
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
        detail: 'Under inputs: Map of filename to content. Under outputs: Map of filename to file checks.'
    },
    outputs: {
        summary: 'Output validations',
        detail: 'Define assertions for stdout, stderr, and output files.'
    },
    stdout: {
        summary: 'Standard output assertions',
        detail: 'Array of regex patterns to match in stdout, or map of line numbers to patterns.'
    },
    stderr: {
        summary: 'Standard error assertions',
        detail: 'Array of regex patterns to match in stderr, or map of line numbers to patterns.'
    },
    '!stdout': {
        summary: 'Negative stdout assertions',
        detail: 'Regex patterns that must NOT appear in stdout.'
    },
    '!stderr': {
        summary: 'Negative stderr assertions',
        detail: 'Regex patterns that must NOT appear in stderr.'
    },
    '!files': {
        summary: 'Negative file assertions',
        detail: 'Map of filenames to checks that should fail or not exist.'
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
        const isKey = afterWord.match(/^\s*:/) && beforeWord.match(/^[\s-]*$/);

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
