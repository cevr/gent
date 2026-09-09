# Kernel one-tool codemode: already collapsed

Date: 2026-09-09
Status: verdict — the collapse is shipped and correct. No candidate.

## What the goal asked

"With our new kernel one tool extension, see what else we can reduce."
Plus the user's guidance: "the one tool kernel can use other tools as a
codemode to reduce tokens", tempered by "certain tools are better for certain
tasks than raw JS or Bun" and "certain things can actually just be better
expressed using bun — like glob."

## The collapse is active

`CellExtension` (`runtime/code-cell/cell-extension.ts`) projects
`toolPolicy: { include: ["cell"], modelSet: ["cell"] }` on every turn, unless
the agent uses an external driver or denies `cell`.

Verified live, not by reading:

```
$ gent -H "say YES if you have a tool literally named 'cell' ... how many tools"
NO, I do not have a tool literally named 'cell' — I have one named `mcp_Cell`.
I have 1 tool available.
```

**One tool.** The other 15 stay admitted as _host_ tools, documented in the
system prompt as a callable API:

```
## Host Tools
Callable inside `cell` with `await tools.call(name, input)`.
`tools.describe(name)` returns the input schema.
- **read** (path, offset?, limit?): Read file contents
- ...
```

One line per tool — name, input keys, snippet — instead of a full JSON schema
per tool in the tool-definitions block. That _is_ the token reduction the goal
described, and it already shipped.

## A wrong intermediate reading, corrected

My first probe asked the model to "list the tools you can call". It answered
"17" and enumerated them. I initially read that as the collapse failing.

It was not. The model was reading the **Host Tools catalog out of its system
prompt** — exactly what that catalog is for — not enumerating callable tools.
The direct question ("how many tools do you have") returns 1.

Lesson: when probing a model's tool surface, ask what it _has_, not what it
_can call_. The second phrasing invites it to include anything the prompt
describes as callable, which in a codemode design is everything.

## Is any remaining tool now redundant?

`glob` was removed earlier today on the user's own reasoning — a directory walk
is better expressed in Bun, and the tool added nothing.

`write` is the closest analogue and does **not** qualify. It does three things
raw `Bun.write` does not:

1. Takes a **file lock** (`ctx.FileLock.withLock`) — mutual exclusion between
   concurrent agents. The cell has no `FileLock` access at all.
2. Resolves through `ctx.Files.resolve` — workspace-relative and sandbox-aware.
3. Supports **atomic** write-then-rename for saved results.

Only `write`, `edit`, and `goal-store` take the file lock. Replacing them with
raw Bun would silently drop mutual exclusion — a correctness loss, not a token
saving. This is the "certain tools are better for certain tasks" half of the
user's rule.

**Verdict: no further tool removals available on this axis.**
