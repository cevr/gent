import { Switch, Match } from "solid-js"
import { DEFAULT_MODEL_ID, type ModelId } from "@gent/core"
import { CommandPalette } from "./components/command-palette.js"
import { ThemeProvider } from "./theme/index.js"
import { CommandProvider } from "./command/index.js"
import { ModelProvider } from "./model/index.js"
import { AgentStateProvider } from "./agent-state/index.js"
import { useRouter, isRoute } from "./router/index.js"
import { HomeView } from "./routes/home-view.js"
import { SessionView } from "./routes/session-view.js"

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
          <HomeView initialPrompt={props.initialPrompt} />
        </Match>
        <Match when={isRoute.session(router.route()) ? router.route() : false}>
          {(r) => {
            const route = r() as { sessionId: string; branchId: string }
            return (
              <SessionView
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
