# Agents

Agents are one schema, `AgentDefinition` (`domain/agent.ts`), written two ways:
an extension registers one (`host.register("agent", ...)`), and the config
`agents` key writes one in JSON as an agent patch, the definition's fields
without `name`, all optional (`Struct.omit` of the class fields, not a copy).
A config entry decodes through `AuthoredAgentPatch`, which refuses a key the
schema does not name and names the agent and the key. A turn reads the config
through `ConfigService.getFresh` and does not run while the user or project
file for its cwd does not load (`resolveTurnContext` publishes an
`ErrorOccurred` naming each file and ends the turn, as for an unknown agent):
the stand-in for a failed file (the last user file that loaded, an empty
project file) could drop a `tools` restriction. Config never widens an agent.
Health, providers and the route a client reads keep the lenient read.
`AgentDefinition`'s every authoring constructor (`new`, `make`, `makeEffect`,
`makeOption`) refuses a key the schema does not name (`refusedAgentKeys`).
The roster (`resolveAgentRoster`) is the extension agents with each config
entry of their name applied, plus a new agent for each entry that names none.
A patch replaces the fields it names; `systemPromptAddendum` appends. A field
resolves project entry > user entry > extension (`mergeAgentPatches` in
`mergeConfigs`), and a run's `RunSpec.overrides` (`RunOverrides`, a pick of the patch) wins
over all (`resolveSessionAgent`), so a workspace pins its orchestrator model
under `main` and its delegate threads' model under `delegate`, and a
`thread.start` call can still pick a different model and effort for one
thread. A run spec's `credentialSlot` (optional, beside `overrides` and never
in the stored patch) pins the run to one credential label: every request of
its turns and their handoff summaries walk that slot alone (`credentials.md`,
Credential slots). A child it spawns inherits the pin only when it names no agent (it
runs the parent's spec); a named-agent child walks its own spec's order, and
it starts where its parent stands only when both walk the same pin (both
none, or the same slot). A run's
`tools` and `paths` do not replace: they narrow (least authority; the
resolved definition is the bound its author set). The bound is a resolution
result, never part of a definition: `resolveSessionAgent` gives the reshaped
definition (routing reads it for the model and driver), and
`bindSessionAgent` gives the `SessionAgent`, a subclass of
`AgentDefinition` that carries a `RunBound` beside the fields: tool pattern
lists a tool must pass, every one, and path scopes, each with the cwd its
entries resolve against, a file tool call must lie in, every one. The lists
are the definition's, the run's, then every parent run's: an ordered pattern
list cannot write the intersection of two others, so they stay apart.
`admitsTool` and `pathScopes()` answer for the run. The turn binds its
dispatch agent (`resolveTurnContext`), and `Session.getAgent` returns the
bound agent, so hooks, `compileToolPolicy` and the file tools all read the
run. No author builds a `SessionAgent`: `AgentDefinition.make` refuses a
`bound` key, and `StoredAgentDefinition` refuses to encode one, so
`driver.list` sends only definitions, and a client that decodes one admits
what the server admits. A child never exceeds its parent run. A spawned
session's bound includes its parent run's whole bound, resolved again at
each turn and each file call (`resolveParentBound`, `resolveSessionBound`
in `extension-host.ts`), not copied at admission: a parent agent narrowed
later narrows its child at the child's next call, and a link retargeted
since admission is judged where it points at the call. A handoff is no spawn
(no depth level), but it runs under its predecessor's parent bound:
`resolveParentBound` climbs the handoff edges to the session that started
the thread and takes that spawn's parent run bound (none for a root thread),
and `admitRun` checks a handoff's named run `paths` against it, as for a
spawn. The handoff keeps its predecessor's admission unless it names one. A
predecessor that cannot be read, or a parent cycle, fails closed. Fail closed: a parent row that cannot be read,
a parent cwd whose config does not load, or a parent agent gone from its
roster is a `ParentBoundError` naming the parent session and agent; a create
of a child is refused with it, the child's turn ends with it as an
`ErrorOccurred`, and `Session.getAgent` fails with it, so a file call fails.
A session's own agent gone from its roster, or a session that cannot be read,
fails the same way: `Session.getAgent` fails with `SessionAgentError` naming
the session and agent, never returns a parent bound alone or no bound, so a
file call in a response that was streaming when the agent left is refused.
`getAgent` has no empty answer: no caller can read an unknown agent as
unbounded. A create that names run `paths` for an agent the roster lacks
(the default one included) is refused (`NotFoundError`).
Authority follows the creating run, not the input: the `ExtensionContext`
`Session.create` takes no `parentSessionId`, and the new session's parent is
always the calling session (`runInfo.sessionId`), so a tool in a bounded run
cannot make a root session or name a wider parent to leave its chain; a
`parentBranchId` of another session is refused (`admitParent`). A client's
`session.create` (the user) still names its parent, and only a client sets
`continueThread`, so only the user makes a handoff. An extension's reach is
its run's: `Session.delete` and the `historyBranchId` of `Session.create`
take only a session in the caller's thread or spawned below it
(`getThreadTree`); any other is refused with `SessionReachError`, so a tool in
a child cannot delete its parent or a sibling, or copy their history.
Session create (`admitRun` in `server.ts`, before the storage transaction)
also refuses, early and by name, a run `paths` entry that an agent scope or
a parent run scope does not reach with at least its access
(`RunPathRefusedError`; a dropped entry would change the run's meaning),
with links resolved at the check (`resolveLinks`, `pathWithin` and
`scopeReaches`, the predicates the file tools use). The stored form does not
change: an old row's `tools`, `paths` or old tool lists narrow when they
resolve. The turn,
`driver.list`, agent admission and the `Session.getAgent` facet all read the
roster the same way. `tools` is ordered patterns over tool ids: `*` matches
any run of characters, dots included; `!` takes tools back; the last match
decides; no match leaves a tool out; no list admits every tool. `paths`
(`{ path, access }`, a bare string a write entry, relative to the session cwd)
confines the shipped file tools: `fs-tools` reads the agent through
`ctx.Session.getAgent()` and refuses a target outside the entries of any of
its `pathScopes()` (`PathScopeError`) after links and `..` resolve, each
scope's entries against that scope's cwd; `read` and `grep` accept any
entry, `write` and `edit` only a write entry. It is not a sandbox: bash and the
cell are not confined. One reader owns the encoded agent (`readStoredPatch`): it
reads config entries (`AuthoredAgentPatch`) and `driver.list`
(`StoredAgentDefinition`), with the keys before `tools` (`allowedTools`,
`deniedTools`, `modelId`), and prefers the new ones. `sessions.admission_json`
holds the new keys only (`RunOverrides`). A `deniedTools` list alone keeps an internal
`legacyTools` edit that the merge resolves against the inherited tools (they
minus those ids); an `allowedTools` list alone replaces and keeps the
inherited denials; both replace. An explicit `tools` replaces. A wire reply
gets the new keys and also the old ones
(`writeStoredPatch`), so the previous gent, SDK and TUI read them the same
way: `model` also as `modelId`, patterns the old lists
can express as those lists, and any other patterns as `allowedTools: []`, so
an old reader holds no tool rather than every tool. `paths` has no old form:
an old reader drops it. A config entry writes back the keys its author used
(`writeAuthoredPatch`), and a config write keeps an unchanged field's raw
JSON, so a config file never gains keys for an older gent. A `thread.start`
call names its overrides as flat parameters (`model`, `effort`, `tools`,
`instructions`), and the thread writes them to its run spec with the new
keys only. Wire readers stay tolerant of unknown keys;
authoring is strict: a config entry, `AgentDefinition.make` and
`new AgentDefinition` refuse a key the schema does not name, so TypeScript
that still passes `allowedTools` fails to load rather than run with every tool. Each turn reads the config files as
they are then, so an edit reaches the next turn without a restart.

## Session admission, model and effort

- The agent is a session property. `Session.admission` (agent, run spec;
  `sessions.admission_json`) is fixed at creation,
  and every turn of the session runs under it: the first, a wake, a queued
  follow-up, a steer that starts a turn, and a recovered turn after a restart.
  `resolveSessionRoute` (`runtime/turn.ts`) resolves it once for the turn,
  the snapshot (`SessionSnapshot.agent`) and the auth check. No queue item,
  steering command, turn record or loop state carries an agent. A handoff
  (`continueThread`) keeps its parent's admission unless it names one, and
  with it the run spec's credential pin (`RunSpec.credentialSlot`). A row
  stored while admission carried `interactive` still decodes; the key is
  ignored and dropped on the next write.
- Model precedence: the session's `/model` setting, then the admission's run
  overrides, then config `agents[name]`, then the agent definition.
- Effort follows the same order. `/effort <level>` (alias `/think`) stores the
  session's level: `off` stores `none`, and `default` clears it, so the run
  overrides, config and agent decide again. `/effort auto` stores `auto`
  (the `reasoning_level` column holds `"auto"`; the session reads it as
  `reasoningAuto: true` with no level, and an older binary reads no level),
  and each user turn asks the effort router for its level (the effort router
  bullet above); `/effort <level>` or `default` leaves auto. The `/effort`
  picker lists `default`, then `auto` and the levels the model accepts (its
  catalog `efforts`; neither for a model with no reasoning); the `default` row names the level without the
  session's own (`defaultReasoningLevel` on the snapshot and on
  `session.get`), so an override does not hide it. The status row shows the effort the model is
  sent, after the clamp to the levels it accepts (`effectiveEffort`,
  `@gent/core/protocol`). While a turn runs it shows the turn's own level:
  each `StreamStarted` names the model and the level its step goes out at
  (the fields of the `StreamEnded` receipt), the metrics fold keeps it as `turnEffort` until
  `TurnCompleted`, and a level set meanwhile shows once the turn completes.
  On auto the row reads `auto → <level>` with the newest effort route's
  level, and `auto` before the first route.
  The change writes no notice and keeps the cache (rule 11).
