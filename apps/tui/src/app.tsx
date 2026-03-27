import { Switch, Match, ErrorBoundary, createEffect, createSignal } from "solid-js"
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
          <Permissions client={client.client} runtime={client.runtime} />
        </Match>
        <Match when={isRoute.auth(router.route())}>
          <Auth
            client={client.client}
            runtime={client.runtime}
            enforceAuth={authGateActive()}
            onResolved={() => setAuthGateActive(false)}
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
