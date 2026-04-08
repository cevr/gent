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
- "Can this be a pure function that the shell just calls?" If yes, extract it`

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
- "Can I delete this state and recompute it from what already exists?" If yes, it shouldn't be stored independently`

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
Code doesn't change between runs. State does. When "fails after restart," suspect stale persistent state first — config files, caches, lock files, serialized state. If clearing a state file restores behavior, prioritize state validation as the fix.`

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
- **Product direction** comes from the human; _execution_ should not block`

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
- "Would removing this from the default view break the primary workflow?" If not, it belongs in progressive disclosure`

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
When migrating between library versions, grep the actual source (via \`repo-explorer\`) rather than relying on docs or research agent summaries. Docs lag releases; agent output can be wrong on 2/5 API changes. Read the types directly.`

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

const PRINCIPLES: ReadonlyArray<readonly [string, string]> = [
  ["boundary-discipline", boundaryDiscipline],
  ["cost-aware-delegation", costAwareDelegation],
  ["derive-dont-sync", deriveDontSync],
  ["encode-lessons-in-structure", encodeLessonsInStructure],
  ["exhaust-the-design-space", exhaustTheDesignSpace],
  ["experience-first", experienceFirst],
  ["fix-root-causes", fixRootCauses],
  ["foundational-thinking", foundationalThinking],
  ["guard-the-context-window", guardTheContextWindow],
  ["make-operations-idempotent", makeOperationsIdempotent],
  ["migrate-callers-then-delete-legacy-apis", migrateCallersThenDeleteLegacyApis],
  ["never-block-on-the-human", neverBlockOnTheHuman],
  ["outcome-oriented-execution", outcomeOrientedExecution],
  ["progressive-disclosure", progressiveDisclosure],
  ["prove-it-works", proveItWorks],
  ["redesign-from-first-principles", redesignFromFirstPrinciples],
  ["serialize-shared-state-mutations", serializeSharedStateMutations],
  ["subtract-before-you-add", subtractBeforeYouAdd],
]

/** Sorted list of all principle names */
export const PRINCIPLE_NAMES: ReadonlyArray<string> = PRINCIPLES.map(([name]) => name)

/** Pre-loaded principle content map */
export const loadPrinciples = (): Map<string, string> => new Map(PRINCIPLES)
