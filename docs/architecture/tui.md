# TUI

TUI is a client over the shared contract, not a parallel app.

The session feed uses the durable input-message and step identity for each assistant message. The protocol exports the shared answer-ID rule. Stream chunks update that message only. Tool events locate their owning message by call or assistant ID, including late child results. Historical streams without IDs receive one local ID per stream.

The native transcript and its split region (the canvas, the live tail, the commit path, the replay, the alternate-screen return, the exit flush and the mermaid fence) are specified once, in `apps/tui/docs/transcript.md`, with the OpenTUI renderer facts behind them.

Production shape:

- local mode: one process owns renderer, runtime, storage, and reconnect UX under one root scope
- remote mode: TUI shell attaches to an external server boundary and rehydrates from transport state
- reconnect logic rehydrates from runtime state, not UI guesses

Main boundaries:

- `apps/tui/src/client.tsx` for client/session/event state
- `apps/tui/src/session.tsx` for session-screen orchestration
- `apps/tui/src/extensions/client-facets.ts` for TUI-owned extension facets
- route state machines for modal/session surfaces
- components like `composer.tsx` and `message-list.tsx` as presentation + local interaction

Rules:

- one screen-level owner for session state
- one keyboard owner per route surface
- overlays/composer flows modeled explicitly
- renderer tests cover critical capture/focus paths

## TUI Extensions

Client extensions have one home: `apps/tui/docs/extensions.md` (authoring, loading, contributions) and `apps/tui/docs/shipped-extensions.md` (the shipped ones).
