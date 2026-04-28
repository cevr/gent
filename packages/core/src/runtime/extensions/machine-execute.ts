/**
 * MachineExecute — read-only call surface onto extension state machines.
 *
 * Projections need to query a machine's current state via the typed
 * request/reply protocol but must NOT be able to send commands or
 * publish events. `MachineExecute` is the narrow Tag that exposes only
 * the read path (`execute<M>`); writes (`send`) live on `ActorRouter`,
 * the substrate's wide write surface.
 *
 * B11.4 brands `MachineExecute` with the `ReadOnly` tag so projection
 * R-channels enforce read-only at the type level — `ActorRouter`
 * exposes `send` and can't honestly carry the brand.
 *
 * Delegates to `engine.execute` (renamed from `engine.ask` in B11.3d).
 *
 * @module
 */
import { Context, Effect, Layer } from "effect"
import type { BranchId, SessionId } from "../../domain/ids.js"
import type {
  AnyExtensionRequestMessage,
  ExtensionProtocolError,
  ExtractExtensionReply,
} from "../../domain/extension-protocol.js"
import { type ReadOnly, ReadOnlyBrand, withReadOnly } from "../../domain/read-only.js"
import { ActorRouter, type ActorRouterService } from "./resource-host/actor-router.js"

export interface MachineExecuteService {
  readonly execute: <M extends AnyExtensionRequestMessage>(
    sessionId: SessionId,
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>
}

/**
 * `MachineExecute` carries the `ReadOnly` brand — it exposes only
 * `execute<M>` and read-intent R-channels accept only `ReadOnly`-branded
 * service Tags. See `domain/read-only.ts`.
 */
export class MachineExecute extends Context.Service<
  MachineExecute,
  ReadOnly<MachineExecuteService>
>()("@gent/core/src/runtime/extensions/machine-execute/MachineExecute") {
  /**
   * Brand on the Tag identifier so `yield* MachineExecute` produces an
   * `R extends ReadOnlyTag` requirement for read-intent R-channels.
   */
  declare readonly [ReadOnlyBrand]: true

  /**
   * Live layer — projects `ActorRouter.execute` onto the read-only
   * `execute` surface. Requires `ActorRouter` (provided alongside
   * by callers — see `runtime/profile.ts`).
   */
  static Live: Layer.Layer<MachineExecute, never, ActorRouter> = Layer.effect(
    MachineExecute,
    Effect.gen(function* () {
      const engine: ActorRouterService = yield* ActorRouter
      return withReadOnly({
        execute: (sessionId, message, branchId) => engine.execute(sessionId, message, branchId),
      } satisfies MachineExecuteService)
    }),
  )
}
