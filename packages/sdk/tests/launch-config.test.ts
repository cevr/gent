/**
 * The launch-value decoders `apps/server/src/main.ts` reads its environment
 * through.
 *
 * A launcher gets strings. Before these decoders, `Number()` accepted anything
 * finite and an unknown mode string fell through to the default, so two wrong
 * values ran instead of stopping: `GENT_IDLE_TIMEOUT_MS=-1` made the idle
 * watcher shut the server down on its first poll, and a misspelled
 * `GENT_PROVIDER_MODE` selected the live provider for a caller that asked for
 * the scripted one. Each test below names the value that used to pass.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { knownModeOr, positiveIntegerOr, tcpPortOr } from "../src/server"
import type { LaunchConfigError } from "../src/server"

/** The mode lists `apps/server/src/main.ts` decodes its environment against. */
const PROVIDER_MODES: ReadonlyArray<"live" | "debug-scripted"> = ["live", "debug-scripted"]
const PERSISTENCE_MODES: ReadonlyArray<"sqlite" | "memory"> = ["sqlite", "memory"]
const SERVER_MODES: ReadonlyArray<"standalone" | "shared"> = ["standalone", "shared"]

const failureOf = <A>(effect: Effect.Effect<A, LaunchConfigError>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect)
    if (result._tag === "Success") {
      return yield* Effect.die(`expected a LaunchConfigError, got ${String(result.success)}`)
    }
    return result.failure
  })

describe("positiveIntegerOr", () => {
  it.effect("an unset variable takes the fallback", () =>
    Effect.gen(function* () {
      const value = yield* positiveIntegerOr("GENT_IDLE_TIMEOUT_MS", Option.none(), 30_000)
      expect(value).toBe(30_000)
    }),
  )

  it.effect("a positive whole number is taken as given", () =>
    Effect.gen(function* () {
      const value = yield* positiveIntegerOr("GENT_IDLE_TIMEOUT_MS", Option.some("250"), 30_000)
      expect(value).toBe(250)
    }),
  )

  it.effect("a negative timeout fails instead of shutting the server down at once", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        positiveIntegerOr("GENT_IDLE_TIMEOUT_MS", Option.some("-1"), 30_000),
      )
      expect(error.variable).toBe("GENT_IDLE_TIMEOUT_MS")
      expect(error.value).toBe("-1")
      expect(error.message).toContain("positive whole number")
    }),
  )

  it.effect("zero fails: an idle window of no length stops the server immediately", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        positiveIntegerOr("GENT_IDLE_TIMEOUT_MS", Option.some("0"), 30_000),
      )
      expect(error.value).toBe("0")
    }),
  )

  it.effect("a fractional timeout fails", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        positiveIntegerOr("GENT_IDLE_TIMEOUT_MS", Option.some("1.5"), 30_000),
      )
      expect(error.value).toBe("1.5")
    }),
  )

  it.effect("text that is not a number fails", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        positiveIntegerOr("GENT_IDLE_TIMEOUT_MS", Option.some("soon"), 30_000),
      )
      expect(error.value).toBe("soon")
    }),
  )
})

describe("tcpPortOr", () => {
  it.effect("an unset variable takes the fallback", () =>
    Effect.gen(function* () {
      const value = yield* tcpPortOr("GENT_PORT", Option.none(), 3000)
      expect(value).toBe(3000)
    }),
  )

  it.effect("a port inside the TCP range is taken as given", () =>
    Effect.gen(function* () {
      const value = yield* tcpPortOr("GENT_PORT", Option.some("8080"), 3000)
      expect(value).toBe(8080)
    }),
  )

  it.effect("a port above the TCP range fails", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(tcpPortOr("GENT_PORT", Option.some("70000"), 3000))
      expect(error.variable).toBe("GENT_PORT")
      expect(error.message).toContain("1 to 65535")
    }),
  )

  it.effect("a negative port fails", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(tcpPortOr("GENT_PORT", Option.some("-8080"), 3000))
      expect(error.value).toBe("-8080")
    }),
  )

  it.effect("port zero fails: the launcher names a port its clients dial", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(tcpPortOr("GENT_PORT", Option.some("0"), 3000))
      expect(error.value).toBe("0")
    }),
  )
})

describe("knownModeOr", () => {
  it.effect("an unset variable takes the fallback", () =>
    Effect.gen(function* () {
      const value = yield* knownModeOr("GENT_PROVIDER_MODE", Option.none(), PROVIDER_MODES, "live")
      expect(value).toBe("live")
    }),
  )

  it.effect("a known mode is taken as given", () =>
    Effect.gen(function* () {
      const value = yield* knownModeOr(
        "GENT_PROVIDER_MODE",
        Option.some("debug-scripted"),
        PROVIDER_MODES,
        "live",
      )
      expect(value).toBe("debug-scripted")
    }),
  )

  it.effect("a misspelled provider mode fails instead of selecting the live provider", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        knownModeOr("GENT_PROVIDER_MODE", Option.some("debug-script"), PROVIDER_MODES, "live"),
      )
      expect(error.variable).toBe("GENT_PROVIDER_MODE")
      expect(error.value).toBe("debug-script")
      expect(error.message).toContain("live, debug-scripted")
    }),
  )

  it.effect("a misspelled persistence mode fails instead of writing SQLite", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        knownModeOr("GENT_PERSISTENCE_MODE", Option.some("in-memory"), PERSISTENCE_MODES, "sqlite"),
      )
      expect(error.value).toBe("in-memory")
    }),
  )

  it.effect("a misspelled server mode fails instead of running standalone forever", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        knownModeOr("GENT_SERVER_MODE", Option.some("share"), SERVER_MODES, "standalone"),
      )
      expect(error.value).toBe("share")
    }),
  )

  it.effect("the mode comparison is exact, not a prefix", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        knownModeOr("GENT_SERVER_MODE", Option.some("shared-extra"), SERVER_MODES, "standalone"),
      )
      expect(error.value).toBe("shared-extra")
    }),
  )
})
