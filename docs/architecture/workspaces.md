# Thread workspaces

`thread.start` takes `workspace` with exactly one key:
`{ snapshot: true }`, `{ rift: { name, from? } }` or `{ path }`. The
boundary decodes it to `WorkspaceKind` (`Snapshot`, `Rift`, `Path`).
`@gent/workspaces` (`packages/extensions/src/workspaces.ts`)
owns the places and uses only the public extension API, `runProcess` and
the platform services. A path-confined starter run bounds its workspace
thread by its scopes in the starter's cwd, so the thread's file calls in
its place are refused (decided in the narrow-only batch, Round 6, on least
authority): core has no copy relation, and moving a starter's relative
entries into whatever cwd a create names would let a confined run reach
any directory by naming it. Core has no workspace concept: the seam is
`Session.create({ cwd })`, and the thread's profile is the place's.

- Snapshot: a copy of the caller's working tree. The backend is `rift rpc`
  with `copyAll` (one snapshot, an exact copy) when the origin is a rift
  workspace on a file system rift copies on: APFS (macOS, so a Mac's
  snapshot default is rift), btrfs or XFS. gent reads the file system type
  with GNU `stat -f -c %T`, or on BSD `stat` from the device
  (`stat -f %Sd`) and its `mount` line. Everywhere else, and for any
  rift failure that leaves nothing at the target, a detached `git worktree`
  under `<data dir>/workspaces/worktrees/` with the origin's working tree
  checked out unstaged. gent never asks rift for a filtered copy: rift's
  filter drops names such as `build` even when git tracks them. The start
  result notes why a copy is a worktree.
- Rift: a rift copy named `name` (one path segment that does not start with
  `.`) in the rift storage of its source. The source is `from` (its
  repository's top level), or by default the warm source of the caller's
  repository: the last rift ancestor of the caller's rift workspace, or the
  caller's own when it is no copy. The source must have a `.rift` file and
  a commit, and must be no copy itself: a copy's copies would block its
  removal later. Rift only, never a worktree: a missing rift, a file system
  rift does not copy on, or anything at the target already is refused
  before gent writes a record; gent never adopts a target. When rift answers
  `already_exists`, the target stays as it is and gent forgets the record.
  A failed `postcreate` hook fails the start with `WorkspaceHookFailed`,
  and the copy is `retained` at the path the error names. The thread works
  at the caller's relative place when the source has that directory, else
  at the copy's top. The record's key stays the start's digest; the
  record's `copyName` holds the asked name.
- Path: an existing directory in a git repository, attached as it is. No
  copy, no hook, no collect, no branch: `StartResult.workspace` has no
  `branch`. A record (`kind: "path"`) names the directory and its
  session; the session's delete or a failed start forgets the record and
  deletes nothing on disk. A path that does not exist, is no directory or
  lies outside git is refused.
- Hooks: gent sends `hooks: false`, so rift runs no `precreate` in the
  origin. gent reads `.rift.toml` with `Bun.TOML.parse`, checks it as rift
  does (`version = 1`, only the four hook lists, a non-empty `run`), and runs
  the `postcreate` steps in the copy with the `RIFT_*` variables. rift reads
  `version` as a `u32`, and `Bun.TOML.parse` reads `1.0` as the number 1, so
  gent also reads the `version` token as written in the root table: a TOML
  float or a string runs no step, and the start note says why. Every git
  command gent runs sets `core.hooksPath=/dev/null` and turns automatic
  maintenance off, so gent's plumbing runs no hook in the origin
  (`packages/extensions/src/git-plumbing.ts`, the one runner of gent's
  git commands, which fails with git's last line as `GitError`). rift itself
  still adds `/.rift` to the origin's `.git/info/exclude`.
- Identity: the name is `child-<12 hex>` of a SHA-256 over the parent
  session, the parent branch, the start's request id and the resolved
  origin. A repeated start with all four adopts its place, and one that
  asks for another kind or another name is refused; any other start gets
  its own. A copy bound to one child session is never bound to another,
  and a session whose index names one copy is never bound to another. The
  start's request id is the thread's create key (`thread:` and 32 hex of a
  SHA-256 of the same starter session, starter branch and tool call), and
  its first round's message id is `thread-round:<round>`: core keeps one
  session per request id and one message per id, so two starters whose
  tool calls share an id get two threads.
- Records: `<data dir>/workspaces/<name>.json`, under the extension file
  lock, written as `creating` before gent makes anything. Its `kind` is
  `snapshot` (the default for a record written before kinds), `rift` or
  `path`; the next lines are about copies. The record names
  the real directory that holds the copy (`root`: gent's worktrees
  directory, or the rift storage) and the copy's real path in it; a rift
  record also keeps the copy's rift id (its `.rift`). After the copy exists
  gent writes an ownership marker (`gent-workspace`) into the copy's git
  directory: a SHA-256 of the identity digest, the copy's real path, the
  backend and the rift id. gent proves the git directory without following
  a link: a rift copy's `.git` is a directory in it; a worktree's `.git` is
  a file whose `gitdir` resolves into the origin's `.git/worktrees/`; git
  must name the same top level and git directory. A link or a directory at
  the marker's place is refused; the marker goes to a new file beside it
  and a rename puts it in place, so a link that a whole-tree copy brought
  along is never written through. Then gent runs the hooks, captures the
  base (the copy after its hooks, as one commit on a private index), writes
  it into the record, and makes `refs/gent/base/<name>` (in the origin for
  a worktree, in the copy for rift) with compare-and-swap from absent;
  `ready` comes last. gent adopts, collects or removes a copy only when the
  record and the marker agree and the copy's real path lies in the
  directory its backend owns; never a path that is, holds or lies in the
  origin, and never a directory that lies in the origin or holds it, but
  for the rift storage beside an origin that is itself a rift copy. A directory it cannot prove is kept, and the call says so. A
  crash recovers by phase: `creating` with nothing there is made again; a
  marked half-made worktree is removed and made again (its base ref goes
  only from the recorded base); a half-made rift copy is retained.
- `retained`: a record that gent keeps with its copy and never adopts,
  collects or removes; the record says why. Every rift copy ends here, and
  so does a copy whose base ref was already there, or a rift copy that a
  later step of its making could not finish. Manual removal of a retained
  copy comes with W2 (the copy list, confirmed by the user).
- Merge-back is a branch, never a merge. At each round's end the copy's
  tree goes on `refs/heads/gent/<name>` of the origin as one commit over the
  base. A worktree shares the origin's objects; for a rift copy gent fetches
  the commit by id into no ref (`--no-write-fetch-head`, then `cat-file -e`
  proves the commit is there). Then `update-ref` moves the branch. gent
  writes no other ref of the origin. gent moves or deletes the branch
  only with compare-and-swap from the commit it last wrote (the record keeps
  `tip`, and `nextTip` for a write in flight). A branch someone else moved,
  or one a worktree has checked out, stays as it is: the round end says so,
  and the work stays in the copy. A turn is collected once: the round's end
  reads the collect of the round's turn before it goes out. The round end
  names the branch and a diffstat in its text and in `details.workspace`.
  No model call.
- Lifetime is the thread session's. The start's scope closes after the
  copy is bound to the created session. When the start fails or is interrupted,
  storage decides, not what the fiber saw: core can store the session and
  then be interrupted before `Session.create` returns. The finalizer lists
  the parent's sessions (`listSessions({ thread })`) for a child of this
  parent branch whose cwd is in the copy (the copy's path is named by the
  start's identity). A stored child gets the copy (bound); no stored child
  releases it; a list that fails keeps it. `sessionDeleted` collects and
  ends the copy under one lock; a collect that fails or leaves the work in
  the copy keeps the copy and its record. A worktree copy is removed with
  `git worktree remove` (one that fails keeps the copy; no recursive
  delete), and its base ref goes only from the recorded base: a moved base
  ref keeps the copy and the ref. gent never removes a rift copy: rift's
  remove runs `preremove` and then trashes the whole subtree, so a copy
  made from it in between goes too, and no `rift rpc` request refuses a copy
  with descendants in one step. A rift copy is collected and then
  `retained`. gent prunes nothing by age; a copy of a session that is not
  deleted stays. The branch outlives the copy.
- The session index (`<data dir>/workspaces/sessions/<session id>`) holds
  the bound copy's name, so a turn end of a session with no copy reads one
  missing file. A delete whose index was lost reads every record.
- Refusals: a cwd outside git or with no commit, under 2 GB free where the
  copy goes, and free space that `df` does not report. The four-child cap is
  checked before a copy is made. Making a copy can be interrupted; only the
  record and marker writes are masked.
- A copy is not a sandbox: the child's `bash` and cell still reach every
  path. Project trust (`trustedProjects`, `isProjectExtensionDirectoryTrusted`)
  is keyed by directory and does not follow the copy: the child's profile
  lists the copy's project extensions and does not build them until the
  owner trusts the copy's directory. No core change makes it follow.
