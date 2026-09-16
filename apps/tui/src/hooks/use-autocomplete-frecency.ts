/**
 * The live pick history behind the composer's autocomplete ranking.
 *
 * One store serves every prefix and every session. The value lives in
 * `autocomplete-frecency-store.ts` rather than here, because two surfaces
 * record picks — this hook for `/` commands, and the `$` skills extension —
 * and a cache owned by one of them goes stale the moment the other writes.
 * That is not hypothetical: it is the bug this hook used to have. A snapshot
 * loaded once and never refreshed was serialized back over the file on every
 * `/` pick, erasing whatever `$` had written in between.
 *
 * So this hook keeps no store of its own. It reads the shared snapshot for
 * ranking and delegates every write to `recordFrecencyPick`, which folds the
 * pick into what is actually on disk under a single-permit gate.
 *
 * Ranking stays synchronous. It runs inside the popup's resource callback,
 * which cannot await a file read while the reader is typing, so it reads the
 * snapshot as a plain map lookup. Until the first load lands the lookup
 * answers zero, which is the same thing it answers for a reader with no
 * history: the popup ranks by match quality and nothing waits.
 *
 * Writes never block the keystroke path either. `cast` forks the write onto
 * the client runtime and returns immediately, and the Solid signal is bumped
 * when the write lands so the next keystroke ranks with the new pick.
 */

import { createSignal } from "solid-js"
import { DateTime, Effect, Option } from "effect"
import { frecencyLookup, type FrecencyLookup } from "../components/autocomplete-frecency"
import {
  clearFrecencyStore,
  frecencySnapshot,
  readFrecencyStore,
  recordFrecencyPick,
  setFrecencySnapshot,
} from "../components/autocomplete-frecency-store"
import { useWorkspace } from "../workspace/context"
import { useRuntime } from "./use-runtime"

/** Wall-clock millis, in the house style for a Solid callback outside Effect. */
const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

export interface AutocompleteFrecency {
  /** The reader's decayed pick weights, fixed at the moment of the call. */
  readonly lookup: () => FrecencyLookup
  /** Records that the reader chose `id` from the `prefix` popup. */
  readonly record: (prefix: string, id: string) => void
  /** Forgets every pick, so ranking falls back to match quality alone. */
  readonly reset: () => void
}

/**
 * Tracks that the shared snapshot changed, so Solid re-runs a ranking that
 * read it. The counter is the reactive handle; the value itself lives in the
 * store module, which is the only thing both writers can reach.
 */
type FrecencyStoreCell = {
  revision: ReturnType<typeof createSignal<number>>[0]
  bump: ReturnType<typeof createSignal<number>>[1]
  loaded: boolean
}

let singleton: Option.Option<FrecencyStoreCell> = Option.none()

const getCell = (): FrecencyStoreCell => {
  if (Option.isSome(singleton)) return singleton.value
  const [revision, bump] = createSignal<number>(0)
  const cell: FrecencyStoreCell = { revision, bump, loaded: false }
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
          setFrecencySnapshot(loaded.value)
          cell.bump((value) => value + 1)
        }),
      ),
    )
  }

  return {
    lookup: () => {
      cell.revision()
      return frecencyLookup(frecencySnapshot(), currentMillis())
    },
    record: (prefix: string, id: string) => {
      cast(
        Effect.tap(recordFrecencyPick(workspace.home, prefix, id, currentMillis()), () =>
          Effect.sync(() => {
            cell.bump((value) => value + 1)
          }),
        ),
      )
    },
    reset: () => {
      cast(
        Effect.tap(clearFrecencyStore(workspace.home), () =>
          Effect.sync(() => {
            cell.bump((value) => value + 1)
          }),
        ),
      )
    },
  }
}
