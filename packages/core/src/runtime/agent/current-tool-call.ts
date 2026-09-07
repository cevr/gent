import { Context } from "effect"
import type { OwnedToolCallAddress } from "../../storage/sqlite/owned-tool-call.js"
import type { ResolvedToolCapability } from "./tool-runner.js"

/** Set by transcript dispatch. Model input and worker frames cannot select this address. */
export class CurrentToolCall extends Context.Service<
  CurrentToolCall,
  OwnedToolCallAddress & {
    readonly toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  }
>()("@gent/core/src/runtime/agent/current-tool-call/CurrentToolCall") {}
