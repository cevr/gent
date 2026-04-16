# Derive, Don't Sync

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
