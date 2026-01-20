import { Switch, Match } from "solid-js"
import { DEFAULT_MODEL_ID, type ModelId } from "@gent/core"
import { CommandPalette } from "./components/command-palette"
import { ThemeProvider } from "./theme/index"
import { CommandProvider } from "./command/index"
import { ModelProvider } from "./model/index"
import { AgentStateProvider } from "./agent-state/index"
import { useRouter, isRoute } from "./router/index"
import { Home } from "./routes/home"
import { Session } from "./routes/session"

export interface AppProps {
  initialPrompt?: string
  model?: string
  onModelChange?: (modelId: ModelId) => void
}

function AppContent(props: AppProps) {
  const router = useRouter()

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Switch>
        <Match when={isRoute.home(router.route())}>
          <Home initialPrompt={props.initialPrompt} />
        </Match>
        <Match when={isRoute.session(router.route()) ? router.route() : false}>
          {(r) => {
            const route = r() as { sessionId: string; branchId: string }
            return (
              <Session
                sessionId={route.sessionId}
                branchId={route.branchId}
                initialPrompt={props.initialPrompt}
              />
            )
          }}
        </Match>
      </Switch>

      {/* Command Palette */}
      <CommandPalette />
    </box>
  )
}

export function App(props: AppProps) {
  const initialModel = (props.model ?? DEFAULT_MODEL_ID) as ModelId

  return (
    <ThemeProvider mode={undefined}>
      <CommandProvider>
        <ModelProvider initialModel={initialModel} onModelChange={props.onModelChange}>
          <AgentStateProvider>
            <AppContent {...props} />
          </AgentStateProvider>
        </ModelProvider>
      </CommandProvider>
    </ThemeProvider>
  )
}
