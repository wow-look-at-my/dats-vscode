import { describe, it, expect, vi } from 'vitest';

// hover.ts constructs vscode.MarkdownString and vscode.Hover, and reads
// document.lineAt / getWordRangeAtPosition / getText - mock just those.
vi.mock('vscode', () => {
    class MarkdownString {
        value = '';
        appendMarkdown(s: string) {
            this.value += s;
            return this;
        }
    }
    class Hover {
        constructor(
            public contents: MarkdownString,
            public range?: unknown
        ) {}
    }
    return { MarkdownString, Hover };
});

import { DatsHoverProvider } from './hover';

interface Pos {
    line: number;
    character: number;
}

/** Minimal TextDocument implementing what DatsHoverProvider uses. */
function docFrom(lines: string[]) {
    return {
        lineAt: (position: Pos) => ({ text: lines[position.line] }),
        getWordRangeAtPosition: (position: Pos, regex: RegExp) => {
            const line = lines[position.line];
            const global = new RegExp(regex.source, 'g');
            let m: RegExpExecArray | null;
            while ((m = global.exec(line)) !== null) {
                if (m.index <= position.character && position.character <= m.index + m[0].length) {
                    return {
                        start: { line: position.line, character: m.index },
                        end: { line: position.line, character: m.index + m[0].length },
                    };
                }
                if (m.index > position.character) break;
            }
            return undefined;
        },
        getText: (range: { start: Pos; end: Pos }) =>
            lines[range.start.line].substring(range.start.character, range.end.character),
    } as any;
}

const provider = new DatsHoverProvider();

function hoverText(lines: string[], line: number, character: number): string | undefined {
    const hover = provider.provideHover(docFrom(lines), { line, character } as any, {} as any);
    return hover ? (hover.contents as any).value : undefined;
}

describe('DatsHoverProvider', () => {
    it('shows docs for plain keys', () => {
        const text = hoverText(['tests:', '  - cmd: echo hi'], 1, 5);
        expect(text).toContain('**cmd**');
        expect(text).toContain('Command to execute');
    });

    it('shows docs for quoted "!stdout", "!stderr" and "!files" keys', () => {
        const lines = [
            '    outputs:',
            '      "!stdout":',
            '        - "error"',
            '      "!stderr":',
            '        - "fatal"',
            '      "!files":',
            '        junk.txt:',
            '          exists: true',
        ];
        const stdoutText = hoverText(lines, 1, 9);
        expect(stdoutText).toContain('**!stdout**');
        expect(stdoutText).toContain('must NOT appear in stdout');

        const stderrText = hoverText(lines, 3, 9);
        expect(stderrText).toContain('**!stderr**');

        const filesText = hoverText(lines, 5, 9);
        expect(filesText).toContain('**!files**');
        expect(filesText).toContain('must NOT exist');
    });

    it('shows docs for bare !stdout, !stderr and !files keys', () => {
        const lines = ['\t  outputs:', '\t\t!stdout:', '\t\t\t- "error"', '\t\t!stderr:', '\t\t\t- "fatal"', '\t\t!files:', '\t\t\tjunk.txt:'];
        expect(hoverText(lines, 1, 4)).toContain('**!stdout**');
        expect(hoverText(lines, 3, 4)).toContain('**!stderr**');
        expect(hoverText(lines, 5, 4)).toContain('**!files**');
    });

    it('describes pattern lists as literal substrings, not regexes', () => {
        const text = hoverText(['      stdout:'], 0, 8);
        expect(text).toContain('literal substrings');
        expect(text).toContain('not regexes');
        // the map form IS regex - both facts should be present
        expect(text).toContain('regex');
    });

    it('documents timeout', () => {
        const text = hoverText(['    timeout: 2s'], 0, 6);
        expect(text).toContain('**timeout**');
        expect(text).toContain('Go duration string');
        expect(text).toContain('500ms');
    });

    it('documents json_output', () => {
        const text = hoverText(['      json_output: 2'], 0, 9);
        expect(text).toContain('**json_output**');
        expect(text).toContain('deep-equals');
    });

    it('documents snapshot', () => {
        const text = hoverText(['      snapshot: true'], 0, 9);
        expect(text).toContain('**snapshot**');
        expect(text).toContain('.snapshots/');
        expect(text).toContain('--update');
        expect(text).toContain('{testdir}');
    });

    it('names exactly the two recognized exit code names', () => {
        const text = hoverText(['    exit: 1'], 0, 5);
        expect(text).toContain('EXIT_SUCCESS');
        expect(text).toContain('EXIT_FAILURE');
        expect(text).not.toContain('EXIT_*');
    });

    it('does not fire on words inside values', () => {
        expect(hoverText(['    desc: cmd runner test'], 0, 11)).toBeUndefined();
        expect(hoverText(['        - "stdout"'], 0, 12)).toBeUndefined();
    });

    it('does not fire on unknown keys', () => {
        expect(hoverText(['    bogus: 1'], 0, 6)).toBeUndefined();
    });

    it('fires for keys on sequence item lines', () => {
        const text = hoverText(['  - desc: my test'], 0, 5);
        expect(text).toContain('**desc**');
    });
});

describe('file-level and fixture keys', () => {
    it('documents the file-level blocks', () => {
        expect(hoverText(['sandbox:'], 0, 2)).toContain('**sandbox**');
        expect(hoverText(['sandbox:'], 0, 2)).toContain('opts this file commands');
        expect(hoverText(['shared:'], 0, 2)).toContain('**shared**');
        expect(hoverText(['setup:'], 0, 2)).toContain('**setup**');
        expect(hoverText(['teardown:'], 0, 2)).toContain('**teardown**');
    });

    it('documents the sandbox mapping keys', () => {
        expect(hoverText(['\tenabled: true'], 0, 3)).toContain('**enabled**');
        expect(hoverText(['\tnetwork: false'], 0, 3)).toContain('**network**');
        expect(hoverText(['\timage: alpine:3.20'], 0, 3)).toContain('**image**');
    });

    it('documents copy fixtures, stdin_file and matrix', () => {
        expect(hoverText(['\t\tcopy:'], 0, 3)).toContain('**copy**');
        expect(hoverText(['\t\tcopy:'], 0, 3)).toContain('writable');
        expect(hoverText(['\t  stdin_file: in.txt'], 0, 6)).toContain('**stdin_file**');
        expect(hoverText(['\t  matrix:'], 0, 5)).toContain('**matrix**');
    });
});
