/** Runtime marker for the extension actor host. Actor communication is exposed
 * through `ExtensionHostContext.actors`, not through extension-message routing.
 *
 * @module
 */

import { Context, Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import { ActorEngine } from "../actor-engine.js"
import type { Receptionist } from "../receptionist.js"

export interface ActorRouterService {}

export class ActorRouter extends Context.Service<ActorRouter, ActorRouterService>()(
  "@gent/core/src/runtime/extensions/resource-host/actor-router/ActorRouter",
) {
  static fromExtensions = (_extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ActorRouter> =>
    Layer.succeed(ActorRouter, {})

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ActorRouter> =>
    ActorRouter.fromExtensions(extensions)

  // Test variant keeps the historical helper behavior: many tests use
  // `ActorRouter.Test()` as the compact layer for actor runtime services.
  static Test = (): Layer.Layer<ActorRouter | ActorEngine | Receptionist> =>
    ActorRouter.fromExtensions([]).pipe(Layer.provideMerge(ActorEngine.Live))
}
