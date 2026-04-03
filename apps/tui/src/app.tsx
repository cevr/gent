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

export interface AppProps {
  missingAuthProviders?: readonly string[]
  debugMode?: boolean
}

function AppContent(props: AppProps) {
  const router = useRouter()
  const client = useClient()
  const [authGateActive, setAuthGateActive] = createSignal(
    !props.debugMode && (props.missingAuthProviders?.length ?? 0) > 0,
  )
  let authGateVersion = 0

  const refreshAuthGate = (agentName = client.agent()) => {
    if (props.debugMode) {
      authGateVersion += 1
      setAuthGateActive(false)
      return
    }

    const version = ++authGateVersion
    client.runtime.cast(
      client.client.auth
        .listProviders({
          ...(agentName !== undefined ? { agentName } : {}),
        })
        .pipe(
          Effect.tap((providers) =>
            Effect.sync(() => {
              if (version !== authGateVersion) return
              setAuthGateActive(providers.some((provider) => provider.required && !provider.hasKey))
            }),
          ),
          Effect.catchEager((error) =>
            Effect.sync(() => {
              if (version !== authGateVersion) return
              client.log.error("app:auth-gate", { error: String(error), agentName })
            }),
          ),
        ),
    )
  }

  createEffect(
    on(
      () => client.agent(),
      (agentName) => {
        refreshAuthGate(agentName)
      },
      { defer: false },
    ),
  )

  createEffect(() => {
    if (authGateActive() && !isRoute.auth(router.route())) {
      router.navigateToAuth()
    }
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Switch>
        <Match when={isRoute.session(router.route()) ? (router.route() as SessionRoute) : false}>
          {(r) => {
            const route = r()
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
            enforceAuth={authGateActive()}
            onResolved={() => {
              setAuthGateActive(false)
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
