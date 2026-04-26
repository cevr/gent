/**
 * Resource service/lifecycle assembly.
 *
 * Keeps heterogeneous Resource layer erasure and lifecycle finalizer policy out
 * of the resource-host facade. Machine, subscription, and schedule collectors
 * own their own protocols; this module owns only service layers plus start/stop.
 *
 * @module
 */

import { Effect, Exit, Layer } from "effect"
import type { LoadedExtension } from "../../../domain/extension.js"
import type { ExtensionId } from "../../../domain/ids.js"
import type { AnyResourceContribution, ResourceScope } from "../../../domain/resource.js"
import {
  emptyErasedResourceLayer,
  eraseResourceLayer,
  exitErasedEffect,
  type ErasedResourceLayer,
} from "../effect-membrane.js"

export interface ResourceEntry {
  readonly extensionId: ExtensionId
  readonly resource: AnyResourceContribution
}

export const collectResourceEntries = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope,
): ReadonlyArray<ResourceEntry> =>
  extensions.flatMap((ext) =>
    (ext.contributions.resources ?? [])
      .filter((resource) => resource.scope === scope)
      .map((resource) => ({ extensionId: ext.manifest.id, resource })),
  )

const mergeResourceServiceLayers = (entries: ReadonlyArray<ResourceEntry>): ErasedResourceLayer =>
  entries.reduce<ErasedResourceLayer>(
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — heterogeneous Resource layer enters the explicit eraseResourceLayer membrane.
    (acc, { resource }) => Layer.merge(acc, eraseResourceLayer(resource.layer)),
    emptyErasedResourceLayer,
  )

const buildLifecycleLayer = (entries: ReadonlyArray<ResourceEntry>): Layer.Layer<never> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const successfullyStarted: ResourceEntry[] = []
      for (const entry of entries) {
        const start = entry.resource.start
        if (start !== undefined) {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.
          const exit = yield* exitErasedEffect(() => start)
          if (Exit.isFailure(exit)) {
            yield* Effect.logError("resource.start.failed").pipe(
              Effect.annotateLogs({ extensionId: entry.extensionId, cause: String(exit.cause) }),
            )
            continue
          }
        }
        successfullyStarted.push(entry)
      }

      for (const { resource } of successfullyStarted) {
        const stop = resource.stop
        if (stop !== undefined) {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Resource lifecycle effects cross the explicit exitErasedEffect membrane.
          yield* Effect.addFinalizer(() => exitErasedEffect(() => stop).pipe(Effect.asVoid))
        }
      }
    }),
  )

export const buildResourceLayer = (
  extensions: ReadonlyArray<LoadedExtension>,
  scope: ResourceScope = "process",
): ErasedResourceLayer => {
  const entries = collectResourceEntries(extensions, scope)
  if (entries.length === 0) return emptyErasedResourceLayer

  const serviceLayers = mergeResourceServiceLayers(entries)
  const hasLifecycle = entries.some(
    ({ resource }) => resource.start !== undefined || resource.stop !== undefined,
  )
  if (!hasLifecycle) return serviceLayers

  return eraseResourceLayer(Layer.provideMerge(buildLifecycleLayer(entries), serviceLayers))
}
