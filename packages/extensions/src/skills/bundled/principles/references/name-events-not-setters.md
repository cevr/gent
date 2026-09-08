# Name Events, Not Setters

Name actions, messages, and state transitions after what happened in the domain — not after the mechanism that applies the change. `'submitted'`, `'item_added'`, `'payment_failed'` — never `'set_loading'`, `'set_items'`, `'update_state'`.

**Why:** Setter names couple the caller to the current implementation. If the handler later needs to update three fields, emit an analytics event, or trigger a workflow, every caller saying `setLoading(true)` has to change. Event names describe the fact that occurred; the handler decides what to do about it. This makes reducers, state machines, and pub/sub systems resilient to change and readable as a domain log.

**The Pattern:**

- **Reducer actions:** `{ type: 'submitted' }` not `{ type: 'set_status', status: 'submitting' }`. The reducer translates the event into whatever state change that implies
- **Callbacks / props:** `onSubmitted`, `onItemAdded` over `onSetState`, `onChange` (when something more specific is meant)
- **Messages / RPC:** name by domain fact (`OrderPlaced`, `UserInvited`), not by operation (`InsertOrderRow`)
- **Events carry facts, handlers carry policy:** the event says "the user clicked submit"; the handler decides whether to validate, retry, dispatch, or ignore
- **Past tense for things that happened; imperative for commands:** `OrderPlaced` (event) vs `PlaceOrder` (command). Mixing them blurs what's authoritative

**The Test:**

- "If I changed how this is handled, would every caller need to update?" If yes, the name leaked the mechanism
- "Does the name describe a fact about the domain, or a field on the state?" Field-shaped names are setters in disguise
- "Could a non-engineer reading the event log understand what happened?" If not, the vocabulary is too technical — it's probably a setter

**See also:** [[make-impossible-states-unrepresentable]] — events are the transitions over a tight state space; the two principles pair tightly.
