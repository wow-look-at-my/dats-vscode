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

function validate(text: string) {
    return validateDatsDocument({ getText: () => text } as any);
}

describe('validateDatsDocument', () => {
    it('accepts a minimal valid test', () => {
        expect(validate('tests:\n  - cmd: echo hi\n')).toEqual([]);
    });

    it('accepts a fully featured valid file', () => {
        const yaml = [
            'tests:',
            '  - desc: everything',
            '    exit: EXIT_SUCCESS',
            '    timeout: 500ms',
            '    cmd: cp {inputs.data.txt} {outputs.copy.txt}',
            '    inputs:',
            '      stdin: "hello"',
            '      files:',
            '        data.txt: |',
            '          content',
            '    outputs:',
            '      stdout:',
            '        - "copied"',
            '      stderr:',
            '        0: "^warning"',
            '      "!stdout":',
            '        - "error"',
            '      files:',
            '        copy.txt:',
            '          exists: true',
            '          match:',
            '            - "content"',
            '          notMatch:',
            '            - "garbage"',
            '      "!files":',
            '        unexpected.txt:',
            '          exists: true',
            '      json_output: null',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('reports YAML parse errors as diagnostics', () => {
        const diags = validate('tests:\n  - cmd: [unclosed\n');
        expect(diags.length).toBeGreaterThan(0);
        expect(diags[0].severity).toBe(ERROR);
    });
});

describe('tests array', () => {
    it('flags an empty document', () => {
        const diags = validate('');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('no tests defined');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags a missing tests key', () => {
        const diags = validate('# nothing here yet\n{}\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('no tests defined');
    });

    it('flags a null tests key', () => {
        const diags = validate('tests:\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('no tests defined');
    });

    it('flags an empty tests array', () => {
        const diags = validate('tests: []\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('no tests defined');
    });

    it('flags a non-array tests value', () => {
        const diags = validate('tests: 5\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('"tests" must be an array');
    });

    it('flags a non-mapping document root', () => {
        const diags = validate('- cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Document root must be a mapping');
    });
});

describe('cmd', () => {
    it('flags a test missing cmd', () => {
        const diags = validate('tests:\n  - desc: no command\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('required property "cmd"');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags a null cmd', () => {
        const diags = validate('tests:\n  - cmd:\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('"cmd" must be a non-empty string');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags an empty string cmd', () => {
        const diags = validate('tests:\n  - cmd: ""\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('"cmd" must be a non-empty string');
    });
});

describe('exit', () => {
    it('accepts integer exit codes and the two exit code names', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    exit: 0\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    exit: 255\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    exit: EXIT_SUCCESS\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    exit: EXIT_FAILURE\n')).toEqual([]);
    });

    it('accepts quoted integer exit codes', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    exit: "3"\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    exit: "0"\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    exit: "255"\n')).toEqual([]);
    });

    it('flags out-of-range exit codes, bare or quoted', () => {
        for (const exit of ['-1', '256', '"256"', '"-1"']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    exit: ${exit}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(`exit code ${exit.replace(/"/g, '')} must be in range 0-255`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags float exit codes, including integral ones like 2.0', () => {
        for (const exit of ['1.5', '2.0']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    exit: ${exit}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(`exit code must be an integer in range 0-255, got float ${exit}`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags quoted float exit codes as unrecognized names (like the CLI)', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    exit: "1.5"\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe(
            'exit "1.5" is not a recognized exit code name (use EXIT_SUCCESS, EXIT_FAILURE, or an integer 0-255)'
        );
    });

    it('flags unrecognized exit code names, including other EXIT_* strings', () => {
        for (const exit of ['EXIT_BANANA', 'banana']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    exit: ${exit}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(
                `exit "${exit}" is not a recognized exit code name (use EXIT_SUCCESS, EXIT_FAILURE, or an integer 0-255)`
            );
            expect(diags[0].severity).toBe(ERROR);
        }
    });
});

describe('unknown keys are hard errors (the CLI refuses to run unknown fields)', () => {
    it('flags unknown test keys', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    retries: 3\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Unknown property "retries" (dats will refuse to run this file)');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags unknown top-level keys', () => {
        const diags = validate('version: 2\ntests:\n  - cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('Unknown property "version"');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags unknown inputs keys', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    inputs:\n      environment: FOO=1\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('Unknown inputs property "environment"');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags unknown outputs keys', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      bogus: ["x"]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('Unknown outputs property "bogus"');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags unknown file check keys', () => {
        const yaml = [
            'tests:',
            '  - cmd: echo hi',
            '    outputs:',
            '      files:',
            '        out.txt:',
            '          contains: ["x"]',
            '',
        ].join('\n');
        const diags = validate(yaml);
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('Unknown file check property "contains"');
        expect(diags[0].severity).toBe(ERROR);
    });
});

describe('output check shape', () => {
    for (const key of ['stdout', 'stderr', '"!stdout"', '"!stderr"']) {
        it(`flags a scalar ${key} value`, () => {
            const diags = validate(`tests:\n  - cmd: echo hi\n    outputs:\n      ${key}: "hello"\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe('output check must be a list of patterns or map of line checks');
            expect(diags[0].severity).toBe(ERROR);
        });
    }

    it('accepts a null output check (no checks)', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n')).toEqual([]);
    });

    it('accepts list and map forms', () => {
        const yaml = [
            'tests:',
            '  - cmd: echo hi',
            '    outputs:',
            '      stdout:',
            '        - "hello"',
            '      stderr:',
            '        0: "^warn"',
            '        3: "done$"',
            '        "7": "quoted keys work too"',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('flags non-integer line check keys', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        foo: "^x$"\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('line check key must be an integer, got "foo"');
    });

    it('flags negative line check keys', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        -1: "^x$"\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('line number must be >= 0, got -1');
    });

    it('flags duplicate line check keys (bare 0 and quoted "0" collide)', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        0: "^a$"\n        "0": "^b$"\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('duplicate line number 0 in output check');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags non-string line check values', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        0: 5\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Line check values must be regex strings');
    });

    it('flags non-string patterns in the list form', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      stdout:\n        - 5\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Output check patterns must be strings');
    });
});

describe('timeout', () => {
    it('accepts integer second timeouts', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    timeout: 5\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    timeout: 0\n')).toEqual([]);
    });

    it('accepts Go duration string timeouts, including both micro signs', () => {
        for (const duration of ['500ms', '2s', '1m30s', '1.5h', '.5s', '0', '100us', '100µs', '100μs']) {
            expect(validate(`tests:\n  - cmd: echo hi\n    timeout: "${duration}"\n`)).toEqual([]);
        }
    });

    it('accepts quoted bare integer timeouts as seconds', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    timeout: "5"\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    timeout: "0"\n')).toEqual([]);
    });

    it('flags negative integer timeouts, bare or quoted', () => {
        for (const timeout of ['-1', '"-1"']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    timeout: ${timeout}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe('timeout -1 must not be negative');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags float timeouts, including integral ones like 1.0', () => {
        for (const timeout of ['2.5', '1.0']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    timeout: ${timeout}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(
                `timeout must be an integer number of seconds or a duration string (e.g. "900ms", "1.5s"), got float ${timeout}`
            );
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags invalid and negative duration strings', () => {
        for (const duration of ['banana', '-5s', '5 s', '1.5']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    timeout: "${duration}"\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toContain(`Timeout "${duration}"`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });
});

describe('inputs.env', () => {
    it('accepts env as a map of string values', () => {
        const yaml = [
            'tests:',
            '  - cmd: echo $FOO $BAR',
            '    inputs:',
            '      env:',
            '        FOO: bar',
            '        DATA: "{inputs.data.txt}"',
            '      files:',
            '        data.txt: content',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('accepts an empty env', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    inputs:\n      env:\n')).toEqual([]);
        expect(validate('tests:\n  - cmd: echo hi\n    inputs:\n      env: {}\n')).toEqual([]);
    });

    it('accepts null env values (decode to the empty string)', () => {
        expect(validate('tests:\n  - cmd: echo hi\n    inputs:\n      env:\n        FOO:\n')).toEqual([]);
    });

    it('flags a non-map env value', () => {
        for (const env of ['FOO=1', '["FOO"]']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    inputs:\n      env: ${env}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe('"env" must be a map of environment variable names to string values');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags non-string env values (lists, maps, numbers)', () => {
        for (const value of ['[1, 2]', '{a: b}', '5', 'true']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    inputs:\n      env:\n        FOO: ${value}\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe('env values must be strings');
            expect(diags[0].severity).toBe(ERROR);
        }
    });
});

describe('fixture file names must be local relative paths', () => {
    it('accepts nested relative names', () => {
        const yaml = [
            'tests:',
            '  - cmd: cp {inputs.sub/in.txt} {outputs.deep/out.txt}',
            '    inputs:',
            '      files:',
            '        sub/in.txt: content',
            '    outputs:',
            '      files:',
            '        deep/out.txt:',
            '      "!files":',
            '        other/missing.txt:',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('flags absolute and escaping input file names', () => {
        for (const name of ['/abs.txt', '../escape.txt', 'sub/../../up.txt']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    inputs:\n      files:\n        ${name}: content\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(`input file name "${name}" must be a relative path that stays inside the test directory`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags absolute and escaping output file names in files and !files', () => {
        for (const key of ['files', '"!files"']) {
            for (const name of ['/abs.txt', '../escape.txt']) {
                const diags = validate(`tests:\n  - cmd: echo hi\n    outputs:\n      ${key}:\n        ${name}:\n`);
                expect(diags).toHaveLength(1);
                expect(diags[0].message).toBe(`output file name "${name}" must be a relative path that stays inside the test directory`);
                expect(diags[0].severity).toBe(ERROR);
            }
        }
    });
});

describe('empty file checks are implicit existence assertions', () => {
    it('accepts null and {} file checks under files and !files', () => {
        const yaml = [
            'tests:',
            '  - cmd: touch {outputs.a.txt}',
            '    outputs:',
            '      files:',
            '        a.txt:',
            '        b.txt: {}',
            '      "!files":',
            '        c.txt:',
            '        d.txt: {}',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
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
});
