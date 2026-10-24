# Prior art: Vesalius (2026-10-23)

`haplollc/Vesalius` (`02022d1`, 2026-10-22; owner, 2026-10-23). A code map for
coding agents: it parses a repository once (SwiftSyntax for Swift, tree-sitter
for TypeScript, JavaScript and Python, a lexical pass for the rest), stores a
symbol and reference graph in SQLite with FTS5, and serves five read-only MCP
tools: `usages`, `feature_map`, `outline`, `architecture`,
`dependency_cycles`. Swift 6, macOS only. Licence: all rights reserved, except
the VS Code extension. Take ideas, not code. Created the day before this read,
1 commit, 32 stars.

## Their claims

- Benchmark (`docs/benchmark/README.md`): 20 questions about 6 codebases, headless
  Claude Code with and without the server, one blind judge. 51% fewer tokens
  (geometric mean of per-question ratios, 95% CI 36 to 62%), 43% fewer turns,
  quality −0.5 points (CI −1.6 to +0.8). Held-out questions: 44% fewer.
- The questions only ask about code; none edits it. Their token count sums
  cache reads at full weight, so it is not a cost figure (inferred).
- Round 1 put every tool behind Claude Code's tool search: the model called the
  server in 2 of 24 runs. Round 2 loads `usages` and `feature_map` up front
  (about 900 tokens) and the model called it in 20 of 20.
- Each answer carries a completeness line ("X occurs 9×: 6 resolved, 1
  declaration, 2 imports; 0 unresolved"), so the model does not re-check with
  a grep.

## Measured on gent (CLI 2.0.0, index in scratch, main at `2114244b6`)

- Index: 623 files, 15,951 symbols, 293,312 references in 5.2 s; a refresh
  with no change 0.4 s.
- `outline` on the six largest source files (180k to 346k chars each) returns
  2.3k to 5.8k chars, 1% to 3% of the file: exports with line ranges, members,
  the unexported names, calls out. `turn.ts` (7,154 lines) outlines in 35 lines.
- `usages` on a name used in 72 files (`ExtensionContext`): 4.5k chars, paged,
  against 42k for `rg -n`. On a name used in 2 to 8 files: the same size as
  `rg -n` (783 against 787, 1,751 against 1,886, 2,353 against 2,046), plus the
  enclosing function and the completeness line.
- TypeScript references resolve through import bindings only. A name from a
  package (`WideEvent` from `effect-wide-event`) is not in the index.
- `dependency-cycles`: 4 import cycles, the largest 21 files in
  `packages/core/src/domain`, mostly through type-only edges. Not checked
  against a runtime cycle (guess: no runtime cycle).

## What this means for gent

- Reads of files are the largest read cost: in the owner's data to 2026-09-23,
  `.ts` reads were 1,012,688 chars, 11% of all cell output; `.md` reads 3.3%;
  git history through bash 3.1% (queue row 9).
- gent keeps one large file per concern, so a whole-file read is expensive and
  the `read` tool's 2,000-line default window covers under a third of
  `turn.ts`. The read tool already takes `offset` and `limit`
  (`packages/extensions/src/fs-tools.ts`); what the model lacks is where to
  point them. An outline with line ranges is that pointer.
- A wide `usages` saves only on widely used names; for most names `rg -n` is
  as small.

## Candidates

- V1, outline. A read-only `outline(path)` capability in an extension: exports
  and top-level declarations with line ranges and one-line signatures, from a
  TypeScript parser gent already ships (TypeScript 7, or the oxc parser behind
  oxlint). No index and no graph: one parse per call, so nothing goes stale and
  the layer sheds by deleting one tool. Shipped 2026-10-24 on `@babel/parser`
  8 (queue row 36). Accept: on a Haiku gamut A/B with the
  same prompt, `.ts` read chars per task fall, and the gate pass rate holds.
- V2, completeness line. When `grep` or `usages`-like results are cut, say how
  many matches were cut and where, so the model does not search again. Check
  first what `grep` in `fs-tools.ts` already reports.
- V3, tool visibility. A tool the model must discover is not called. Name a new
  read tool in the base prompt, not only behind search.
- V4, A/B method. Interleaved paired runs, geometric mean of per-task ratios,
  bootstrap interval over tasks. The gamut A/B for V1 uses it.
- Rejected: run Vesalius itself behind the MCP extension. It is macOS only (the
  workbox is Linux), its licence forbids reuse, and its index is a second store
  that goes stale; V1 gets the measured part without it.
