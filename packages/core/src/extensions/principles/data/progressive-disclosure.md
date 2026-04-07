# Progressive Disclosure

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
