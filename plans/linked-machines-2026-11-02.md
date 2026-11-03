# Linked machines (sync), design plan, 2026-11-02

Labels: **[m]** measured (read in code, docs or on disk), **[i]** inferred (follows from measured facts), **[g]** guess (not checked). Line numbers are at `8dbb1ad67`.

## Goal

The owner works on two machines: the Mac and the workbox (`bite-cristian`, ssh alias `bite-workbox`, Tailscale). Each runs one shared `gent server start`. Link the two servers so that:

1. `~/.gent/config.json` is the same on both machines.
2. User extensions (`~/.gent/extensions`) and user skills (`~/.gent/skills`) are the same on both machines.
3. Sessions are not copied. A session lives on the machine that runs it. From either machine the owner can list, open, read and drive every session of both machines. The owning machine serves it live.

Auth is out of scope. `~/.gent/auth/` stays per machine. Nothing in this design reads, copies or prints it.

## Today

**The only link is the pool peer.**

- `pool.peer` is an argv in the user config: `PoolConfig = Schema.Struct({ peer: Schema.optional(Schema.NonEmptyArray(Schema.String)) })` (`packages/core/src/runtime/config.ts:209`, field at `:270`) [m]. The owner's config has a top-level `pool` key [m: key names only].
- `runPoolPeer` spawns that command and writes pool facts as JSON lines to its stdin; it reads the peer's lines from stdout (`packages/core/src/runtime/provider.ts:8539`) [m]. The far end is `gent ctl pool --follow` (`apps/tui/src/ctl.ts:1782-1824`) [m], wired in the server at `packages/core/src/server/server.ts:2825` [m]. A peer with no line for 90 s turns silent (`provider.ts:3757`) [m]. The facts name a host from `os.hostname()` (`packages/core/src/runtime/gent-platform-bun.ts:283`) [m].
- So an ssh-carried child process with a stdio channel to the other server exists and works today [m]. It carries one private line format, not RPC [m].

**RPC is loopback, unauthenticated, schema-first.**

- The server listens on `127.0.0.1` only (`gent-platform-bun.ts:307`) [m]. Clients speak Effect RPC over WebSocket (`packages/sdk/src/client.ts:94-136`) [m]. Rule 16: RPC is the only application transport (`docs/architecture/server.md`) [m].
- Each request carries the header `x-gent-workspace-id` = sha256 of the client's cwd (`packages/core/src/server/workspace-rpc.ts:10,29,38`) [m]. Headers ride each request, not only the socket (`packages/sdk/src/client.ts:194,238`) [i].
- Session-scoped inputs name `sessionId` (`packages/core/src/server/rpc.ts`: `CreateBranchInput:135`, `SendMessageInput:159`, `GetSessionSnapshotInput:179`, `QueueTarget:233`, `SubscribeEventsInput:245` with an `after` cursor at `:248`, `RespondInteractionInput:253`, `UpdateSessionSettingsInput:286`, `ExtensionRpcRequestInput:389`, `SetDriverOverrideInput:521`) [m]. One gap: `message.list` takes `{ branchId }` only (`rpc.ts:641`) [m]. This breaks the owner rule "every session-scoped RPC names its session" [i].

**A session has no machine.**

- `SessionId` is a branded string (`packages/core/src/domain/ids.ts:5`), made from `platform.randomId` (`server.ts:890`) [m]. The `Session` class has no machine field (`packages/core/src/domain/message.ts:592`) [m].
- `session.list` reads the local store only (`server.ts:2130`) [m]. The agents view lists sessions through the host facade `listSessions` (`packages/core/src/runtime/extension-host.ts:4751`; `packages/extensions/src/agents-view.ts:802`) [m]. It shows them in a pane docked below the input (`apps/tui/src/extensions/agents.client.tsx:2352-2366`) [m].
- The actor entity id is `workspace:session:branch` (`packages/core/src/domain/agent-loop.ts:449-454`) [m]. The workspace comes from the request header, not from the session's stored cwd (`packages/core/src/runtime/session.ts:295-296,321-322`) [m]. So a call for one session from two different cwds addresses two entity ids [i]. That is two actors for one session, against rule 2 [i]. A remote client always has a different cwd, so the link makes this latent gap certain [i].
- Some client features act on the client's own machine: shell mode runs `bash -c` locally (`apps/tui/src/composer.tsx:255-262`), file completion reads the local disk (`apps/tui/src/autocomplete.ts`), the git widget runs local git (`apps/tui/src/extensions/git.client.tsx:328-356`) [m]. For a session on the other machine each one would act on the wrong machine [i].

**Config and extensions reload without a watcher.**

- The config is read again when its file stamp changes (`config.ts:802`, `fileStamp` near `:1240`) [m]. Writes go through `writeFileAtomic` (`config.ts:1275-1293`) [m]. The profile key hashes the config fingerprint (`docs/architecture/profiles.md:17`) [m]. "No watcher exists: the scan at each turn start is the one apply point" (`profiles.md:193-194`) [m].
- A failed extension build keeps the last good build (`extension-host.ts:1600-1615`) [m]. `extension.add` copies into a temp staging dir and renames into place (`packages/extensions/src/extension-admin.ts:410-419`); `remove` moves the entry into `extension-trash` in the data dir (`:486,508`) [m].
- Skills load from `.gent/skills`, `.claude/skills`, `.codex/skills`, `.agents/skills` at user and project level (`packages/extensions/src/skills.ts:257`) [m].
- On the Mac today: `~/.gent/extensions` and `~/.gent/skills` do not exist [m]. `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills` are symlinks to the dotfiles repo [m]. Git already syncs those [i].

**Name clash.** The `@gent/machines` extension owns the RPC names `machine.define`, `machine.start`, `machine.answer` (`packages/extensions/src/machines.ts:1-30`) [m]. This design uses the prefix `link.` and the word "linked machine" so that it does not clash.

## The design

### 1. The link

One link per peer, generalized from the pool peer. It carries RPC, and RPC carries everything: pool facts, remote sessions, config and file sync.

- **Config.** `link.machines` replaces `pool.peer`: a record from machine name to argv, for example `{ "bite-cristian": ["ssh", "bite-workbox", "gent", "ctl", "link"], "<mac-name>": ["ssh", "<mac-alias>", "gent", "ctl", "link"] }`. The file is identical on both machines. Each server runs every entry except its own name. The own name is the hostname to the first dot; `GENT_MACHINE` overrides it (two scratch servers on one host need it) [i].
- **The far end.** `gent ctl link` connects to the local shared server over the normal WebSocket and relays frames: each stdin line becomes one frame, each frame becomes one stdout line. It does not decode them. It never starts a server; with no server it exits non-zero and the caller backs off. It exits on stdin EOF. JSON frames hold no raw newline, so line framing is safe [i].
- **The near end.** The server spawns the argv in a scope and builds an Effect `RpcClient` over the child's stdio (`Socket.make` over the pipes, `RpcClient.layerProtocolSocket`) [i: the Effect 4.1.2 modules `rpc/RpcClient.ts` and `socket/Socket.ts` exist, m; the wiring is not tried, g]. It is a typed client of the same `GentRpcs` contract. No second protocol exists.
- **Hello.** The first call is `link.hello` → `{ machine, contract }`. `contract` is a hash of the RPC group's tags and schemas [g: feasibility; fallback is the build commit]. A different contract puts the link in state `incompatible`. Nothing routes over it. `gent ctl lanes --line` and doctor show the state.
- **States.** `connecting`, `connected`, `silent` (no frame for 90 s, the pool rule), `incompatible`. Backoff doubles to 5 minutes, as today.
- **Loop stop.** The relay adds the header `x-gent-link: <origin machine>`. A request with it is served locally only. It never routes on. This stops A→B→A loops [i].
- **Pool facts.** The server pulls the peer's `accounts.pool` stream and pushes its own facts with the peer's `accounts.notePeer` (`rpc.ts:720,726`) [m: both RPCs exist]. One link carries pool facts both ways, as the JSON-lines channel does today [i]. The JSON-lines format, `pool.peer` and `ctl pool --follow` go.
- **Proxy, not direct.** A client always talks to its own server. The server proxies to the owner. RPC stays on loopback with no new listener, ssh stays the only auth, and no credential crosses [i]. One server per machine owns each actor (rule 2) [i]. Latency adds one ssh hop per call; events stream, so a turn pays it once per subscription [i].
- **Core.** The link is transport. It lives in core in one new file, `packages/core/src/server/link.ts`. Reason for a new file: two concerns share it (the pool and session routing) [i].

### 2. Remote sessions as one aggregate

- **Address by lookup, not by id.** A session id does not carry its machine. The server routes each session-scoped call: the local store has the id → serve locally; else ask each connected peer `link.locate({ sessionId })` in parallel, keep the answer in a memo, forward the call. Random ids make a clash negligible [i]. The id needs no format change, no schema bump and no rewrite at the proxy [i].
- **Forwarding.** The forward calls the same RPC tag with the same payload on the peer's typed client [i]. Streams (`session.events`) forward as streams.
- **Workspace from the session.** For a session-scoped call the owning server takes the workspace from the session's stored cwd, not from the header. One session then has one entity id from every client and every machine (rule 2) [i]. This fix also holds for two cwds on one machine [i].
- **`message.list`** gets `sessionId` (owner rule) [i].
- **New error.** `MachineUnreachable { machine, sessionId }`, a `Schema.TaggedError`, joins the error union of each session-scoped RPC.
- **Server-scoped calls stay local.** `session.list` stays local, so a peer never recurses. New `link.machines` → each machine with its state. New `link.sessions` → the local list plus each connected peer's `session.list`, each row tagged with its machine. A silent peer shows as one row with its state and no sessions.
- **Create.** `session.create` (`CreateSessionInput`, `rpc.ts:111`) takes an optional `machine`. The cwd is a path on that machine. A `parentSessionId` routes the create to the parent's machine. A `machine` that differs from the parent's is refused: `CrossMachineSession`. Fork and branch calls name a session, so they always run on its owner [i]. A fork onto the other machine cannot happen.
- **Link drop mid-turn.** The turn runs in the owner's actor and goes on [i]. The client's stream fails with `MachineUnreachable`. The TUI marks the machine silent and subscribes again with `after` (`rpc.ts:248`) when the link is back. Sends are not retried by the server: the TUI keeps the draft. The transcript after the re-subscribe shows if the send arrived.
- **Clients.**
  - The sessions pane in the agents view (docked below the input) groups rows by machine: the local machine first, then each peer with a machine mark `⌂ <name>` and its link state. It reads through a host facade `linkedSessions`, open to every extension (a shipped extension is never more privileged) [i].
  - The status line names the machine of a remote session.
  - `gent resume <id>` and `gent ctl -s <id>` work for any session; routing is in the server. `gent resume` with no id continues the newest session in the local cwd (`apps/tui/src/app.tsx:338`), as today.
  - `gent sessions` (`apps/tui/src/ops.ts:971`) prints a machine column. `gent ctl` gets `--machine <name>` for create.
  - For a remote session the TUI refuses shell mode with one notice, turns off file completion and hides the git widget. Routing them is later work.

### 3. Config sync

- **One shared file, no per-machine file.** Nothing that is in the file today must differ per machine [i]. Top keys today: `permissions`, `sabbath`, `roles`, `providers`, `wake`, `pool`, `model` [m]. `link.machines` is keyed by machine, so each server takes only the other entries. A trusted-project path that does not exist on a machine matches nothing there [i].
- **Merge, no conflict state.** Each side keeps a base: the last merged config, in `~/.gent/sync/<peer>/config.json` (data dir, not synced). A sync compares local, peer and base by JSON path. Objects merge per key. Arrays and scalars are atomic. A path changed on one side only takes that change. A path changed on both sides to different values takes the value of the newer file mtime; the lost value goes to `~/.gent/sync/<peer>/lost/<ts>.json` and doctor lists it. There is no state to clear and no blocked sync [i].
- **Who writes.** The side with the link drives: it reads the peer config, merges, writes its own file with `writeFileAtomic`, then writes the peer's file with a compare-and-set on the peer's stamp. A changed stamp makes it merge again. Both sides end identical; both bases become the merged doc. With two links both drive; compare-and-set keeps it safe [i].
- **When.** At link connect, and on a stat sweep every 10 s while connected. A stat of one file is cheap [i]. `gent ctl sync` runs it at once.
- **Apply.** The write changes the stamp; `getFresh` (`config.ts:802`) reads it; the fingerprint changes; the next turn builds the new profile (`profiles.md:17`) [m: path exists]. No new reload path.
- **Secrets.** Provider `env` and `headers` (`config.ts:150-151`) sync as config [i]. They cross only the owner's own ssh channel. `~/.gent/auth/` is never touched.

### 4. Extensions and skills sync

- **Directories.** `~/.gent/extensions` and `~/.gent/skills` only. The other user skill dirs are dotfiles symlinks; git syncs them [i]. Project dirs live in repos; git syncs them.
- **Entry.** One top-level child of a synced dir (a file or a directory) is one entry. Its hash is a sha256 over its sorted paths, modes and bytes, without `node_modules` and `.git`.
- **Change.** The same three-way rule as config, per entry, against a base manifest in `~/.gent/sync/<peer>/files.json`. Add: present on one side, absent on the other and in the base → copy. Edit: hash differs from the base on one side → copy. Delete: absent on one side, present in the base and unchanged on the other → delete. So the base is the tombstone; no tombstone record exists [i]. Both changed: the newer mtime wins; the loser moves to `extension-trash`, as `extension.remove` does (`extension-admin.ts:486,508`) [m: path].
- **Atomic swap.** The receiver writes the entry into a staging dir under the target's parent, then renames. A directory replace moves the old entry to `extension-trash` and renames the staged one in. A turn-start scan between the two renames sees no entry for one turn [i]. A cut transfer leaves only a staging dir, which the next sync removes. A partial copy is never visible [i].
- **Broken code.** A copy that does not build keeps the last good build and shows a failed status (`extension-host.ts:1600-1615`) [m]. An extension that needs packages from `node_modules` fails on the receiver until the owner installs them there [g].
- **Apply.** The next turn's scan picks it up (`profiles.md:193-194`) [m].
- **Where it lives.** File sync is a shipped extension, `packages/extensions/src/sync.ts`. It reads and writes with the platform `FileSystem`. It talks to its twin on the peer through a new core host facade `link.request(machine, request)`, which calls the peer's extension server request (`ExtensionServerRequestInput`, `rpc.ts:402`). A user extension gets the same facade. Core owns the transport only [i].

## What is rejected and why

- **Copying sessions.** The owner chose remote sessions. A copy has two writers of one durable session and two actors [i].
- **Machine in the session id.** A format change, a schema bump, and a rewrite at every proxy. A lookup costs one round trip per first touch [i].
- **Client connects to the peer directly** (a Tailscale port, opencode `attach` style). It needs a network listener and auth on an RPC that is loopback and unauthenticated by design [i].
- **ssh `-L` forward per client.** Each client manages a forward, discovery breaks, and the forward exposes the unauthenticated server to every local user of the far port [i].
- **A second channel for files** (rsync, Syncthing, a git repo of `~/.gent`). rsync both ways has no base and loses deletes; Syncthing is a new daemon with its own conflict files; a git repo needs an owner commit per change. One RPC link already reaches both servers [i].
- **A per-machine config overlay** (`config.local.json`). A second read path with nothing to hold today [i]. Owner question 3.
- **Remote tool execution** (Codex `exec-server` style: a local session runs tools on the other machine). A session lives on its machine with its cwd and files [i].
- **Server retry of a failed send.** Its delivery is unknown; a retry can send twice [i].

**Prior art** (fetched with `okra repo`):

- opencode (`sst/opencode` at `b42c316`): `opencode attach` and `pair` connect a thin client to a remote server over HTTP (`packages/cli/src/services/server-connection.ts`, `packages/cli/src/commands/handlers/pair.ts`, `packages/cli/src/services/remote-tunnel.ts`) [m: files read]. **Take:** the server that runs a session serves it; the client is thin. **Reject:** the direct network connection with pairing auth.
- Codex (`openai/codex` at `94350a9`): remote control wraps the existing app-server messages in envelopes over one channel (`codex-rs/app-server-transport/src/transport/remote_control/protocol.rs:92-195`) [m]. Cloud tasks list remote tasks and apply their diff locally (`codex-rs/cloud-tasks-client/src/api.rs:137-163`) [m]. **Take:** relay the existing protocol unchanged over one channel (`gent ctl link`). **Reject:** cloud tasks (a snapshot to apply, not a live session) and `exec-server` (`codex-rs/exec-server/src/remote.rs`, remote tools for a local session).
- pi (`earendil-works/pi` at `8c03fef`): RPC mode is JSON lines over stdin and stdout (`packages/coding-agent/docs/rpc.md`) [m]. **Take:** stdio is a full RPC transport. **Reject:** one process per session; pi has no aggregate of machines [i].

## Units

Each unit compiles and passes `bun run gate` alone, in this order. No test reaches the network or ssh: a link argv in tests runs `gent ctl link` (or the in-repo entry under `bun`) against a second scratch server in its own `GENT_DATA_DIR` with its own `GENT_MACHINE`. Each regression test is proved red with its fix off (memory: "validate regression tests catch the regression").

### U1. One entity per session, and `message.list` names its session

- **Files.** `packages/core/src/server/rpc.ts` (`message.list` input), `packages/core/src/server/server.ts`, `packages/core/src/runtime/session.ts` (workspace from the session's cwd), `packages/sdk/src/client.ts` and its callers in `apps/tui/src`, `docs/architecture/server.md`.
- **Tests.** Through the SDK client: create a session from cwd A, send from a client with cwd B, read the state from A. One entity serves both; one turn runs. Red today: the B send starts a second entity [i]. `message.list` with a `sessionId` of another session's branch is refused.
- **Live check.** verify-gent: start a turn in the TUI, `gent ctl -s <id> send` from another cwd, the TUI shows the reply in the same transcript.

### U2. The link replaces the pool peer

- **Files.** New `packages/core/src/server/link.ts` (spawn, stdio RPC client, hello, states, backoff, pool pull and push). `config.ts` (`link.machines` replaces `PoolConfig`), `provider.ts` (delete `runPoolPeer`, `followPoolPeer` and the JSON-lines codec, keep `notePeer`), `server.ts` (wiring, `link.hello`), `rpc.ts` (`LinkRpcs`), `apps/tui/src/ctl.ts` (`ctl link` relay; delete `pool --follow`), `docs/architecture/lanes.md`, `docs/architecture/server.md`. The existing pool peer tests move to the link (memory: "vehicle vs subject tests").
- **Tests.** Two scratch servers, A links to B: `link.machines` on A shows B `connected`; B's pool facts appear in A's lanes and A's in B's. Kill B: A turns B `silent` after the idle window (TestClock where in-process). Different contract hash: `incompatible`, no pool facts. `gent ctl link` with no server exits non-zero and starts nothing. A frame with `x-gent-link` is not routed on.
- **Live check.** Two mock servers on the Mac with two `GENT_DATA_DIR`s, each config naming the other with a local argv (memory: "cross-machine pool live check"). `debug threads` on B holds a lane; `gent ctl lanes --line` on A prints `peer <B> …` with the held lane.
- **Owner data.** After U2 merges, the owner's two configs need `pool.peer` rewritten as `link.machines`. No shim reads `pool.peer` (personal library).

### U3. Remote sessions route through the server

- **Files.** `link.ts` (locate, memo, forward), `server.ts` (the router around each session-scoped handler, `link.sessions`, create with `machine`), `rpc.ts` (`MachineUnreachable`, `CrossMachineSession`, the `machine` field), `packages/core/src/domain/message.ts` only if the error lives there, `docs/architecture/server.md`, `docs/architecture/runtime.md`.
- **Tests.** Two scratch servers with a link. Create on B through A's client with `machine: B`; send through A; A's event stream shows B's turn; B's store has the session and A's has none. `link.sessions` on A lists both machines. A fork call through A runs on B. `session.create` with a B parent and `machine: A` fails with `CrossMachineSession`. Stop B mid-turn: A's stream fails with `MachineUnreachable`; start B; a re-subscribe with `after` returns the missed events. A loop test: A and B both linked, an unknown id returns not-found and no call repeats.
- **Live check.** Two scratch servers on the scripted model: `gent ctl --machine B create`, `gent ctl -s <id> send` on A, read the transcript on B.

### U4. Clients show the aggregate

- **Files.** `packages/core/src/runtime/extension-host.ts` (the `linkedSessions` facade), `packages/extensions/src/agents-view.ts`, `apps/tui/src/extensions/agents.client.tsx` (machine groups and mark), the status line, `apps/tui/src/composer.tsx` (shell-mode refusal), `apps/tui/src/autocomplete.ts`, `apps/tui/src/extensions/git.client.tsx`, `apps/tui/src/ops.ts` (`gent sessions` column), `apps/tui/src/ctl.ts` (`--machine`), `apps/tui/docs/cli.md`, `docs/architecture/tui.md`.
- **Tests.** TUI render tests: the pane groups rows under machine headers with the mark and a silent peer's state, at normal and narrow width. `!ls` in a remote session shows the notice and runs nothing. `gent sessions` prints the machine column. e2e: `gent resume <remote id>` opens the transcript.
- **Live check.** verify-gent with two scratch servers: open `/sessions`, see both machines, open a B session from A, send, resize, stop B and see the silent mark, start B and see the stream come back. Compare with Codex and Pi (`docs/architecture/ui.md`).

### U5. Config sync

- **Files.** `extension-host.ts` and `packages/core/src/extensions/api.ts` (`link.request` facade), new `packages/extensions/src/sync.ts` (merge, base, sweep, `gent ctl sync` request), `packages/extensions/src/index.ts`, `docs/architecture/profiles.md`, `docs/architecture/shipped-extensions.md`.
- **Tests.** Two scratch servers: a `model` change on A appears in B's file and B's next profile. Link down, change `roles.x` on A and `wake` on B, link up: both files hold both changes. Change `model` on both while down: the newer wins and the older is in `lost/`. A user extension can call `link.request` like the shipped one. `link.machines` stays identical on both.
- **Live check.** Two scratch servers: edit the scratch config on A by hand, wait one sweep, `gent ctl` on B shows the new model on its next turn.

### U6. Extensions and skills sync

- **Files.** `packages/extensions/src/sync.ts` (manifest, entry transfer, staging, trash), `docs/architecture/profiles.md`.
- **Tests.** Two scratch servers: add an extension on A, B's next turn has its tool. Edit it on A, B gets the edit. Delete it on A, B moves it to `extension-trash`. Edit on both while down: the newer wins, the loser is in trash. Copy a broken edit: B keeps the last good build and reports the failure. Cut a transfer (fail the stream after half the files): B's dir has no partial entry. A skill dir added on B appears in A's skill list.
- **Live check.** Two scratch servers: drop a one-tool extension into A's `~/.gent/extensions`, run a turn on B on the scripted model that calls the tool.

## Owner questions

Orchestrator defaults (2026-11-02), in force until the owner answers: (1) hostnames, (2) `gent ctl --machine` only in U4; a TUI flow is a later unit if the owner asks, (3) one shared file. The orchestrator rewrites both owner configs from `pool.peer` to `link.machines` when U2 merges, with a backup of each.

1. **Machine names.** Use the hostnames (`bite-cristian` and the Mac's hostname), or short names you choose (for example `mac` and `workbox`)? Short names need one per-machine setting outside the shared config. Default: hostnames.
2. **Create on the other machine from the TUI.** U4 gives create on the other machine through `gent ctl --machine` only. Do you also want a TUI flow (pick a machine and a cwd there), or only open existing sessions?
3. **Per-machine config.** Is there a config key you want different per machine (for example `model` or `sabbath`)? Default: none, one shared file.
