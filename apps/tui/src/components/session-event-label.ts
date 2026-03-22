import { formatThinkTime } from "./message-list-utils"

export type SessionEvent =
  | {
      _tag: "event"
      kind: "turn-ended"
      durationSeconds: number
      createdAt: number
      seq: number
    }
  | {
      _tag: "event"
      kind: "interruption"
      createdAt: number
      seq: number
    }
  | {
      _tag: "event"
      kind: "error"
      error: string
      createdAt: number
      seq: number
    }
  | {
      _tag: "event"
      kind: "retrying"
      attempt: number
      maxAttempts: number
      delayMs: number
      createdAt: number
      seq: number
    }

export const getSessionEventLabel = (event: SessionEvent, now = Date.now()): string => {
  switch (event.kind) {
    case "turn-ended":
      return `Worked for ${formatThinkTime(event.durationSeconds)}`
    case "interruption":
      return "Interrupted - what do you want to do instead?"
    case "retrying": {
      const retryAt = event.createdAt + event.delayMs
      const remainingMs = Math.max(0, retryAt - now)
      const seconds = Math.ceil(remainingMs / 1000)
      if (seconds <= 0) {
        return `Retrying now... ${event.attempt}/${event.maxAttempts}`
      }
      return `Retrying in ${seconds}s... ${event.attempt}/${event.maxAttempts}`
    }
    case "error":
      return event.error
  }
}
