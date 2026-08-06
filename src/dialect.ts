// The `yaml` package parses standard YAML; `.dats` files are yaml-fixed, which
// differs in three ways that make a real file unparseable here: structural depth
// is a count of leading TABS (standard YAML rejects tabs as indentation), tags do
// not exist so the negated assertion keys are written bare (`!stdout:`, which
// standard YAML reads as a tag on the following node), and a plain value runs to
// the end of the line, so a shell command may hold a ": " that standard YAML
// re-reads as a nested mapping.
//
// normalizeDats rewrites a source file into the equivalent standard YAML -- one
// output line per input line, so line numbers are unchanged -- and hands back a
// column mapper that puts a diagnostic back where the user actually typed it.
// see docs/dialect.md

/** A source file rewritten into standard YAML, plus the mapping back. */
export interface DialectSource {
    /** Standard-YAML text, same number of lines as the input. */
    text: string;
    /**
     * The first flow collection left open at the end of its line, if any. The
     * block parser reads one line at a time, so `stdout: [` continued on the
     * next line is where the CLI stops -- the `yaml` package would accept it.
     */
    flowError?: DialectError;
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

// A bare `!key` is a tag to the yaml parser; quoting it makes it the key it is.
const BARE_BANG_KEY = /^![^\s:'"]*$/;

// A plain scalar standard YAML would not read as the whole value written here:
// one holding a ": " or ending in ":" starts a nested mapping, and one opening
// with an indicator character means something else (a tag, an anchor, an alias,
// a directive, ...).
const SCALAR_NEEDS_QUOTING = /:(\s|$)|^[!&*@`%?,\]}]/;
// After "key:" a leading dash is a value the CLI reads as text, where standard
// YAML wants a sequence. After a "- " marker it IS a nested sequence in both,
// so only a mapping value adds this.
const VALUE_DASH = /^-(\s|$)/;

// A block scalar header (`|`, `>`, with chomping/indent indicators and an
// optional comment): its body lines are content, not structure.
const BLOCK_SCALAR_HEADER = /^[|>][-+0-9]*\s*(#.*)?$/;

/** Where a line breaks a dialect rule, and what to say about it. */
export interface DialectError {
    line: number;
    col: number;
    endCol: number;
    message: string;
}

// Mirrors yaml-fixed's `measure`, which the CLI applies to every line -- comment
// lines included -- and fails on the first offender: depth is leading TABS, and
// spaces may only ALIGN after them. A line that is nothing but whitespace has no
// indentation to judge. Reports the first error only, like the CLI.
export function firstIndentationError(text: string): DialectError | undefined {
    const lines = text.split(/\r?\n/);
    for (let line = 0; line < lines.length; line++) {
        const indent = /^(\t*)( *)/.exec(lines[line])!;
        const tabs = indent[1].length;
        const spaces = indent[2].length;
        if (lines[line].slice(tabs).trim() === '') continue;
        if (tabs === 0 && spaces > 0) {
            return {
                line,
                col: 0,
                endCol: spaces,
                message: 'spaces cannot be used for indentation; indent with tabs (spaces only align after a tab)',
            };
        }
        if (spaces > 0 && lines[line][tabs + spaces] === '\t') {
            return {
                line,
                col: tabs + spaces,
                endCol: tabs + spaces + 1,
                message: 'tab after spaces; indent with tabs first, then align with spaces',
            };
        }
    }
    return undefined;
}

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
    // Depth of the key holding the block scalar being read, if any: every
    // deeper line is its body and is passed through untouched.
    let blockScalarDepth: number | undefined;
    let flowError: DialectError | undefined;

    for (const line of lines) {
        const indent = /^(\t*)( *)/.exec(line)!;
        const depth = indent[1].length;
        const align = indent[2].length;
        const content = line.slice(depth + align);

        if (content === '' && depth === 0 && align === 0) {
            out.push('');
            shifts.push([]);
            continue;
        }
        if (content !== '' && depth === 0 && align > 0) {
            // Space-indented line in a tab-indented file: the CLI rejects it and
            // this pass cannot place it, so pass it through and let yaml judge.
            out.push(line);
            shifts.push([]);
            continue;
        }
        if (blockScalarDepth !== undefined && depth <= blockScalarDepth) {
            blockScalarDepth = undefined;
        }
        const inBlockScalar = blockScalarDepth !== undefined;

        // An indented but otherwise empty line is where a key gets typed, so it
        // keeps its indentation: dropping it would put the cursor outside the
        // block it belongs to, and yaml ignores a blank line either way.
        const isBlank = content === '';
        const isDash = content === '-' || content.startsWith('- ');
        // A comment line says nothing about structure and may sit at any depth,
        // so it reads the state without touching it -- letting one at the left
        // margin end the block it is written inside would misplace every line
        // after it. It is still emitted by depth, since inside a block scalar it
        // is body text rather than a comment.
        if (!isBlank && !inBlockScalar && !content.startsWith('#')) {
            // Deeper levels belong to a block that just ended; this depth's own
            // kind survives: a non-dash line under a sequence is an item body.
            kinds.length = Math.min(kinds.length, depth + 1);
            if (isDash || kinds[depth] === undefined) {
                kinds[depth] = isDash ? 'seq' : 'map';
            }
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
        const rewrite = new LineRewrite(column, sourceStart);
        if (isBlank) {
            // nothing to rewrite; the indentation above is the whole line
        } else if (inBlockScalar || content.startsWith('#')) {
            rewrite.keep(content);
        } else {
            const holdsBlockScalar = rewriteContent(content, rewrite);
            if (holdsBlockScalar) blockScalarDepth = depth;
            const open = unclosedFlowColumn(content);
            if (open !== undefined && !flowError) {
                flowError = {
                    line: out.length,
                    col: sourceStart + open,
                    endCol: line.length,
                    message: 'unexpected end of flow value',
                };
            }
        }

        out.push(rewrite.text);
        shifts.push(rewrite.shifts);
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

    return { text: normalized, flowError, toSourceCol, toNormalizedOffset: offsetAt(normalized, toNormalizedCol) };
}

// Builds one rewritten line, recording a shift wherever a piece is emitted at a
// different width than it was written, so a column can be mapped back.
class LineRewrite {
    text: string;
    shifts: Shift[];
    private consumed = 0;

    constructor(
        column: number,
        private sourceStart: number
    ) {
        this.text = ' '.repeat(column);
        this.shifts = [{ from: column, delta: column - sourceStart }];
    }

    /** Emits `piece` as written. */
    keep(piece: string) {
        this.emit(piece, piece.length);
    }

    /** Emits `piece` in place of `sourceLength` source characters. */
    emit(piece: string, sourceLength: number) {
        this.text += piece;
        this.consumed += sourceLength;
        const delta = this.text.length - (this.sourceStart + this.consumed);
        if (delta !== this.shifts[this.shifts.length - 1].delta) {
            this.shifts.push({ from: this.text.length, delta });
        }
    }
}

// Where a flow collection opens on this line and is still open at the end of
// it, or undefined. Only a value (or a sequence item) that STARTS with "[" or
// "{" is a flow collection; a bracket inside shell text is not.
function unclosedFlowColumn(content: string): number | undefined {
    const mapping = splitMapping(content);
    let value = content;
    let column = 0;
    if (mapping) {
        column = mapping.key.length + mapping.separator.length;
        value = mapping.value;
    } else {
        const dash = /^-\s+/.exec(content);
        if (!dash) return undefined;
        column = dash[0].length;
        value = content.slice(dash[0].length);
    }
    if (value === '' || (value[0] !== '[' && value[0] !== '{')) return undefined;

    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (inSingle) {
            if (c === "'") inSingle = false;
        } else if (inDouble) {
            if (c === '\\') i++;
            else if (c === '"') inDouble = false;
        } else if (c === "'") {
            inSingle = true;
        } else if (c === '"') {
            inDouble = true;
        } else if (c === '[' || c === '{') {
            depth++;
        } else if (c === ']' || c === '}') {
            depth--;
        }
    }
    return depth > 0 ? column : undefined;
}

// Rewrites one structural line into standard YAML, reporting whether its value
// opens a block scalar (whose body the caller must then pass through).
function rewriteContent(content: string, rewrite: LineRewrite): boolean {
    let rest = content;
    const dash = /^-\s+/.exec(rest);
    if (dash) {
        rewrite.keep(dash[0]);
        rest = rest.slice(dash[0].length);
    } else if (rest === '-') {
        rewrite.keep(rest);
        return false;
    }

    const mapping = splitMapping(rest);
    if (!mapping) {
        // A sequence item's own scalar, e.g. "- rm -f out". A line that is
        // neither an item nor a mapping entry is not something this pass
        // understands (yaml-fixed would reject it too), so it goes out as
        // written rather than being quoted on a guess.
        if (dash) emitValue(rest, rewrite, false);
        else rewrite.keep(rest);
        return false;
    }

    const { key, separator, value } = mapping;
    if (BARE_BANG_KEY.test(key)) {
        rewrite.emit(`"${key}"`, key.length);
    } else {
        rewrite.keep(key);
    }
    rewrite.keep(separator);
    if (value === '') return false;
    if (BLOCK_SCALAR_HEADER.test(value)) {
        rewrite.keep(value);
        return true;
    }
    emitValue(value, rewrite, true);
    return false;
}

// Emits a value, quoting it when standard YAML would otherwise read it as
// something other than this line's whole value. A trailing comment stays
// outside the quotes: both parsers treat it as a comment, not as content.
function emitValue(value: string, rewrite: LineRewrite, isMappingValue: boolean) {
    const commentAt = commentStart(value);
    const scalar = commentAt === -1 ? value : value.slice(0, commentAt).replace(/[ \t]+$/, '');
    const trailer = commentAt === -1 ? '' : value.slice(scalar.length);

    const needsQuoting = SCALAR_NEEDS_QUOTING.test(scalar) || (isMappingValue && VALUE_DASH.test(scalar));
    if (scalar === '' || `'"[{`.includes(scalar[0]) || !needsQuoting) {
        rewrite.keep(value);
        return;
    }
    rewrite.emit(`'${scalar.replace(/'/g, "''")}'`, scalar.length);
    rewrite.keep(trailer);
}

// Index where a trailing comment starts, or -1. A '#' opens one only at the
// start or after whitespace -- the same rule yaml-fixed applies.
function commentStart(s: string): number {
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return i;
    }
    return -1;
}

// Splits "key: value" the way yaml-fixed does: at the first ':' followed by
// whitespace or end of line, outside quotes and outside a flow collection.
// Returns undefined when the line is not a mapping entry.
function splitMapping(s: string): { key: string; separator: string; value: string } | undefined {
    let inSingle = false;
    let inDouble = false;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inSingle) {
            if (c === "'") inSingle = false;
        } else if (inDouble) {
            if (c === '\\') i++;
            else if (c === '"') inDouble = false;
        } else if (c === "'") {
            inSingle = true;
        } else if (c === '"') {
            inDouble = true;
        } else if (c === '[' || c === '{') {
            depth++;
        } else if ((c === ']' || c === '}') && depth > 0) {
            depth--;
        } else if (c === ':' && depth === 0 && (i + 1 === s.length || s[i + 1] === ' ' || s[i + 1] === '\t')) {
            const afterColon = s.slice(i + 1);
            const spacing = /^[ \t]*/.exec(afterColon)![0];
            return { key: s.slice(0, i), separator: ':' + spacing, value: afterColon.slice(spacing.length) };
        }
    }
    return undefined;
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
