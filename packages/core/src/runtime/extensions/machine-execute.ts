/**
 * MachineExecute — read-only call surface onto extension state machines.
 *
 * Projections need to query a machine's current state via the typed
 * request/reply protocol but must NOT be able to send commands or
 * publish events. `MachineExecute` is the narrow Tag that exposes only
 * the read path (`execute<M>`); writes (`send`/`publish`/`terminateAll`)
 * live on `MachineEngine`, the substrate's wide write surface.
 *
 * B11.4 brands `MachineExecute` with the `ReadOnly` tag so projection
 * R-channels enforce read-only at the type level — `MachineEngine`
 * exposes `send` + `publish` and can't honestly carry the brand.
 *
 * Until B11.3d renames the underlying `MachineEngine.ask` method to
 * `execute`, this Tag's `execute` simply delegates to `engine.ask` —
 * the public surface name is what matters; the internal name flips in
 * the same commit that renames `extension.ask` → `extension.execute`.
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
import { MachineEngine, type MachineEngineService } from "./resource-host/machine-engine.js"

export interface MachineExecuteService {
  readonly execute: <M extends AnyExtensionRequestMessage>(
    sessionId: SessionId,
    message: M,
    branchId?: BranchId,
  ) => Effect.Effect<ExtractExtensionReply<M>, ExtensionProtocolError>
}

export class MachineExecute extends Context.Service<MachineExecute, MachineExecuteService>()(
  "@gent/core/src/runtime/extensions/machine-execute/MachineExecute",
) {
  /**
   * Live layer — projects `MachineEngine.ask` onto the read-only
   * `execute` surface. Requires `MachineEngine` (provided alongside
   * by callers — see `runtime/profile.ts`).
   *
   * The `ask`→`execute` rename on `MachineEngine` lands in B11.3d.
   */
  static Live: Layer.Layer<MachineExecute, never, MachineEngine> = Layer.effect(
    MachineExecute,
    Effect.gen(function* () {
      const engine: MachineEngineService = yield* MachineEngine
      return {
        execute: (sessionId, message, branchId) => engine.ask(sessionId, message, branchId),
      }
    }),
  )
}
