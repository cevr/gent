/**
 * The live pick history behind the composer's autocomplete ranking.
 *
 * One store serves every prefix and every session, so it is a module
 * singleton in the shape `use-prompt-history.ts` already established: a Solid
 * signal holding the loaded value, filled once on first use and written back
 * on every pick.
 *
 * The signal matters for more than caching. Ranking runs inside the popup's
 * resource callback, which is synchronous with respect to the store — it
 * cannot await a file read while the reader is typing. So the store is read
 * once into memory, and every rank afterwards is a map lookup. Until that read
 * lands the lookup answers zero, which is the same thing it answers for a
 * reader with no history: the popup ranks by match quality and nothing waits.
 *
 * Writes never block the keystroke path either. `cast` forks the write onto
 * the client runtime and returns immediately; the in-memory signal is updated
 * first, so the next keystroke already ranks with the new pick whether or not
 * the file has been written yet.
 */

import { createSignal } from "solid-js"
import { DateTime, Effect, Option } from "effect"
import {
  emptyFrecencyStore,
  frecencyLookup,
  recordPick,
  type FrecencyLookup,
  type FrecencyStoreValue,
} from "../components/autocomplete-frecency"
import { readFrecencyStore, writeFrecencyStore } from "../components/autocomplete-frecency-store"
import { useWorkspace } from "../workspace/context"
import { useRuntime } from "./use-runtime"

/** Wall-clock millis, in the house style for a Solid callback outside Effect. */
const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

export interface AutocompleteFrecency {
  /** The reader's decayed pick weights, fixed at the moment of the call. */
  readonly lookup: () => FrecencyLookup
  /** Records that the reader chose `id` from the `prefix` popup. */
  readonly record: (prefix: string, id: string) => void
}

type FrecencyStoreCell = {
  store: ReturnType<typeof createSignal<FrecencyStoreValue>>[0]
  setStore: ReturnType<typeof createSignal<FrecencyStoreValue>>[1]
  loaded: boolean
}

let singleton: Option.Option<FrecencyStoreCell> = Option.none()

const getCell = (): FrecencyStoreCell => {
  if (Option.isSome(singleton)) return singleton.value
  const [store, setStore] = createSignal<FrecencyStoreValue>(emptyFrecencyStore())
  const cell: FrecencyStoreCell = { store, setStore, loaded: false }
  singleton = Option.some(cell)
  return cell
}

export function useAutocompleteFrecency(): AutocompleteFrecency {
  const cell = getCell()
  const workspace = useWorkspace()
  const { cast } = useRuntime()

  if (!cell.loaded) {
    cell.loaded = true
    cast(
      Effect.tap(readFrecencyStore(workspace.home), (loaded) =>
        Effect.sync(() => {
          if (Option.isNone(loaded)) return
          cell.setStore(loaded.value)
        }),
      ),
    )
  }

  return {
    lookup: () => frecencyLookup(cell.store(), currentMillis()),
    record: (prefix: string, id: string) => {
      const next = recordPick(cell.store(), prefix, id, currentMillis())
      cell.setStore(next)
      cast(writeFrecencyStore(workspace.home, next))
    },
  }
}
