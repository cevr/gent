# Runtime Profile

`packages/core/src/runtime/extension-host.ts` owns the shared profile pipeline.
`loadRuntimeProfileDeclarations` discovers extensions, runs trusted setup,
validates declarations, and loads the core prompt sections. It does not build
Resource layers. Trusted setup can still perform its own effects; this is not a
sandbox boundary.

`SessionProfileCache` builds one profile per (workspace, cwd, set of
extensions the config leaves active or failed, versions of the extension files
on disk, what the config files hold). Each resolve reads the config and lists
the user and project extension directories as they are now, under the place's
lock, so an edit to `disabledExtensions` and an added, fixed or edited
extension file reach the next turn and the next session without a restart.
An extension reads its own config keys at setup (`@gent/guard`,
`@gent/router`), and `UserConfig` decodes only core's keys, so the key holds
the hash of `FreshConfig.fingerprint` too: every key of the user and project
config files as canonical JSON, the disabled list left out (the key holds its
effect, the set of extensions), a missing file the same as `{}`, and a file
that cannot be read `unreadable`. An edit to any other key builds a new
profile for the next turn, a turn that holds the old one keeps its lease, and
a write of the same keys keeps the profile. A profile is built from one read
of the config: the extension scan and every setup run over
`configSnapshotFileSystem` (`runtime/config.ts`), which answers `exists` and
`readFile` of the two config files from `FreshConfig.files`, the read the key
was taken from, and sends every other path and operation to the platform. So
an edit that lands between the read and a setup does not reach the build, and
a file the read could not read fails again for each setup, never reads as
missing. Resource builds and leaves read the live files. Each extension entry (a file,
or a directory's index) is built with every module it imports by a relative
path into one module (`GentPlatform.bundleModule`, `Bun.build` with package
imports external), and its version is the built module's hash. The platform
serves the build at the entry's path with the version in the query
(`serveModule`), so a new version is imported afresh, the same version comes
from Bun's module cache, and a package import still resolves from the entry's
directory. The cache keeps each entry's last build with a stat stamp and a
content hash of every input (`buildExtensionModule`, `ModuleGraphs`, exported
from `@gent/core/host`, so the TUI's client loader builds through the same
code with its own bundler): a resolve with no
input touched costs a stat of each and reads no input (about 1.5 ms for the
scan); a save of the same bytes reads and hashes the inputs and builds nothing;
an edit builds again (about 10 ms; the first build of a process about 70 ms).
An in-place save sets the mtime before it copies the bytes, so a stamp whose
mtime is within one tick of the file clock (`RACY_STAMP_MILLIS`, two seconds
for FAT and HFS+) is kept as racy and the bytes decide, in a load and in the
client's stale check alike (git's racy-git rule). The config read cache keeps
its stamps the same way: one owner, `fileStamp` in
`packages/core/src/runtime/config.ts`, so a config file saved within that tick
is read again until the save ages.
A build is kept only when it is coherent: it read the inputs whose stats and
bytes were taken before it, and their stats and bytes after it are the same, so
a save during a build is never kept as the new version, even one that puts the
earlier bytes back (A, then B, then A: the inode and mtime moved). A build that found an import not known before it, or
that a save overlapped, builds again with what it found (the first build of an
entry with relative imports builds twice); after three tries the build runs
that resolve and is not kept. A failed build is never reused, so a relative
module created later is found; it keeps the last good build and records the
stats, taken before it, of every module the entry was known to read
(`extensionModuleChanged`), so a fix to a broken imported module is a change
to look at. An untrusted project's
files are listed, not built. Project trust comes from
`isProjectExtensionDirectoryTrusted` (`runtime/config.ts`), the reader the TUI's
client-extension loader calls too: it reads `trustedProjects` from the user
config file as it is now, and a file that does not decode trusts no project.
Launched from home, the project's `.gent` is the user's, so there is no project
scope: `hasProjectScope` (`runtime/config.ts`) keeps the config read, the
extension scan and the TUI loader from reading `~/.gent` a second time. A
list that leaves the
same extensions, such as one that names an unknown id, finds the profile
already built. Finding or building the profile, its lease and making it
current are one step no interrupt can split: the place's lock is held by
`Semaphore.withPermits`, which takes the permit and its release in one step,
and the lease's release joins the caller's scope before the lock is taken.
`resolve` takes a
lease in the caller's scope: a turn and an extension request hold it until they
end, a branch Resource built over it holds it while it lives, and a query holds
it for its read. The newest profile of a (workspace, cwd) stays cached; a
superseded one closes its scope when its last lease is released.

A profile holds its server and process Resources as shared builds: one build
of one extension's Resources of one scope over one context, owned by an
`RcMap` of the cache (one per server) under its build key (`SharedBuild`,
`holdResources`). The first profile that asks for a key builds it, two places
that ask at once share the one build, a later one shares it, and builds of
different keys never wait on each other: there is no server-wide lock. A
profile holds each build through a scope of its own, and the build closes when
the last profile holding it lets go (a profile retires, its build fails or is
interrupted); an interrupted asker lets go of its own hold only, and a build
no profile holds any more is interrupted. A build that failed stays only while
an asker still holds it: every asker that holds it, or asks before the last of
them lets go, shares its failure, and the first asker after that builds again.
The reference and its release are taken in one step (`RcMap.get`), so no
interrupt leaves a hold behind. A profile build closes the scopes it lets go
of (a hold that failed or was interrupted, a pass a later pass replaced, the
whole profile when its build fails) only after the place's lock is let go, as
a retired profile's, so letting go of a build never runs its finalizers under
the lock. Each closes on its own: a finalizer that dies stops no other close.
Once every close has run, each failure is logged with the shared build it
belongs to (its extension id, scope and build key, carried on the failure by
the build's own scope, `SharedBuildOwner`); a lenient root fails no resolve
with it, and a test root raises them together (below). A build's own
acquisition, and its rollback when that acquisition fails, still run while the
resolve that awaits the build holds the place's lock. So a process Resource
must not resolve or reload the place it was built for from those, and a server Resource
must not resolve or reload any place: a server Resource has no place, and
every place that awaits its build holds its own lock.

A profile builds every extension's server Resources first, in resolution
order. A server build reads the host's services only, so its key is its
extension's version (`server`, then scope, id, source and file version) and
holds no place: every place that runs that version shares it. State that a
round started in one place and ended in another must both reach (the threads'
round-end feed) lives there. Then it builds every extension's process
Resources in resolution order, each over the host's services, every server
service of the profile and the process services before it. The build key of
an extension's process Resources names what that build reads: the place, the
key of every server build the profile holds, the identity (scope, id, source,
file version from `LoadedExtension.version`) of each process-bearing extension
before it, then its own. So a profile rebuilt for a config edit keeps the
process Resources the edit leaves alone, and their state with them (an open
`/btw` fork, the agents-view watchers, a running background job), while a new
version (an edit, or a reload that finds changed code) or a disable of an
extension with a server Resource releases its server build once no profile
holds it and builds every process Resource of the place again: a process
service is never held over a server service that closed. A reload that finds
the code unchanged keeps the version, so it keeps every key and every build.
Every leaf of a profile reads the services of both
scopes. A branch Resource keys on what its build reads (`branchResourceKeys`),
so it is built again when the process Resources it names are.

A profile runs each extension in one version across both phases. A build that
fails decides for its whole extension: its last good version runs in its place
(below), or it leaves the profile and is reported failed at the startup phase,
with the failure of the version that first failed; then both phases run again
over the new set. The pass before is let go only after the new one holds its
builds, so a build the change left alone is shared, not built again, and the
failed version's builds (its server service among them) close unless another
profile holds them. A last good version is named by its own version, in its
key and in the key of each build over it, so a Resource built over one version
is never shared by a profile that runs another. A reload (`SessionProfileCacheService.reload`, which the
`Extensions` facet calls) adds a count per (place, extension id) to the file
stamp, so the next resolve misses the cached profile, runs every setup again,
and keeps each Resource whose build key it shares; the counts live in memory
only. The cache keeps, per (place, scope, source path), the last version of
each user and project extension the place's current profile ran (`lastGood`).
A new version that fails `load`, `setup` or `validation`
(`loadRuntimeProfileDeclarations`), or whose server or process Resources fail
at `startup` (`holdResources`), runs that last good version in
its place, marked with the failure (`LoadedExtension.reloadFailed`); it keeps
the Resources the profile before it built, by their build key. A last good
version runs only in a set it is valid in: one whose contributions collide
with the set's fails as its new version did, and the set validates again
without it, so it never takes down an extension whose new version is good.
The profile key names the versions it decided by: the entry key adds to the
declaration key (`profileKey`) the last good version under the key of each
extension whose new version failed (`consultedLastGood`), named by scope and
source, since a user and a project extension can share an id; a fallback the
set rejected, and a failure with no last good version, count too. A profile
serves a resolve only while each of those is still the last good one
(`runsCurrentLastGood`), so a profile a turn still holds never brings an older
version back, nor keeps a failure that a newer last good version would fill. Health reports such an extension `Degraded` with an
`ActivationFailed` issue that carries the optional `runningVersion`, and the
facet reports it `Active` with the optional `reloadFailed`: both fields are
optional on the wire, so an older client reads a failed activation. A deleted
file, a disabled id and an untrusted project keep nothing. Branch Resources
have no fallback yet. An extension the disabled list names is reported `disabled`
(`resolveExtensions` takes it as a third list): `ExtensionHealth.Disabled` on
the wire, in the optional `disabledExtensions` field of both snapshot cases.
The TUI reads `extension.listStatus` again at each `TurnCompleted` of the
session in view (the turn resolved the extensions from their files) and on an
extension's pulse; the connection widget names a failed reload's running
version (`<id>: <error>; version <12 hex> still runs`), and `gent doctor`
names it too and lists the disabled ids (`Disabled: <ids>`).
The `Extensions` facet (`status`, `reload`) reads and reloads the session's
profile. The shipped `@gent/extension-admin` gives both to the agent
(`extensions.status`, `extensions.reload`), with four verbs over public entries
only: `enable` and `disable` edit a scope's `disabledExtensions` under
`FileLock` with `writeFileAtomic` and refuse a file that does not decode as a
`UserConfig` (exported from the extension API for this), keeping every raw key;
`add` copies a file or directory into a scope's extensions directory through a
hidden staging directory, and `remove` moves one into its own new directory
(an exclusive create) under the data directory's `extension-trash`, so no
remove replaces another, and deletes the source only after a whole copy when
a rename cannot cross file systems. The four ask once
(`Interaction.approve`) after their reads and before their write, so the tool
that runs again after the ask writes once; a headless run declines. `project`
needs a trusted project; trust stays the user's step. `resume` queues one
follow-up on the tool's own branch, which runs on the profile the change made.
The `/extensions` pane's two requests (`ExtensionAdminRpc`) make the same
changes without an ask, since the pane is the user's own act: a toggle off
writes the narrowest config that holds the session (the trusted project's,
else the user's), a toggle on takes the id from every config that names it.
No verb installs npm or git packages, and no watcher exists: the scan at each
turn start is the one apply point.
`buildSessionProfile` then stages the `ExtensionRegistry` and the base
prompt sections over the built resource context. The cache is a required
service of the loop behavior and of the server's session wiring: every turn
resolves its profile through it (`resolveTurnProfile`), so every turn has a
resource generation (`turnGenerationId`) for binding identity and replay, and
no launch-registry fallback exists. A session with no stored cwd resolves the
host cwd's profile as it is when it reads, for its turns, its agent admission
and its route (`resolveRegistryForCwd` in `server/server.ts`). Test roots provide `fixedSessionProfiles(profiles,
fallbackRegistry)` from `test-utils` when they do not need the live cache.
Profile tests use the live cache. The tool test layer uses the production composition root. Neither has a
separate activation implementation.

The production server uses one live profile owner:

- `runtime/extension-host.ts` owns entries by workspace, canonical cwd and
  disabled list. Each
  entry is built once: declarations load, every extension's process resources
  build into a child of the server scope, and `buildSessionProfile` stages the
  catalog from that context. An extension whose process resource fails to build
  is reported as failed at the `startup` phase; the rest of the profile stays
  live. There is no reconciler, publication, or admission lease. Gent owns
  resource identity, configuration and graph policy; Effect owns Context,
  Layer, Scope and finalization; effect-encore owns durable actor commands and
  recovery. Test roots
  (`createE2ELayer`) set `failOnExtensionFailure`, so a failed extension is a
  defect that names it, at build and at retire: a finalizer that dies when its
  build is let go fails the resolve or release that let go of it, once every
  close has run; `allowFailedExtensions: true` keeps a failure-path
  test running. The harness loads every `extensionInputs`/`extensions` entry
  at builtin scope; a scope test builds its profile from `LoadedExtension`s
  and passes it as `sessionProfileCacheLayer`.
- `server/server.ts` builds the launch cwd's profile in that cache at startup,
  so an extension that fails to load stops the start, and then releases the
  lease: a later edit retires that profile when its last reader ends. An RPC
  that names a session reads that session's profile; one shared lookup
  (`loadSession`) fails it with `NotFoundError` when the session does not
  exist, so no call answers from the launch profile instead. No registry and
  no extension resource service joins the server context. A turn, an extension request and a
  hook read them from their session's profile (for a session with no stored
  cwd, the profile of the host's cwd), the one owner of a turn's services, so
  a project that disables an extension does not see its resources. Driver
  catalog, auth and health callbacks also run under the selected profile's
  resource context. A pending login keeps that context with its profile lease
  until its callbacks finish. Receipt:
  "turn services" in `packages/core/tests/runtime/extension-host.test.ts`.
- Every session-scoped RPC names its session (owner rule). The contract
  (`packages/core/src/server/rpc.ts`) requires `sessionId` on `auth.setKey`,
  `auth.deleteKey`, `auth.listMethods`, `auth.listProviders`, `driver.set`,
  `driver.list` and `model.list`, so a payload that leaves it out is a type
  error at the call site and a decode failure on the wire; no handler has a
  launch-profile branch for a missing session. `extension.listStatus` takes an
  explicit `scope` (`ExtensionStatusScope`: `Session { id }` or `Launch`);
  only `gent doctor`, which has no session, asks for `Launch`. Its tags carry
  no constructor default (plain `Schema.Literal`, not `TaggedStruct`): the RPC
  client builds each payload with the schema's constructor, so a defaulted tag
  would read `{ scope: {} }` as `Launch`. A session that
  stored no cwd runs in the host's cwd, so it reads the launch profile as its
  loop does. `driver.clear` writes the user config and reads no profile, so
  it names no session. Receipt: the `@ts-expect-error` payloads in
  `packages/core/tests/server/rpc.test.ts` ("a session-scoped payload that
  names no session is a type error").

Turn profiles carry the process identity that built them. A process-local tool
binding names that process and is valid only inside it. A tool of a user or
project extension file binds to the file's version instead (`version:<hash>`,
`sourceRevisionFor` in `runtime/tools.ts`): after a restart the same bytes
replay, an edited file fails with `SourceMismatch`. Each profile also has a
revision, a short hash of what its extensions put in the request prefix
(`modelSurface`: each model tool in request order, with its name, description,
input and result schemas, prompt lines and whether it asks the user, then each
agent), not of their code: a body edit or a reload keeps it. What a hook
computes per turn (a turn projection's sections, a system-prompt rewrite) is
not a profile property and is not in it; a miss from it stays `PrefixChanged`. Every
`StreamStarted` of a turn names it (`profileRevision`, optional), so the cache
fold of the TUI names a prefix miss between two revisions `ExtensionsChanged`,
not a regression. The binding keeps the code identity; the revision keeps
only what the model reads.

Core writes two prompt sections: the environment, once per profile, and the
date, per turn. The date is the local day the session tree's root session
started (`dateSection`), so the cached prefix stays byte-identical past
midnight and a child shares its parent's. A turn on a later day carries
today's local date as a notice after the conversation (`dateNotice`, first
among the turn's notices, never stored). Extensions add sections
only from `turnProjection` hooks, which run each turn inside the extension
service context.

A `turnProjection` hook returns standing content as `promptSections` and
show-until-read content as `notices` (`TurnNotice`: id, content, keys,
trusted). The system prompt holds only the sections, so it stays
byte-identical while a notice comes and goes. Core places the turn's
notices after the conversation, as one system message at the end of each
step's request, and stores none (`toPrompt` in `runtime/model-context.ts`).
Each step then shapes the request for its model (`promptForModel`).
Decided by: content provenance decides the role. A system message in
history is the host's own instruction, and Anthropic lets it override the
top-level one, so only text that is wholly gent's own may take that role.
A notice is trusted only when it says so (`trusted: true`) because its
whole text is gent's own: no command output, file content, tool output,
model output or other third-party text. Core's date notice is trusted; the
wake, background job, stopped threads, session and example notes notices embed
outside text and say `trusted: false`; a notice that does not say, and a
stored system message, is untrusted. A later system message stays a system
message only when (1) it is trusted (the notices message is when every
notice in it is), (2) the model reports `supportsSystemMessagesInHistory:
true` (a model that does not say counts as false), and (3) it has a place
the Messages API takes: after a user turn (a tool result counts) and last
or before an assistant turn. Every other later system message goes as a
`<host-context-update>` user message at its place, its text escaped and its
cache marker kept, until each one left has a place, so the request never
ends on an assistant turn with a notice behind it. Core marks that user
message in its options (`gent.hostContextUpdate`, with the model's own
`hostContextUpdateOptions` from its driver class merged in), so a reader
knows it by its metadata, never by its text: a user may type the wrap. The
Anthropic driver knows an update by the Messages class's mark, keeps each
update a user message of its own and puts no tail marker on it or on a
system message, so the tail marker stays on the last conversation block;
the OpenAI drivers report no capability, so they get every notice as the
user message after the conversation, and the prefix they cache is
unchanged. The message opens with "Host status for this turn, not a
message from the user." The user form ranks below the system prompt, so a
user instruction wins over a notice. The opening line
keeps the model from reading host facts as the user speaking. A notice with
blank content is dropped, so it is never recorded as shown. The turn ledger records the keys each step's request
carried, per extension; `turnAfter` hands an extension back its own keys as
`readNotices` when the turn answered, and an empty set for an interrupted,
failed or unanswered turn. The marks live in the turn's memory: a turn a
restart cut short shows its notices again.
