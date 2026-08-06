// The `yaml` package parses standard YAML; `.dats` files are yaml-fixed, which
// differs in two ways that make a real file unparseable here: structural depth
// is a count of leading TABS (standard YAML rejects tabs as indentation), and
// tags do not exist, so the negated assertion keys are written bare (`!stdout:`,
// which standard YAML reads as a tag on the following node).
//
// normalizeDats rewrites a source file into the equivalent standard YAML -- one
// output line per input line, so line numbers are unchanged -- and hands back a
// column mapper that puts a diagnostic back where the user actually typed it.
// see docs/dialect.md

/** A source file rewritten into standard YAML, plus the mapping back. */
export interface DialectSource {
    /** Standard-YAML text, same number of lines as the input. */
    text: string;
    /** Maps a 0-based column in the normalized text back to the source column. */
    toSourceCol(line: number, col: number): number;
    /** Offset in the normalized text of a 0-based source (line, col). */
    toNormalizedOffset(line: number, col: number): number;
}

// A column at or past `from` (in the normalized line) sits `delta` columns to
// the right of where it does in the source.
interface Shift {
    from: number;
    delta: number;
}

const IDENTITY: (line: number, col: number) => number = (_line, col) => col;

// A bare `!key:` at the start of a line's content, optionally after a "- "
// sequence marker. Quoting it is what stops the yaml parser reading it as a tag.
const BARE_BANG_KEY = /^(-\s+)?(![^\s:'"]*)(?=\s*:)/;

export function normalizeDats(text: string): DialectSource {
    // A file with no tab indentation is not in the dialect (the CLI rejects it),
    // so leave it exactly as written rather than guessing at its structure.
    if (!/^\t/m.test(text)) {
        return { text, toSourceCol: IDENTITY, toNormalizedOffset: offsetAt(text, IDENTITY) };
    }

    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    const shifts: Shift[][] = [];
    // kinds[d] is what depth d holds in the block currently being read: a
    // sequence once a "- " line appears there (its item bodies are the deeper
    // lines plus the same-depth non-dash ones), otherwise a mapping.
    const kinds: ('map' | 'seq')[] = [];

    for (const line of lines) {
        const indent = /^(\t*)( *)/.exec(line)!;
        const depth = indent[1].length;
        const align = indent[2].length;
        const content = line.slice(depth + align);

        if (content === '') {
            out.push('');
            shifts.push([]);
            continue;
        }
        if (depth === 0 && align > 0) {
            // Space-indented line in a tab-indented file: the CLI rejects it and
            // this pass cannot place it, so pass it through and let yaml judge.
            out.push(line);
            shifts.push([]);
            continue;
        }

        const isDash = content === '-' || content.startsWith('- ');
        // Deeper levels belong to a block that just ended; this depth's own kind
        // survives, since a non-dash line under a sequence is an item body.
        kinds.length = Math.min(kinds.length, depth + 1);
        if (isDash || kinds[depth] === undefined) {
            kinds[depth] = isDash ? 'seq' : 'map';
        }

        // Each level costs two columns, and a sequence level costs two more so
        // that a child clears its item's body column (dash + space).
        let base = 0;
        for (let d = 0; d < depth; d++) {
            base += kinds[d] === 'seq' ? 4 : 2;
        }
        // A non-dash line under a sequence continues that item's body.
        const column = !isDash && kinds[depth] === 'seq' ? base + 2 : base;

        const sourceStart = depth + align;
        const lineShifts: Shift[] = [{ from: column, delta: column - sourceStart }];
        const quoted = content.replace(BARE_BANG_KEY, (_m, dash: string | undefined, key: string) => {
            const keyStart = column + (dash?.length ?? 0);
            lineShifts.push({ from: keyStart + 1, delta: lineShifts[0].delta + 1 });
            lineShifts.push({ from: keyStart + key.length + 2, delta: lineShifts[0].delta + 2 });
            return `${dash ?? ''}"${key}"`;
        });

        out.push(' '.repeat(column) + quoted);
        shifts.push(lineShifts);
    }

    const normalized = out.join('\n');
    const toSourceCol = (line: number, col: number): number => {
        const lineShifts = shifts[line];
        if (!lineShifts || lineShifts.length === 0) return col;
        // Inside the rewritten indentation there is no matching source column;
        // the nearest honest answer is where the content starts.
        if (col < lineShifts[0].from) {
            return Math.min(col, lineShifts[0].from - lineShifts[0].delta);
        }
        let delta = 0;
        for (const shift of lineShifts) {
            if (col >= shift.from) delta = shift.delta;
        }
        return Math.max(0, col - delta);
    };
    const toNormalizedCol = (line: number, col: number): number => {
        const lineShifts = shifts[line];
        if (!lineShifts || lineShifts.length === 0) return col;
        let delta = 0;
        for (const shift of lineShifts) {
            if (col >= shift.from - shift.delta) delta = shift.delta;
        }
        return col + delta;
    };

    return { text: normalized, toSourceCol, toNormalizedOffset: offsetAt(normalized, toNormalizedCol) };
}

// offsetAt turns a 0-based (line, col) in the SOURCE into an offset into text,
// putting the column through mapCol first.
function offsetAt(text: string, mapCol: (line: number, col: number) => number): (line: number, col: number) => number {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') lineStarts.push(i + 1);
    }
    return (line, col) => {
        const start = lineStarts[Math.min(Math.max(line, 0), lineStarts.length - 1)];
        return Math.min(start + mapCol(line, col), text.length);
    };
}
