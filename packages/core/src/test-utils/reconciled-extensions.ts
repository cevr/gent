import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import type { FailedExtension, LoadedExtension } from "../domain/extension.js"
import { reconcileLoadedExtensions } from "../runtime/extensions/activation.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { DriverRegistry } from "../runtime/extensions/driver-registry.js"

const reconcileTestExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  home = "/tmp",
) =>
  reconcileLoadedExtensions({
    extensions,
    failedExtensions,
    home,
    command: undefined,
  }).pipe(Effect.map((result) => result.resolved))

export const testExtensionRegistryLayer = (
  extensions: ReadonlyArray<LoadedExtension>,
  failedExtensions: ReadonlyArray<FailedExtension> = [],
  home = "/tmp",
) =>
  Layer.unwrap(
    reconcileTestExtensions(extensions, failedExtensions, home).pipe(
      Effect.map((resolved) =>
        Layer.merge(
          ExtensionRegistry.fromResolved(resolved),
          DriverRegistry.fromResolved({
            modelDrivers: resolved.modelDrivers,
            externalDrivers: resolved.externalDrivers,
          }),
        ),
      ),
    ),
  ).pipe(Layer.provide(BunServices.layer))
