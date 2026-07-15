import { describe, it, expect, vi } from 'vitest';

// One mock serves both keyCompletion.ts (CompletionItem, SnippetString, Range,
// CompletionItemKind) and validator.ts (Range, Diagnostic, DiagnosticSeverity),
// which is imported to prove the snippets generate files the validator accepts.
vi.mock('vscode', () => {
    class Position {
        constructor(
            public line: number,
            public character: number
        ) {}
    }
    class Range {
        public start: Position;
        public end: Position;
        constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
            this.start = new Position(startLine, startCharacter);
            this.end = new Position(endLine, endCharacter);
        }
    }
    class CompletionItem {
        insertText?: unknown;
        detail?: string;
        sortText?: string;
        preselect?: boolean;
        range?: Range;
        constructor(
            public label: string,
            public kind?: number
        ) {}
    }
    class SnippetString {
        constructor(public value: string) {}
    }
    class Diagnostic {
        constructor(
            public range: Range,
            public message: string,
            public severity: number
        ) {}
    }
    const CompletionItemKind = { Variable: 5, Property: 9, Snippet: 14 };
    const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
    return { Position, Range, CompletionItem, SnippetString, CompletionItemKind, Diagnostic, DiagnosticSeverity };
});

import { SnippetString } from 'vscode';
import { DatsKeyCompletionProvider } from './keyCompletion';
import { validateDatsDocument } from './validator';

interface Pos {
    line: number;
    character: number;
}

/** Minimal TextDocument implementing what DatsKeyCompletionProvider uses. */
function docFrom(text: string) {
    const lines = text.split('\n');
    return {
        getText: () => text,
        lineAt: (position: Pos) => ({ text: lines[position.line] }),
        offsetAt: (position: Pos) => {
            let offset = 0;
            for (let i = 0; i < position.line; i++) offset += lines[i].length + 1;
            return offset + position.character;
        },
    } as any;
}

const provider = new DatsKeyCompletionProvider();

function complete(text: string, line: number, character: number) {
    return provider.provideCompletionItems(docFrom(text), { line, character } as any, {} as any, {} as any);
}

function insertTextOf(item: any): string {
    return item.insertText instanceof SnippetString ? item.insertText.value : item.insertText;
}

/** The provider always sets a plain Range (never {inserting, replacing}). */
function rangeOf(item: any): { start: Pos; end: Pos } {
    return item.range;
}

/** Expands ${n:default} and $n snippet placeholders to their default values. */
function expandSnippet(snippet: string): string {
    const defaults: Record<string, string> = {};
    return snippet
        .replace(/\$\{(\d+):([^}]*)\}/g, (_m, index, def) => {
            defaults[index] = def;
            return def;
        })
        .replace(/\$(\d+)/g, (_m, index) => defaults[index] ?? '');
}

/** Simulates accepting a snippet on a line indented by `indent` spaces: VS Code
 *  prepends the current line's indentation to every continuation line. */
function insertAtIndent(expanded: string, indent: number): string {
    const pad = ' '.repeat(indent);
    return expanded
        .split('\n')
        .map(line => pad + line)
        .join('\n');
}

describe('context-aware key completion', () => {
    it('offers test keys (including timeout) at test level, minus existing ones', () => {
        const text = 'tests:\n  - cmd: echo hi\n    \n';
        const items = complete(text, 2, 4)!;
        const labels = items.map(i => i.label);
        expect(labels).toContain('timeout');
        expect(labels).toContain('desc');
        expect(labels).toContain('exit');
        expect(labels).toContain('inputs');
        expect(labels).toContain('outputs');
        expect(labels).not.toContain('cmd'); // already present
    });

    it('offers output keys (including json_output) inside outputs', () => {
        const text = 'tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        - "x"\n';
        const items = complete(text, 3, 6)!;
        const labels = items.map(i => i.label);
        expect(labels).toContain('json_output');
        expect(labels).toContain('stderr');
        expect(labels).toContain('!stdout');
        expect(labels).toContain('!stderr');
        expect(labels).toContain('files');
        expect(labels).toContain('!files');
        expect(labels).not.toContain('stdout'); // already present
    });

    it('returns nothing mid-value', () => {
        const text = 'tests:\n  - cmd: echo hi\n';
        expect(complete(text, 1, 15)).toBeUndefined();
    });

    it('uses relative continuation indentation in multi-line insert texts', () => {
        const text = 'tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        - "x"\n';
        const items = complete(text, 3, 6)!;
        const stderr = items.find(i => i.label === 'stderr')!;
        // snippet whitespace normalization adds the line indent; the text itself
        // must not hardcode an absolute depth
        expect(insertTextOf(stderr)).toBe('stderr:\n  - ');
        expect(stderr.insertText).toBeInstanceOf(SnippetString);

        const negated = items.find(i => i.label === '!stdout')!;
        expect(insertTextOf(negated)).toBe('"!stdout":\n  - ');
    });
});

describe('completion replace range', () => {
    it('covers a typed "!" so accepting "!stdout" does not double it', () => {
        // mid-typing document: the user typed "!st" on a new line inside outputs
        const text = 'tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        - "x"\n      !st\n';
        const items = complete(text, 5, 9)!;
        const negated = items.find(i => i.label === '!stdout')!;
        expect(negated.range).toBeDefined();
        expect(rangeOf(negated).start.line).toBe(5);
        expect(rangeOf(negated).start.character).toBe(6); // start of "!st", including the "!"
        expect(rangeOf(negated).end.character).toBe(9);
    });

    it('covers a plain typed prefix', () => {
        const text = 'tests:\n  - cmd: echo hi\n    time\n';
        const items = complete(text, 2, 8)!;
        const timeout = items.find(i => i.label === 'timeout')!;
        expect(rangeOf(timeout).start.character).toBe(4);
        expect(rangeOf(timeout).end.character).toBe(8);
    });

    it('is empty when nothing was typed yet', () => {
        const text = 'tests:\n  - cmd: echo hi\n    \n';
        const items = complete(text, 2, 4)!;
        const desc = items.find(i => i.label === 'desc')!;
        expect(rangeOf(desc).start.character).toBe(4);
        expect(rangeOf(desc).end.character).toBe(4);
    });
});

describe('snippets generate files the validator accepts', () => {
    // Regression guard: the old test-input/test-stdin snippets nested keys at
    // levels the CLI rejects (files directly under inputs; stdin at test level).
    it('root "dats" snippet produces a valid file', () => {
        const items = complete('', 0, 0)!;
        const dats = items.find(i => i.label === 'dats')!;
        const generated = expandSnippet(insertTextOf(dats));
        expect(validateDatsDocument({ getText: () => generated } as any)).toEqual([]);
    });

    it('every tests-array snippet produces a valid test entry', () => {
        // "tests:\n  - " puts the cursor in the tests-array context
        const items = complete('tests:\n  - ', 1, 4)!;
        const snippets = items.filter(i => i.kind === 14 /* Snippet */);
        expect(snippets.map(s => s.label)).toEqual(['test', 'test-input', 'test-stdin']);

        for (const snippet of snippets) {
            const expanded = expandSnippet(insertTextOf(snippet));
            // simulate acceptance on a fresh line indented two spaces under tests:
            const file = 'tests:\n' + insertAtIndent(expanded, 2) + '\n';
            expect(
                validateDatsDocument({ getText: () => file } as any),
                `snippet "${snippet.label}" generated:\n${file}`
            ).toEqual([]);
        }
    });
});
