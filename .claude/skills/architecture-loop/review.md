# Review sweep

Every pass runs one **review** agent per workspace package (`packages/*`, `apps/*`, `examples/`, `testbeds/`), beside the architecture areas. The architecture areas look for structure; the review agents read the code and the tests line by line for slop and test value.

## Criteria

Read these in full before the first file:

- `~/.claude/skills/code-review/references/review-contract.md`: correctness, minimality, and each slop class (type, schema and boundary, wrapper and abstraction, defensive and verbose, agent artifact, Effect, test), and the finding test.
- `~/.claude/skills/code-review/references/test-audit.md`: the value bar, the authoring gate, the junk patterns, the retention bar, the candidate evidence and the repair shape.
- `~/.claude/skills/writing-tests/SKILL.md`: tests cover behavior users depend on, not implementation details or coverage.
- The Testing section of `CLAUDE.md`: the three-tier taxonomy, one file per feature area, behavioral names, no `Effect.sleep` for state changes, `Effect.timeout` inside the Effect.

## Method

1. Read every source file of the package, then every test file. A package over about 15k lines splits by directory across two agents; each names its half.
2. Source: report each slop instance that passes the finding test in the review contract. Group repeats of one pattern into one finding with every site listed.
3. Tests, per file: which user-facing behavior each `describe` protects; tests that fail the value bar (asserting a mock, restating the implementation, a snapshot of internals, a duplicate of a stronger test, a name that says what is called instead of what happens); fix-shaped files and god tests; tests at the wrong tier (a direct service test where the per-request scope is the risk, an RPC harness where a pure reducer test would do). A deletion or move carries the full candidate evidence from `test-audit.md`.
4. Gaps: user-facing behavior with no test that would fail if it broke. Name the behavior and the tier the test belongs at; do not write it.

## Report

`~/.cache/gent-pass<N>/pass<N>-review-<package>.md`: a slop table (id, class, slop class, file:line or sites, repair), a test table (id, file, verdict keep/delete/merge/move/rename, evidence), a gap list, and the files read. Ids are `R<N>-<package>-<k>`. The triage folds them into the package's batch; a pure test cleanup may be its own batch.
