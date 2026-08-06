import { describe, it, expect } from 'vitest';
import { findTestRange, extractBlockLines, extractBlockKeys, findInputs, findOutputs, matchInputsPlaceholder, matchOutputsPlaceholder, findShared, matchSharedPlaceholder } from './parser';

describe('findTestRange', () => {
    it('finds test range for single test', () => {
        const lines = [
            'tests:',
            '  - desc: test one',
            '    exit: 0',
            '    cmd: echo hello',
        ];
        expect(findTestRange(lines, 2)).toEqual([1, 4]);
    });

    it('finds test range with multiple tests', () => {
        const lines = [
            'tests:',
            '  - desc: test one',
            '    exit: 0',
            '  - desc: test two',
            '    exit: 1',
        ];
        expect(findTestRange(lines, 2)).toEqual([1, 3]);
        expect(findTestRange(lines, 4)).toEqual([3, 5]);
    });

    it('treats a test starting with any key as a boundary', () => {
        const lines = [
            'tests:',
            '  - cmd: echo one',
            '  - inputs:',
            '      stdin: "hi"',
            '    cmd: cat',
        ];
        expect(findTestRange(lines, 1)).toEqual([1, 2]);
        expect(findTestRange(lines, 3)).toEqual([2, 5]);
    });

    it('does not treat nested sequence items as test boundaries', () => {
        const lines = [
            'tests:',
            '  - cmd: echo hello',
            '    outputs:',
            '      stdout:',
            '        - "hello"',
            '        - "world"',
            '  - cmd: echo two',
        ];
        expect(findTestRange(lines, 4)).toEqual([1, 6]);
        expect(findTestRange(lines, 6)).toEqual([6, 7]);
    });

    it('supports test items at the same indent as the tests key', () => {
        const lines = [
            'tests:',
            '- cmd: echo one',
            '- cmd: echo two',
        ];
        expect(findTestRange(lines, 1)).toEqual([1, 2]);
        expect(findTestRange(lines, 2)).toEqual([2, 3]);
    });

    it('returns undefined when not in a test', () => {
        expect(findTestRange(['tests:', '  # comment'], 0)).toBeUndefined();
        expect(findTestRange(['tests:', '  - cmd: echo'], 0)).toBeUndefined();
        expect(findTestRange(['# just a comment'], 0)).toBeUndefined();
    });
});

describe('extractBlockLines', () => {
    it('returns the lines nested inside the named block', () => {
        const lines = [
            '    inputs:',
            '      stdin: "hi"',
            '      files:',
            '        data.txt: content',
            '    cmd: echo',
        ];
        expect(extractBlockLines(lines, 'inputs')).toEqual([
            '      stdin: "hi"',
            '      files:',
            '        data.txt: content',
        ]);
    });

    it('returns empty array when block not found', () => {
        expect(extractBlockLines(['    cmd: echo'], 'inputs')).toEqual([]);
    });
});

describe('extractBlockKeys', () => {
    it('extracts immediate child keys of a block', () => {
        const lines = [
            '    inputs:',
            '      stdin: "hi"',
            '      files:',
            '        data.txt: content',
            '    cmd: echo',
        ];
        expect(extractBlockKeys(lines, 'inputs')).toEqual(['stdin', 'files']);
    });

    it('extracts keys from outputs block', () => {
        const lines = [
            '  - desc: test',
            '    outputs:',
            '      stdout:',
            '        - "hello"',
            '      files:',
            '        binary:',
            '          exists: true',
        ];
        expect(extractBlockKeys(lines, 'outputs')).toEqual(['stdout', 'files']);
    });

    it('returns empty array when block not found', () => {
        const lines = ['  - desc: test', '    cmd: echo'];
        expect(extractBlockKeys(lines, 'inputs')).toEqual([]);
    });

    it('stops at end of block', () => {
        const lines = [
            '    inputs:',
            '      files:',
            '    outputs:',
            '      stdout:',
        ];
        expect(extractBlockKeys(lines, 'inputs')).toEqual(['files']);
    });
});

describe('findInputs', () => {
    it('finds file names declared under inputs.files', () => {
        const lines = [
            '  - desc: test',
            '    inputs:',
            '      stdin: "some input"',
            '      files:',
            '        data.txt: |',
            '          hello',
            '        config.json: "{}"',
            '    cmd: cat {inputs.data.txt}',
        ];
        expect(findInputs(lines)).toEqual(['data.txt', 'config.json']);
    });

    it('returns empty array when inputs has no files block', () => {
        const lines = [
            '  - cmd: cat',
            '    inputs:',
            '      stdin: "hi"',
        ];
        expect(findInputs(lines)).toEqual([]);
    });

    it('does not pick up output files', () => {
        const lines = [
            '  - cmd: touch {outputs.out.txt}',
            '    outputs:',
            '      files:',
            '        out.txt:',
            '          exists: true',
        ];
        expect(findInputs(lines)).toEqual([]);
    });
});

describe('findOutputs', () => {
    it('finds file names declared under outputs.files', () => {
        const lines = [
            '  - desc: test',
            '    outputs:',
            '      stdout:',
            '        - "hello"',
            '      stderr:',
            '        - "warning"',
            '      files:',
            '        result.txt:',
            '          exists: true',
            '        binary:',
            '          match:',
            '            - "ok"',
        ];
        expect(findOutputs(lines)).toEqual(['result.txt', 'binary']);
    });

    it('does not include names under "!files" or reserved output keys', () => {
        const lines = [
            '    outputs:',
            '      "!stdout":',
            '        - "bad"',
            '      files:',
            '        output.bin:',
            '          exists: true',
            '      "!files":',
            '        unexpected.txt:',
            '          exists: true',
        ];
        expect(findOutputs(lines)).toEqual(['output.bin']);
    });

    it('does not pick up input files', () => {
        const lines = [
            '  - cmd: cat {inputs.in.txt}',
            '    inputs:',
            '      files:',
            '        in.txt: content',
        ];
        expect(findOutputs(lines)).toEqual([]);
    });
});

describe('matchInputsPlaceholder', () => {
    it('matches {inputs. at end of string', () => {
        expect(matchInputsPlaceholder('cmd: cat {inputs.')).toBe('');
        expect(matchInputsPlaceholder('cat {inputs.file')).toBe('file');
        expect(matchInputsPlaceholder('{inputs.data.txt')).toBe('data.txt');
    });

    it('returns undefined when no match', () => {
        expect(matchInputsPlaceholder('cat file.txt')).toBeUndefined();
        expect(matchInputsPlaceholder('{outputs.file')).toBeUndefined();
        expect(matchInputsPlaceholder('{inputs.file}')).toBeUndefined(); // closed
    });
});

describe('matchOutputsPlaceholder', () => {
    it('matches {outputs. at end of string', () => {
        expect(matchOutputsPlaceholder('-o {outputs.')).toBe('');
        expect(matchOutputsPlaceholder('{outputs.bin')).toBe('bin');
        expect(matchOutputsPlaceholder('{outputs.out.dat')).toBe('out.dat');
    });

    it('returns undefined when no match', () => {
        expect(matchOutputsPlaceholder('file.txt')).toBeUndefined();
        expect(matchOutputsPlaceholder('{inputs.file')).toBeUndefined();
    });
});

describe('copy fixtures and shared placeholders', () => {
    const file = [
        'shared:',
        '\tfiles:',
        '\t\tconfig.json: "{}"',
        '\tcopy:',
        '\t\thelper.sh: fixtures/helper.sh',
        'tests:',
        '\t- cmd: bash {shared.helper.sh}',
        '\t  inputs:',
        '\t\tfiles:',
        '\t\t\tdata.txt: hi',
        '\t\tcopy:',
        '\t\t\treal.bin: fixtures/real.bin',
    ];

    it('offers copy destinations alongside files in the inputs namespace', () => {
        const range = findTestRange(file, 6)!;
        expect(findInputs(file.slice(range[0], range[1]))).toEqual(['data.txt', 'real.bin']);
    });

    it('finds shared fixtures from both files and copy', () => {
        expect(findShared(file)).toEqual(['config.json', 'helper.sh']);
    });

    it('matches a {shared. placeholder prefix', () => {
        expect(matchSharedPlaceholder('cmd: bash {shared.hel')).toBe('hel');
        expect(matchSharedPlaceholder('cmd: bash {shared.')).toBe('');
        expect(matchSharedPlaceholder('cmd: bash {inputs.')).toBeUndefined();
    });
});
