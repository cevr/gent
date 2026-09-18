import { createSignal, Show, ErrorBoundary } from "solid-js"
import { Option, Schema } from "effect"
import type { Branch } from "@gent/core/protocol"
import { CommandPalette } from "./components/command-palette"
import { ThemeProvider } from "./theme"
import { CommandProvider } from "./command/context"
import { Session } from "./routes/session"
import { useClient } from "./client"
import { KeyboardScopeProvider, useScopedKeyboard } from "./terminal"
import { useRenderer } from "@opentui/solid"
import { useEnv } from "./workspace"

interface AppProps {
  missingAuthProviders?: readonly string[]
  debugMode?: boolean
  initialThemeMode?: "dark" | "light"
  /**
   * Branches the boot flow resumed into, when the session has more than one.
   * The session mounts on its active branch and docks the picker over it.
   */
  initialBranches?: Option.Option<readonly Branch[]>
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

  // Which session shows is the client's to say. `switchSession` is the one
  // writer, and every pane that moves the reader between sessions already
  // goes through it, so keying the mount on it is all the router ever did.
  const sessionClient = useClient()
  //
  // The key is the identity, not the session record: a new name or a new model
  // makes a new record, and a mount keyed on the record would tear the whole
  // session view down for it. `sessionIdentity` is the client's one answer to
  // "which session"; every consumer that does not read the name shares it.
  const active = () => Option.getOrUndefined(sessionClient.sessionIdentity())

  // The boot picker belongs to the first session this process mounts. A later
  // switch is a session the reader already chose, so it docks nothing.
  //
  // Read once and remember the answer: Solid re-reads a prop every time the
  // child touches it, so a getter that consumes the branches would hand the
  // first read `Some` and every read after it `None`.
  const [bootBranches, setBootBranches] = createSignal(
    Option.getOrElse(Option.fromNullishOr(props.initialBranches), () =>
      Option.none<readonly Branch[]>(),
    ),
  )

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Show when={active()} keyed fallback={<CommandPalette />}>
        {(session) => {
          const branches = bootBranches()
          setBootBranches(Option.none())
          return (
            <Session
              sessionId={session.sessionId}
              branchId={session.branchId}
              initialBranches={branches}
              debugMode={props.debugMode}
              missingAuthProviders={props.missingAuthProviders}
            />
          )
        }}
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
