import { Match } from "effect"

/**
 * - `compact`: whole seconds under a minute, then `2m 5s` (status lines, turn summaries).
 * - `padded`: whole seconds under a minute, then `2m05s` (fixed-width detail rows).
 * - `precise`: `12ms` under a second, tenths under a minute, then `2m 5s` (tool receipts).
 */
type DurationStyle = "compact" | "padded" | "precise"

const wholeSeconds = (ms: number): number => Math.floor(ms / 1000)

const compact = (ms: number): string => {
  const secs = wholeSeconds(ms)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

const padded = (ms: number): string => {
  const secs = wholeSeconds(ms)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`
}

const precise = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
}

export const formatDuration = (ms: number, style: DurationStyle): string =>
  Match.value(style).pipe(
    Match.when("compact", () => compact(ms)),
    Match.when("padded", () => padded(ms)),
    Match.when("precise", () => precise(ms)),
    Match.exhaustive,
  )
