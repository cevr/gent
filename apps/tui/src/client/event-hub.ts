import type { EventEnvelope } from "@gent/core-internal/domain/event.js"
import type { BranchId, SessionId } from "@gent/core-internal/domain/ids.js"
import type { ClientLog } from "../utils/client-logger"

export type ExtensionStatePulse = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly extensionId: string
}

export type ExtensionPulseCallback = (pulse: ExtensionStatePulse) => void
export type SessionEventCallback = (envelope: EventEnvelope) => void

const decodeError = Schema.decodeUnknownOption(Schema.instanceOf(Error))
type ThrownInput = Parameters<typeof decodeError>[0]

const formatThrown = (error: ThrownInput): string =>
  Option.match(decodeError(error), {
    onNone: () => String(error),
    onSome: (cause) => cause.message,
  })

export const createClientEventHub = (log: ClientLog) => {
  const extensionStateChangedSubscribers = new Set<ExtensionPulseCallback>()
  const sessionEventSubscribers = new Set<SessionEventCallback>()

  const onExtensionStateChanged = (cb: ExtensionPulseCallback): (() => void) => {
    extensionStateChangedSubscribers.add(cb)
    return () => {
      extensionStateChangedSubscribers.delete(cb)
    }
  }

  const onSessionEvent = (cb: SessionEventCallback): (() => void) => {
    sessionEventSubscribers.add(cb)
    return () => {
      sessionEventSubscribers.delete(cb)
    }
  }

  const notifyExtensionStateChanged = (event: EventEnvelope["event"]): void => {
    if (event._tag !== "ExtensionStateChanged") return
    if (extensionStateChangedSubscribers.size === 0) return
    const pulse = {
      sessionId: event.sessionId,
      branchId: event.branchId,
      extensionId: event.extensionId,
    }
    for (const cb of extensionStateChangedSubscribers) {
      const exit = Effect.runSyncExit(Effect.sync(() => cb(pulse)))
      if (Exit.isFailure(exit)) {
        log.warn("client.extensionStateChanged.subscriber.threw", {
          extensionId: event.extensionId,
          error: formatThrown(Cause.squash(exit.cause)),
        })
      }
    }
  }

  const notifySessionEvent = (envelope: EventEnvelope): void => {
    if (sessionEventSubscribers.size === 0) return
    for (const cb of sessionEventSubscribers) {
      const exit = Effect.runSyncExit(Effect.sync(() => cb(envelope)))
      if (Exit.isFailure(exit)) {
        log.warn("client.sessionEvent.subscriber.threw", {
          tag: envelope.event._tag,
          error: formatThrown(Cause.squash(exit.cause)),
        })
      }
    }
  }

  return {
    onExtensionStateChanged,
    onSessionEvent,
    notifyExtensionStateChanged,
    notifySessionEvent,
  }
}
import { Cause, Effect, Exit, Option, Schema } from "effect"
