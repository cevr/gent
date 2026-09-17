/**
 * The launch values `apps/server/src/main.ts` reads its environment through.
 *
 * A launcher gets strings. Before this config, `Number()` accepted anything
 * finite and an unknown mode string fell through to the default, so two wrong
 * values ran instead of stopping: `GENT_IDLE_TIMEOUT_MS=-1` made the idle
 * watcher shut the server down on its first poll, and a misspelled
 * `GENT_PROVIDER_MODE` selected the live provider for a caller that asked for
 * the scripted one. Each test below names the value that used to pass.
 *
 * Every case drives the real `ConfigProvider`, so it exercises the same path
 * the launcher takes rather than a decoder called by hand.
 */
import { describe, expect, it } from "effect-bun-test"
import { ConfigProvider, Effect } from "effect"
import { LaunchConfig } from "../src/server"

/** Read `LaunchConfig` against an environment holding exactly `env`. */
const launchWith = (env: Record<string, string>) =>
  LaunchConfig.parse(ConfigProvider.fromEnvRecord(env))

/** The failure `LaunchConfig` gives for `env`, as its rendered message. */
const failureOf = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(launchWith(env))
    if (result._tag === "Success") {
      const named = Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
      return yield* Effect.die(`expected a config failure for ${named}`)
    }
    return String(result.failure)
  })

describe("GENT_IDLE_TIMEOUT_MS", () => {
  it.effect("an unset variable takes the fallback", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({})
      expect(launch.idleTimeoutMs).toBe(30_000)
    }),
  )

  it.effect("a positive whole number is taken as given", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({ GENT_IDLE_TIMEOUT_MS: "250" })
      expect(launch.idleTimeoutMs).toBe(250)
    }),
  )

  it.effect("a negative timeout fails instead of shutting the server down at once", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "-1" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("greater than 0")
    }),
  )

  it.effect("zero fails: an idle window of no length stops the server immediately", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "0" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("greater than 0")
    }),
  )

  it.effect("a fractional timeout fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "1.5" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("an integer")
    }),
  )

  it.effect("text that is not a number fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_IDLE_TIMEOUT_MS: "soon" })
      expect(failure).toContain("GENT_IDLE_TIMEOUT_MS")
      expect(failure).toContain("finite number")
    }),
  )
})

describe("GENT_PORT", () => {
  it.effect("an unset variable takes the fallback", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({})
      expect(launch.port).toBe(3000)
    }),
  )

  it.effect("a port inside the TCP range is taken as given", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({ GENT_PORT: "8080" })
      expect(launch.port).toBe(8080)
    }),
  )

  it.effect("a port above the TCP range fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PORT: "70000" })
      expect(failure).toContain("GENT_PORT")
      expect(failure).toContain("between 1 and 65535")
    }),
  )

  it.effect("a negative port fails", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PORT: "-8080" })
      expect(failure).toContain("GENT_PORT")
      expect(failure).toContain("between 1 and 65535")
    }),
  )

  it.effect("port zero fails: the launcher names a port its clients dial", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PORT: "0" })
      expect(failure).toContain("GENT_PORT")
      expect(failure).toContain("between 1 and 65535")
    }),
  )
})

describe("mode words", () => {
  it.effect("unset variables take their fallbacks", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({})
      expect(launch.providerMode).toBe("live")
      expect(launch.persistenceMode).toBe("sqlite")
      expect(launch.serverMode).toBe("standalone")
    }),
  )

  it.effect("a known mode is taken as given", () =>
    Effect.gen(function* () {
      const launch = yield* launchWith({ GENT_PROVIDER_MODE: "debug-scripted" })
      expect(launch.providerMode).toBe("debug-scripted")
    }),
  )

  it.effect("a misspelled provider mode fails instead of selecting the live provider", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PROVIDER_MODE: "debug-script" })
      expect(failure).toContain("GENT_PROVIDER_MODE")
      expect(failure).toContain('"live" | "debug-scripted"')
    }),
  )

  it.effect("a misspelled persistence mode fails instead of writing SQLite", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_PERSISTENCE_MODE: "in-memory" })
      expect(failure).toContain("GENT_PERSISTENCE_MODE")
      expect(failure).toContain('"sqlite" | "memory"')
    }),
  )

  it.effect("a misspelled server mode fails instead of running standalone forever", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_SERVER_MODE: "share" })
      expect(failure).toContain("GENT_SERVER_MODE")
      expect(failure).toContain('"standalone" | "shared"')
    }),
  )

  it.effect("the mode comparison is exact, not a prefix", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({ GENT_SERVER_MODE: "shared-extra" })
      expect(failure).toContain("GENT_SERVER_MODE")
      expect(failure).toContain('"standalone" | "shared"')
    }),
  )
})
