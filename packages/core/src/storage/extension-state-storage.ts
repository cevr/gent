/**
 * ExtensionStateStorage — focused service for extension actor state persistence.
 *
 * Split from the `Storage` god-interface (B11.7).
 */

import type { Effect } from "effect"
import { Context, Layer } from "effect"
import type { ExtensionId, SessionId } from "../domain/ids.js"
import type { StorageError } from "./sqlite-storage.js"

export interface ExtensionStateStorageService {
  readonly saveExtensionState: (params: {
    sessionId: SessionId
    extensionId: ExtensionId
    stateJson: string
    version: number
  }) => Effect.Effect<void, StorageError>
  readonly loadExtensionState: (params: {
    sessionId: SessionId
    extensionId: ExtensionId
  }) => Effect.Effect<{ stateJson: string; version: number } | undefined, StorageError>
}

export class ExtensionStateStorage extends Context.Service<
  ExtensionStateStorage,
  ExtensionStateStorageService
>()("@gent/core/src/storage/extension-state-storage/ExtensionStateStorage") {
  static fromStorage = (s: ExtensionStateStorageService): Layer.Layer<ExtensionStateStorage> =>
    Layer.succeed(ExtensionStateStorage, s)
}
