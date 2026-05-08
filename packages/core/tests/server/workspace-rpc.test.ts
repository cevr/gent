import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { RpcClient, RpcTest } from "effect/unstable/rpc"
import { Headers } from "effect/unstable/http"
import { textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { GentRpcs } from "../../src/server/rpcs"
import { RpcHandlersLive } from "../../src/server/rpc-handlers"
import {
  CurrentWorkspaceId,
  WORKSPACE_ID_HEADER,
  validateWorkspaceId,
  withWorkspaceIdHeader,
} from "../../src/server/workspace-rpc"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"

const validWorkspaceId = "a".repeat(64)
const otherWorkspaceId = "b".repeat(64)

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
      const observed = yield* withWorkspaceIdHeader(
        Effect.service(CurrentWorkspaceId),
        Headers.fromInput({ [WORKSPACE_ID_HEADER]: validWorkspaceId }),
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
          client["session.create"]({ name: "workspace-a-session", cwd: "/tmp/a" }),
        )
        yield* inWorkspace(
          otherWorkspaceId,
          client["session.create"]({ name: "workspace-b-session", cwd: "/tmp/b" }),
        )

        const first = yield* inWorkspace(validWorkspaceId, client["session.list"]())
        const second = yield* inWorkspace(otherWorkspaceId, client["session.list"]())

        expect(first.map((session) => session.name)).toEqual(["workspace-a-session"])
        expect(second.map((session) => session.name)).toEqual(["workspace-b-session"])
      }),
    ),
  )
})
