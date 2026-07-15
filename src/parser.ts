// Pure parsing functions - no VS Code dependencies

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
            const testsMatch = line.match(/^(\s*)tests\s*:/);
            if (testsMatch) testsIndent = testsMatch[1].length;
            continue;
        }

        const indent = line.match(/^(\s*)/)![1].length;
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
            blockIndent = blockMatch[1].length;
            continue;
        }

        if (inBlock) {
            const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
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
            blockIndent = blockMatch[1].length;
            keyIndent = -1; // Will be set by first key
            continue;
        }

        if (inBlock) {
            const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
            const isNonEmpty = line.trim().length > 0;

            // Check if we've exited the block (same or less indentation, non-empty)
            if (isNonEmpty && currentIndent <= blockIndent) {
                inBlock = false;
                continue;
            }

            // Extract key - only at the first level of indentation after block header
            const keyMatch = line.match(/^(\s+)([a-zA-Z0-9_."!-]+):/);
            if (keyMatch) {
                const thisIndent = keyMatch[1].length;

                // Set expected key indent from first key found
                if (keyIndent === -1 && thisIndent > blockIndent) {
                    keyIndent = thisIndent;
                }

                // Only extract if at the expected key indentation level
                if (thisIndent === keyIndent) {
                    // Remove quotes if present
                    const key = keyMatch[2].replace(/^"|"$/g, '');
                    keys.push(key);
                }
            }
        }
    }

    return keys;
}

/**
 * Find input file names declared under inputs.files in the given test lines
 */
export function findInputs(testLines: string[]): string[] {
    return extractBlockKeys(extractBlockLines(testLines, 'inputs'), 'files');
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
