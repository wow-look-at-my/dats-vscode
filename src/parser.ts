// Pure parsing functions - no VS Code dependencies

/**
 * Structural depth of a line. In the dats dialect that is its count of leading
 * TABS -- spaces after them align a sequence item's keys past its "- " and
 * never nest -- so counting characters would read a "\t\tfiles:" as SHALLOWER
 * than the "\t  inputs:" holding it. A space-indented file (which the CLI
 * rejects, but the editor still opens) keeps the old count-the-spaces reading.
 */
function indentDepth(line: string): number {
    const indent = /^(\t*)( *)/.exec(line)!;
    return indent[1].length > 0 ? indent[1].length : indent[2].length;
}

/**
 * Find the range of the current test given document lines and cursor position
 * Returns [startLine, endLine] or undefined if not in a test
 *
 * A test is any sequence item directly under the `tests:` key. Nested sequence
 * items (e.g. stdout pattern lists) are distinguished by their deeper
 * indentation.
 */
export function findTestRange(lines: string[], cursorLine: number): [number, number] | undefined {
    let testsIndent = -1;
    let itemIndent = -1;
    let testStart = -1;
    let testEnd = lines.length;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

        if (testsIndent === -1) {
            if (/^\s*tests\s*:/.test(line)) testsIndent = indentDepth(line);
            continue;
        }

        const indent = indentDepth(line);
        const isItem = /^\s*-(\s|$)/.test(line);

        // The first item under tests: determines the indentation of all test
        // items (YAML also allows items at the same indent as the tests: key).
        if (isItem && (itemIndent === -1 || indent === itemIndent)) {
            itemIndent = indent;
            if (i <= cursorLine) {
                testStart = i;
            } else {
                testEnd = i;
                break;
            }
            continue;
        }

        // A non-item line at or above the tests: indentation ends the block.
        if (!isItem && indent <= testsIndent) {
            if (i <= cursorLine) return undefined;
            testEnd = i;
            break;
        }
    }

    if (testStart === -1) return undefined;
    return [testStart, testEnd];
}

/**
 * Extract the lines nested inside the first `blockName:` mapping block
 */
export function extractBlockLines(lines: string[], blockName: string): string[] {
    const result: string[] = [];
    let inBlock = false;
    let blockIndent = -1;
    const blockPattern = new RegExp(`^(\\s*)${blockName}:\\s*(#.*)?$`);

    for (const line of lines) {
        const blockMatch = line.match(blockPattern);
        if (!inBlock && blockMatch) {
            inBlock = true;
            blockIndent = indentDepth(line);
            continue;
        }

        if (inBlock) {
            const currentIndent = indentDepth(line);
            const isNonEmpty = line.trim().length > 0;
            if (isNonEmpty && currentIndent <= blockIndent) break;
            result.push(line);
        }
    }

    return result;
}

/**
 * Extract keys from a YAML block within the given lines
 * Only extracts immediate children (one indentation level deeper)
 */
export function extractBlockKeys(lines: string[], blockName: string): string[] {
    const keys: string[] = [];
    let inBlock = false;
    let blockIndent = -1;
    let keyIndent = -1; // The expected indentation for keys
    const blockPattern = new RegExp(`^(\\s*)${blockName}:\\s*(#.*)?$`);

    for (const line of lines) {
        // Check if this line starts the block we're looking for
        const blockMatch = line.match(blockPattern);
        if (blockMatch) {
            inBlock = true;
            blockIndent = indentDepth(line);
            keyIndent = -1; // Will be set by first key
            continue;
        }

        if (inBlock) {
            const currentIndent = indentDepth(line);
            const isNonEmpty = line.trim().length > 0;

            // Check if we've exited the block (same or less indentation, non-empty)
            if (isNonEmpty && currentIndent <= blockIndent) {
                inBlock = false;
                continue;
            }

            // Extract key - only at the first level of indentation after block header
            // Fixture names may be nested paths (sub/file.txt)
            const keyMatch = line.match(/^\s+([a-zA-Z0-9_./"!-]+):/);
            if (keyMatch) {
                const thisIndent = currentIndent;

                // Set expected key indent from first key found
                if (keyIndent === -1 && thisIndent > blockIndent) {
                    keyIndent = thisIndent;
                }

                // Only extract if at the expected key indentation level
                if (thisIndent === keyIndent) {
                    // Remove quotes if present
                    const key = keyMatch[1].replace(/^"|"$/g, '');
                    keys.push(key);
                }
            }
        }
    }

    return keys;
}

/**
 * Find input fixture names in the given test lines. files and copy share one
 * directory and one {inputs.X} namespace, so both are offered.
 */
export function findInputs(testLines: string[]): string[] {
    const inputs = extractBlockLines(testLines, 'inputs');
    return dedupe([...extractBlockKeys(inputs, 'files'), ...extractBlockKeys(inputs, 'copy')]);
}

/**
 * Find shared fixture names declared in the file-level shared block (files and
 * copy alike), addressed as {shared.X} from anywhere in the file.
 */
export function findShared(lines: string[]): string[] {
    const shared = extractBlockLines(lines, 'shared');
    return dedupe([...extractBlockKeys(shared, 'files'), ...extractBlockKeys(shared, 'copy')]);
}

function dedupe(names: string[]): string[] {
    return [...new Set(names)];
}

/**
 * Find output file names declared under outputs.files in the given test lines
 */
export function findOutputs(testLines: string[]): string[] {
    return extractBlockKeys(extractBlockLines(testLines, 'outputs'), 'files');
}

/**
 * Check if text before cursor matches {inputs. pattern
 * Returns the prefix after the dot, or undefined if no match
 */
export function matchInputsPlaceholder(textBeforeCursor: string): string | undefined {
    const match = textBeforeCursor.match(/\{inputs\.([a-zA-Z0-9_.-]*)$/);
    return match ? match[1] : undefined;
}

/**
 * Check if text before cursor matches {outputs. pattern
 * Returns the prefix after the dot, or undefined if no match
 */
export function matchOutputsPlaceholder(textBeforeCursor: string): string | undefined {
    const match = textBeforeCursor.match(/\{outputs\.([a-zA-Z0-9_.-]*)$/);
    return match ? match[1] : undefined;
}

/**
 * Check if text before cursor matches {shared. pattern
 * Returns the prefix after the dot, or undefined if no match
 */
export function matchSharedPlaceholder(textBeforeCursor: string): string | undefined {
    const match = textBeforeCursor.match(/\{shared\.([a-zA-Z0-9_.-]*)$/);
    return match ? match[1] : undefined;
}
