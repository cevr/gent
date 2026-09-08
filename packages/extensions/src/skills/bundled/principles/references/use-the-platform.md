# Use the Platform

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

**See also:** [[subtract-before-you-add]] — the platform already exists; reaching for it is the subtraction move. [[boundary-discipline]] — the platform sits at a boundary; trust what it gives you rather than re-validating inside.
