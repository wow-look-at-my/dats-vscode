import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { Registry, parseRawGrammar, INITIAL, IGrammar } from 'vscode-textmate';

// Tokenizes .dats samples the same way VS Code does: the dats grammar layered over the
// REAL built-in YAML grammar (vendored in testdata/yaml-grammar). The built-in YAML
// grammar claims whole-document regions, so the dats shell/placeholder rules only work
// if the grammar's injections reach through it - this is the regression test for that.

const repoRoot = join(__dirname, '..');
const fixtureDir = join(repoRoot, 'testdata', 'yaml-grammar');

const GRAMMAR_PATHS: Record<string, string> = {
    'source.dats': join(repoRoot, 'syntaxes', 'dats.tmLanguage.json'),
    'source.yaml': join(fixtureDir, 'yaml.tmLanguage.json'),
    'source.yaml.1.0': join(fixtureDir, 'yaml-1.0.tmLanguage.json'),
    'source.yaml.1.1': join(fixtureDir, 'yaml-1.1.tmLanguage.json'),
    'source.yaml.1.2': join(fixtureDir, 'yaml-1.2.tmLanguage.json'),
    'source.yaml.1.3': join(fixtureDir, 'yaml-1.3.tmLanguage.json'),
    'source.yaml.embedded': join(fixtureDir, 'yaml-embedded.tmLanguage.json'),
};

interface Token {
    text: string;
    scopes: string[];
}

let grammar: IGrammar;

beforeAll(async () => {
    const wasmBin = readFileSync(
        join(repoRoot, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')
    ).buffer;
    await loadWASM(wasmBin);

    const registry = new Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
            createOnigString: (s: string) => new OnigString(s),
        }),
        loadGrammar: async (scopeName: string) => {
            const path = GRAMMAR_PATHS[scopeName];
            if (!path) {
                throw new Error(`no grammar fixture registered for scope "${scopeName}"`);
            }
            return parseRawGrammar(readFileSync(path, 'utf8'), path);
        },
    });

    const loaded = await registry.loadGrammar('source.dats');
    if (!loaded) throw new Error('failed to load source.dats grammar');
    grammar = loaded;
});

function tokenize(lines: string[]): Token[][] {
    const result: Token[][] = [];
    let ruleStack = INITIAL;
    for (const line of lines) {
        const r = grammar.tokenizeLine(line, ruleStack);
        result.push(
            r.tokens.map(t => ({
                text: line.substring(t.startIndex, t.endIndex),
                scopes: t.scopes,
            }))
        );
        ruleStack = r.ruleStack;
    }
    return result;
}

/** Scopes of the first token on the given line whose trimmed text equals `text`. */
function scopesOf(tokens: Token[][], lineIdx: number, text: string): string[] {
    const token = tokens[lineIdx].find(t => t.text.trim() === text);
    expect(token, `token "${text}" on line ${lineIdx}: ${JSON.stringify(tokens[lineIdx])}`).toBeDefined();
    return token!.scopes;
}

describe('dats grammar injection over the built-in YAML grammar', () => {
    it('scopes cmd values as shell and placeholders as dats variables', () => {
        const tokens = tokenize([
            'tests:',
            '  - desc: copy a file',
            '    cmd: cp {inputs.data.txt} {outputs.copy.txt}',
        ]);

        // YAML scopes still come from the built-in grammar
        expect(scopesOf(tokens, 0, 'tests')).toContain('entity.name.tag.yaml');
        expect(scopesOf(tokens, 1, 'desc')).toContain('entity.name.tag.yaml');

        // ...and the dats rules reach through it on the cmd line
        expect(scopesOf(tokens, 2, 'cmd')).toContain('entity.name.tag.yaml');
        expect(scopesOf(tokens, 2, 'cp')).toContain('entity.name.function.shell');
        expect(scopesOf(tokens, 2, '{inputs.data.txt}')).toContain('variable.parameter.dats');
        expect(scopesOf(tokens, 2, '{outputs.copy.txt}')).toContain('variable.parameter.dats');
    });

    it('scopes shell args, flags, variables and strings on cmd lines', () => {
        const tokens = tokenize([
            'tests:',
            "  - cmd: grep -q --file={inputs.pat} \"$HOME dir\" 'lit {inputs.x}'",
        ]);

        expect(scopesOf(tokens, 1, 'grep')).toContain('entity.name.function.shell');
        expect(scopesOf(tokens, 1, '-q')).toContain('constant.other.option.shell');
        expect(scopesOf(tokens, 1, '--file')).toContain('entity.other.attribute-name.shell');
        expect(scopesOf(tokens, 1, '$HOME')).toContain('variable.other.shell');
        // placeholders are highlighted inside single- AND double-quoted shell strings
        expect(scopesOf(tokens, 1, '{inputs.x}')).toContain('variable.parameter.dats');
        expect(scopesOf(tokens, 1, '{inputs.x}')).toContain('string.quoted.single.shell');
    });

    it('closes command substitution $(...) instead of swallowing the rest of the line', () => {
        const tokens = tokenize(['tests:', '  - cmd: echo $(basename foo) after']);

        const closeParen = tokens[1].filter(t => t.text === ')');
        expect(closeParen.length).toBeGreaterThan(0);
        expect(closeParen[0].scopes).toContain('string.interpolated.shell');
        // the token following the substitution is a plain argument again
        const after = scopesOf(tokens, 1, 'after');
        expect(after).not.toContain('string.interpolated.shell');
        expect(after).toContain('string.unquoted.argument.shell');
    });

    it('leaves cmd block scalars (| and >) entirely to the YAML grammar', () => {
        const tokens = tokenize([
            'tests:',
            '  - cmd: |',
            '      not shell | here > at all',
            '  - cmd: >-',
            '      folded body',
        ]);

        const pipe = scopesOf(tokens, 1, '|');
        expect(pipe).toContain('keyword.control.flow.block-scalar.literal.yaml');
        expect(pipe).not.toContain('keyword.operator.pipe.shell');

        // block scalar bodies get no shell scopes
        for (const bodyLine of [2, 4]) {
            for (const token of tokens[bodyLine]) {
                expect(token.scopes.filter(s => s.endsWith('.shell'))).toEqual([]);
            }
        }
    });

    it('does not scope a leading flag as the command name', () => {
        const tokens = tokenize(['tests:', '  - cmd:  --flag=val positional']);

        const flag = scopesOf(tokens, 1, '--flag');
        expect(flag).not.toContain('entity.name.function.shell');
        expect(flag).toContain('entity.other.attribute-name.shell');
        expect(scopesOf(tokens, 1, 'positional')).toContain('string.unquoted.argument.shell');
    });

    it('scopes command names after pipes, && and ;', () => {
        const tokens = tokenize(['tests:', '  - cmd: a | b && c; d']);

        for (const word of ['a', 'b', 'c', 'd']) {
            expect(scopesOf(tokens, 1, word)).toContain('entity.name.function.shell');
        }
        expect(scopesOf(tokens, 1, '|')).toContain('keyword.operator.pipe.shell');
    });

    it('highlights placeholders outside cmd lines (quoted patterns, file contents)', () => {
        const tokens = tokenize([
            'tests:',
            '  - cmd: echo hi',
            '    outputs:',
            '      stdout:',
            '        - "wrote {outputs.copy.txt}"',
        ]);

        const placeholder = scopesOf(tokens, 4, '{outputs.copy.txt}');
        expect(placeholder).toContain('variable.parameter.dats');
        expect(placeholder).toContain('string.quoted.double.yaml');
    });

    it('tokenizes new-format files (setup/teardown/shared/matrix) without breaking', () => {
        const tokens = tokenize([
            'shared:',
            '  files:',
            '    cfg.json: \'{"a": 1}\'',
            'setup:',
            '  - echo ready',
            'tests:',
            '  - cmd: cat {shared.cfg.json} && echo {matrix.word}',
            '    matrix:',
            '      word: [hello, howdy]',
        ]);

        // the new keys are plain YAML keys for the built-in grammar
        expect(scopesOf(tokens, 0, 'shared')).toContain('entity.name.tag.yaml');
        expect(scopesOf(tokens, 3, 'setup')).toContain('entity.name.tag.yaml');
        expect(scopesOf(tokens, 7, 'matrix')).toContain('entity.name.tag.yaml');

        // setup commands are NOT cmd lines: no shell scopes (documented gap)
        for (const token of tokens[4]) {
            expect(token.scopes.filter(s => s.endsWith('.shell'))).toEqual([]);
        }

        // cmd lines still get their shell scopes
        expect(scopesOf(tokens, 6, 'cat')).toContain('entity.name.function.shell');
        expect(scopesOf(tokens, 6, 'echo')).toContain('entity.name.function.shell');

        // {shared.X}/{matrix.X} are ordinary shell arguments, not dats
        // placeholders -- highlighting them is a documented cosmetic gap
        for (const placeholder of ['{shared.cfg.json}', '{matrix.word}']) {
            const scopes = scopesOf(tokens, 6, placeholder);
            expect(scopes).toContain('string.unquoted.argument.shell');
            expect(scopes).not.toContain('variable.parameter.dats');
        }
    });

    it('tokenizes snapshot-format files (outputs.snapshot) without breaking', () => {
        const tokens = tokenize([
            'tests:',
            '  - cmd: echo hello',
            '    outputs:',
            '      snapshot: true',
            '  - cmd: echo again',
            '    outputs:',
            '      snapshot:',
            '        stdout: true',
            '        stderr: false',
        ]);

        // the new key is a plain YAML key for the built-in grammar, in both
        // its scalar and stream-map forms
        expect(scopesOf(tokens, 3, 'snapshot')).toContain('entity.name.tag.yaml');
        expect(scopesOf(tokens, 6, 'snapshot')).toContain('entity.name.tag.yaml');
        expect(scopesOf(tokens, 7, 'stdout')).toContain('entity.name.tag.yaml');
        expect(scopesOf(tokens, 8, 'stderr')).toContain('entity.name.tag.yaml');

        // snapshot lines are NOT cmd lines: no shell scopes leak onto them
        for (const lineIdx of [3, 6, 7, 8]) {
            for (const token of tokens[lineIdx]) {
                expect(
                    token.scopes.filter(s => s.endsWith('.shell')),
                    `line ${lineIdx} token ${JSON.stringify(token.text)}`
                ).toEqual([]);
            }
        }

        // cmd lines still get their shell scopes
        expect(scopesOf(tokens, 1, 'echo')).toContain('entity.name.function.shell');
        expect(scopesOf(tokens, 4, 'echo')).toContain('entity.name.function.shell');
    });

    it('only treats a line-leading cmd key as a shell command', () => {
        const tokens = tokenize([
            'tests:',
            '  - desc: "note cmd: not-a-key"',
            '    ncmd: plain value',
            '    inputs:',
            '      files:',
            '        script.cmd: also plain',
        ]);

        for (const lineIdx of [1, 2, 5]) {
            for (const token of tokens[lineIdx]) {
                expect(
                    token.scopes.filter(s => s.endsWith('.shell')),
                    `line ${lineIdx} token ${JSON.stringify(token.text)}`
                ).toEqual([]);
            }
        }
    });
});
