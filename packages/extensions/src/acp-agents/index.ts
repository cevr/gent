/**
 * ACP Agents Extension — external coding agents (opencode, gemini-cli) as
 * first-class gent agents via the ExternalDriver primitive.
 *
 * Each agent is a subprocess spoken to over ACP JSON-RPC on stdio
 * (`protocol.ts` + `schema.ts`); `AcpSessionManager` owns one subprocess
 * per gent session and is captured by both the contributed drivers and the
 * process-scoped Resource that disposes them.
 *
 * This is the adapter at core's `externalDriver` seam — the second
 * implementation of `TurnExecutor`, alongside the model drivers. Agents
 * dispatch gent's tools over ACP's own tool surface, so no host-side tool
 * bridge is built here.
 *
 * @module
 */
import { Context, Effect, Layer } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import {
  AgentDefinition,
  AgentName,
  defineExtension,
  defineResource,
  ExtensionHost,
  ExternalDriverRef,
  type GentExtension,
} from "@gent/core/extensions/api"
import { ACP_PROTOCOL_AGENTS } from "./config.js"
import { makeAcpTurnExecutor, type AcpSessionManager } from "./executor.js"
import { createAcpSessionManager } from "./session-manager.js"

/**
 * Anchors the disposer Resource's layer to a concrete service type.
 * `Layer.empty: Layer<never>` is not assignable to the heterogeneous
 * bucket type under contravariant `ROut`; naming `A` keeps the leaf
 * structural so `defineResource(...)` flows straight into `register`.
 */
class AcpAgentsDisposer extends Context.Service<
  AcpAgentsDisposer,
  { readonly _tag: "AcpAgentsDisposer" }
>()("@gent/extensions/src/acp-agents/AcpAgentsDisposer") {}

/**
 * Process-scoped finalizer for the manager's subprocesses.
 *
 * Subprocesses outlive a turn and a branch, so this is process-scoped:
 * without it a stale `opencode` child survives the runtime that spawned
 * it. The release step is exported separately so a test can assert it.
 */
const acpDisposerResource = (manager: AcpSessionManager) =>
  defineResource({
    id: "@gent/acp-agents/disposer",
    scope: "process",
    layer: Layer.effect(
      AcpAgentsDisposer,
      Effect.acquireRelease(
        Effect.succeed(AcpAgentsDisposer.of({ _tag: "AcpAgentsDisposer" })),
        () => acpDisposerRelease(manager),
      ),
    ),
  })

/**
 * The disposer's release step. Named so a test can assert it: the
 * resource's own layer carries the process `ServerScope` brand, which
 * only the runtime can supply.
 */
export const acpDisposerRelease = (manager: AcpSessionManager): Effect.Effect<void> =>
  manager.disposeAll

export const makeAcpAgentsExtension = (
  deps: { readonly makeAcpSessionManager?: typeof createAcpSessionManager } = {},
): GentExtension<ChildProcessSpawner | ExtensionHost> =>
  defineExtension({
    id: "@gent/acp-agents",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      const manager = yield* deps.makeAcpSessionManager ?? createAcpSessionManager

      for (const [name, config] of Object.entries(ACP_PROTOCOL_AGENTS)) {
        const id = `acp-${name}`
        yield* host.register(
          "agent",
          AgentDefinition.make({
            name: AgentName.make(name),
            description: `${config.command} via ACP`,
            driver: ExternalDriverRef.make({ id }),
          }),
        )
        yield* host.register("externalDriver", {
          id,
          executor: makeAcpTurnExecutor(id, config, manager),
          invalidate: manager.invalidateDriver(id),
        })
      }

      yield* host.register("resource", acpDisposerResource(manager))
    }),
  })

export const AcpAgentsExtension: GentExtension<ChildProcessSpawner | ExtensionHost> =
  makeAcpAgentsExtension()
