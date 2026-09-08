# Small Interface, Deep Implementation

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

**See also:** [[boundary-discipline]] — boundaries decide _where_ to draw the line; this principle decides _how much_ to expose at each one. [[progressive-disclosure]] — same instinct applied to APIs: minimum required up front, everything else on demand.
