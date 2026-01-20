import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Effect, Stream, Runtime } from "effect"
import type { AgentEvent } from "@gent/core"
import type { GentRpcClient, MessageInfoReadonly } from "../client"
import type { SessionState, Session, SessionInfo, BranchInfo, ClientContextValue } from "./types"

const ClientContext = createContext<ClientContextValue>()

export function useClient(): ClientContextValue {
  const ctx = useContext(ClientContext)
  if (!ctx) throw new Error("useClient must be used within ClientProvider")
  return ctx
}

interface ClientProviderProps extends ParentProps {
  rpcClient: GentRpcClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime context unused by RPC calls
  runtime: Runtime.Runtime<any>
  initialSession: Session | undefined
}

export function ClientProvider(props: ClientProviderProps) {
  const [state, setState] = createStore<{ sessionState: SessionState }>({
    sessionState: props.initialSession
      ? { status: "active", session: props.initialSession }
      : { status: "none" },
  })

  const run = <T,>(effect: Effect.Effect<T, unknown, never>) =>
    Runtime.runPromise(props.runtime)(effect)

  // Derived accessors
  const session = () => {
    const s = state.sessionState
    return s.status === "active" ? s.session : null
  }

  const isActive = () => state.sessionState.status === "active"
  const isLoading = () => state.sessionState.status === "loading"

  const value: ClientContextValue = {
    sessionState: () => state.sessionState,
    session,
    isActive,
    isLoading,

    sendMessage: async (content, mode) => {
      // Create session on first message if none exists
      if (state.sessionState.status === "none") {
        setState({ sessionState: { status: "loading", creating: true } })
        const result = await run(props.rpcClient.createSession({ firstMessage: content }))
        const newSession: Session = {
          sessionId: result.sessionId,
          branchId: result.branchId,
          name: result.name,
        }
        setState({ sessionState: { status: "active", session: newSession } })
      }

      const s = session()
      if (!s) throw new Error("No active session")

      await run(
        props.rpcClient.sendMessage({
          sessionId: s.sessionId,
          branchId: s.branchId,
          content,
          ...(mode !== undefined ? { mode } : {}),
        }),
      )
    },

    createSession: async (firstMessage) => {
      setState({ sessionState: { status: "loading", creating: true } })
      const result = await run(
        props.rpcClient.createSession(firstMessage !== undefined ? { firstMessage } : {}),
      )
      setState({
        sessionState: {
          status: "active",
          session: {
            sessionId: result.sessionId,
            branchId: result.branchId,
            name: result.name,
          },
        },
      })
    },

    switchSession: async (sessionId, branchId, name) => {
      const current = session()
      if (current) {
        setState({
          sessionState: { status: "switching", fromSession: current, toSessionId: sessionId },
        })
      } else {
        setState({ sessionState: { status: "loading", creating: false } })
      }

      // Switch to new session
      setState({
        sessionState: { status: "active", session: { sessionId, branchId, name } },
      })
    },

    clearSession: () => {
      setState({ sessionState: { status: "none" } })
    },

    listMessages: async () => {
      const s = session()
      if (!s) return []
      return run(props.rpcClient.listMessages({ branchId: s.branchId })) as Promise<
        readonly MessageInfoReadonly[]
      >
    },

    listSessions: async () => {
      const result = await run(props.rpcClient.listSessions())
      return result as unknown as readonly SessionInfo[]
    },

    listBranches: async () => {
      const s = session()
      if (!s) return []
      const result = await run(props.rpcClient.listBranches({ sessionId: s.sessionId }))
      return result as unknown as readonly BranchInfo[]
    },

    createBranch: async (name) => {
      const s = session()
      if (!s) throw new Error("No active session")
      const result = await run(
        props.rpcClient.createBranch({
          sessionId: s.sessionId,
          ...(name !== undefined ? { name } : {}),
        }),
      )
      return result.branchId
    },

    subscribeEvents: (onEvent) => {
      let cancelled = false
      const s = session()
      if (!s) return () => {}

      const events = props.rpcClient.subscribeEvents({ sessionId: s.sessionId })
      void run(
        Stream.runForEach(events, (e: AgentEvent) =>
          Effect.sync(() => {
            if (cancelled) return

            // Handle session name update internally
            if (e._tag === "SessionNameUpdated" && e.sessionId === s.sessionId) {
              setState(
                produce((draft) => {
                  if (draft.sessionState.status === "active") {
                    draft.sessionState.session.name = e.name
                  }
                }),
              )
            }

            onEvent(e)
          }),
        ),
      )
      return () => {
        cancelled = true
      }
    },

    steer: (command) => run(props.rpcClient.steer({ command })),
  }

  return <ClientContext.Provider value={value}>{props.children}</ClientContext.Provider>
}
