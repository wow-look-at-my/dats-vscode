# The dats dialect, and how the extension parses it

`.dats` files are parsed by the runner with
[yaml-fixed](https://github.com/wow-look-at-my/yaml-fixed), not a general-purpose YAML
library. Two of its differences make a real file unparseable by the `yaml` package this
extension is built on:

- **Structural depth is a count of leading TABS.** Standard YAML rejects tabs as
  indentation outright, so every line of a valid `.dats` file is a parse error
  (`Tabs are not allowed as indentation`). Spaces after the tabs are alignment and never
  change depth -- that is what lets a sequence item's sibling keys line up past its `- `.
- **There are no tags, so `!` is an ordinary character.** The negated assertion keys are
  written bare (`!stdout:`, `!stderr:`, `!files:`). Standard YAML reads that as a tag on
  the following node, which is worse than an error: the key silently disappears and the
  block under it becomes the value of its parent.

`src/dialect.ts` (`normalizeDats`) rewrites a source file into the equivalent standard
YAML before either the validator or the completion provider parses it.

## The rewrite

One output line per input line, so line numbers never move. Per line:

1. Split the leading tabs (depth) from the alignment spaces that follow them.
2. Emit the content at a column derived from depth: each level costs two columns, and a
   level holding a sequence costs two more, so a child clears its item's body column
   (`- ` included). A non-dash line at a sequence's own depth is that item's body and is
   emitted two columns in.
3. Quote a bare `!key:` at the start of the content, so the parser reads a key.

The mapping from depth to column is strictly increasing, which is the property that makes
the rewrite faithful: any line deeper in the source is more indented in the output, so the
tree the parser builds is the tree the runner builds.

A file with no tab-indented line at all is returned untouched. The runner rejects such a
file, but this pass cannot place its lines, so it lets the `yaml` parser judge it.

## Mapping positions back

`toSourceCol(line, col)` puts a parser position back on the source column, and
`toNormalizedOffset(line, col)` converts a cursor position the other way (the completion
provider compares the cursor against node ranges). Both are driven by the same per-line
list of breakpoints, recorded while the line is rewritten: one where the content starts,
and two more around an inserted quote pair.

A position inside the rewritten indentation has no exact source column; it maps to where
the content starts.

## What it does not do

- **Block scalar bodies are reindented like everything else.** Their leading whitespace
  shifts by the same rule, so a `|` body's content is not byte-identical to the source.
  Nothing in the validator inspects that whitespace.
- **It does not flag space indentation.** The runner rejects a space-indented file; the
  extension parses it as ordinary YAML and reports whatever it finds there. That gap is
  intentional (existing space-indented files still validate as before), not an oversight.
