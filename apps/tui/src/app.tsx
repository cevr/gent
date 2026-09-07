import { Switch, Match, Show, ErrorBoundary } from "solid-js"
import { Option, Schema } from "effect"
import { CommandPalette } from "./components/command-palette"
import { ThemeProvider } from "./theme/index"
import { CommandProvider } from "./command/context"
import { useRouter, isRoute, type AppRoute } from "./router"
import { Session } from "./routes/session"
import { BranchPicker } from "./routes/branch-picker"
import { KeyboardScopeProvider, useScopedKeyboard } from "./keyboard/context"
import { useRenderer } from "@opentui/solid"
import { useEnv } from "./env/context"

type SessionRoute = Extract<AppRoute, { _tag: "session" }>
type BranchPickerRoute = Extract<AppRoute, { _tag: "branchPicker" }>

export interface AppProps {
  missingAuthProviders?: readonly string[]
  debugMode?: boolean
  initialThemeMode?: "dark" | "light"
}

function AppContent(props: AppProps) {
  const renderer = useRenderer()
  const env = useEnv()
  useScopedKeyboard((event) => {
    if (event.ctrl !== true || event.name !== "c") return false
    renderer.destroy()
    env.shutdown()
    return true
  })
  const router = useRouter()
  const sessionRoute = (): SessionRoute | false => {
    const route = router.route()
    if (isRoute.session(route)) return route
    return false
  }
  const branchPickerRoute = (): BranchPickerRoute | false => {
    const route = router.route()
    if (isRoute.branchPicker(route)) return route
    return false
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Switch>
        <Match when={sessionRoute()} keyed>
          {(route) => (
            <Session
              sessionId={route.sessionId}
              branchId={route.branchId}
              initialPrompt={route.prompt}
              debugMode={props.debugMode}
              missingAuthProviders={props.missingAuthProviders}
            />
          )}
        </Match>
        <Match when={branchPickerRoute()}>
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
      </Switch>

      {/* Command Palette */}
      <Show when={!sessionRoute()}>
        <CommandPalette />
      </Show>
    </box>
  )
}

export function App(props: AppProps) {
  const decodeError = Schema.decodeUnknownOption(Schema.instanceOf(Error))
  const errorMessage = (error: Parameters<typeof decodeError>[0]): string =>
    Option.match(decodeError(error), {
      onNone: () => String(error),
      onSome: (cause) => cause.message,
    })

  return (
    <ErrorBoundary
      fallback={(err) => (
        <box flexDirection="column" paddingLeft={1} paddingTop={1}>
          <text>
            <span style={{ fg: "red", bold: true }}>Fatal error</span>
          </text>
          <text>{errorMessage(err)}</text>
        </box>
      )}
    >
      <ThemeProvider mode={props.initialThemeMode}>
        <KeyboardScopeProvider>
          <CommandProvider>
            <AppContent {...props} />
          </CommandProvider>
        </KeyboardScopeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
