# Test Through Public Interfaces

Tests must verify behavior through the same public surface a real caller would use. Never reach past the interface to assert on internal state, mock internal collaborators, or inspect side effects directly.

**Why:** Tests coupled to internals break on every refactor — even when behavior is unchanged — and pass when behavior breaks but the internal shape happens to match. Tests coupled to the public interface survive refactors, catch real regressions, and double as executable documentation of the contract. If a test can only be written by reaching inside, the interface is probably wrong, not the test.

**The Pattern:**

- **Act through the API, assert through the API:** if `createUser` is the entry point, verify by calling `getUser` — not by querying the underlying store
- **Mock only at system boundaries:** external services, the clock, the network, the filesystem. Don't mock your own modules
- **No white-box assertions:** peeking at private fields, spying on internal method calls, or checking "was this function called?" couples the test to the implementation
- **If it's hard to test through the interface, the interface is wrong:** treat test pain as interface feedback, not test-framework trivia
- **One real path per behavior:** integration-shaped tests that exercise the full code path beat a hundred unit tests mocking every collaborator

**The Test:**

- "If I rewrite the internals completely but keep the interface, will this test still pass?" If no, it's coupled to internals
- "Does this test know anything a caller wouldn't?" If yes, remove that knowledge
- "Would this test catch a real bug a user would see?" If no, it's testing the mock, not the code

**See also:** [[prove-it-works]] — the _what_ of verification (don't claim done without evidence); this principle is the _how_ (verify through the caller's eyes). [[boundary-discipline]] — mocks belong at system boundaries, not inside them.
