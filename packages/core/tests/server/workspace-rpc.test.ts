import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { RpcClient, RpcTest } from "effect/unstable/rpc"
import { Headers } from "effect/unstable/http"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { LanguageModelLayers, textStep } from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/harness"
import { GentRpcs } from "../../src/server/rpc"
import { RpcHandlersLive } from "../../src/server/server"
import {
  CurrentWorkspaceId,
  WORKSPACE_ID_HEADER,
  WorkspaceId,
  validateWorkspaceId,
  provideWorkspaceIdHeader,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
} from "../../src/server/workspace-rpc"
import { e2ePreset } from "../helpers/test-preset"

const validWorkspaceId = WorkspaceId.make("a".repeat(64))
const otherWorkspaceId = WorkspaceId.make("b".repeat(64))

describe("workspace RPC middleware", () => {
  it.live("validates workspace ids", () =>
    Effect.gen(function* () {
      expect(yield* validateWorkspaceId(validWorkspaceId)).toBe(validWorkspaceId)
      const invalid = yield* Effect.exit(validateWorkspaceId("not-a-workspace"))
      expect(invalid._tag).toBe("Failure")
    }),
  )

  it.live("publishes the validated workspace id to request scope", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.service(CurrentWorkspaceId).pipe(
        provideWorkspaceIdHeader(Headers.fromInput({ [WORKSPACE_ID_HEADER]: validWorkspaceId })),
      )
      expect(observed).toBe(validWorkspaceId)
    }),
  )

  it.live("rejects raw RPC calls without workspace header", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const context = yield* Layer.build(
          Layer.provide(RpcHandlersLive, createE2ELayer({ ...e2ePreset, providerLayer })),
        )
        const client = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
        const exit = yield* Effect.exit(client["session.list"]())
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Bun.inspect(exit.cause)).toContain("WorkspaceHeaderError")
        }
      }),
    ),
  )

  it.live("isolates session lists by workspace header", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const context = yield* Layer.build(
          Layer.provide(RpcHandlersLive, createE2ELayer({ ...e2ePreset, providerLayer })),
        )
        const client = yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(context))
        const inWorkspace = <A, E, R>(workspaceId: string, effect: Effect.Effect<A, E, R>) =>
          RpcClient.withHeaders(effect, { [WORKSPACE_ID_HEADER]: workspaceId })

        yield* inWorkspace(
          validWorkspaceId,
          client["session.create"]({ name: "workspace-a-session", cwd: "/nonexistent/a" }),
        )
        yield* inWorkspace(
          otherWorkspaceId,
          client["session.create"]({ name: "workspace-b-session", cwd: "/nonexistent/b" }),
        )

        const first = yield* inWorkspace(validWorkspaceId, client["session.list"]())
        const second = yield* inWorkspace(otherWorkspaceId, client["session.list"]())

        expect(first.map((session) => session.name)).toEqual(["workspace-a-session"])
        expect(second.map((session) => session.name)).toEqual(["workspace-b-session"])
      }),
    ),
  )

  /**
   * A client hashes its cwd into the header; the server hashes its launch cwd
   * into the id it reads sessions under. The two run in different processes.
   * If they ever disagree, every request silently lands in an empty
   * workspace — so pin the derivation here.
   */
  it.live("derives a valid, canonical, stable workspace id", () =>
    Effect.gen(function* () {
      const id = workspaceIdForCwd("/tmp/gent")

      // The branded pattern the RPC middleware validates against.
      expect(yield* validateWorkspaceId(id)).toBe(id)

      // Canonical: the path is resolved before hashing.
      expect(workspaceIdForCwd("/tmp/gent/../gent")).toBe(id)
      expect(workspaceIdForCwd("/tmp/gent/")).toBe(id)

      // Distinct directories never collide.
      expect(workspaceIdForCwd("/tmp/other")).not.toBe(id)

      // The header carries exactly that id.
      expect(workspaceHeadersForCwd("/tmp/gent")[WORKSPACE_ID_HEADER]).toBe(String(id))
    }),
  )

  it.live("agrees with a sha256 of the platform-resolved path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const platform = yield* GentPlatform
      const cwd = "/nonexistent/gent/nested/.."

      // The shape `dependencies.ts` used to compute on its own. It must keep
      // matching the shared derivation, or the server and its clients split.
      const viaPlatform = WorkspaceId.make(platform.hash("sha256", path.resolve(cwd)))

      expect(workspaceIdForCwd(cwd)).toBe(viaPlatform)
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunGentPlatformLive))),
  )
})
