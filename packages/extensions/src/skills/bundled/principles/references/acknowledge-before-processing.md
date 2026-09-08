# Acknowledge Before Processing

Whenever a caller hands off work, confirm receipt inside the minimum perceptible window — then do the work. Never let the caller face silence while processing; silence is indistinguishable from being broken.

**Why:** Humans judge "working" vs "hung" in roughly 100ms. Machines time out and retry. Systems that start a long operation without first acknowledging it force every caller to implement their own "is this alive?" heuristic — retries, cancellations, duplicate submissions, anxious refreshes. A fast, explicit "I have your request" collapses that ambiguity and buys unlimited headroom for the actual work.

**The Pattern:**

- **Print something within 100ms:** a heading, a spinner, the parsed intent — anything that proves the request was received
- **Separate acknowledgment from completion:** `202 Accepted` with a status URL beats a 30-second synchronous request. Return a handle; deliver the result out-of-band
- **Show progress, not just eventual output:** for anything over a few seconds, stream partial results or a progress signal. Unknown duration → spinner with a status line
- **On cancellation, acknowledge fast too:** Ctrl-C, cancel buttons, and aborts must respond immediately — even if cleanup takes longer, the caller needs to know the cancel landed
- **Design the handoff, not just the work:** the first thing a caller experiences is receipt, not result. Make that experience deliberate

**The Test:**

- "If the work took 10x longer than expected, would the caller know the system is still alive?" If no, there's no acknowledgment — just silence
- "Can the caller tell the difference between 'processing' and 'hung'?" If not, add an explicit signal
- "Does cancellation feel instant even when cleanup isn't?" If no, the ack is coupled to the work — decouple them

**See also:** [[never-block-on-the-human]] — the reverse direction: don't block _on_ your caller either. [[experience-first]] — acknowledgment is the first touchpoint of the experience; design it deliberately.
