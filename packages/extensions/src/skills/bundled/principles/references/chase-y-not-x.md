# Chase Y, Not X

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

**See also:** [[fix-root-causes]] — same "surface isn't substance" spine, but applied to debugging (a bug exists) rather than requirements (a request arrived).
