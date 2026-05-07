import { describe, expect, it } from "effect-bun-test"
import { Cause, Config, Effect, Layer, Option } from "effect"
import { SqlClientLive } from "../../src/runtime/sql-client"

describe("SqlClientLive", () => {
  it.live("fails with ConfigError when postgres config is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(SqlClientLive({ backend: "postgres" }))),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error)).toBe(true)
      if (!Option.isSome(error)) return
      expect(error.value).toBeInstanceOf(Config.ConfigError)
      expect(error.value.message).toContain("SqlClientLive: postgres config required")
    }),
  )
})
