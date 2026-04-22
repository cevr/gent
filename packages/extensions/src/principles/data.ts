const acknowledgeBeforeProcessing = `# Acknowledge Before Processing

Whenever a caller hands off work, confirm receipt inside the minimum perceptible window — then do the work. Never let the caller face silence while processing; silence is indistinguishable from being broken.

**Why:** Humans judge "working" vs "hung" in roughly 100ms. Machines time out and retry. Systems that start a long operation without first acknowledging it force every caller to implement their own "is this alive?" heuristic — retries, cancellations, duplicate submissions, anxious refreshes. A fast, explicit "I have your request" collapses that ambiguity and buys unlimited headroom for the actual work.

**The Pattern:**

- **Print something within 100ms:** a heading, a spinner, the parsed intent — anything that proves the request was received
- **Separate acknowledgment from completion:** \`202 Accepted\` with a status URL beats a 30-second synchronous request. Return a handle; deliver the result out-of-band
- **Show progress, not just eventual output:** for anything over a few seconds, stream partial results or a progress signal. Unknown duration → spinner with a status line
- **On cancellation, acknowledge fast too:** Ctrl-C, cancel buttons, and aborts must respond immediately — even if cleanup takes longer, the caller needs to know the cancel landed
- **Design the handoff, not just the work:** the first thing a caller experiences is receipt, not result. Make that experience deliberate

**The Test:**

- "If the work took 10x longer than expected, would the caller know the system is still alive?" If no, there's no acknowledgment — just silence
- "Can the caller tell the difference between 'processing' and 'hung'?" If not, add an explicit signal
- "Does cancellation feel instant even when cleanup isn't?" If no, the ack is coupled to the work — decouple them

**See also:** [[never-block-on-the-human]] — the reverse direction: don't block *on* your caller either. [[experience-first]] — acknowledgment is the first touchpoint of the experience; design it deliberately.`

const boundaryDiscipline = `# Boundary Discipline

Place validation, type narrowing, and error handling at system boundaries. Trust internal code unconditionally. Business logic lives in pure functions; the shell is thin and mechanical.

**Why:** Validation scattered throughout is noisy, redundant, and gives a false sense of safety. Concentrating it at boundaries means each piece of data is validated exactly once. Logic tangled with framework wiring can't be tested without the framework.

**The Pattern:**

- **At boundaries** (CLI args, config files, external APIs, network protocols): validate, return errors, handle defensively
- **Inside the system**: typed data, error propagation, no re-validation. Trust the types.

**Applications:**

Validation and Error Handling:

- Validate config at parse time (the boundary), not inside business logic
- Store raw data at boundaries — parse lazily at use-site
- No redundant nil checks deep in call chains if the boundary already validated

Code Organization:

- Business logic in pure functions with no framework dependencies
- Parse functions: pure transforms from raw bytes to typed state
- Prompt construction: structured state in, string out
- Scoring/assessment: pure transforms from state to results

**The Tests:**

- "Is this data crossing a system boundary right now?" If not, validation is redundant
- "Can this be a pure function that the shell just calls?" If yes, extract it

**See also:** [[small-interface-deep-implementation]] — once the boundary is drawn, keep the surface at it narrow and absorb complexity inside. [[test-through-public-interfaces]] — mock only at boundaries; inside the system, trust the types and exercise real code.`

const chaseYNotX = `# Chase Y, Not X

When solving a problem, interrogate the request before executing it. The stated problem (X) is often a proxy for the real need (Y). Solving X literally can leave Y untouched — or worse, calcify a wrong framing into the system.

**Why:** Requests come pre-shaped by the asker's current mental model. That model may be incomplete, out of date, or scoped too narrowly. Jumping straight to X produces technically correct solutions that miss the point. Finding Y first makes the solution smaller, more durable, and often obviates X entirely.

**The Pattern:**

- **Ask "what are you trying to accomplish?"** before "how do I build X?" — the answer reframes the problem
- **Watch for proxy requests:** "add a flag for Z" often means "the default behavior is wrong." Fix the default, skip the flag
- **Distrust overly specific asks:** a narrow, implementation-shaped request signals the asker has already picked a solution — check whether it's the right one
- **Solve the class, not the instance:** if Y is "I keep hitting this category of bug," the fix is structural, not a patch on X
- **Name Y explicitly:** state the underlying goal back to the asker before building. Misalignment surfaces immediately

**The Test:**

- "If I deliver X exactly as asked, will the asker's real problem be solved?" If unsure, Y isn't clear yet
- "Would a different X solve Y better?" If yes, propose it before building
- "Is X a workaround for a missing Y?" If yes, build Y and let X fall away

**See also:** [[fix-root-causes]] — same "surface isn't substance" spine, but applied to debugging (a bug exists) rather than requirements (a request arrived).`

const compositionOverFlags = `# Composition Over Flags

Build primitives that compose, not monoliths with configuration flags. When a component, function, or API grows boolean props to switch behavior, the right move is usually to split it into distinct primitives that share underlying pieces.

**Why:** Each flag doubles the state space. Five booleans = 32 branches to reason about, most invalid. Worse, flags couple unrelated concerns into one implementation — every consumer pays the cost of every variant. Primitives that compose stay small, testable, and truthful about what they do. The caller assembles exactly what they need; nothing more is loaded, rendered, or reasoned about.

**The Pattern:**

- **Split by variant, not by flag:** \`<ThreadComposer>\` and \`<EditComposer>\` beat \`<Composer isThread isEditing>\`. Each variant wraps its own provider and composes only what it needs
- **Children over configuration:** prefer \`children\` / slot composition over \`renderHeader\` / \`renderFooter\` props. Reserve render props for when the parent must pass data back
- **Compound components:** expose \`Thing.Frame\`, \`Thing.Input\`, \`Thing.Submit\` with shared context. The consumer renders pieces to opt in
- **Primitives first, convenience later:** ship the composable pieces. If a common combination emerges, offer a thin wrapper — don't start with the wrapper
- **Decouple behavior from shell:** the container defines the contract (\`state\`, \`actions\`, \`meta\`); swappable providers implement it. Same consumers, different backing stores

**The Test:**

- "How many branches does this component have internally?" If every method starts with \`if (isX)\`, the flag should be a separate primitive
- "Can I delete this flag by splitting the component?" If yes, split it
- "Does the caller have to understand implementation details to pick the right flag combo?" Then the flags are leaking the wrong abstraction — expose the primitives directly

**See also:** [[progressive-disclosure]] — primitives + sensible defaults let simple cases stay simple while advanced cases compose. [[subtract-before-you-add]] — flags accrete; splitting into primitives is the subtraction move.`

const correctnessOverPragmatism = `# Correctness Over Pragmatism

When the road forks between "structurally correct" and "pragmatic shortcut," default to correct. Pragmatism is not the default posture — correctness is. The user invests hours for correctness; shortcuts compound into debt the user never asked for.

**Why:** Shortcuts taken in the name of pragmatism — silencing a type error, stubbing a function, working around broken state instead of fixing it, abandoning an in-flight approach because it got harder — are dead ends dressed up as progress. They leave the codebase in a worse state than before the task started. The user would rather wait for the right fix than ship a wrong one.

**Pattern:**

- **No self-interrupts.** Don't stop mid-task to propose "let's just do the simple version." Finish the correct path, or flag the blocker — don't silently downgrade.
- **No silent shortcuts.** Casting to \`any\`, commenting out failing code, stubbing with \`throw new Error("not implemented")\`, adding a guard to mask a crash — these are symptom fixes. See [[fix-root-causes]].
- **Flag, don't capitulate.** If the correct fix requires significant architectural change, STOP. Surface it: "the root cause is X, fixing it properly requires Y. Want me to plan that, or is there a constraint I'm missing?" Then wait for direction.
- **Dead-end detection.** If you find yourself adding workaround on top of workaround, you are in a dead end. Back out. Redesign. See [[redesign-from-first-principles]].
- **Complexity is not a reason to bail.** Bad architecture is. Know the difference. When the work is genuinely hard but the direction is right, keep going. When the direction is wrong, stop and say so.

**Boundaries:**

- "Correct" means structurally sound, not gold-plated. Don't confuse correctness with over-engineering — a simple solution that fixes the root cause is correct. A complex solution that papers over the root cause is not.
- Time pressure from the user ("just get it working for the demo") is an explicit override, not a default. Without that signal, assume correctness.

**See also:** [[fix-root-causes]] — the debugging analogue. [[redesign-from-first-principles]] — the integration analogue. [[never-block-on-the-human]] still applies to reversible execution choices; this principle governs the architectural choices underneath them.`

const costAwareDelegation = `# Cost-Aware Delegation

Every delegation boundary has a budget. Account for delegation overhead itself, and hard-cap scope to prevent work from expanding to fill available resources.

**Why:** Agent turns, CI minutes, and API dollars are finite. Without explicit budgets, work expands to fill the available resources.

**Pattern:**

- **Budget before delegating:** Estimate turns per phase: setup, read context, implement, verify + fix, commit. If total exceeds budget, scope is too large
- **Front-load context to avoid rediscovery costs:** Every piece of analysis withheld is a turn wasted. Cost of a longer prompt is one read; cost of rediscovery is multiple turns
- **Hard-cap scope:** Limit files per phase. One function/type + tests per unit of work. Without caps, work expands
- **Account for coordination overhead:** Team coordination costs turns. Direct task delegation returns results without coordination tax
- **Exit smart, not late:** Commit passing work before your budget runs out, not at the last moment`

const deriveDontSync = `# Derive, Don't Sync

Compute values from existing state rather than introducing new state that must be kept synchronized. Every piece of independent state is a potential inconsistency.

**Why:** Synchronization is a liability. Two pieces of state representing the same truth will eventually diverge — through missed updates, race conditions, or code paths that update one but not the other. Derivation from a single source of truth eliminates this entire class of bugs.

**The Pattern:**

- **Prefer computed values:** If a value can be derived from existing state, compute it on access rather than storing it separately
- **Single source of truth:** One canonical representation. Everything else is a projection
- **Projections, not copies:** Actor snapshots, UI models, and API responses should project from state, not maintain independent copies
- **Cache, don't sync:** If derivation is expensive, cache the result and invalidate on source change. Caching is a performance optimization; syncing is an architectural decision with ongoing maintenance cost

**The Test:**

- "If the source changes, does this value automatically reflect the change?" If not, you have synchronization — convert to derivation
- "Can I delete this state and recompute it from what already exists?" If yes, it shouldn't be stored independently

**See also:** [[make-impossible-states-unrepresentable]] — derivation and tight state modeling both collapse the space of things that can go wrong.`

const encodeLessonsInStructure = `# Encode Lessons in Structure

Encode recurring fixes in mechanisms (tools, code, metadata, automation) rather than textual instructions. Every error, human correction, and unexpected outcome is a learning signal — capture it, route it, and close the loop.

**Why:** Textual instructions are routinely ignored. They require the reader to notice, remember, and comply. Structural mechanisms — lint rules, metadata flags, runtime checks, automation scripts — enforce the rule without cooperation.

**Pattern:**
When you catch yourself writing the same instruction a second time:

1. Ask: can this be a lint rule, a metadata flag, a runtime check, or a script?
2. If yes, encode it. Delete the instruction
3. If no (genuinely requires judgment), make the instruction more prominent and add an example of the failure mode

**Corollary:** Don't paper over symptoms. If the fix is structural, ONLY use the structural fix. The instruction IS the symptom.

**Feedback Loop:**

- **Capture every correction:** When the human intervenes or tests fail, decide if it's a one-off or a pattern
- **Route to the right layer:** One-off -> brain note. Recurring fix -> skill or lint rule. Systemic issue -> principle
- **Close the loop:** Don't only record — apply now or create a concrete todo

**Anti-Patterns:**

- Acknowledging without recording ("I'll keep that in mind" does not persist)
- Recording without routing (brain note about a lint rule that should exist is wasted unless the lint rule gets implemented)
- Fixing without generalizing (fixing one instance while leaving the recurring pattern intact)`

const exhaustTheDesignSpace = `# Exhaust the Design Space

When facing a novel interaction or architectural decision with no established precedent, explore multiple concrete alternatives before committing to implementation. The cost of building the wrong thing dwarfs the cost of exploring three options.

**The Rule:** For decisions where the right answer isn't obvious, build 2-3 competing prototypes or sketches. Compare them side-by-side. Only then commit.

**When It Applies:**

- Novel UI interactions (no prior art in the codebase)
- Architectural choices with multiple viable approaches
- Product design decisions where user experience depends on feel, not logic

**When It Doesn't:**

- Mechanical implementation where the pattern is established
- Bug fixes or refactors with a clear target state
- Changes where constraints dictate a single viable approach`

const experienceFirst = `# Experience First

The user experience is the product. Every technical decision either serves or hinders it. When a tradeoff exists between implementation convenience and user delight, choose delight.

- Say no to 1,000 things (every feature, control, and option must earn its place)
- Ship less, ship better (polished experience with three features beats rough one with ten)
- Prototype before committing (design decisions are cheaper in throwaway HTML than production code)
- Sweat the details (transitions, alignment, spacing, feedback, error states)
- Tighten the core loop (every feature should serve the central workflow or get out of the way)

Foundations should serve the experience, not the other way around. Foundational thinking governs the _sequence_ of work; this principle governs the _target_.`

const fixRootCauses = `# Fix Root Causes

When debugging, never paper over symptoms. Trace every problem to its root cause and fix it there.

**Why:** Symptom fixes accumulate: each workaround makes the system harder to reason about, and the real bug remains. Root-cause fixes are slower upfront but reduce total debugging time.

**Pattern:**

- Reproduce first (if you can't reproduce it, you can't verify your fix)
- Ask "why" until you hit bedrock
- Resist the urge to add guards (adding a nil check to silence a crash is a symptom fix)
- Check for the pattern, not just the instance (grep for the same pattern, fix all instances)
- When stuck, instrument — don't guess (add logging, read the actual error)

**Restart Bugs: Suspect State Before Code**
Code doesn't change between runs. State does. When "fails after restart," suspect stale persistent state first — config files, caches, lock files, serialized state. If clearing a state file restores behavior, prioritize state validation as the fix.

**See also:** [[chase-y-not-x]] — the requirements-side analogue: interrogate the framing of an incoming request before building, not just the framing of a bug before fixing.`

const foundationalThinking = `# Foundational Thinking

**Structural decisions** optimize for option value. **Code-level decisions** optimize for simplicity. Over-engineering means making premature decisions that close doors. Choosing the right foundational data structure opens doors and preserves option value.

**Data Structures First:** Get data structures right before writing logic. The right structure makes downstream code obvious. Define core types early, trace every access pattern, choose structures matching dominant access patterns. A data structure change late is a rewrite; early is a one-line diff.

At code level: DRY at structural level (types, data models), but three similar lines beats premature abstraction. Explicit over clever. Well-tested (behavior and edge cases, not line coverage).

**Concurrency corollary:** Before sharing state between actors, ask "What happens if another actor modifies this concurrently?" If not "nothing", isolate.

**Scaffold First:** If something benefits all future work, do it first. Ask "does every subsequent phase benefit from this existing?" CI, linting, testing infra, shared types are scaffold. Sequence for maximum option value: infra/setup before features, tests before fixes. Keep commits small and single-purpose.

Subtraction comes before scaffolding — remove dead weight first, then lay foundations.`

const guardTheContextWindow = `# Guard the Context Window

The context window is finite and non-renewable within a session. Every token that enters should earn its place.

**Why:** Context overflow degrades reasoning quality, causes compression artifacts, and halts progress. Unlike compute or time, context consumed within a session cannot be reclaimed.

**Pattern:**

- **Isolate large payloads:** Route verbose outputs, screenshots, and large documents to subagents. The main context gets summaries, not raw data
- **Don't read what you won't use:** Read selectively based on relevance. If a file isn't needed for the current task, skip it
- **Keep frequently-used content inline:** Templates and references used on every invocation belong in the skill file, not in separate files that cost a read each time
- **Size phases and cap scope:** Limit files per phase, set turn budgets, account for mechanism costs
- **Emit paths, not content:** When outputting reference material to agents, prefer file paths over inlined content. Agents can choose what to read; inlined content is always consumed. (Vercel finding: condensed indexes with paths outperform full content dumps.)`

const makeImpossibleStatesUnrepresentable = `# Make Impossible States Unrepresentable

Model state so invalid combinations can't be constructed, not just avoided. The type system is the cheapest test you will ever write — use it to encode what "valid" means.

**Why:** Boolean pairs and optional fields create silent junk states. \`isLoading=true, isError=true, data=null\` compiles fine and means nothing. Every consumer then has to defend against the junk — or forget to, and ship a bug. Discriminated unions collapse the valid space to exactly the states that exist, and TypeScript narrows each branch to just the fields it needs.

**The Pattern:**

- **Discriminated unions over boolean clusters:** replace \`isLoading / isError / isSuccess\` with \`{ status: 'idle' | 'loading' | 'success' | 'error' }\`. Each branch carries only its relevant fields
- **Fields belong to the state they describe:** \`data\` lives on \`success\`, \`error\` lives on \`error\`. No \`data?: T\` or \`error?: Error\` on the parent
- **Guard transitions at the reducer:** not every action is valid in every state. Invalid transitions no-op or error — they don't silently corrupt
- **Exhaustive switches:** use \`satisfies\` / \`never\` defaults so adding a new state breaks the compile rather than slipping through
- **Name by lifecycle, not by flag:** \`'closed' | 'opening' | 'open' | 'closing'\` beats \`isOpen + isAnimating + isClosing\`

**The Test:**

- "Can I write down a state that compiles but shouldn't exist?" If yes, the model is too loose — collapse to a union
- "Does every consumer need a \`?? null\` or \`if (data)\` guard?" The state shape is lying about what's actually present
- "Would a junior reading this know which fields are meaningful when?" If not, the discriminant isn't doing its job

**See also:** [[name-events-not-setters]] — the transitions between these states should be named as facts, not as field assignments. [[derive-dont-sync]] — once the state space is tight, derived values project from it rather than living alongside.`

const makeOperationsIdempotent = `# Make Operations Idempotent

Design operations so they converge to the correct state regardless of how many times they run or where they start from. Every state-mutating operation should answer: "What happens if this runs twice? What happens if the previous run crashed halfway?"

**Why:** Commands, lifecycle operations, and processing loops run in environments where crashes, restarts, and retries are normal. If an operation leaves partial state that causes a different outcome on re-execution, every restart becomes a debugging session.

**The Pattern:**

- Convergent startup: scan for existing state, clean stale artifacts, adopt live sessions
- Content-based cleanup: compare by content equivalence, not creation order
- Self-healing locks: use PID-based stale lock detection
- Idempotent scheduling: failed work respawns cleanly, fresh input regenerated after each cycle

**The Test:**

1. What happens if this runs twice in a row?
2. What happens if the previous run crashed at every possible point?
3. Does re-execution converge to the same end state?

If any answer is "it depends on what state was left behind," the operation needs a reconciliation step.`

const migrateCallersThenDeleteLegacyApis = `# Migrate Callers Then Delete Legacy APIs

When we decide a new API is the right design, migrate callers and remove the old API in the same refactor wave instead of preserving compatibility layers.

**Rule:**

- Do not keep legacy API paths alive just because internal callers still exist
- Inventory callers, migrate them, and delete the old API immediately
- Treat temporary adapters as exceptional and time-boxed, not default architecture
- Update tests to assert the new contract, and delete tests that only protect pre-refactor implementation details

**When This Applies:**

- No external users depend on backward compatibility
- The project can absorb coordinated breaking changes
- The new API is part of a simplification/refactor initiative

Keeping both old and new APIs creates dual-path complexity, slows cleanup, and makes the codebase feel append-only.`

const nameEventsNotSetters = `# Name Events, Not Setters

Name actions, messages, and state transitions after what happened in the domain — not after the mechanism that applies the change. \`'submitted'\`, \`'item_added'\`, \`'payment_failed'\` — never \`'set_loading'\`, \`'set_items'\`, \`'update_state'\`.

**Why:** Setter names couple the caller to the current implementation. If the handler later needs to update three fields, emit an analytics event, or trigger a workflow, every caller saying \`setLoading(true)\` has to change. Event names describe the fact that occurred; the handler decides what to do about it. This makes reducers, state machines, and pub/sub systems resilient to change and readable as a domain log.

**The Pattern:**

- **Reducer actions:** \`{ type: 'submitted' }\` not \`{ type: 'set_status', status: 'submitting' }\`. The reducer translates the event into whatever state change that implies
- **Callbacks / props:** \`onSubmitted\`, \`onItemAdded\` over \`onSetState\`, \`onChange\` (when something more specific is meant)
- **Messages / RPC:** name by domain fact (\`OrderPlaced\`, \`UserInvited\`), not by operation (\`InsertOrderRow\`)
- **Events carry facts, handlers carry policy:** the event says "the user clicked submit"; the handler decides whether to validate, retry, dispatch, or ignore
- **Past tense for things that happened; imperative for commands:** \`OrderPlaced\` (event) vs \`PlaceOrder\` (command). Mixing them blurs what's authoritative

**The Test:**

- "If I changed how this is handled, would every caller need to update?" If yes, the name leaked the mechanism
- "Does the name describe a fact about the domain, or a field on the state?" Field-shaped names are setters in disguise
- "Could a non-engineer reading the event log understand what happened?" If not, the vocabulary is too technical — it's probably a setter

**See also:** [[make-impossible-states-unrepresentable]] — events are the transitions over a tight state space; the two principles pair tightly.`

const neverBlockOnTheHuman = `# Never Block on the Human

The human supervises asynchronously. Agents must stay unblocked — make reasonable decisions, proceed, and let the human course-correct after the fact. Code is cheap; waiting is expensive.

**Why:** Every time an agent pauses to ask for permission, the entire pipeline stalls. The human becomes the bottleneck. Since code changes are reversible and reviewable, the cost of a wrong decision is almost always lower than the cost of blocking.

**Pattern:**

- **Proceed, then present:** Do the work, show the result. Don't ask "should I do X?" — do X, explain why
- **Reserve questions for genuine ambiguity:** Ask only when you truly cannot infer intent from context
- **Make the system self-healing:** When you notice a problem, log it and fix it in the next round
- **Supervision is async:** The human reviews plans, diffs, and changes on their own schedule. Design workflows for review-after-the-fact
- **Code is cheap, attention is scarce:** A wrong implementation costs minutes to fix. A blocked agent costs the human's attention to unblock

**Boundaries:**

- **Irreversible actions** (force-push, delete production data, send external messages) still require confirmation
- **Reversible actions** (write code, edit notes, split tasks) should proceed without blocking
- **Product direction** comes from the human; _execution_ should not block

**See also:** [[acknowledge-before-processing]] — the inverse direction: don't force *your caller* to wait in silence either. Both principles say "collapse ambiguity fast; don't let anyone hang."`

const outcomeOrientedExecution = `# Outcome-Oriented Execution

Optimize for the intended, verifiable end state rather than preserving smooth intermediate states.

**Why:** Forcing every intermediate step to stay fully stable often creates temporary compatibility code that becomes long-lived debt. The cleaner strategy is to converge directly on the target architecture and prove correctness at explicit verification boundaries.

**Core Rule:**

- Prioritize end-state integrity over transitional stability
- Intermediate breakage is acceptable when it is planned, scoped, and reversible
- Final verification is non-negotiable

**Guardrails:**

- Use this for planned rewrites/migrations with explicit phase boundaries
- Declare where temporary breakage is acceptable
- Keep high-signal checks for actively touched areas while migrating
- Require full static and runtime verification at plan completion`

const progressiveDisclosure = `# Progressive Disclosure

Reveal complexity only when needed. Start with the simplest correct interface; expose details progressively as the user or consumer demonstrates need.

**Why:** Systems that front-load every option, configuration, and edge case overwhelm users and developers alike. Information hidden behind a deliberate action costs one click; information displayed unconditionally costs attention on every encounter.

**The Pattern:**

- **APIs:** Provide sensible defaults. Require only what's essential. Accept optional overrides for advanced use cases
- **Prompts:** List names and summaries upfront. Provide full content via a tool call, not inline
- **UIs:** Show the primary action. Tuck secondary actions behind menus, drawers, or detail views
- **Documentation:** Index at the top, full content linked. Don't inline everything into one file
- **Error messages:** Show what went wrong. Offer a "details" path for the full stack trace

**The Test:**

- "Does the consumer need this information right now?" If not, hide it behind a deliberate action
- "Would removing this from the default view break the primary workflow?" If not, it belongs in progressive disclosure

**See also:** [[small-interface-deep-implementation]] — the smallest front door with the most capability behind it is progressive disclosure at the API level. [[composition-over-flags]] — primitives with defaults beat monoliths with toggles.`

const proveItWorks = `# Prove It Works

Every task output must be verified by checking the real thing directly — not by inferring from proxies, self-reports, or "it compiles."

**Why:** Unverified work has unknown correctness. Indirect verification (file mtimes, output freshness, agent self-reports, cached screenshots) feels cheaper than direct observation, but acting on a wrong inference costs far more than checking the source.

**Pattern:** After completing any task, ask: "How do I prove this actually works?"

Check the real thing, not a proxy:

- Check process liveness directly, not indirectly through derived state
- Read the actual value, not a cached or derived representation
- When verification fails, suspect the observation method before suspecting the system

Code / Features:

1. Build it (necessary but not sufficient)
2. Run it and exercise the actual feature path
3. Check the full chain: does data flow from input to output?
4. For integrations, test the full communication path end-to-end

Delegation: trust artifacts, not self-reports:
When verifying delegated work, inspect the actual output artifact (git diff, file contents, runtime behavior) — never the delegate's summary. Agents report what they intended, not always what happened.

Cross-session artifacts: verify before ending:
Files written during a session can fail to persist (interrupted writes, path errors, tool failures). If an artifact is needed in a future session, verify it exists (\`ls\` or \`Read\`) before closing. Unverified writes are lost work.

API Research: trust source over docs/agents:
When migrating between library versions, grep the actual source (via \`repo-explorer\`) rather than relying on docs or research agent summaries. Docs lag releases; agent output can be wrong on 2/5 API changes. Read the types directly.

**See also:** [[test-through-public-interfaces]] — *how* to verify: through the caller's surface, not internal inspection. This principle says verify; that one says verify from the outside in.`

const redesignFromFirstPrinciples = `# Redesign From First Principles

When integrating a change, don't bolt it onto the existing design. Redesign as if the change had been a foundational assumption from the start. The result should be the most elegant solution that would have emerged if we'd known about this requirement on day one.

- Read all affected files and understand the current design holistically
- Ask: "if we were writing this from scratch with this new requirement, what would we build?"
- Propagate the change through every reference — types, docs, examples, rationale sections
- The redesign should be thought of holistically but delivered incrementally

This is the method for preserving option value when integrating changes into an existing design.`

const serializeSharedStateMutations = `# Serialize Shared-State Mutations

When concurrent actors share mutable state, enforce serialization structurally — lockfiles, sequential phases, exclusive ownership. Instructions and conventions are insufficient for concurrency safety.

**Why:** Concurrent writes to shared state produce race conditions that are intermittent, hard to reproduce, and expensive to debug. Telling agents or goroutines to "take turns" does not work.

**Pattern:**

1. **Identify shared mutable state** (files both read and write, branches both push to, APIs both define and consume)
2. **If shared state exists, serialize access** (lockfiles, sequential phases, or exclusive ownership)
3. **If serialization is impractical, eliminate the sharing** (give each actor its own copy: worktrees, separate files, isolated state directories)`

const smallInterfaceDeepImplementation = `# Small Interface, Deep Implementation

A module's public surface should be the smallest that fully delivers its capability. Complexity belongs inside, absorbed by the implementation, not spread across the contract for every caller to reassemble.

**Why:** Every method, parameter, and exported type is a promise to every caller, forever. Shallow modules — large surface, thin body — push their complexity outward: callers wire pieces together, duplicate glue logic, and depend on details that should have been hidden. Deep modules — small surface, substantial body — absorb complexity once so N callers don't have to solve it N times. The best abstractions give you a lot of power through a narrow door.

**The Pattern:**

- **Minimize what's public, maximize what's hidden:** if something can be an implementation detail, make it one
- **Fewer methods, simpler parameters:** each additional method or flag is a tax on every future reader, tester, and caller
- **Absorb, don't delegate:** if every caller has to do the same follow-up step, that step belongs inside the module
- **Default to private:** export on demand, with a concrete use case. Reverse the polarity of the usual "I might need this later"
- **Interface size is not proportional to capability:** a 3-method module can be far more powerful than a 30-method one. Count what's hidden, not what's listed

**The Test:**

- "Does the caller have to understand the internals to use this correctly?" If yes, the interface is too shallow
- "Can I delete this method, parameter, or type and have callers do the same thing another way?" If yes, delete it
- "Is this module mostly forwarding to something else?" If yes, either delete the layer or move real logic into it

**See also:** [[boundary-discipline]] — boundaries decide *where* to draw the line; this principle decides *how much* to expose at each one. [[progressive-disclosure]] — same instinct applied to APIs: minimum required up front, everything else on demand.`

const subtractBeforeYouAdd = `# Subtract Before You Add

When evolving a system, remove complexity first, then build. Deletion creates a simpler substrate that makes subsequent additions cleaner, smaller, and less error-prone.

**Why:** Adding to a complex system compounds complexity. Removing first reduces the surface area, reveals the essential structure, and makes the addition's design more obvious. The default action should be subtraction.

**The Pattern:**

- Sequence removal before construction
- Cut before you polish (ruthlessly cut to minimum before investing in quality)
- Design for observed usage, not speculative edge cases
- Simplify prompts (remove redundant instructions, excessive templates)
- When a reference has no novel content, delete it rather than leaving a stub

This is about _when_ to act — an ordering principle that says subtraction comes before addition.`

const testThroughPublicInterfaces = `# Test Through Public Interfaces

Tests must verify behavior through the same public surface a real caller would use. Never reach past the interface to assert on internal state, mock internal collaborators, or inspect side effects directly.

**Why:** Tests coupled to internals break on every refactor — even when behavior is unchanged — and pass when behavior breaks but the internal shape happens to match. Tests coupled to the public interface survive refactors, catch real regressions, and double as executable documentation of the contract. If a test can only be written by reaching inside, the interface is probably wrong, not the test.

**The Pattern:**

- **Act through the API, assert through the API:** if \`createUser\` is the entry point, verify by calling \`getUser\` — not by querying the underlying store
- **Mock only at system boundaries:** external services, the clock, the network, the filesystem. Don't mock your own modules
- **No white-box assertions:** peeking at private fields, spying on internal method calls, or checking "was this function called?" couples the test to the implementation
- **If it's hard to test through the interface, the interface is wrong:** treat test pain as interface feedback, not test-framework trivia
- **One real path per behavior:** integration-shaped tests that exercise the full code path beat a hundred unit tests mocking every collaborator

**The Test:**

- "If I rewrite the internals completely but keep the interface, will this test still pass?" If no, it's coupled to internals
- "Does this test know anything a caller wouldn't?" If yes, remove that knowledge
- "Would this test catch a real bug a user would see?" If no, it's testing the mock, not the code

**See also:** [[prove-it-works]] — the *what* of verification (don't claim done without evidence); this principle is the *how* (verify through the caller's eyes). [[boundary-discipline]] — mocks belong at system boundaries, not inside them.`

const useThePlatform = `# Use the Platform

Before reaching for a library, a framework feature, or a hand-rolled abstraction, check what the platform already gives you. The runtime, the OS, the protocol, and the standard library have solved most common problems — durably, performantly, and for free.

**Why:** Custom solutions carry ongoing cost: tests, edge cases, bundle or binary size, drift from standards, and onboarding friction for anyone who expects the native behavior. Platform features are battle-tested, interoperable by default, inspectable with standard tools, and outlive framework churn. Reinventing them is a tax paid on every feature afterward, and the reinvention is almost always a worse version.

**The Pattern:**

- **Use built-in data structures and algorithms before custom ones:** hash maps, sets, sorted collections, streams, iterators — the standard library beats a bespoke container
- **Use the protocol, not a wrapper:** HTTP status codes, cache headers, content negotiation, signals, exit codes — these already encode meaning everyone understands
- **Use the system's own state stores:** URL / query string, filesystem, environment variables, database — before adding an in-process state layer that shadows them
- **Prefer standard formats:** JSON, CSV, semver, ISO-8601, UUIDs — pick the format the ecosystem already speaks so tools compose for free
- **Default to native primitives:** OS-level locking, process supervision, scheduled jobs, pipes — before a framework abstraction that reimplements them
- **Let the platform handle concerns it owns:** cancellation, timeouts, backpressure, auth, i18n — reach for the standard mechanism before inventing parallel plumbing

**The Test:**

- "Is there a built-in that does 80% of this?" If yes, start there and layer on only what's missing
- "Am I reimplementing behavior the platform already provides?" Pause — check first
- "Would a newcomer expect the native mechanism here?" If yes, using anything else is surprise tax

**See also:** [[subtract-before-you-add]] — the platform already exists; reaching for it is the subtraction move. [[boundary-discipline]] — the platform sits at a boundary; trust what it gives you rather than re-validating inside.`

const PRINCIPLES: ReadonlyArray<readonly [string, string]> = [
  ["acknowledge-before-processing", acknowledgeBeforeProcessing],
  ["boundary-discipline", boundaryDiscipline],
  ["chase-y-not-x", chaseYNotX],
  ["composition-over-flags", compositionOverFlags],
  ["correctness-over-pragmatism", correctnessOverPragmatism],
  ["cost-aware-delegation", costAwareDelegation],
  ["derive-dont-sync", deriveDontSync],
  ["encode-lessons-in-structure", encodeLessonsInStructure],
  ["exhaust-the-design-space", exhaustTheDesignSpace],
  ["experience-first", experienceFirst],
  ["fix-root-causes", fixRootCauses],
  ["foundational-thinking", foundationalThinking],
  ["guard-the-context-window", guardTheContextWindow],
  ["make-impossible-states-unrepresentable", makeImpossibleStatesUnrepresentable],
  ["make-operations-idempotent", makeOperationsIdempotent],
  ["migrate-callers-then-delete-legacy-apis", migrateCallersThenDeleteLegacyApis],
  ["name-events-not-setters", nameEventsNotSetters],
  ["never-block-on-the-human", neverBlockOnTheHuman],
  ["outcome-oriented-execution", outcomeOrientedExecution],
  ["progressive-disclosure", progressiveDisclosure],
  ["prove-it-works", proveItWorks],
  ["redesign-from-first-principles", redesignFromFirstPrinciples],
  ["serialize-shared-state-mutations", serializeSharedStateMutations],
  ["small-interface-deep-implementation", smallInterfaceDeepImplementation],
  ["subtract-before-you-add", subtractBeforeYouAdd],
  ["test-through-public-interfaces", testThroughPublicInterfaces],
  ["use-the-platform", useThePlatform],
]

/** Sorted list of all principle names */
export const PRINCIPLE_NAMES: ReadonlyArray<string> = PRINCIPLES.map(([name]) => name)

/** Pre-loaded principle content map */
export const loadPrinciples = (): Map<string, string> => new Map(PRINCIPLES)
