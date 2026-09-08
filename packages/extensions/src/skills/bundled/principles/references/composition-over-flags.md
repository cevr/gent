# Composition Over Flags

Build primitives that compose, not monoliths with configuration flags. When a component, function, or API grows boolean props to switch behavior, the right move is usually to split it into distinct primitives that share underlying pieces.

**Why:** Each flag doubles the state space. Five booleans = 32 branches to reason about, most invalid. Worse, flags couple unrelated concerns into one implementation — every consumer pays the cost of every variant. Primitives that compose stay small, testable, and truthful about what they do. The caller assembles exactly what they need; nothing more is loaded, rendered, or reasoned about.

**The Pattern:**

- **Split by variant, not by flag:** `<ThreadComposer>` and `<EditComposer>` beat `<Composer isThread isEditing>`. Each variant wraps its own provider and composes only what it needs
- **Children over configuration:** prefer `children` / slot composition over `renderHeader` / `renderFooter` props. Reserve render props for when the parent must pass data back
- **Compound components:** expose `Thing.Frame`, `Thing.Input`, `Thing.Submit` with shared context. The consumer renders pieces to opt in
- **Primitives first, convenience later:** ship the composable pieces. If a common combination emerges, offer a thin wrapper — don't start with the wrapper
- **Decouple behavior from shell:** the container defines the contract (`state`, `actions`, `meta`); swappable providers implement it. Same consumers, different backing stores

**The Test:**

- "How many branches does this component have internally?" If every method starts with `if (isX)`, the flag should be a separate primitive
- "Can I delete this flag by splitting the component?" If yes, split it
- "Does the caller have to understand implementation details to pick the right flag combo?" Then the flags are leaking the wrong abstraction — expose the primitives directly

**See also:** [[progressive-disclosure]] — primitives + sensible defaults let simple cases stay simple while advanced cases compose. [[subtract-before-you-add]] — flags accrete; splitting into primitives is the subtraction move.
