// @ts-nocheck — held-shapes fixture
// The capture preload keeps `noGlobals` with `builtins: false`; its members
// list holds the globals the language service held before (GR-8).
export const timer = setTimeout(() => {}, 1) // held-by: effect/noGlobals
export const poll = setInterval(() => {}, 1) // held-by: effect/noGlobals
export const coin = Math.random() // held-by: effect/noGlobals
export const uuid = crypto.randomUUID() // held-by: effect/noGlobals
export const line = console.log("loop-probe-x") // held-by: effect/noGlobals
export const id = Bun.randomUUIDv7() // held-by: effect/noGlobals
