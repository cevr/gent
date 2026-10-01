// @ts-nocheck — held-shapes fixture
// Retired: gent/no-retired-bun-member (094b2f976). The gamut driver keeps
// `noGlobals` with `builtins: false`: it may reach Bun and the host, but not
// the retired Bun members, and its members list holds the globals the
// retired language-service rule held.
export const files = new Bun.Glob("*") // held-by: effect/noGlobals
export const computed = new Bun["Glob"]("*") // held-by: effect/noGlobals
export const id = Bun.randomUUIDv7() // held-by: effect/noGlobals
export const viaGlobal = new globalThis.Bun.Glob("*") // held-by: effect/noGlobals
export const viaComputedGlobal = globalThis["Bun"].randomUUIDv7() // held-by: effect/noGlobals
export const optional = Bun?.randomUUIDv7() // held-by: effect/noGlobals
export const body = fetch("/nonexistent/loop-probe-x") // held-by: effect/noGlobals
export const timer = setTimeout(() => {}, 1) // held-by: effect/noGlobals
export const poll = setInterval(() => {}, 1) // held-by: effect/noGlobals
export const coin = Math.random() // held-by: effect/noGlobals
export const uuid = crypto.randomUUID() // held-by: effect/noGlobals
export const env = process.env["LOOP_PROBE_X"] // held-by: effect/noGlobals
const host = process
export const aliased = host.env["LOOP_PROBE_X"] // held-by: effect/noGlobals
