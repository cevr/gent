/** Runtime marker for the extension actor host. Actor communication is exposed
 * through `ExtensionHostContext.actors`, not through extension-message routing.
 *
 * @module
 */

import { Context, Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import { ActorEngine } from "../actor-engine.js"
import type { Receptionist } from "../receptionist.js"

export interface ExtensionRuntimeService {}

export class ExtensionRuntime extends Context.Service<ExtensionRuntime, ExtensionRuntimeService>()(
  "@gent/core/src/runtime/extensions/resource-host/extension-runtime/ExtensionRuntime",
) {
  static fromExtensions = (
    _extensions: ReadonlyArray<LoadedExtension>,
  ): Layer.Layer<ExtensionRuntime> => Layer.succeed(ExtensionRuntime, {})

  static Live = (extensions: ReadonlyArray<LoadedExtension>): Layer.Layer<ExtensionRuntime> =>
    ExtensionRuntime.fromExtensions(extensions)

  // Test variant keeps the historical helper behavior: many tests use
  // `ExtensionRuntime.Test()` as the compact layer for actor runtime services.
  static Test = (): Layer.Layer<ExtensionRuntime | ActorEngine | Receptionist> =>
    ExtensionRuntime.fromExtensions([]).pipe(Layer.provideMerge(ActorEngine.Live))
}
