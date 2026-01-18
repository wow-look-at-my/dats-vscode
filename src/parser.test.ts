import { describe, it, expect } from 'vitest';
import {
    findTestRange,
    extractBlockKeys,
    findInputs,
    findOutputs,
    matchInputsPlaceholder,
    matchOutputsPlaceholder,
} from './parser';

describe('findTestRange', () => {
    it('finds test range for single test', () => {
        const lines = [
            'tests:',
            '  - name: test one',
            '    exit: 0',
            '    cmd: echo hello',
        ];
        expect(findTestRange(lines, 2)).toEqual([1, 4]);
    });

    it('finds test range with multiple tests', () => {
        const lines = [
            'tests:',
            '  - name: test one',
            '    exit: 0',
            '  - name: test two',
            '    exit: 1',
        ];
        expect(findTestRange(lines, 2)).toEqual([1, 3]);
        expect(findTestRange(lines, 4)).toEqual([3, 5]);
    });

    it('returns undefined when not in a test', () => {
        const lines = ['tests:', '  # comment'];
        expect(findTestRange(lines, 0)).toBeUndefined();
    });
});

describe('extractBlockKeys', () => {
    it('extracts keys from inputs block', () => {
        const lines = [
            '  - name: test',
            '    inputs:',
            '      file1.txt: content',
            '      file2.txt: content',
            '    cmd: echo',
        ];
        expect(extractBlockKeys(lines, 'inputs')).toEqual(['file1.txt', 'file2.txt']);
    });

    it('extracts keys from outputs block', () => {
        const lines = [
            '  - name: test',
            '    outputs:',
            '      stdout:',
            '        - "hello"',
            '      binary:',
            '        exists: true',
        ];
        expect(extractBlockKeys(lines, 'outputs')).toEqual(['stdout', 'binary']);
    });

    it('returns empty array when block not found', () => {
        const lines = ['  - name: test', '    cmd: echo'];
        expect(extractBlockKeys(lines, 'inputs')).toEqual([]);
    });

    it('stops at end of block', () => {
        const lines = [
            '    inputs:',
            '      file.txt: content',
            '    outputs:',
            '      stdout:',
        ];
        expect(extractBlockKeys(lines, 'inputs')).toEqual(['file.txt']);
    });
});

describe('findInputs', () => {
    it('finds input file names', () => {
        const lines = [
            '  - name: test',
            '    inputs:',
            '      data.txt: |',
            '        hello',
            '      config.json: "{}"',
        ];
        expect(findInputs(lines)).toEqual(['data.txt', 'config.json']);
    });
});

describe('findOutputs', () => {
    it('finds output file names excluding reserved keys', () => {
        const lines = [
            '  - name: test',
            '    outputs:',
            '      stdout:',
            '        - "hello"',
            '      stderr:',
            '        - "error"',
            '      binary:',
            '        exists: true',
            '      result.txt:',
            '        contains:',
            '          - "success"',
        ];
        expect(findOutputs(lines)).toEqual(['binary', 'result.txt']);
    });

    it('excludes !stdout and !stderr', () => {
        const lines = [
            '    outputs:',
            '      "!stdout":',
            '        - "bad"',
            '      "!stderr":',
            '        - "error"',
            '      output.bin:',
            '        exists: true',
        ];
        // Note: the parser extracts !stdout and !stderr as keys, then filters
        expect(findOutputs(lines)).toEqual(['output.bin']);
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
