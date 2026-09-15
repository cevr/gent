import { plural } from "./message-list-utils"
import { formatDuration } from "../utils/format-duration"
import { DateTime } from "effect"

/** What the model steps of one turn added up to, from each `StreamEnded.outcome`. */
export type TurnSteps = {
  readonly count: number
  readonly toolCalls: number
  readonly costUsd: number
}

export const emptyTurnSteps: TurnSteps = { count: 0, toolCalls: 0, costUsd: 0 }

export const addStep = (
  steps: TurnSteps,
  step: { readonly outcome?: string; readonly costUsd?: number },
): TurnSteps => ({
  count: steps.count + 1,
  toolCalls: steps.toolCalls + Number(step.outcome === "ToolCalls"),
  costUsd: steps.costUsd + (step.costUsd ?? 0),
})

export type SessionEvent =
  | {
      _tag: "turn-ended"
      durationSeconds: number
      steps: TurnSteps
      createdAt: number
      seq: number
    }
  | {
      _tag: "interruption"
      createdAt: number
      seq: number
    }
  | {
      _tag: "error"
      error: string
      createdAt: number
      seq: number
    }
  | {
      _tag: "retrying"
      attempt: number
      maxAttempts: number
      delayMs: number
      resolved: boolean
      createdAt: number
      seq: number
    }

const currentMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

/** "3 steps · 2 tool calls · $0.012"; a turn with no recorded steps says nothing extra. */
const stepSummary = (steps: TurnSteps): ReadonlyArray<string> => {
  if (steps.count === 0) return []
  const parts = [plural(steps.count, "step")]
  if (steps.toolCalls > 0) parts.push(plural(steps.toolCalls, "tool call"))
  if (steps.costUsd > 0) parts.push(`$${steps.costUsd.toFixed(3)}`)
  return parts
}

export const getSessionEventLabel = (event: SessionEvent, now = currentMillis()): string => {
  if (event._tag === "turn-ended") {
    return [
      `Worked for ${formatDuration(event.durationSeconds * 1000, "compact")}`,
      ...stepSummary(event.steps),
    ].join(" · ")
  }
  if (event._tag === "interruption") return "Interrupted - what do you want to do instead?"
  if (event._tag === "error") return event.error
  if (event.resolved) return `Retry ${event.attempt}/${event.maxAttempts} finished`

  const retryAt = event.createdAt + event.delayMs
  const remainingMs = Math.max(0, retryAt - now)
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds <= 0) {
    return `Retrying now... ${event.attempt}/${event.maxAttempts}`
  }
  return `Retrying in ${seconds}s... ${event.attempt}/${event.maxAttempts}`
}
