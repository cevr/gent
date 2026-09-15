/**
 * Wire shapes shared by the wake extension and its TUI tray: the pending
 * entries a branch holds and the request that lists them.
 */
import { Schema } from "effect"
import { ExtensionId } from "@gent/core/extensions/api"

export const WAKE_EXTENSION_ID = ExtensionId.make("@gent/wake")
/** `metadata.customType` on the user-role message an entry queues when it fires. */
export const WAKE_MESSAGE_TYPE = "wake"

/**
 * One pending wake. An alarm fires at a time; a monitor runs a command on an
 * interval and fires when it succeeds, its output matches `until`, or the
 * deadline passes.
 */
export const WakeEntry = Schema.TaggedUnion({
  alarm: { wakeId: Schema.String, dueAt: Schema.Finite, note: Schema.String },
  monitor: {
    wakeId: Schema.String,
    command: Schema.String,
    cwd: Schema.optionalKey(Schema.String),
    everySeconds: Schema.Finite,
    until: Schema.optionalKey(Schema.String),
    deadline: Schema.Finite,
    note: Schema.String,
  },
})
export type WakeEntry = typeof WakeEntry.Type

/** What the tray shows: the entries still pending on the current branch, and the clock they count against. */
export const WakePending = Schema.Struct({
  now: Schema.Finite,
  entries: Schema.Array(WakeEntry),
})
export type WakePending = typeof WakePending.Type

/** `details` on a fired wake message; the transcript collapses the row to `kind` and `note`. */
export const WakeDetails = Schema.Struct({
  kind: Schema.Literals(["alarm", "monitor"]),
  outcome: Schema.Literals(["fired", "matched", "timed-out"]),
  note: Schema.String,
})
export type WakeDetails = typeof WakeDetails.Type
