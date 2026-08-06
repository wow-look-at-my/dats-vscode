import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// The validator only touches Range/Diagnostic/DiagnosticSeverity.
vi.mock('vscode', () => {
    class Range {
        constructor(
            public startLine: number,
            public startCharacter: number,
            public endLine: number,
            public endCharacter: number
        ) {}
    }
    class Diagnostic {
        constructor(
            public range: Range,
            public message: string,
            public severity: number
        ) {}
    }
    return { Range, Diagnostic, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 } };
});

import { validateDatsDocument } from './validator';

// testdata/corpus holds one .dats file per behaviour worth pinning, and
// verdicts.txt records what the REAL CLI does with each -- recorded by running
// `just corpus`, which shells out to `dats syntax`. The extension exists to
// predict that verdict, so this test compares the two directly: anything the
// validator invents, and any rule it has not caught up with, is a mismatch
// here. Add a file, re-record, and the guard covers it.
const corpusDir = join(__dirname, '..', 'testdata', 'corpus');

function recordedVerdicts(): Map<string, 'ACCEPT' | 'REJECT'> {
    const lines = readFileSync(join(corpusDir, 'verdicts.txt'), 'utf8').trim().split('\n');
    return new Map(
        lines.map(line => {
            const [name, verdict] = line.split(' ');
            return [name, verdict as 'ACCEPT' | 'REJECT'];
        })
    );
}

describe('the extension agrees with the CLI on the corpus', () => {
    const verdicts = recordedVerdicts();
    const files = readdirSync(corpusDir)
        .filter(name => name.endsWith('.dats'))
        .sort();

    it('has a recorded verdict for every corpus file', () => {
        expect(files.length).toBeGreaterThan(0);
        expect(files.filter(name => !verdicts.has(name))).toEqual([]);
        expect([...verdicts.keys()].filter(name => !files.includes(name))).toEqual([]);
    });

    for (const name of files) {
        it(`${name} matches the CLI`, () => {
            const text = readFileSync(join(corpusDir, name), 'utf8');
            const diagnostics = validateDatsDocument({ getText: () => text } as any);
            const verdict = diagnostics.length === 0 ? 'ACCEPT' : 'REJECT';
            expect(verdict, diagnostics.map(d => d.message).join('\n')).toBe(verdicts.get(name));
        });
    }
});
