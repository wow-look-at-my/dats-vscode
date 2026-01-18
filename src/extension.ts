import * as vscode from 'vscode';
import { findTestRange, findInputs, findOutputs, matchInputsPlaceholder, matchOutputsPlaceholder } from './parser';
import { validateDatsDocument } from './validator';
import { DatsHoverProvider } from './hover';
import { DatsKeyCompletionProvider } from './keyCompletion';

export function activate(context: vscode.ExtensionContext) {
    // Schema validation diagnostics
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('dats');
    context.subscriptions.push(diagnosticCollection);

    const validateDocument = (document: vscode.TextDocument) => {
        if (document.languageId !== 'dats') return;
        const diagnostics = validateDatsDocument(document);
        diagnosticCollection.set(document.uri, diagnostics);
    };

    // Validate all open dats documents on activation
    vscode.workspace.textDocuments.forEach(validateDocument);

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(validateDocument),
        vscode.workspace.onDidChangeTextDocument(e => validateDocument(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri))
    );

    // Register completion provider for {inputs.X} and {outputs.X}
    const placeholderCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'dats',
        new DatsCompletionProvider(),
        '.', '{' // Trigger on . and {
    );

    // Register completion provider for YAML keys
    const keyCompletionProvider = vscode.languages.registerCompletionItemProvider(
        'dats',
        new DatsKeyCompletionProvider()
    );

    // Register hover provider for field documentation
    const hoverProvider = vscode.languages.registerHoverProvider('dats', new DatsHoverProvider());

    context.subscriptions.push(placeholderCompletionProvider, keyCompletionProvider, hoverProvider);
}

export function deactivate() {}

class DatsCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] | undefined {
        const lineText = document.lineAt(position).text;
        const textBeforeCursor = lineText.substring(0, position.character);

        // Check if we're typing {inputs. or {outputs.
        const inputsPrefix = matchInputsPlaceholder(textBeforeCursor);
        if (inputsPrefix !== undefined) {
            const inputs = this.findInputsInCurrentTest(document, position);
            return this.createCompletions(inputs, inputsPrefix, 'input');
        }

        const outputsPrefix = matchOutputsPlaceholder(textBeforeCursor);
        if (outputsPrefix !== undefined) {
            const outputs = this.findOutputsInCurrentTest(document, position);
            return this.createCompletions(outputs, outputsPrefix, 'output');
        }

        // Check if we just typed { - suggest {inputs.X} and {outputs.X} with known files
        if (textBeforeCursor.endsWith('{')) {
            const completions: vscode.CompletionItem[] = [];

            // Add known inputs from current test
            const inputs = this.findInputsInCurrentTest(document, position);
            for (const input of inputs) {
                const item = new vscode.CompletionItem(
                    `{inputs.${input}}`,
                    vscode.CompletionItemKind.Variable
                );
                item.insertText = `inputs.${input}}`;
                item.detail = 'input file';
                item.documentation = `Reference to input file "${input}"`;
                item.sortText = '0' + input; // Sort inputs first
                completions.push(item);
            }

            // Add known outputs from current test
            const outputs = this.findOutputsInCurrentTest(document, position);
            for (const output of outputs) {
                const item = new vscode.CompletionItem(
                    `{outputs.${output}}`,
                    vscode.CompletionItemKind.Variable
                );
                item.insertText = `outputs.${output}}`;
                item.detail = 'output file';
                item.documentation = `Reference to output file "${output}"`;
                item.sortText = '1' + output; // Sort outputs after inputs
                completions.push(item);
            }

            // Add generic snippets if no specific files found
            if (inputs.length === 0) {
                const item = new vscode.CompletionItem('{inputs.}', vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString('inputs.${1:filename}}');
                item.detail = 'Reference an input file';
                item.sortText = '2inputs';
                completions.push(item);
            }
            if (outputs.length === 0) {
                const item = new vscode.CompletionItem('{outputs.}', vscode.CompletionItemKind.Snippet);
                item.insertText = new vscode.SnippetString('outputs.${1:filename}}');
                item.detail = 'Reference an output file';
                item.sortText = '2outputs';
                completions.push(item);
            }

            return completions;
        }

        return undefined;
    }

    private createCompletions(
        names: string[],
        prefix: string,
        type: 'input' | 'output'
    ): vscode.CompletionItem[] {
        return names
            .filter(name => name.startsWith(prefix))
            .map(name => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
                item.detail = `${type} file`;
                item.insertText = name.substring(prefix.length) + '}';
                item.documentation = `Reference to ${type} file "${name}"`;
                return item;
            });
    }

    private findInputsInCurrentTest(document: vscode.TextDocument, position: vscode.Position): string[] {
        const lines = document.getText().split('\n');
        const range = findTestRange(lines, position.line);
        if (!range) return [];

        const testLines = lines.slice(range[0], range[1]);
        return findInputs(testLines);
    }

    private findOutputsInCurrentTest(document: vscode.TextDocument, position: vscode.Position): string[] {
        const lines = document.getText().split('\n');
        const range = findTestRange(lines, position.line);
        if (!range) return [];

        const testLines = lines.slice(range[0], range[1]);
        return findOutputs(testLines);
    }
}
