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
  // Seed auth gate key from current route/agent so sessionAuthPending() starts false.
  // Bootstrap already resolved auth — no need to wait for the first RPC round-trip.
  const initialAuthGateKey = (() => {
    const routeTag = router.route()._tag
    if (props.debugMode || (routeTag !== "session" && routeTag !== "auth")) return null
    return `${routeTag}:${client.agent() ?? "pending"}`
  })()
  const [authGateKey, setAuthGateKey] = createSignal<string | null>(initialAuthGateKey)
  let authGateVersion = 0

  const desiredAuthGateKey = (
    routeTag: AppRoute["_tag"] = router.route()._tag,
    agentName = client.agent(),
  ): string | null => {
    if (props.debugMode || (routeTag !== "session" && routeTag !== "auth")) return null
    return `${routeTag}:${agentName ?? "pending"}`
  }

  const refreshAuthGate = (
    agentName = client.agent(),
    routeTag: AppRoute["_tag"] = router.route()._tag,
  ) => {
    const key = desiredAuthGateKey(routeTag, agentName)
    if (props.debugMode || routeTag === "branchPicker") {
      authGateVersion += 1
      setAuthGateKey(key)
      setAuthGateState("closed")
      return
    }

    if (agentName === undefined) {
      authGateVersion += 1
      setAuthGateKey(key)
      setAuthGateState("closed")
      return
    }

    const version = ++authGateVersion
    setAuthGateKey(key)
    setAuthGateState("checking")
    client.runtime.cast(
      client.client.auth
        .listProviders({
          ...(agentName !== undefined ? { agentName } : {}),
        })
        .pipe(
          Effect.tap((providers) =>
            Effect.sync(() => {
              if (version !== authGateVersion) return
              setAuthGateState(
                providers.some((provider) => provider.required && !provider.hasKey)
                  ? "open"
                  : "closed",
              )
            }),
          ),
          Effect.catchEager((error) =>
            Effect.sync(() => {
              if (version !== authGateVersion) return
              setAuthGateState("closed")
              client.log.error("app:auth-gate", { error: String(error), agentName })
            }),
          ),
        ),
    )
  }

  createEffect(
    on(
      () => [client.agent(), router.route()._tag] as const,
      ([agentName, routeTag]) => {
        refreshAuthGate(agentName, routeTag)
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
    (desiredAuthGateKey() !== authGateKey() || authGateState() === "checking")

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
          <Permissions client={client.client} runtime={client.runtime} log={client.log} />
        </Match>
        <Match when={isRoute.auth(router.route())}>
          <Auth
            client={client.client}
            runtime={client.runtime}
            log={client.log}
            agentName={client.agent()}
            enforceAuth={authGateState() === "open"}
            onResolved={() => {
              setAuthGateState("closed")
              refreshAuthGate()
            }}
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
