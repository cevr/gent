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
 * which Solid runs under `untrack`, so nothing read there can make the popup
 * re-rank. The lookup is therefore a plain map read of the shared snapshot,
 * re-done on the next keystroke, which is when a new ranking is wanted anyway.
 * Until the first load lands it answers zero, which is the same thing it
 * answers for a reader with no history: the popup ranks by match quality and
 * nothing waits.
 *
 * Writes never block the keystroke path either. `cast` forks the write onto
 * the client runtime and returns immediately.
 */

import { DateTime, Effect, Option } from "effect"
import {
  clearFrecencyStore,
  frecencyLookup,
  type FrecencyLookup,
  frecencySnapshot,
  readFrecencyStore,
  recordFrecencyPick,
  setFrecencySnapshot,
} from "../autocomplete"
import { useWorkspace } from "../workspace"
import { useRuntime } from "./use-runtime"

/** Wall-clock millis, in the house style for a Solid callback outside Effect. */
const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

interface AutocompleteFrecency {
  /** The reader's decayed pick weights, fixed at the moment of the call. */
  readonly lookup: () => FrecencyLookup
  /** Records that the reader chose `id` from the `prefix` popup. */
  readonly record: (prefix: string, id: string) => void
  /** Forgets every pick, so ranking falls back to match quality alone. */
  readonly reset: () => void
}

/** Whether the store has been read from disk yet, once per process. */
let loaded = false

export function useAutocompleteFrecency(): AutocompleteFrecency {
  const workspace = useWorkspace()
  const { cast } = useRuntime()

  if (!loaded) {
    loaded = true
    cast(
      Effect.tap(readFrecencyStore(workspace.home), (snapshot) =>
        Effect.sync(() => {
          if (Option.isNone(snapshot)) return
          setFrecencySnapshot(snapshot.value)
        }),
      ),
    )
  }

  return {
    lookup: () => frecencyLookup(frecencySnapshot(), currentMillis()),
    record: (prefix: string, id: string) => {
      cast(recordFrecencyPick(workspace.home, prefix, id, currentMillis()))
    },
    reset: () => {
      cast(clearFrecencyStore(workspace.home))
    },
  }
}
