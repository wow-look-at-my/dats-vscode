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
            '      snapshot: true',
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

describe('file-level setup/teardown/shared and $schema', () => {
    it('accepts the full new-format file the CLI accepts (probe p0-positive.dats)', () => {
        const yaml = [
            'shared:',
            '  files:',
            `    cfg.json: '{"a": 1}'`,
            '    sub/cfg.json: nested content',
            'setup:',
            '  - echo setup1 {shared.cfg.json}',
            '  - echo setup2',
            'teardown:',
            '  - echo teardown1',
            '  - echo teardown2',
            'tests:',
            '  - desc: matrix test {matrix.word}',
            '    cmd: cat {inputs.in.txt} && echo {matrix.word} && cat {shared.cfg.json} && echo out > {outputs.result.txt}',
            '    matrix:',
            '      word: [hello, howdy]',
            '      num: [1, 2]',
            '    inputs:',
            '      stdin: "stdin {matrix.word}"',
            '      files:',
            '        in.txt: "content {matrix.word}"',
            '      env:',
            '        MY_VAR: "val {matrix.num}"',
            '    outputs:',
            '      stdout:',
            '        - "{matrix.word}"',
            '      "!stdout":',
            '        - "nope {matrix.num}"',
            '      files:',
            '        result.txt:',
            '          match:',
            '            - out',
            '  - desc: json matrix',
            '    cmd: echo hi',
            '    matrix:',
            '      v: [a]',
            '    outputs:',
            '      json_output:',
            '        k: "{matrix.v}"',
            '  - desc: null matrix test',
            '    cmd: echo hi',
            '    matrix: null',
            '    outputs:',
            '      stdout:',
            '        - hi',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });

    it('accepts single-string setup and teardown commands', () => {
        expect(validate('setup: echo hi\nteardown: echo bye\ntests:\n  - cmd: echo hi\n')).toEqual([]);
    });

    it('accepts explicit null setup/teardown/shared (absent, like the CLI)', () => {
        expect(validate('setup: null\ntests:\n  - cmd: echo hi\n')).toEqual([]);
        expect(validate('teardown: null\ntests:\n  - cmd: echo hi\n')).toEqual([]);
        expect(validate('shared: null\ntests:\n  - cmd: echo hi\n')).toEqual([]);
    });

    it('accepts a top-level $schema key (the CLI does too)', () => {
        expect(validate('$schema: https://example.com/dats.schema.json\ntests:\n  - cmd: echo hi\n')).toEqual([]);
    });

    it('still flags setup and shared as unknown TEST-level keys', () => {
        for (const key of ['setup', 'shared']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    ${key}: x\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(`Unknown property "${key}" (dats will refuse to run this file)`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('still requires tests when only hooks or shared are present', () => {
        expect(validate('setup: echo hi\n').map(d => d.message)).toEqual(['no tests defined']);
        expect(validate('setup: echo hi\ntests: []\n').map(d => d.message)).toEqual(['no tests defined']);
    });
});

describe('setup/teardown command lists', () => {
    it('flags empty command lists', () => {
        for (const key of ['setup', 'teardown']) {
            const diags = validate(`${key}: []\ntests:\n  - cmd: echo hi\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(`${key}: must list at least one command`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags blank commands in a list', () => {
        const diags = validate('setup: [""]\ntests:\n  - cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('setup: command 1 must not be empty');
    });

    it('flags a blank single-string command', () => {
        const diags = validate('setup: "   "\ntests:\n  - cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('setup: command must not be empty');
    });

    it('flags non-string commands (the CLI never coerces a bare 123)', () => {
        const diags = validate('setup: [123]\ntests:\n  - cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('setup: command 1 must be a string');
    });

    it('flags a mapping-shaped value', () => {
        const diags = validate('setup: {a: b}\ntests:\n  - cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('setup must be a command string or a list of command strings');
    });

    it('flags matrix placeholders in hook commands, counting the single form as command 1', () => {
        let diags = validate('setup: echo {matrix.v}\ntests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('setup command 1: {matrix.v} is not available outside tests');

        diags = validate('teardown:\n  - echo one\n  - echo {matrix.v}\ntests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('teardown command 2: {matrix.v} is not available outside tests');
    });

    it('reports hook diagnostics alongside no tests defined', () => {
        expect(validate('setup: []\n').map(d => d.message)).toEqual([
            'setup: must list at least one command',
            'no tests defined',
        ]);
    });
});

describe('shared fixtures', () => {
    it('flags shared blocks that declare no files', () => {
        for (const shared of ['shared: {}\n', 'shared:\n  files: {}\n', 'shared:\n  files: null\n', 'shared:\n  copy: {}\n']) {
            const diags = validate(`${shared}tests:\n  - cmd: echo hi\n`);
            expect(diags, shared).toHaveLength(1);
            expect(diags[0].message).toBe('shared: must declare at least one file under files or copy');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags unknown shared properties', () => {
        const diags = validate('shared:\n  files:\n    a.txt: hi\n  bogus: 1\ntests:\n  - cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Unknown shared property "bogus" (dats will refuse to run this file)');
    });

    it('flags non-local shared file names', () => {
        for (const name of ['../x', '/abs']) {
            const diags = validate(`shared:\n  files:\n    ${name}: hi\ntests:\n  - cmd: echo hi\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(`shared file name "${name}" must be a relative path that stays inside the shared directory`);
        }
    });

    it('flags a non-mapping shared value', () => {
        const diags = validate('shared: hello\ntests:\n  - cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('"shared" must be a mapping with a "files" or "copy" key');
    });

    it('flags matrix placeholders in shared file contents', () => {
        const diags = validate('shared:\n  files:\n    cfg.txt: "value {matrix.v}"\ntests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('shared file "cfg.txt": {matrix.v} is not available outside tests');
    });
});

describe('matrix declarations', () => {
    it('flags invalid variable names', () => {
        for (const name of ['1bad', 'foo-bar']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    matrix:\n      ${name}: [a]\n`);
            expect(diags).toHaveLength(1);
            expect(diags[0].message).toBe(`matrix variable name "${name}" must match ^[A-Za-z_][A-Za-z0-9_]*$`);
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags an empty matrix mapping', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    matrix: {}\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('matrix must declare at least one variable');
    });

    it('flags a non-mapping matrix', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    matrix: hello\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('matrix must be a mapping of variable names to value lists');
    });

    it('flags non-sequence value lists (a null value lands there too)', () => {
        for (const values of ['hello', 'null']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    matrix:\n      v: ${values}\n`);
            expect(diags, values).toHaveLength(1);
            expect(diags[0].message).toBe('matrix variable "v" must list its values as a sequence');
        }
    });

    it('flags empty value lists', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    matrix:\n      v: []\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('matrix variable "v" must list at least one value');
    });

    it('flags non-scalar and null values', () => {
        for (const values of ['[[a]]', '[null]']) {
            const diags = validate(`tests:\n  - cmd: echo hi\n    matrix:\n      v: ${values}\n`);
            expect(diags, values).toHaveLength(1);
            expect(diags[0].message).toBe('matrix variable "v" value 1: values must be scalar strings, numbers, or booleans');
        }
    });

    it('flags duplicate values, compared after stringification like the CLI', () => {
        let diags = validate('tests:\n  - cmd: echo hi\n    matrix:\n      v: [a, a]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('matrix variable "v" lists duplicate value "a"');

        // x and "x" (and 1.50 and "1.50") produce byte-identical instances
        diags = validate('tests:\n  - cmd: echo {matrix.v}\n    matrix:\n      v: [x, "x"]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('matrix variable "v" lists duplicate value "x"');

        diags = validate('tests:\n  - cmd: echo {matrix.v}\n    matrix:\n      v: [1.50, "1.50"]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('matrix variable "v" lists duplicate value "1.50"');
    });

    it('flags duplicate variable names (the yaml parser reports its own error too)', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n      v: [b]\n');
        expect(diags.map(d => d.message)).toContain('matrix variable "v" declared more than once');
        expect(diags).toHaveLength(2);
    });
});

describe('{matrix.X} references', () => {
    it('flags undeclared references in every scanned field', () => {
        const cases: Record<string, string> = {
            cmd: 'tests:\n  - cmd: echo {matrix.nope}\n    matrix:\n      v: [a]\n',
            desc: 'tests:\n  - desc: hello {matrix.nope}\n    cmd: echo hi\n    matrix:\n      v: [a]\n',
            'stdout pattern': 'tests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n    outputs:\n      stdout:\n        - "{matrix.nope}"\n',
            json_output: 'tests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n    outputs:\n      json_output:\n        k: "{matrix.nope}"\n',
            'env value': 'tests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n    inputs:\n      env:\n        MY_VAR: "{matrix.nope}"\n',
            'file content': 'tests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n    inputs:\n      files:\n        in.txt: "{matrix.nope}"\n',
            stdin: 'tests:\n  - cmd: echo hi\n    matrix:\n      v: [a]\n    inputs:\n      stdin: "{matrix.nope}"\n',
        };
        for (const [field, yaml] of Object.entries(cases)) {
            const diags = validate(yaml);
            expect(diags, field).toHaveLength(1);
            expect(diags[0].message, field).toBe('{matrix.nope} is not a declared matrix variable (declared: v)');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('lists declared variables in declaration order', () => {
        const diags = validate('tests:\n  - cmd: echo {matrix.nope}\n    matrix:\n      b: [1]\n      a: [2]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('{matrix.nope} is not a declared matrix variable (declared: b, a)');
    });

    it('flags references in a test that declares no matrix, explicit null included', () => {
        let diags = validate('tests:\n  - cmd: echo {matrix.nope}\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('{matrix.nope} is used but the test declares no matrix');

        diags = validate('tests:\n  - cmd: echo {matrix.x}\n    matrix: null\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('{matrix.x} is used but the test declares no matrix');
    });

    it('flags the empty-name form {matrix.}', () => {
        const diags = validate('tests:\n  - cmd: echo {matrix.}\n    matrix:\n      v: [a]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('{matrix.} must name a matrix variable');
    });

    it('treats any {matrix.X} text as a reference, even names a matrix could not declare', () => {
        const diags = validate('tests:\n  - cmd: echo {matrix.foo-bar}\n    matrix:\n      v: [a]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('{matrix.foo-bar} is not a declared matrix variable (declared: v)');
    });

    it('does not scan fixture file names or env var names (out of scope, like the CLI)', () => {
        const yaml = [
            'tests:',
            '  - cmd: echo hi',
            '    matrix:',
            '      v: [a]',
            '    inputs:',
            '      files:',
            '        "{matrix.v}.txt": content',
            '      env:',
            '        "{matrix.v}": value',
            '',
        ].join('\n');
        expect(validate(yaml)).toEqual([]);
    });
});

// Every accept/reject verdict and message below was verified against
// dats@d76c889 (dats syntax) probe runs.
describe('outputs.snapshot', () => {
    // yaml-fixed resolves only the core-schema spellings, so yes/y/on/off are
    // plain strings and the CLI rejects them.
    it('accepts scalar booleans (core-schema spellings only)', () => {
        for (const value of ['true', 'false', 'True', 'TRUE', 'null']) {
            const yaml = `tests:\n  - cmd: echo hi\n    outputs:\n      snapshot: ${value}\n`;
            expect(validate(yaml), `snapshot: ${value}`).toEqual([]);
        }
    });

    it('accepts stream-boolean mappings', () => {
        for (const body of [
            '        stdout: true',
            '        stderr: true',
            '        stdout: true\n        stderr: true',
            '        stdout: false\n        stderr: true',
            '        stdout: True',
        ]) {
            const yaml = `tests:\n  - cmd: echo hi\n    outputs:\n      snapshot:\n${body}\n`;
            expect(validate(yaml), body).toEqual([]);
        }
    });

    it('leaves an alias at the snapshot key to the CLI (which resolves it)', () => {
        const yaml = 'tests:\n  - desc: &b true\n    cmd: echo hi\n    outputs:\n      snapshot: *b\n';
        expect(validate(yaml)).toEqual([]);
    });

    it('flags non-boolean scalars, sequences, quoted "true" and the YAML 1.1 spellings', () => {
        for (const value of ['"true"', '"TRUE"', '1', '""', '[true]', 'enabled', 'yes', '"yes"', 'y', 'on', 'Off']) {
            const yaml = `tests:\n  - cmd: echo hi\n    outputs:\n      snapshot: ${value}\n`;
            const diags = validate(yaml);
            expect(diags, `snapshot: ${value}`).toHaveLength(1);
            expect(diags[0].message).toBe('snapshot: must be true, false, or a mapping of stream booleans (stdout, stderr)');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags unknown stream names', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      snapshot:\n        stdout: true\n        foo: true\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('snapshot: unknown key "foo" (allowed: stdout, stderr)');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags a merge key like any other unknown key (the CLI does not merge here)', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      snapshot:\n        <<: {stdout: true}\n');
        expect(diags.map(d => d.message)).toContain('snapshot: unknown key "<<" (allowed: stdout, stderr)');
    });

    it('flags duplicate stream keys (the yaml parser reports its own error too)', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      snapshot:\n        stdout: true\n        stdout: true\n');
        expect(diags.map(d => d.message)).toContain('snapshot: stdout declared more than once');
        expect(diags).toHaveLength(2);
    });

    it('flags non-boolean stream values, including quoted "false" and aliases', () => {
        for (const [body, stream] of [
            ['        stdout: 1', 'stdout'],
            ['        stdout: "false"', 'stdout'],
            ['        stdout: [true]', 'stdout'],
            ['        stderr: text', 'stderr'],
            ['        stderr: no', 'stderr'],
            ['        stdout: null', 'stdout'],
            ['        stdout:', 'stdout'],
        ] as const) {
            const yaml = `tests:\n  - cmd: echo hi\n    outputs:\n      snapshot:\n${body}\n`;
            const diags = validate(yaml);
            expect(diags, body).toHaveLength(1);
            expect(diags[0].message).toBe(`snapshot: ${stream} must be a boolean`);
            expect(diags[0].severity).toBe(ERROR);
        }

        // The CLI's manual mapping walk does not resolve alias values
        const diags = validate('tests:\n  - desc: &b true\n    cmd: echo hi\n    outputs:\n      snapshot:\n        stdout: *b\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('snapshot: stdout must be a boolean');
    });

    it('flags mappings that enable no stream (empty or all-false)', () => {
        for (const value of ['{}', '{stdout: false}', '{stdout: false, stderr: false}']) {
            const yaml = `tests:\n  - cmd: echo hi\n    outputs:\n      snapshot: ${value}\n`;
            const diags = validate(yaml);
            expect(diags, `snapshot: ${value}`).toHaveLength(1);
            expect(diags[0].message).toBe('snapshot: must enable at least one of stdout, stderr');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('does not cascade the enables-nothing error onto entry-level errors (the CLI stops at its first)', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    outputs:\n      snapshot:\n        stdout: false\n        foo: true\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('snapshot: unknown key "foo" (allowed: stdout, stderr)');
    });

    it('still flags snapshot as an unknown TEST-level key', () => {
        const diags = validate('tests:\n  - cmd: echo hi\n    snapshot: true\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Unknown property "snapshot" (dats will refuse to run this file)');
    });
});

// The `.dats` dialect: tab indentation and bare "!stdout"-style keys. These
// files are what the CLI actually accepts, so they must validate clean.
describe('tab-indented dialect', () => {
    it('accepts a tab-indented file with bare negated keys', () => {
        const dats =
            'shared:\n' +
            '\tfiles:\n' +
            '\t\tconfig.json: |\n' +
            '\t\t\t{"debug": true}\n' +
            'setup:\n' +
            '\t- cat {shared.config.json}\n' +
            'tests:\n' +
            '\t- desc: hello\n' +
            '\t  cmd: echo hi\n' +
            '\t  inputs:\n' +
            '\t\tfiles:\n' +
            '\t\t\tin.txt: content\n' +
            '\t  outputs:\n' +
            '\t\tstdout:\n' +
            '\t\t\t- hi\n' +
            '\t\t!stdout:\n' +
            '\t\t\t- boom\n' +
            '\t\t!stderr:\n' +
            '\t\t\t0: "^never$"\n' +
            '\t\t!files:\n' +
            '\t\t\tstray.txt:\n' +
            '\t\t\t\texists: true\n';
        expect(validate(dats)).toEqual([]);
    });

    it('reports a diagnostic where the source actually says it', () => {
        const diags = validate('tests:\n\t- cmd: echo hi\n\t  bogus: 1\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('Unknown property "bogus" (dats will refuse to run this file)');
        // "\t  bogus" -- the key starts at column 3 of line 2, tabs counted as
        // the single characters they are.
        const range = diags[0].range as any;
        expect([range.startLine, range.startCharacter]).toEqual([2, 3]);
    });

    it('validates inside a negated file check written bare', () => {
        const diags = validate('tests:\n\t- cmd: echo hi\n\t  outputs:\n\t\t!files:\n\t\t\t../escape.txt:\n\t\t\t\texists: true\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('must be a relative path that stays inside the test directory');
    });
});

// Everything below was checked against the real CLI (`dats syntax` probe runs)
// on the tab dialect, which is what a .dats file actually looks like.
describe('file-level sandbox block', () => {
    it('accepts the scalar and mapping forms', () => {
        for (const sandbox of ['sandbox: false\n', 'sandbox: true\n', 'sandbox:\n\tenabled: true\n\tnetwork: false\n\timage: alpine:3.20\n']) {
            expect(validate(`${sandbox}tests:\n\t- cmd: echo hi\n`), sandbox).toEqual([]);
        }
    });

    it('flags a value that is neither a boolean nor a mapping', () => {
        for (const value of ['nope', 'yes', '"true"', '[true]']) {
            const diags = validate(`sandbox: ${value}\ntests:\n\t- cmd: echo hi\n`);
            expect(diags, `sandbox: ${value}`).toHaveLength(1);
            expect(diags[0].message).toBe('sandbox: must be true, false, or a mapping (enabled, network, image)');
            expect(diags[0].severity).toBe(ERROR);
        }
    });

    it('flags a mapping that configures nothing', () => {
        const diags = validate('sandbox: {}\ntests:\n\t- cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('sandbox: mapping must set at least one of enabled, network, image');
    });

    it('flags unknown sandbox keys', () => {
        const diags = validate('sandbox:\n\tbogus: true\ntests:\n\t- cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('sandbox: unknown key "bogus" (allowed: enabled, network, image)');
    });

    it('flags non-boolean enabled/network and a non-string image', () => {
        for (const [body, message] of [
            ['\tenabled: yes', 'sandbox: enabled must be a boolean'],
            ['\tnetwork: 1', 'sandbox: network must be a boolean'],
            ['\timage: 5', 'sandbox: image must be a non-empty string'],
            ['\timage: ""', 'sandbox: image must be a non-empty string'],
        ] as const) {
            const diags = validate(`sandbox:\n${body}\ntests:\n\t- cmd: echo hi\n`);
            expect(diags, body).toHaveLength(1);
            expect(diags[0].message).toBe(message);
        }
    });

    it('flags a matrix placeholder in the image (the sandbox is resolved once per file)', () => {
        const diags = validate('sandbox:\n\timage: "img:{matrix.v}"\ntests:\n\t- cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('sandbox image: {matrix.v} is not available outside tests');
    });
});

describe('copy fixtures (inputs.copy and shared.copy)', () => {
    it('accepts a copy block, alone or beside files', () => {
        expect(validate('tests:\n\t- cmd: echo hi\n\t  inputs:\n\t\tcopy:\n\t\t\treal.bin: fixtures/real.bin\n')).toEqual([]);
        expect(validate('shared:\n\tcopy:\n\t\treal.bin: fixtures/real.bin\ntests:\n\t- cmd: echo hi\n')).toEqual([]);
        expect(
            validate('tests:\n\t- cmd: echo hi\n\t  inputs:\n\t\tfiles:\n\t\t\ta.txt: hi\n\t\tcopy:\n\t\t\tb.bin: fixtures/b.bin\n')
        ).toEqual([]);
    });

    it('flags a destination that escapes the fixture directory', () => {
        const diags = validate('tests:\n\t- cmd: echo hi\n\t  inputs:\n\t\tcopy:\n\t\t\t../evil.txt: src\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('test 1: copy destination "../evil.txt" must be a relative path that stays inside the fixture directory');
        expect(diags[0].severity).toBe(ERROR);
    });

    it('flags an empty or absent source path', () => {
        for (const source of ['""', '', '"   "']) {
            const diags = validate(`tests:\n\t- cmd: echo hi\n\t  inputs:\n\t\tcopy:\n\t\t\tf.txt: ${source}\n`);
            expect(diags, `source: ${source}`).toHaveLength(1);
            expect(diags[0].message).toBe('test 1: copy destination "f.txt" must name a non-empty source path');
        }
    });

    it('flags a name declared under both files and copy', () => {
        const diags = validate('tests:\n\t- cmd: echo hi\n\t  inputs:\n\t\tfiles:\n\t\t\tf.txt: hi\n\t\tcopy:\n\t\t\tf.txt: fixtures/f\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('test 1: "f.txt" is declared under both files and copy');
    });

    it('names the test the CLI would name', () => {
        const diags = validate('tests:\n\t- cmd: echo hi\n\t- cmd: echo bye\n\t  inputs:\n\t\tcopy:\n\t\t\t/abs.txt: src\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('test 2: copy destination "/abs.txt" must be a relative path that stays inside the fixture directory');
    });

    it('substitutes matrix values into a copy source, and flags an undeclared one', () => {
        expect(validate('tests:\n\t- cmd: echo hi\n\t  matrix:\n\t\tn: [1, 2]\n\t  inputs:\n\t\tcopy:\n\t\t\tf.bin: fixtures/{matrix.n}.bin\n')).toEqual([]);

        const diags = validate('tests:\n\t- cmd: echo hi\n\t  inputs:\n\t\tcopy:\n\t\t\tf.bin: fixtures/{matrix.n}.bin\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('{matrix.n} is used but the test declares no matrix');
    });

    it('flags a matrix placeholder in a shared copy source (no instance exists there)', () => {
        const diags = validate('shared:\n\tcopy:\n\t\tf.bin: fixtures/{matrix.n}.bin\ntests:\n\t- cmd: echo hi\n\t  matrix:\n\t\tn: [1]\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('shared copy "f.bin": {matrix.n} is not available outside tests');
    });
});

describe('hook entries in the mapping form', () => {
    it('accepts cmd with env, stdin_file and timeout', () => {
        expect(
            validate('setup:\n\t- cmd: echo a\n\t  timeout: 5s\n\t  stdin_file: in.txt\n\t  env:\n\t\tK: v\ntests:\n\t- cmd: echo hi\n')
        ).toEqual([]);
    });

    it('still rejects a lone mapping (only a list item may be one)', () => {
        const diags = validate('setup:\n\tcmd: echo a\ntests:\n\t- cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('setup must be a command string or a list of command strings');
    });

    it('flags a nested sequence item', () => {
        const diags = validate('setup:\n\t- - nested\ntests:\n\t- cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toBe('setup: command 1 must be a command string or a mapping (cmd, env, stdin_file, timeout)');
    });

    it('flags an entry with no cmd, and unknown entry keys', () => {
        const noCmd = validate('setup:\n\t- env:\n\t\tK: v\ntests:\n\t- cmd: echo hi\n');
        expect(noCmd).toHaveLength(1);
        expect(noCmd[0].message).toBe('setup: command 1: must set cmd');

        const unknown = validate('teardown:\n\t- cmd: echo a\n\t  bogus: 1\ntests:\n\t- cmd: echo hi\n');
        expect(unknown).toHaveLength(1);
        expect(unknown[0].message).toBe('teardown: command 1: unknown key "bogus" (allowed: cmd, env, stdin_file, timeout)');
    });

    it('flags a non-string env value and a non-mapping env', () => {
        const nonString = validate('setup:\n\t- cmd: echo a\n\t  env:\n\t\tK: 5\ntests:\n\t- cmd: echo hi\n');
        expect(nonString).toHaveLength(1);
        expect(nonString[0].message).toBe('setup: command 1: env: "K" must be a string');

        const nonMapping = validate('setup:\n\t- cmd: echo a\n\t  env: nope\ntests:\n\t- cmd: echo hi\n');
        expect(nonMapping).toHaveLength(1);
        expect(nonMapping[0].message).toBe('setup: command 1: env must be a mapping of variable name to value');
    });

    it('flags an empty stdin_file and a zero timeout', () => {
        const stdin = validate('setup:\n\t- cmd: echo a\n\t  stdin_file: ""\ntests:\n\t- cmd: echo hi\n');
        expect(stdin).toHaveLength(1);
        expect(stdin[0].message).toBe('setup: command 1: stdin_file must be a non-empty string');

        for (const timeout of ['0', '0s']) {
            const diags = validate(`setup:\n\t- cmd: echo a\n\t  timeout: ${timeout}\ntests:\n\t- cmd: echo hi\n`);
            expect(diags, `timeout: ${timeout}`).toHaveLength(1);
            expect(diags[0].message).toBe('setup: command 1: timeout must be greater than 0 (omit it to use the default 30s)');
        }
    });

    it('flags matrix placeholders in an entry env value and stdin_file', () => {
        const env = validate('setup:\n\t- cmd: echo a\n\t  env:\n\t\tK: "{matrix.n}"\ntests:\n\t- cmd: echo hi\n');
        expect(env).toHaveLength(1);
        expect(env[0].message).toBe('setup command 1: env "K": {matrix.n} is not available outside tests');

        const stdin = validate('setup:\n\t- cmd: echo a\n\t  stdin_file: "{matrix.n}.txt"\ntests:\n\t- cmd: echo hi\n');
        expect(stdin).toHaveLength(1);
        expect(stdin[0].message).toBe('setup command 1: stdin_file: {matrix.n} is not available outside tests');
    });
});

describe('heredocs and herestrings are rejected in commands', () => {
    it('flags them in a test cmd, naming the test', () => {
        const heredoc = validate('tests:\n\t- cmd: cat <<EOF\n');
        expect(heredoc).toHaveLength(1);
        expect(heredoc[0].message).toBe(
            'test 1: cmd: must not use a shell heredoc (<<WORD) -- write the file and pull it in with inputs.files/inputs.copy or shared.files/shared.copy instead'
        );

        const herestring = validate('tests:\n\t- cmd: cat <<< hi\n');
        expect(herestring).toHaveLength(1);
        expect(herestring[0].message).toBe(
            'test 1: cmd: must not use a shell herestring (<<<) -- use inputs.stdin (or a pipe within cmd) instead of redirecting from the end of the line'
        );
    });

    it('flags them in a hook command', () => {
        const diags = validate('setup:\n\t- cat <<EOF\ntests:\n\t- cmd: echo hi\n');
        expect(diags).toHaveLength(1);
        expect(diags[0].message).toContain('setup: command 1: must not use a shell heredoc (<<WORD)');
    });
});

describe('outputs.files exists', () => {
    it('flags a non-boolean exists (the CLI cannot decode it into a bool)', () => {
        for (const value of ['yes', '1', '"true"']) {
            const diags = validate(`tests:\n\t- cmd: echo hi\n\t  outputs:\n\t\tfiles:\n\t\t\tf.txt:\n\t\t\t\texists: ${value}\n`);
            expect(diags, `exists: ${value}`).toHaveLength(1);
            expect(diags[0].message).toBe('"exists" must be a boolean (dats will refuse to run this file)');
        }
        // an absent value decodes to false, which the CLI accepts
        expect(validate('tests:\n\t- cmd: echo hi\n\t  outputs:\n\t\tfiles:\n\t\t\tf.txt:\n\t\t\t\texists:\n')).toEqual([]);
    });
});

