import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import { normalizeDats } from './dialect';

// Parse the normalized text the way the validator does, so a test asserts the
// structure the parser actually sees rather than the spaces it was given.
function structure(dats: string): unknown {
    const source = normalizeDats(dats);
    const doc = parseDocument(source.text);
    expect(doc.errors.map((e) => e.message)).toEqual([]);
    return doc.toJS();
}

describe('normalizeDats', () => {
    it('leaves a file without tab indentation alone', () => {
        const text = 'tests:\n  - cmd: echo hi\n';
        const source = normalizeDats(text);
        expect(source.text).toBe(text);
        expect(source.toSourceCol(1, 4)).toBe(4);
    });

    it('keeps one output line per input line', () => {
        const text = 'tests:\n\t- cmd: echo hi\n\n\t- cmd: echo bye\n';
        expect(normalizeDats(text).text.split('\n')).toHaveLength(text.split('\n').length);
    });

    it('nests tab-indented mappings, sequences and item bodies', () => {
        expect(
            structure(
                'tests:\n' +
                    '\t- desc: hello\n' +
                    '\t  cmd: echo hi\n' +
                    '\t  outputs:\n' +
                    '\t\tstdout:\n' +
                    '\t\t\t- hi\n' +
                    '\t\tfiles:\n' +
                    '\t\t\tout.txt:\n' +
                    '\t\t\t\texists: true\n'
            )
        ).toEqual({
            tests: [
                {
                    desc: 'hello',
                    cmd: 'echo hi',
                    outputs: { stdout: ['hi'], files: { 'out.txt': { exists: true } } },
                },
            ],
        });
    });

    it('reads bare negated keys as keys, not tags', () => {
        expect(
            structure(
                'tests:\n' +
                    '\t- cmd: echo hi\n' +
                    '\t  outputs:\n' +
                    '\t\t!stdout:\n' +
                    '\t\t\t- boom\n' +
                    '\t\t!files:\n' +
                    '\t\t\tstray.txt:\n' +
                    '\t\t\t\texists: true\n'
            )
        ).toEqual({
            tests: [{ cmd: 'echo hi', outputs: { '!stdout': ['boom'], '!files': { 'stray.txt': { exists: true } } } }],
        });
    });

    it('leaves the quoted spelling of a negated key alone', () => {
        expect(structure('tests:\n\t- cmd: echo hi\n\t  outputs:\n\t\t"!stdout":\n\t\t\t- boom\n')).toEqual({
            tests: [{ cmd: 'echo hi', outputs: { '!stdout': ['boom'] } }],
        });
    });

    it('handles a mapping nested directly under a top-level key', () => {
        expect(structure('shared:\n\tfiles:\n\t\tconfig.json: "{}"\ntests:\n\t- cmd: echo hi\n')).toEqual({
            shared: { files: { 'config.json': '{}' } },
            tests: [{ cmd: 'echo hi' }],
        });
    });

    it('handles sequences of scalars at the top level', () => {
        expect(structure('teardown:\n\t- rm -f out\n\t- echo done\ntests:\n\t- cmd: echo hi\n')).toEqual({
            teardown: ['rm -f out', 'echo done'],
            tests: [{ cmd: 'echo hi' }],
        });
    });

    it('is not derailed by a comment at another depth', () => {
        expect(
            structure(
                'tests:\n' +
                    '\t- cmd: echo hi\n' +
                    '\t  outputs:\n' +
                    '# a comment at the left margin, inside the outputs block\n' +
                    '\t\tstdout:\n' +
                    '\t\t\t- hi\n'
            )
        ).toEqual({ tests: [{ cmd: 'echo hi', outputs: { stdout: ['hi'] } }] });
    });

    it('keeps a "#" line inside a block scalar as body text', () => {
        expect(
            structure('tests:\n\t- cmd: bash {inputs.s.sh}\n\t  inputs:\n\t\tfiles:\n\t\t\ts.sh: |\n\t\t\t\t# not a comment\n\t\t\t\techo hi\n')
        ).toEqual({
            tests: [{ cmd: 'bash {inputs.s.sh}', inputs: { files: { 's.sh': '# not a comment\necho hi\n' } } }],
        });
    });

    it('maps columns back to the source line', () => {
        const dats = 'tests:\n\t- cmd: echo hi\n\t  outputs:\n\t\t!stdout:\n\t\t\t- boom\n';
        const source = normalizeDats(dats);
        const bangLine = 3;
        const normalized = source.text.split('\n')[bangLine];
        // The key moved right (deeper indent) and gained an opening quote; the
        // mapper puts both ends back where they are typed in the source.
        expect(source.toSourceCol(bangLine, normalized.indexOf('"'))).toBe(dats.split('\n')[bangLine].indexOf('!'));
        expect(source.toSourceCol(bangLine, normalized.indexOf(':'))).toBe(dats.split('\n')[bangLine].indexOf(':'));
    });
});
