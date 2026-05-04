// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-hand-rolled-tagged-union` fires once per
// hand-rolled `_tag` union with ≥2 PascalCase tagged members.

// Two-variant inline union — the canonical C17 case.
export type WorkerLifecycleState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly pid: number }

// Three-variant inline union with mixed fields.
export type ConnState =
  | { readonly _tag: "Disconnected" }
  | { readonly _tag: "Connecting"; readonly attempts: number }
  | { readonly _tag: "Connected"; readonly socket: unknown }

// Two-variant union without `readonly` — still hand-rolled, still flagged.
export type PortProbe =
  | { _tag: "Listening"; port: number }
  | { _tag: "Closed"; reason: string }

// Two-variant union using string-literal property keys.
export type SidecarRecord =
  | { readonly "_tag": "Spawned"; readonly pid: number }
  | { readonly "_tag": "Exited"; readonly code: number }
