/**
 * Session shell — what the TUI carries into the session it booted with.
 *
 * There used to be a router here: a reducer, a history stack, a subscriber
 * set, and two route tags. Only one of those tags ever changed at runtime.
 * The branch picker was never navigated to; the bootstrap built it once and
 * nothing pushed it again, so the history stack was always empty and `back`
 * always returned false.
 *
 * The fact the router was really carrying — which session and branch show —
 * belongs to `ClientProvider`, where `switchSession` writes it and `session()`
 * reads it. What is left over is the startup prompt.
 *
 * The prompt belongs to the session the startup flags named, on whichever
 * branch of it the reader ends up: picking a branch in the boot picker
 * re-mounts the session view, and the prompt has to survive that. A session
 * the reader opens afterwards is a different session and starts empty, so the
 * shell keys the prompt on the boot session's id rather than handing it to
 * whoever asks first.
 *
 * @module
 */

import { createContext, type ParentProps } from "solid-js"
import { Option } from "effect"
import type { SessionId } from "@gent/core/protocol"
import { useRequiredContext } from "./utils/solid-context"

/** One startup prompt, held by one send at a time. */
export interface StartupPrompt {
  readonly content: string
  /** The id of a send that failed. The next send uses it, so the prompt cannot run twice. */
  readonly requestId: Option.Option<string>
  /** Report the send's end. A failed send gives the prompt back to the shell. */
  readonly settle: (sent: boolean, requestId: string) => void
}

interface SessionShellValue {
  /**
   * The `-p` prompt, if this is the session the startup flags named and no
   * send holds it. A session view that mounts again gets nothing while a send
   * is in flight or after one landed.
   */
  readonly takePrompt: (sessionId: SessionId) => Option.Option<StartupPrompt>
}

const SessionShellContext = createContext<SessionShellValue>()

interface SessionShellProviderProps {
  readonly initialPrompt: Option.Option<string>
  /** The session the startup flags resolved to, if there was one. */
  readonly initialSessionId: Option.Option<SessionId>
}

export function SessionShellProvider(props: ParentProps<SessionShellProviderProps>) {
  let failedRequestId = Option.none<string>()
  let held = false
  const value: SessionShellValue = {
    takePrompt: (sessionId) => {
      const owns = Option.exists(props.initialSessionId, (boot) => boot === sessionId)
      if (!owns || held) return Option.none()
      return Option.map(props.initialPrompt, (content) => {
        held = true
        return {
          content,
          requestId: failedRequestId,
          settle: (sent, requestId) => {
            held = sent
            failedRequestId = Option.some(requestId)
          },
        }
      })
    },
  }

  return <SessionShellContext.Provider value={value}>{props.children}</SessionShellContext.Provider>
}

export function useSessionShell(): SessionShellValue {
  return useRequiredContext(
    SessionShellContext,
    "useSessionShell must be used within SessionShellProvider",
  )
}
