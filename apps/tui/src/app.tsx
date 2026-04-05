import { Effect } from "effect"
import { Switch, Match, ErrorBoundary, createEffect, createSignal, on } from "solid-js"
import { CommandPalette } from "./components/command-palette"
import { ThemeProvider } from "./theme/index"
import { CommandProvider } from "./command/index"
import { useRouter, isRoute, type AppRoute } from "./router/index"
import { useClient } from "./client/index"
import { Session } from "./routes/session"
import { BranchPicker } from "./routes/branch-picker"
import { Permissions } from "./routes/permissions"
import { Auth } from "./routes/auth"
import { KeyboardScopeProvider } from "./keyboard/context"

type SessionRoute = Extract<AppRoute, { _tag: "session" }>
type BranchPickerRoute = Extract<AppRoute, { _tag: "branchPicker" }>
type AuthGateState = "checking" | "open" | "closed"

export interface AppProps {
  missingAuthProviders?: readonly string[]
  debugMode?: boolean
}

function AppContent(props: AppProps) {
  const router = useRouter()
  const client = useClient()
  const [authGateState, setAuthGateState] = createSignal<AuthGateState>(
    !props.debugMode && (props.missingAuthProviders?.length ?? 0) > 0 ? "open" : "closed",
  )
  // Track which agent was last validated so sessionAuthPending can detect unvalidated state
  const [validatedAgent, setValidatedAgent] = createSignal<string | undefined>(
    // Bootstrap already validated the initial agent
    client.agent(),
  )

  // Re-check auth when agent or route changes (startup already resolved initial state).
  // Version counter discards stale RPC results when agent/route changes mid-flight.
  let authCheckVersion = 0
  createEffect(
    on(
      () => [client.agent(), router.route()._tag] as const,
      ([agentName, routeTag]) => {
        if (props.debugMode || agentName === undefined) return
        if (routeTag === "branchPicker") {
          authCheckVersion += 1
          setAuthGateState("closed")
          return
        }
        const version = ++authCheckVersion
        setAuthGateState("checking")
        client.runtime.cast(
          client.client.auth.listProviders({ agentName }).pipe(
            Effect.tap((providers) =>
              Effect.sync(() => {
                if (version !== authCheckVersion) return
                setValidatedAgent(agentName)
                setAuthGateState(providers.some((p) => p.required && !p.hasKey) ? "open" : "closed")
              }),
            ),
            Effect.catchEager(() =>
              Effect.sync(() => {
                if (version !== authCheckVersion) return
                setValidatedAgent(agentName)
                setAuthGateState("closed")
              }),
            ),
          ),
        )
      },
      { defer: false },
    ),
  )

  createEffect(() => {
    if (authGateState() === "open" && !isRoute.auth(router.route())) {
      router.navigateToAuth()
    }
  })

  const sessionAuthPending = () =>
    !props.debugMode &&
    isRoute.session(router.route()) &&
    (authGateState() !== "closed" || validatedAgent() !== client.agent())

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Switch>
        <Match when={isRoute.session(router.route()) ? (router.route() as SessionRoute) : false}>
          {(r) => {
            const route = r()
            if (sessionAuthPending()) {
              return (
                <box flexDirection="column" paddingLeft={1} paddingTop={1}>
                  <text>Loading session…</text>
                </box>
              )
            }
            return (
              <Session
                sessionId={route.sessionId}
                branchId={route.branchId}
                initialPrompt={route.prompt}
                debugMode={props.debugMode}
              />
            )
          }}
        </Match>
        <Match
          when={
            isRoute.branchPicker(router.route()) ? (router.route() as BranchPickerRoute) : false
          }
        >
          {(r) => {
            const route = r()
            return (
              <BranchPicker
                sessionId={route.sessionId}
                sessionName={route.sessionName}
                branches={route.branches}
                prompt={route.prompt}
              />
            )
          }}
        </Match>
        <Match when={isRoute.permissions(router.route())}>
          <Permissions />
        </Match>
        <Match when={isRoute.auth(router.route())}>
          <Auth
            enforceAuth={authGateState() === "open"}
            onResolved={() => setAuthGateState("closed")}
          />
        </Match>
      </Switch>

      {/* Command Palette */}
      <CommandPalette />
    </box>
  )
}

export function App(props: AppProps) {
  return (
    <ErrorBoundary
      fallback={(err) => (
        <box flexDirection="column" paddingLeft={1} paddingTop={1}>
          <text>
            <span style={{ fg: "red", bold: true }}>Fatal error</span>
          </text>
          <text>{err instanceof Error ? err.message : String(err)}</text>
        </box>
      )}
    >
      <ThemeProvider mode={undefined}>
        <KeyboardScopeProvider>
          <CommandProvider>
            <AppContent {...props} />
          </CommandProvider>
        </KeyboardScopeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
