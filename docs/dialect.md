# The dats dialect, and how the extension parses it

`.dats` files are parsed by the runner with
[yaml-fixed](https://github.com/wow-look-at-my/yaml-fixed), not a general-purpose YAML
library. Four of its differences make a real file unparseable -- or, worse, silently
mis-parsed -- by the `yaml` package this extension is built on:

- **Structural depth is a count of leading TABS.** Standard YAML rejects tabs as
  indentation outright, so every line of a valid `.dats` file is a parse error
  (`Tabs are not allowed as indentation`). Spaces after the tabs are alignment and never
  change depth -- that is what lets a sequence item's sibling keys line up past its `- `.
- **There are no tags, anchors or aliases, so `!`, `&` and `*` are ordinary characters.**
  The negated assertion keys are written bare (`!stdout:`, `!stderr:`, `!files:`), and a
  key like `&a cmd` is a key named `&a cmd`. Standard YAML reads those as a tag or an
  anchor, which is worse than an error: the marker silently disappears and the node it
  decorates takes its place.
- **A plain value runs to the end of its line.** `cmd` holds shell text, so a colon in it
  is ordinary -- `cmd: echo '{"ok": true}'` is one string to the runner. Standard YAML
  re-reads the `": "` inside it and reports a nested mapping where the file has a command.
- **...and only to the end of its line.** The block parser reads one line at a time, so a
  flow collection or a quoted scalar that does not finish there is a parse error, where
  standard YAML would happily continue it on the next line.

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
3. Quote a key opening with an indicator (`!stdout`, `&a cmd`), so the parser reads the
   whole thing as the key rather than as a tag or an anchor.
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

### Values that run off the end of their line

The block parser reads one line at a time, so a value has to finish on the line that
starts it. `stdout: [` with its items below is `unexpected end of flow value` to the
runner and an ordinary multi-line list to the `yaml` package; `cmd: "echo` continued
below is an `unterminated double-quoted scalar` and an ordinary multi-line string. The
rewrite reports either as `flowError`, and only for a value that STARTS with the opening
character -- a bracket or an apostrophe inside shell text (`awk "{print $1}"`) is text.
