# Test fixtures: VS Code built-in YAML grammar

Copied verbatim from [microsoft/vscode `1.108.0`](https://github.com/microsoft/vscode/tree/1.108.0/extensions/yaml/syntaxes)
(`extensions/yaml/syntaxes/`, MIT licensed; itself converted from
[RedCMD/YAML-Syntax-Highlighter](https://github.com/RedCMD/YAML-Syntax-Highlighter), MIT).

`src/grammar.test.ts` registers these alongside `syntaxes/dats.tmLanguage.json` so the
tokenization tests reproduce exactly what a real VS Code install does: the built-in
`source.yaml` grammar claims whole-document regions, and the dats rules must reach
through it via the grammar's `injections`. Do not edit these files; re-copy them from a
newer VS Code tag if the built-in grammar changes.

These fixtures are test-only and are not shipped in the VSIX (the `files` whitelist in
`package.json` governs packaging).
