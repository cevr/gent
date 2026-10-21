# Turn checkpoints

`@gent/checkpoints` (`packages/extensions/src/checkpoints.ts`) records the
work tree at the start and the end of each turn, so a user can review what a
turn changed and take it back. It sends the model nothing: no tool, no prompt
section, no notice. Core has no checkpoint concept.

- Capture: the start is the first `toolCall` hook of a turn for a tool that
  declares a side effect (not `readonly`), before that call runs. The hook
  always answers `Allow` and only captures; a failed capture is logged, never
  an ask. Calls of one step wait for the same capture (a per-turn memo in a
  process Resource, the capture forked in its scope). A turn that reads only
  or calls no tool captures nothing. The end is the `turnAfter` hook, only for
  a turn with a start. A tree capture catches every writer: the file tools,
  bash, the cell, MCP tools. A recovered turn finds its start ref and captures
  no second one.
- Cost on the gate: a profile whose cwd is outside a git work tree, or in a
  gent workspace copy (its git directory holds the `gent-workspace` marker)
  whose store does not exist, registers no capture hook, so its calls stay
  unjudged. Elsewhere in a git work tree every call is
  judged: a top-level call keeps its `Allow` in memory (stored only in a park
  write that happens anyway), and a cell operation stores it in its operation
  record (one more SQLite transaction per cell operation).
- Who captures: a session that is not spawned always does; a spawned one (a
  thread, a `/btw` fork) only where the work tree's store exists, so a
  snapshot child in its own copy pays nothing.
- Store: one private bare git repository per work tree,
  `<data dir>/checkpoints/<16 hex of sha256(realpath of the git top)>/`, with
  a `worktree` file that names the top. gent writes no ref, object or index
  entry into the user's repository, and reads it with no optional lock and no
  `core.fsmonitor` program (the user's config stays for those reads: its
  excludes file decides what git ignores). Every store command runs as
  `--git-dir=<store> --work-tree=<top>` with the quiet git settings, no user
  or system config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`,
  and no inherited `-c` values), `core.fsync=objects,reference`, no eol or
  filter conversion (`--attr-source` is the empty tree,
  `core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`), and gent's own
  identity. `git init` takes an empty template directory and no
  `GIT_TEMPLATE_DIR`, so no template's hook, config or `info/attributes`
  reaches the store. Every path goes to git NUL-terminated (`-z`,
  `--pathspec-file-nul`) or as an argument after `--`, and comes back
  NUL-terminated: no channel reads a quoted name as a C string. A store write
  holds `FileLock` on `<store>/index`. Captured: tracked and untracked files
  that git does not ignore, and files the user's repository tracks though an
  ignore rule names them; not captured: untracked files over 2 MiB (the commit
  counts them in `Gent-Skipped`) and the files of a nested repository (a
  gitlink).
- Record: the refs are the only record. `refs/checkpoints/<session>/<branch>/<turn>/{start,end}`
  (each part the hex of the id, created only once); the commit trailers carry
  `Gent-Kind`, `Gent-Session`, `Gent-Branch`, `Gent-Turn`, `Gent-At`
  (milliseconds, strictly increasing per store) and `Gent-Skipped`. An end
  commit's parent is its start. A revert's refs are
  `refs/reverts/<session>/<branch>/<request>/{before,target,done}` (see
  Revert). One `for-each-ref` reads the timeline.
- Reads (both `answersDuringTurn`): `checkpoints.list` gives the branch's
  turns newest first (`#1` is the newest; openers are user messages that are
  not runtime rows), each `captured`, `open` or `none` with its change; a
  turn a fork copied finds its checkpoints by its `createdAt` up the
  branch's parents. A captured turn's change is what the lineage (this
  session and the sessions below it) wrote in its window: from its start to
  the start of the next newer turn with one, or to the store's newest mark
  (it stands for now: a read writes nothing). So a delegate thread's edits
  after its starter's turn ended count in that turn. The window is cut as a
  revert cuts its time (see Revert), by one owner (`lineageChanges`) that
  the list, the patch and the revert share: a newest turn's row counts the
  paths its revert writes back, and an older row its own share of what its
  revert takes back. One `diff-tree --stdin --numstat` answers every window
  and interval. `checkpoints.patch` gives turn `#n`'s change as a git patch
  of those paths (`--binary`, no external diff or textconv), cut at 10 MB; a
  first `#` line names other sessions, outside this session's lineage, whose
  turns overlapped its window.
- Revert: `checkpoints.revert` (not `answersDuringTurn`, so it waits for the
  branch's turn and holds its side-mutation permit while it writes) takes
  `{ requestId, action, overwrite? }`. `Turn { n, conversation }` takes the
  work tree back to before turn `#n`: the paths that this session's lineage
  changed since that turn's start, each to its content at the start, and
  nothing else. The store's marks since the start cut the time into
  intervals; an interval a lineage span (or a lineage revert) covers is the
  lineage's, one no lineage span covers is someone else's (the user, another
  session, a job left running), and one both cover is both's. A path the
  lineage changed that someone else changed too is a conflict, and so is a
  path to write that is on disk but not in the capture of now (ignored, or
  untracked over 2 MiB). A conflict refuses the revert and names the paths;
  `overwrite` writes them. Another loop that works in the same work tree (a
  top that holds or is held by this one) refuses it too, by name, id and
  status. `conversation` also forks the branch with `Session.forkBranch` at
  the message before the turn (a first turn has none and refuses); the
  answer names the new branch. Each interval's paths count on their own (a
  change and its reversal in two intervals are both seen). The write
  refuses on doubt. Before any record, something in the way refuses, by
  name, and `overwrite` does not pass it: an ancestor of a path to write that
  is a link or a file (git would replace it), a directory where a file goes,
  a special file; an entry the write itself removes first is not in the way.
  The other-loop check runs again under the store lock, just before the
  capture of now. The write is `before` (the capture of now, with each path
  to write as its bytes on disk, hashed into the store with no filter,
  whatever the capture excludes: undo returns all it overwrote), `target`
  (the tree to write, built in a scratch index with no `--replace`; on a
  conversation revert it carries `Gent-Result-Branch`), the files, then
  `done`, under `refs/reverts/<session>/<branch>/<request>/`. The files: on
  a finish, each path must hold its `before` (to write), its `target` (a
  stopped run wrote it), or nothing while `before` holds it (a stop moved it
  aside); any other content is a later edit, and the finish refuses and names
  it. Only the paths not at their target are examined for what stands in the
  way. Each of those holding a file or a link moves aside first, by rename
  in its own directory to `.gent-aside-<16 hex of sha256(request)>-<16 hex of
  sha256(path)>`; what moved is hashed into the store, and an aside whose
  bytes `before` lacks moves the `before` ref (old value checked) to a commit
  of the amended tree with the same message, parent the old `before`; only
  then does the aside go. So the bytes the revert takes are the bytes it
  keeps, an edit made after the last check included: the answer names such a
  path in `kept`, and undo returns it. An emptied directory goes by `rmdir`,
  which removes only an empty one. `checkout-index --prefix` writes each path
  the target holds into `.gent-write-<16 hex of sha256(request)>/` at the
  top, and each goes to its path by `link` (a link by `symlink`), which never
  replaces an entry. Then each path must hold its target, or the request
  fails and the revert stays unfinished. Recovery: a stop leaves each aside
  or its bytes in `before`, and maybe the write directory (store copies
  only); a finish or an undo of the unfinished revert first takes each aside
  into `before` by its fixed name and removes the write directory. A writer
  that keeps a file open and writes after the rename writes to the aside, out
  of reach. A repeat by `requestId` answers
  again from its refs, or finishes one a stop cut short after its `target`;
  one with a `before` alone wrote nothing, so its record goes and it runs
  again. `Undo` reverts the newest revert of the branch (or of the revert
  that made it): the paths it wrote, back to its `before`; a path changed
  since its target is a conflict. `Finish` writes an unfinished revert; with
  `overwrite` it writes over later edits too, and its `before` keeps them for
  undo. An undo is a revert record whose marks also carry `Gent-Undoes:
  <request>` (additive: an older store has none). `checkpoints.list` names
  the newest revert as `undo` (with its file count) once done, unless it is
  itself a done undo, which leaves nothing to undo (its undo would redo the
  revert; a turn row does that by name), and `Undo` refuses then too; it
  names the newest as `unfinished` without its `done`. A
  refusal is an answer (`Refused { reason, conflicts }`), not an error.
- Client: `/diff turn [n]` is a target of `@gent/git`'s `/diff` (see `@gent/git` in
  `apps/tui/docs/shipped-extensions.md`). `/revert` (`apps/tui/src/extensions/checkpoints.client.tsx`,
  one of the `builtinClientModules`) is a docked pane over `checkpoints.list`: one row per turn, newest first,
  `#n · prompt · +a -d in k files · 12m` (a narrow row drops the age, then
  cuts the prompt); a turn with no checkpoint says why and cannot be chosen.
  An undo row, or a finish and an undo row for a revert a stop cut short,
  sits on top. `enter` reverts files and conversation and moves the shell to
  the new branch (`shell.switchSession`); `f` reverts files only; after a
  refusal over paths, `o` sends the same request again with `overwrite`.
  The key row names what the row under the cursor answers (`enter undo` on
  an undo row, which has no `f`), and a narrow row reads `enter all` before
  it drops `f files only`. Each press is a new `requestId`. The pane refuses at once while the session
  in view runs a turn (`activity` is `working`): the revert would otherwise
  wait for the turn's end with no word. The prompt does not go back to the
  composer: the client facets have no composer verb.
- Retention: a process fiber, started by the first `loopOpen` for a data
  directory, runs a pass a minute later and then daily: it removes a store
  whose work tree is gone, deletes refs whose `Gent-At` is over 30 days old,
  and runs `gc` when it deleted a ref or the store's last collection (the
  `gent-gc` file, epoch ms) is a day old. git's default prune grace (two
  weeks) keeps the objects of a capture that runs at the same time, so a
  collection takes no lock. `sessionDeleted` deletes the session's refs from
  its work tree's store, then collects in the process scope.
