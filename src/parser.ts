// Pure parsing functions - no VS Code dependencies

/**
 * Find the range of the current test given document lines and cursor position
 * Returns [startLine, endLine] or undefined if not in a test
 */
export function findTestRange(lines: string[], cursorLine: number): [number, number] | undefined {
    let testStart = -1;
    let testEnd = lines.length;

    // Search backwards for test start
    for (let i = cursorLine; i >= 0; i--) {
        if (lines[i].match(/^\s*-\s*name:/)) {
            testStart = i;
            break;
        }
    }

    if (testStart === -1) return undefined;

    // Search forwards for next test or end
    for (let i = cursorLine + 1; i < lines.length; i++) {
        if (lines[i].match(/^\s*-\s*name:/)) {
            testEnd = i;
            break;
        }
    }

    return [testStart, testEnd];
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

    for (const line of lines) {
        // Check if this line starts the block we're looking for
        const blockMatch = line.match(new RegExp(`^(\\s*)${blockName}:\\s*$`));
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
 * Find input file names in the given test lines
 */
export function findInputs(testLines: string[]): string[] {
    return extractBlockKeys(testLines, 'inputs');
}

/**
 * Find output file names in the given test lines (excluding reserved keys)
 */
export function findOutputs(testLines: string[]): string[] {
    const allKeys = extractBlockKeys(testLines, 'outputs');
    const reservedKeys = ['stdout', 'stderr', '!stdout', '!stderr'];
    return allKeys.filter(key => !reservedKeys.includes(key));
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
