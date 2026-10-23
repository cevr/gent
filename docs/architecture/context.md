# Model context, prompt and routing

- Context compaction is a seam, not a core feature. The loop checks the window,
  and with no `ModelContextCompactor` process resource installed it truncates
  and reports the omission. The `@gent/compaction` extension installs the
  summariser; core keeps only the window marker shape (`context-window`,
  optional `summarized` range) that status and the TUI read. Core owns its
  one recogniser, `contextWindowOf` (`@gent/core/extensions/api` and
  `protocol`): a marker the runtime wrote, its type and its decoded details,
  reads as its anchor, summary and notice; the type alone or a copied notice
  reads as nothing. No compactor names the type by value. A window that
  every compactor fails degrades to truncation with a visible notice. The request names the
  agent whose window it compacts (`agentName`), so a project compactor can
  serve one agent and fail with `ModelCompactionError` for the others.
  Installed compactors form one chain in scope order, project, then user, then
  builtin (`chainCompactors`, joined where the host merges each extension's
  Resource services): the first summary wins, a `ModelCompactionError` hands
  the window to the next compactor, and with none left the window is
  truncated. Each compactor of the chain runs under the turn's credential
  walk (`CompactionAttempt`, model-context.ts): a failure whose `cause` is
  the summary model's is retried, or moved to the next credential, before
  the next compactor gets the window, and a failure the walk gave up on
  leaves without its cause, so no outer run retries it again. A stop of the
  turn ends the compaction where it is (a backoff, a summary stream, the next
  compactor): the projection fails with `CompactionStopped`, which no
  compactor sees, the step does not start, and the turn ends interrupted with
  no truncation notice. A stopped turn admits no model
  (`resolveAdmittedModel`, turn.ts), so a compactor that asks for its summary
  model after the stop gets a refusal and spends no model call. A compactor runs with the `ExtensionContext` a tool call of its
  extension on the compacted branch gets: the merge wraps each extension's
  compactor before it joins the chain (`ownedCompactor`), and each call runs
  `provideExtensionLeaf` with the owner's id over the turn's host context and
  the compacted agent. So `ctx.State.changed()` and `ctx.Session.send` name
  the owner, and `ctx.cwd` is the session's cwd: a user-scope compactor or a
  process resource that profiles share needs no cwd captured at setup, and
  the request carries no cwd. The marker's notice
  names the session id, the branch id, and the replaced id range so the model
  can page the replaced history from the cell.
- A compactor answers a `CompactionOutcome`: `Summarized` (the marker above)
  or `Pruned`. A prune keeps the window: the loop persists a `context-prune`
  runtime line (`pruneLineMessage`, id `context-prune:<branch>:<cutoff>`)
  that opens no window, and `modelVisibleWindow` reads each tool result
  stored before the newest line's cutoff as a stub (call id, tool, failure
  flag, options and size; a result with images stays whole). Storage keeps
  every result, so `context.read(callId)` pages one back. The estimate, the
  projection and the handoff plan read that view; a step measured before the
  line no longer measures the window, and the rent meter treats the line as a
  window start. The request carries why the window hands off (`trigger`:
  `Requested`, `Refused`, `Overflow`, `RoleWindow`, `Cold`), the message
  tokens a kept window must get under (`targetTokens`) and the projection's
  estimate (`estimateTokens`). The loop refuses a prune whose cutoff is not
  in the window or already has a line (`PruneChangedNothing`), or whose
  window still omits a message or overflows (`PruneOverBudget`); a chain
  then asks its next compactor. The shipped
  compactor stubs the results before the window's fifth-newest assistant
  step and prunes on `Overflow` and `RoleWindow` when that fits half the
  target, on `Cold` when it fits the target; otherwise it summarizes the
  history with those stubs applied. A copy of a branch (`copyMessagesToBranch`,
  a session's `historyBranchId` and a fork) keeps every result whole and moves
  a prune line's cutoff to the copied row. Design:
  `plans/pruned-handoff-2026-10-22.md`.
- The rent meter says what each held item has cost. `foldContextRent`
  (model-context.ts) folds the branch's events, oldest first, with the
  orchestrate budget's `burnOf` arithmetic: the first call's context is the
  base, each later call spreads its cache reads (0.1) and a cache miss's
  re-write over the held items by size, a reply joins at its step's output
  tokens and the rest of the growth splits by length, and a window marker
  starts a window with the marker holding what came before. The meter holds
  what the model was sent: a hidden message never joins it, and a projection
  that omits the oldest messages names the first it kept
  (`ModelContextProjected.keptFromMessageId`), so their items leave it. The
  turn keeps the fold beside its step reads (`KnownSteps.rent`), each
  projection carries the costliest five of what it sends
  (`ModelContextProjected.renters`, none once it hands off), `context.status()`
  returns them, and the TUI's gauge names the costliest (`ctx 42% · read
  12k`). Gent charges a tool result at its bounded size, the text its model
  sees. The meter reads the turn's calls only: a compaction summary's call
  reports its usage on `CompactionOutcome.cases.Summarized`, not on a step. A forked branch
  starts its meter fresh.
- The window a role compacts at is a seam too: `ModelContextWindowPolicy`
  (`@gent/core/extensions/branch-tools`) answers `window({ agent, child })`
  with `Option<number>`. The loop reads it with `Effect.serviceOption`, so
  with none installed every role runs at its model's window, and a later
  extension's policy replaces an earlier one (the Resource merge). The
  answer only lowers the window: a value at or above the model's, or not a
  positive integer, is ignored. The role window is a soft limit: the budget,
  the output reserve and `maxTokens` stay the model window's for every
  session. A spawned session hands off at the role window before any step
  (`roleWindowBinds`); a root hands off at it only when a turn starts,
  anchored at the new prompt, so a turn's steps keep the cache they wrote.
  A window past the role window with nothing to summarize (a first prompt
  alone) goes out under the model's budget; only the model's window fails a
  step. One pure rule, `planWindow` (model-context.ts), decides `Keep`,
  `Overflow` or `RoleWindow` for the projection and for the tuner's replay,
  from the model window, the output reserve and the input cap the step ran
  under. `@gent/compaction` installs the policy as a server Resource
  (`ContextWindows`, compaction.ts). Its `turnAfter` hook folds the turn's
  branch events into samples: each step's input tokens (`StreamEnded.usage`),
  model window, output reserve, input cap and handoff
  (`ModelContextProjected`; a step whose projection records no reserve is
  not sampled), and each first `read` after a handoff of a path read before
  it. A `bash` command that names such
  a path is stored too, for the tune report's `readCoverage`; a
  `context.read` is a cell host call with no tool event and is not seen. The
  samples go to the server's database (`context_window_steps`,
  `context_window_rereads`), so every place's turns meet one table. When the
  last tune is over 24 h old, the hook starts one in the Resource's scope
  (one at a time per server; the run's hour is the primary key of
  `context_window_tunes`, so a second server's run is a no-op). A server
  whose check finds a fresh tune from another server reloads that tune's
  windows. The tune
  replays each role's last 7 days at 100k to 350k with the stored handoffs
  undone, prices each handoff as its summary call, the restart write and the
  role's re-reads per handoff (the fleet's below 20 handoffs, 20k with
  neither), skips a role under 20 agents (branches), and keeps the largest
  window within 1% of the cheapest (`tuneWindows`). A failed table setup or
  load leaves every role at its model window; a corrupt row leaves its own
  role there, with a warning. The summary prompt keeps plan, log and state
  file paths, the current step and the user's instructions word for word,
  and the summary source is led by the latest earlier handoff marker, so
  the paths it named carry forward.
- Project instructions are an extension, not a profile field. `@gent/agents`
  reads `AGENTS.md` (or `CLAUDE.md`) from the gent home, each directory from
  the git root down to the project (the project alone outside a git work tree,
  as opencode reads them) and the project-local `.gent/` on every turn and contributes the `project-instructions`
  prompt section at priority 70 beside the persona sections. Launched from home
  (`hasProjectScope` is false), the project-local `.gent/` is the gent home and
  is read once. Core builds no
  instruction text and the profile carries none; an edit to `AGENTS.md` reaches
  the next turn.
- The system prompt has two parts. Sections below `AGENT_PROMPT_PRIORITY`
  (`packages/core/src/domain/capability.ts`: persona, boundaries, the host's
  environment (platform, shell), date, project instructions, skills) are the
  part a session shares with its children, byte for byte, whatever tools each
  has and wherever it works: no shared section names the working directory,
  and the skills listing names a local skills directory relative to it, so a
  thread in a snapshot or rift copy of the project shares it too. The
  agent's own sections (tool list, tool guidelines, the cell guide, sessions and children
  guidance, an agent addendum, then the working directory and its git state,
  last at `WORKING_DIRECTORY_PRIORITY`) and what `systemPrompt` hooks append (the host
  tool list, session naming) follow. Neither part, nor the tools, changes with
  who opened the turn: a turn no user watches lists the interactive tools and
  refuses their calls (interactions.md), so a fork's first request repeats
  its starter's tools and system prompt and reads its whole prefix from the
  cache. The turn sends the parts as two system
  blocks (`systemPromptBlocks`), and the Anthropic driver marks the end of the
  shared one on the API-key path, so a fresh child with its parent's tool set
  reads it from its parent's cache entry (the tool definitions come first in
  the cached prefix, so a child with other tools reads none of it).
- Tool-result spill: the model sees at most 8,000 characters of any tool
  result (head plus tail); the stored message and its events keep the full
  result, and the bounded result carries a `read` locator for
  `context.read(toolCallId, { offset, limit })`. The bounded result keeps the
  result's shape with each long string cut, so the provider encodes the text
  once; only a result of many short strings is cut as JSON text.
  Context pressure drops before compaction ever runs.
- The cell subsumes host tools the Bun runtime already provides: `fetch` for
  network reads and `bun:sqlite` on the data directory's `data.db` for past sessions. No
  `webfetch` or `search_sessions` tool ships; `read_session` stays as the
  parent-to-child output seam.
- Classifier models (Jev, Clef) are one host verb, not a feature:
  `ExtensionContext.Models.decide({ definition, input, model?, timeoutMs? })`
  answers `effect/ai/Decision` questions about an input in one provider call
  and returns the answering model, the usage and the cost at the catalog's
  price. `Models.available` says whether a call that names no model has a
  credentialed classifier (no catalog read); `Models.classifiers` lists the
  credentialed classifiers, cheapest first and unpriced last. Every
  extension gets the same facet (`makeExtensionModels`, `runtime/provider.ts`,
  built by each host-context provider over `DecisionModelResolver` and read
  against the caller's profile registry). The cell's
  `models.decide(input, decisions, { model })` is one caller: it builds the
  questions (`models.classify`, `models.rate`, `models.probability`) from the
  cell's JSON, and the model composes it with other tools in its own code
  (gate, route, retry). A model router is another (virtual models, below).
  A driver serves classifiers through the
  optional `resolveDecisionModel` beside `resolveModel` and lists them with
  `Model.kind: "classifier"`, so they share its id, auth, env credential and
  catalog; the TUI picker leaves them out, and the turn refuses one by name
  (`ModelContextCapabilityFailure.ClassifierModel`) before any chat
  `resolveModel`, whichever agent, config or override named it. A driver
  declares `resolveDecisionModel` only when it lists a classifier, so the
  cell shows its `models.decide` guideline when such a driver has a stored or
  env credential, with no catalog read.
  `DecisionModelResolver`
  (`runtime/provider.ts`, in the loop's runtime services; no extension
  imports it) picks the named
  catalog classifier. With none named it takes a classifier whose driver has a
  stored or env credential: a `-latest` alias first (drivers are ordered by
  extension id, so the order cannot pick it), else the first listed. It fails
  readably naming the variables when none has a credential; a driver defect
  while the model is resolved or built fails that call, not the cell. One call
  has 60 s from resolve to answer (`DECIDE_DEADLINE_MS`; the cell may ask for
  less with `timeoutMs`), since the watchdog pauses during host calls. The
  reply carries the provider's token usage: the runtime keeps no spend record
  for a tool's own model call. Like `context.*`, a decide call leaves no
  receipt and a recovered cell does not repeat it. Three drivers serve
  classifiers through `@effect/ai-typesafe`: `typesafe` (`TYPESAFE_API_KEY` or a stored
  key; `jev-latest`, `jev-preview`, `jev-1.13.0`), OpenCode Zen (the OpenCode key
  and session headers at `https://opencode.ai/zen/v1`; `jev-1.13`,
  `jev-1.13-free`) and Cloudflare (`clef`, `clef-flash`: the Cloudflare
  token, the System One request sent to the account's Workers AI run path
  `/accounts/{account}/ai/run/@cf/cloudflare/{model}` with the gateway header
  when a gateway id is set; the answer may come bare or inside the Workers AI
  envelope `{result, success, errors}`, and an envelope with `success: false`
  fails with its first error's message). Clef and the Zen Jev models come
  from the models.dev decision list (`api.json?type=decision`); TypeSafe's
  three direct ids are not on models.dev, so its driver keeps them as local
  entries in the catalog's shape. Receipts:
  `packages/extensions/src/cell.ts` (models host),
  `packages/extensions/src/typesafe.ts`, `packages/extensions/src/cloudflare.ts`
  (Clef decisions section), `packages/core/src/domain/driver.ts`.
- Virtual models. A `modelRouter`
  contribution (`ModelRouterContribution`, `domain/driver.ts`) serves ids
  `<router id>/<name>` that name no model: each is a list of choices (a
  model, an effort, or both, with the `reason` a classifier reads) and a
  default. The catalog lists one as `Model.kind: "virtual"` under its label;
  one the router reports as a problem, or one whose choice names a router, is
  a catalog failure (extension health lists it under the router's
  extension), and a turn on it fails with `ErrorOccurred` naming why.
  The turn routes once, before its first request (`routeTurn`,
  `runtime/turn.ts`, model-routing section): it calls `route` with the
  model-visible messages, each choice's catalog entry (none for a model the
  catalog does not list or whose driver has no sign-in `/auth` lists as
  ready: `ModelResolver.signedIn`, the `listAuthProviders` row), and the model the
  branch last ran on with whether its prompt cache is warm and the history
  tokens a switch writes again (`estimateHistoryTokens`, the estimate
  `coldHandoffPays` reads). It records the pick as `ModelRouted` (selected,
  model, choice, effort, reason, fallback, classifier, cost, duration) and
  runs the turn on it. Every later step, a replay and a recovered turn read
  the recorded event; nothing routes again. A route that fails, dies, takes
  over 10 s or picks a choice the turn cannot run falls back to the current
  model when it is a choice, else the default; a turn never fails on its
  route. With no choice signed in, the router is not asked (no classifier
  call): the turn falls back the same way among the listed choices, the
  reason names each provider with no sign-in, and that provider's sign-in
  error stops the request, as on a model selected by hand. The turn routes only where the request ends on the user's input: at
  a later step (the selection changed mid-turn) or on a history that ends on
  an assistant message (Anthropic 4.6 and later refuse that prefill) it keeps
  the model the branch runs on. Routing writes nothing the model reads: it
  happens before the model-change check, so a routed switch writes the notice
  a hand switch writes and sends the same bytes, and the earlier model's
  reasoning goes back as text only (`toPromptMessages`). The router's
  classifier calls go through the run's own `ExtensionContext.Models`; their
  cost lands on the event and the session's cost, and the turn's ledger
  charges it once per turn, a recovered turn too (`noteRoute`). The auth gate asks for the
  driver of a virtual model's default choice (`routeCredentialDriver`).
  The shipped router (`packages/extensions/src/router.ts`, `@gent/router`)
  reads `routers` from `~/.gent/config.json` and from a trusted project's
  `.gent/config.json` (by name over the user's) when the extensions load; a
  bad entry (two `default` choices, no choices, a name with `/`) is a
  problem with its reason. It asks one classifier (the entry's `classifier`,
  else the cheapest credentialed one) which choice's reason fits the latest
  request (head and tail, 3,000 characters, with the end of the request
  before it; 4,000 at most) and holds a warm model unless the switch pays: a
  stronger choice needs confidence 0.6; a cheaper one must cost less on the
  turn with the history written to its cache (the cache-write rate of the
  lifetime it asks for) than staying costs with the history read. A pick on
  the current model is no switch, whatever its effort: the route's effort
  is the turn's requested level (`applyTurnRoute`: the session's own level,
  else the route's, else the agent's), the step's receipt records it after
  the clamp, and a change of it alone rides the in-conversation effort
  carrier like any other effort change. The session metrics keep the newest
  route (`SessionRuntimeMetrics.routed`); while the session runs on that
  virtual model the TUI status row names both (`Auto → Claude Sonnet 5
  (Anthropic)`; a row too narrow for it takes the short form `Auto → Sonnet
  5`, after the debug mark and the cwd gave way), shows the level in the
  same order after the routed model's clamp, and reads the context gauge
  against the routed model's window. The effort picker lists the routed
  model's levels, and its `default` row names the route's level.
- The effort router (`/effort auto`) is the same router concept, with no
  second classifier verb. A `modelRouter` may carry `effort`: a virtual
  model whose choices each set an effort and name no model. The catalog does
  not list it and a session cannot select it; the first registered router
  with one serves it (`servedEffortRouter`, `runtime/provider.ts`), and a
  problem with it is a catalog failure under the router's extension, as for
  a virtual model. On a session on auto, the turn asks it once per user
  turn, at step 1, after a model route (`routeEffort`, `runtime/turn.ts`,
  effort-routing section). The model facts come from the model the turn
  dispatches to (`modelDriver.contextModelId`: a driver override, `driverOverrides`, reads its
  own catalog entry), and the receipts name the model the session asked
  for. It offers only the choices that model runs at their own level
  (`effectiveEffort` returns the level unchanged), so the levels filter to
  what the model accepts. It never routes for a child (a child keeps its
  own effort), nor on a history that ends on an assistant message, nor on a
  model with no reasoning. On a warm cache a choice is offered only at the
  held level or where the driver carries the change from this history
  (`ModelDriverContribution.carriesEffort`: the Anthropic driver where
  `takesEffortMarkers` and the thinking plan stays the same, the OpenAI
  driver where `takesConfigurationUpdates`; both rebuild the previous
  request's plan and admit the change only where the new request keeps its
  top-level effort and its earlier changes, `keepsEffortPrefix` in
  `packages/extensions/src/providers.ts`, so on OpenAI no change follows a
  run at the provider default); with no such choice the level
  holds and no classifier is asked, and the receipt says why. A cold cache
  or a first turn offers every level (decided by the cache-rate north star:
  a driver fact asked per transition, with a receipt, over a static model
  flag). A hold is a decision, not a fallback; `fallback: true` marks only a
  router that failed or picked a choice the turn cannot run, and then the
  turn keeps the exact level the branch ran at, `max` and the model's
  default included, though no choice names it. Under a virtual model whose
  router also serves the effort router, the model route's call carries the
  effort choices (`ModelRouteInput.effort`, each choice with a model of the
  route's choices that takes it), and the router answers both in one
  classifier call (`ModelRouteDecision.effort`): two receipts, one charge on
  the model route (decided by the cost north star). A router that answers no
  `effort` leaves core to ask the effort router alone; when a combined call
  fails, the effort route falls back too, with the same reason, and nothing
  is asked again. The pick is recorded as `ModelRouted` with `effortOnly: true` (an
  additive, optional field). Once that receipt is stored, a replay and a
  recovered turn run at it, charge it and ask nothing, whether or not an
  effort router still serves. A process that dies after the classifier
  answered and before the receipt was stored asks again on recovery, and the
  first call's cost is not recorded. Its classifier cost lands on the event,
  the session's cost and the turn's ledger, as a model route's does; the
  ledger keys a route by turn, kind and router, so a model route and an
  effort route of one name are each charged. The effort route's
  level wins over a model route choice's level: auto is the session's own
  setting (the `applyTurnRoute` order). With no effort router served, auto
  runs at the agent's level and records nothing. The shipped router serves
  the `routers.effort` config entry, else built-in choices (low, medium,
  high, xhigh, each with a reason; default high, the main agent's level); a
  bad `effort` entry serves none and is reported. The session metrics keep
  the newest effort route apart from the model route
  (`SessionRuntimeMetrics.effortRouted`), and the TUI status row reads
  `auto → high` (short form `auto→high`, the last label to give way). After
  a route that fell back, the `/effort` picker's `auto` row reads
  `routes fall back: <reason>` (no classifier signed in, a failed call).
