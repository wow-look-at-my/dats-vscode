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
    snapshot: {
        summary: 'Golden-file (snapshot) assertion for output streams',
        detail: 'true snapshots stdout; or a map of stream booleans (stdout / stderr), of which at least one must be true; false or omitted disables. Captured output must byte-match `<file>.snapshots/NNN-<slug>.<stream>.golden` next to the .dats file (NNN = zero-padded instance number, slug from the instance name), after temp paths are normalized to {testdir}/{shareddir}/{tmproot} tokens. Run the dats CLI with --update to (re)write goldens from actual output and prune stale ones.'
    },
    json_output: {
        summary: 'Expected JSON value of the whole stdout',
        detail: 'Stdout must parse as a single JSON value that deep-equals this value: object keys are order-insensitive, array elements are order-sensitive, numbers compare by value. Any JSON value is allowed, including null.'
    },
    shared: {
        summary: 'File-level fixtures, materialized once per file',
        detail: 'files: map of name to content, and/or copy: map of name to a host file to copy in. Both land in the shared directory, addressed as {shared.name}, before setup runs. At least one entry across the two is required, and a name may appear in only one of them. {matrix.X} cannot be used here -- no test instance exists yet.'
    },
    setup: {
        summary: 'Commands run once before the file tests',
        detail: 'A command string, or a list of entries -- each a command string or a mapping of cmd plus optional env, stdin_file and timeout (default 30s, must be greater than 0). A failure fails every test in the file; teardown still runs. Only {shared.X} expands here, and {matrix.X} is rejected.'
    },
    teardown: {
        summary: 'Commands run once after the file tests',
        detail: 'Same form as setup. Always runs -- after failures, and even after setup failed -- and one failing entry does not stop the rest. Any failure marks the file failed even when every test passed.'
    },
    sandbox: {
        summary: 'File-level sandbox control',
        detail: 'false opts this file commands (tests AND hooks) out of the sandbox; true is the explicit opt-in. Or a mapping of enabled / network / image, which can only narrow what the CLI already allows: under --no-sandbox the block is inert. There is deliberately no way to declare extra writable host paths -- scratch space goes in the test temp directory.'
    },
    enabled: {
        summary: 'Whether this file commands are sandboxed',
        detail: 'Boolean. Unstated means yes (the CLI decides whether a sandbox is used at all; this only narrows it).'
    },
    network: {
        summary: 'Whether sandboxed commands keep network access',
        detail: 'Boolean. Unstated means yes -- cutting the network is a declared choice, never inherited by accident.'
    },
    image: {
        summary: 'Container image for the docker sandbox backend',
        detail: 'Non-empty string, used only by the docker backend (it has no effect under bwrap or seatbelt). {matrix.X} is rejected: the sandbox is resolved once per file, before any instance exists.'
    },
    copy: {
        summary: 'Host files copied into the fixture directory, writable',
        detail: 'Map of fixture name to a host source path, resolved relative to the .dats file directory. The read-write counterpart of the sandbox read-only mount of the working directory; permission bits are preserved. Names follow the same locality rule as files, and a name may not appear under both.'
    },
    stdin_file: {
        summary: 'File piped to a hook command stdin',
        detail: 'Non-empty path, resolved like a copy source (relative to the .dats file directory). Its raw content is piped to the command.'
    },
    matrix: {
        summary: 'Parameter variables that expand the test into instances',
        detail: 'Map of variable name to a list of scalar values. The test expands into one instance per combination (cartesian product, declaration order, last variable varying fastest), each reported as `desc [k=v, ...]`. {matrix.X} substitutes into desc, cmd, stdin, file contents, copy sources, env values and output patterns.'
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
        // Negated keys are written bare (!stdout) but the quoted spelling still
        // parses, so allow a quote on either side of the word.
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
