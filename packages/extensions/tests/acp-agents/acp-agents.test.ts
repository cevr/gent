/**
 * The ACP extension is the adapter at core's `externalDriver` seam.
 *
 * Core carries the external-driver contract through roughly ten modules —
 * the contribution bucket, the driver registry, the `external` branch in
 * `turn-source`, and the `/driver` override command. Without a shipped
 * adapter that whole path is unexercised surface. These tests assert the
 * extension actually fills the seam: it registers drivers under the ids
 * its agents reference, and it disposes the subprocesses it owns.
 */

import { BunChildProcessSpawner, BunFileSystem } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Path, Predicate } from "effect"
import { setupExtensions } from "@gent/core-internal/runtime/extension-host.js"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"
import {
  ACP_PROTOCOL_AGENTS,
  AcpAgentsExtension,
  acpDisposerRelease,
  type AcpSessionManager,
  makeAcpAgentsExtension,
} from "../../src/acp-agents.js"

const childProcessSpawnerLive = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)

const fsLayer = Layer.provideMerge(
  Layer.mergeAll(BunFileSystem.layer, Path.layer, BunGentPlatformLive),
  childProcessSpawnerLive,
)

/** Session manager stub — no test here spawns a real ACP subprocess. */
const stubSessionManager = (disposeAll: Effect.Effect<void>): AcpSessionManager => ({
  getOrCreate: () => Effect.die("no session is created in these tests"),
  invalidate: () => Effect.void,
  invalidateDriver: () => Effect.void,
  disposeAll,
})

const activate = (extension: typeof AcpAgentsExtension) =>
  setupExtensions({
    extensions: [{ extension, scope: "builtin", sourcePath: "builtin" }],
    cwd: "/tmp",
    home: "/tmp",
    disabled: new Set(),
  })

describe("acp agents extension", () => {
  it.live("registers one external driver per configured ACP agent", () =>
    Effect.gen(function* () {
      const result = yield* activate(AcpAgentsExtension)
      expect(result.failed).toHaveLength(0)
      expect(result.active).toHaveLength(1)

      const contributions = result.active[0]!.contributions
      const driverIds = (contributions.externalDrivers ?? []).map((driver) => driver.id).sort()
      const expected = Object.keys(ACP_PROTOCOL_AGENTS)
        .map((name) => `acp-${name}`)
        .sort()
      expect(driverIds).toEqual(expected)
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("every agent routes to a driver the extension actually registered", () =>
    Effect.gen(function* () {
      const contributions = (yield* activate(AcpAgentsExtension)).active[0]!.contributions
      const driverIds = new Set((contributions.externalDrivers ?? []).map((driver) => driver.id))
      const agents = contributions.agents ?? []
      expect(agents.length).toBeGreaterThan(0)
      // An agent naming a driver id nothing registered resolves to
      // "External driver not found" at turn time, not at load time.
      for (const agent of agents) {
        const driver = agent.driver
        expect(Predicate.isNotUndefined(driver) && driver._tag === "External").toBe(true)
        const routed =
          Predicate.isNotUndefined(driver) && driver._tag === "External" && driverIds.has(driver.id)
        expect(routed).toBe(true)
      }
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("contributes a process-scoped resource that owns subprocess disposal", () =>
    Effect.gen(function* () {
      const extension = makeAcpAgentsExtension({
        makeAcpSessionManager: Effect.succeed(stubSessionManager(Effect.void)),
      })
      const contributions = (yield* activate(extension)).active[0]!.contributions
      const resources = contributions.resources ?? []
      expect(resources).toHaveLength(1)
      // Subprocesses outlive a branch, so the finalizer must be process-scoped;
      // a branch-scoped one would leave a stale child behind per session.
      expect(resources[0]!.scope).toBe("process")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("the disposer's release step disposes the session manager", () =>
    Effect.gen(function* () {
      let disposed = false
      const manager = stubSessionManager(
        Effect.sync(() => {
          disposed = true
        }),
      )
      // The registered descriptor's layer carries the process `ServerScope`
      // brand, which only the runtime can supply — so assert the release
      // step itself. Without it a spawned `opencode` survives the runtime
      // that started it.
      yield* acpDisposerRelease(manager)
      expect(disposed).toBe(true)
    }),
  )
})
