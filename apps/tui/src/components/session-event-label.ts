import { formatThinkTime } from "./message-list-utils"
import { DateTime } from "effect"

export type SessionEvent =
  | {
      _tag: "turn-ended"
      durationSeconds: number
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

export const getSessionEventLabel = (event: SessionEvent, now = currentMillis()): string => {
  if (event._tag === "turn-ended") {
    return `Worked for ${formatThinkTime(event.durationSeconds)}`
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
