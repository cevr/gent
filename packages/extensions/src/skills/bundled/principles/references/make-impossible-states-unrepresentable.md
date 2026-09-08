# Make Impossible States Unrepresentable

Model state so invalid combinations can't be constructed, not just avoided. The type system is the cheapest test you will ever write — use it to encode what "valid" means.

**Why:** Boolean pairs and optional fields create silent junk states. `isLoading=true, isError=true, data=null` compiles fine and means nothing. Every consumer then has to defend against the junk — or forget to, and ship a bug. Discriminated unions collapse the valid space to exactly the states that exist, and TypeScript narrows each branch to just the fields it needs.

**The Pattern:**

- **Discriminated unions over boolean clusters:** replace `isLoading / isError / isSuccess` with `{ status: 'idle' | 'loading' | 'success' | 'error' }`. Each branch carries only its relevant fields
- **Fields belong to the state they describe:** `data` lives on `success`, `error` lives on `error`. No `data?: T` or `error?: Error` on the parent
- **Guard transitions at the reducer:** not every action is valid in every state. Invalid transitions no-op or error — they don't silently corrupt
- **Exhaustive switches:** use `satisfies` / `never` defaults so adding a new state breaks the compile rather than slipping through
- **Name by lifecycle, not by flag:** `'closed' | 'opening' | 'open' | 'closing'` beats `isOpen + isAnimating + isClosing`

**The Test:**

- "Can I write down a state that compiles but shouldn't exist?" If yes, the model is too loose — collapse to a union
- "Does every consumer need a `?? null` or `if (data)` guard?" The state shape is lying about what's actually present
- "Would a junior reading this know which fields are meaningful when?" If not, the discriminant isn't doing its job

**See also:** [[name-events-not-setters]] — the transitions between these states should be named as facts, not as field assignments. [[derive-dont-sync]] — once the state space is tight, derived values project from it rather than living alongside.
