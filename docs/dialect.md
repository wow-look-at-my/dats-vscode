# The dats dialect, and how the extension parses it

`.dats` files are parsed by the runner with
[yaml-fixed](https://github.com/wow-look-at-my/yaml-fixed), not a general-purpose YAML
library. Three of its differences make a real file unparseable -- or, worse, silently
mis-parsed -- by the `yaml` package this extension is built on:

- **Structural depth is a count of leading TABS.** Standard YAML rejects tabs as
  indentation outright, so every line of a valid `.dats` file is a parse error
  (`Tabs are not allowed as indentation`). Spaces after the tabs are alignment and never
  change depth -- that is what lets a sequence item's sibling keys line up past its `- `.
- **There are no tags, so `!` is an ordinary character.** The negated assertion keys are
  written bare (`!stdout:`, `!stderr:`, `!files:`). Standard YAML reads that as a tag on
  the following node, which is worse than an error: the key silently disappears and the
  block under it becomes the value of its parent.
- **A plain value runs to the end of its line.** `cmd` holds shell text, so a colon in it
  is ordinary -- `cmd: echo '{"ok": true}'` is one string to the runner. Standard YAML
  re-reads the `": "` inside it and reports a nested mapping where the file has a command.

`src/dialect.ts` (`normalizeDats`) rewrites a source file into the equivalent standard
YAML before either the validator or the completion provider parses it.

## The rewrite

One output line per input line, so line numbers never move. Per line:

1. Split the leading tabs (depth) from the alignment spaces that follow them.
2. Emit the content at a column derived from depth: each level costs two columns, and a
   level holding a sequence costs two more, so a child clears its item's body column
   (`- ` included). A non-dash line at a sequence's own depth is that item's body and is
   emitted two columns in. An indented but empty line keeps its indentation: that is
   where the next key gets typed, and completion decides context by where the cursor is.
3. Quote a bare `!key`, so the parser reads a key rather than a tag.
4. Quote a value standard YAML would read as something other than the whole value: one
   holding a `": "` or ending in `:`, or opening with an indicator character (`!`, `&`,
   `*`, ...). A trailing `# comment` stays outside the quotes -- both parsers treat it as
   a comment. A block scalar header (`|`, `>`) is left alone, and every line of its body
   is passed through untouched, colons and dashes included.

The mapping from depth to column is strictly increasing, which is the property that makes
the rewrite faithful: any line deeper in the source is more indented in the output, so the
tree the parser builds is the tree the runner builds.

A file with no tab-indented line at all is returned untouched. The runner rejects such a
file, but this pass cannot place its lines, so it lets the `yaml` parser judge it.

## Mapping positions back

`toSourceCol(line, col)` puts a parser position back on the source column, and
`toNormalizedOffset(line, col)` converts a cursor position the other way (the completion
provider compares the cursor against node ranges). Both are driven by the same per-line
list of breakpoints: the line is emitted piece by piece, and a breakpoint is recorded
wherever a piece went out at a different width than it was written -- the indentation
first, then each quote a key or value gained.

A position inside the rewritten indentation has no exact source column; it maps to where
the content starts.

## What it does not do

- **Block scalar bodies are reindented.** Their content is passed through, but the
  leading whitespace shifts with the block, so a `|` body's string is not byte-identical
  to the source. Nothing in the validator inspects that whitespace.
- **A column inside a quoted value can be off by one or two.** The mapper records a shift
  at each end of an inserted quote pair; a doubled `'` inside the value is not tracked
  individually, so a range in the middle of such a value can drift by the number of
  quotes before it. The diagnostic still lands on the right line and value.

## Rules the yaml parser is too permissive for

Two dialect rules have no equivalent in standard YAML, so the extension checks them
itself rather than waiting for a parse error that never comes.

### Indentation

`firstIndentationError` mirrors yaml-fixed's `measure`: leading spaces with no tab, or a
tab after alignment spaces, is the CLI's first parse error and is reported as a
diagnostic (once, like the CLI). The rewrite still runs afterwards, so a space-indented
file gets its other diagnostics too -- read as ordinary YAML, which is what it is.

### Flow collections

The block parser reads one line at a time, so a flow collection has to close on the line
that opens it: `stdout: [` continued on the next line is `unexpected end of flow value`
to the runner and a perfectly ordinary multi-line list to the `yaml` package. The rewrite
reports it as `flowError`, and only for a value that STARTS with `[` or `{` -- a bracket
inside shell text (`awk "{print $1}"`) is not a flow collection.
