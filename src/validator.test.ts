import { describe, it, expect, vi } from 'vitest';

// validator.ts only touches vscode.Range, vscode.Diagnostic, and
// vscode.DiagnosticSeverity, so a minimal mock stands in for the extension host.
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
    // Values match the real vscode.DiagnosticSeverity enum
    const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
    return { Range, Diagnostic, DiagnosticSeverity };
});

import { validateDatsDocument } from './validator';

const ERROR = 0;
const WARNING = 1;

function validate(text: string) {
    return validateDatsDocument({ getText: () => text } as any);
}

describe('validateDatsDocument', () => {
    it('accepts a minimal valid test', () => {
        expect(validate('tests:\n  - cmd: echo hi\n')).toEqual([]);
    });

    it('flags a test missing cmd', () => {
        const diags = validate('tests:\n  - desc: no command\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('required property "cmd"');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags genuinely unknown test keys', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    retries: 3\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Unknown property "retries"');
        expect(diags[0].severity).toBe(WARNING);
    });
});

describe('timeout', () => {
    it('accepts integer second timeouts', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    timeout: 5\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    timeout: 0\n')).toEqual([]);
    });

    it('accepts Go duration string timeouts', () => {
        for (const duration of ['500ms', '2s', '1m30s', '1.5h', '.5s', '0']) {
            expect(validate(`tests:\n  - cmd: echo hi\n    timeout: "${duration}"\n`)).toEqual([]);
        }
    });

    it('flags negative and non-integer numeric timeouts', () => {
        for (const timeout of ['-1', '2.5']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    timeout: ${timeout}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toContain('Timeout');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags invalid and negative duration strings', () => {
        for (const duration of ['banana', '-5s', '10', '5 s']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    timeout: "${duration}"\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toContain(`Timeout "${duration}"`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });
});

describe('json_output', () => {
    it('accepts json_output with an object value', () => {
        const yaml = [
            'tests:',
            '  - cmd: echo \'{"a":1}\'',
            '    outputs:',
            '      json_output:',
            '        a: 1',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('accepts json_output with scalar and null values', () => {
        expect(validate('tests:\n  - cmd: echo 2\n    outputs:\n      json_output: 2\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo null\n    outputs:\n      json_output: null\n')).toEqual([]);
    });
});

describe('negated output checks', () => {
    it('accepts dict-form !stdout and !stderr (line-keyed regexes)', () => {
        const yaml = [
            'tests:',
            '  - cmd: echo hi',
            '    outputs:',
            '      "!stdout":',
            '        0: "^error"',
            '        3: "warning$"',
            '      "!stderr":',
            '        1: "fatal"',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('accepts array-form !stdout and !stderr (literal substrings)', () => {
        const yaml = [
            'tests:',
            '  - cmd: echo hi',
            '    outputs:',
            '      "!stdout": ["error"]',
            '      "!stderr": ["fatal"]',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('still flags genuinely unknown outputs keys', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      bogus: ["x"]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Unknown outputs property "bogus"');
        expect(diags[0].severity).toBe(WARNING);
    });
});
