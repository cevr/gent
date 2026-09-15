/**
 * One client `ManagedRuntime` for every surface that loads client
 * extensions: the interactive shell, the headless runner, and tests.
 *
 * A surface supplies the transport, the workspace, and the `run`/`cast`
 * pair of its connected runtime. Shell UI callbacks, the activity
 * provider, and the lifecycle cleanup registry default to no-ops so a
 * surface without a UI (headless) does not restate them.
 */

import { Layer, ManagedRuntime, Option } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import type { ClientRuntime } from "./client-facets.js"
import { makeClientActivityLayer, type ClientActivitySnapshot } from "./client-activity"
import { makeClientTransportLayer, type ClientShellTransportDefinition } from "./client-transport"
import {
  type ClientLifecycleDefinition,
  type ClientShellDefinition,
  type ClientWorkspaceDefinition,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "./client-services"

export interface ClientRuntimeDeps {
  readonly transport: ClientShellTransportDefinition
  readonly workspace: ClientWorkspaceDefinition
  /** `run`/`cast` are required; every UI callback defaults to a no-op. */
  readonly shell: Pick<ClientShellDefinition, "run" | "cast"> &
    Partial<Omit<ClientShellDefinition, "run" | "cast">>
  /** Current UI activity; absent when the surface has no activity to report. */
  readonly activity?: () => ClientActivitySnapshot
  /** Cleanup registry; absent when the surface disposes the runtime whole. */
  readonly lifecycle?: Pick<ClientLifecycleDefinition, "addCleanup">
}

const noopShell: Omit<ClientShellDefinition, "run" | "cast"> = {
  sendMessage: () => {},
  openOverlay: () => {},
  closeOverlay: () => {},
  switchSession: () => {},
}

const noopLifecycle: Pick<ClientLifecycleDefinition, "addCleanup"> = { addCleanup: () => {} }

export const makeClientRuntime = (deps: ClientRuntimeDeps): ClientRuntime =>
  ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      makeClientActivityLayer(deps.activity),
      BunServices.layer,
      makeClientTransportLayer(deps.transport),
      makeClientWorkspaceLayer(deps.workspace),
      makeClientShellLayer({ ...noopShell, ...deps.shell }),
      makeClientLifecycleLayer(
        Option.getOrElse(Option.fromUndefinedOr(deps.lifecycle), () => noopLifecycle),
      ),
    ),
  )
