import { Switch, Match, onMount } from "solid-js"
import type { ModelId } from "@gent/core"
import { CommandPalette } from "./components/command-palette"
import { ThemeProvider } from "./theme/index"
import { CommandProvider } from "./command/index"
import { useRouter, isRoute } from "./router/index"
import { useClient } from "./client/index"
import { Home } from "./routes/home"
import { Session } from "./routes/session"
import { BranchPicker } from "./routes/branch-picker"
import { Permissions } from "./routes/permissions"
import * as State from "./state"
import type { BranchInfo } from "./client"

export interface AppProps {
  initialPrompt?: string
  initialModel?: ModelId
}

function AppContent(props: AppProps) {
  const router = useRouter()
  const client = useClient()

  // Initialize model state on mount
  onMount(() => {
    if (props.initialModel) {
      State.initModelState(props.initialModel)
    }
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Switch>
        <Match when={isRoute.home(router.route())}>
          <Home initialPrompt={props.initialPrompt} />
        </Match>
        <Match when={isRoute.session(router.route()) ? router.route() : false}>
          {(r) => {
            const route = r() as { sessionId: string; branchId: string; prompt?: string }
            const prompt = route.prompt ?? props.initialPrompt
            return (
              <Session
                sessionId={route.sessionId}
                branchId={route.branchId}
                initialPrompt={prompt}
              />
            )
          }}
        </Match>
        <Match when={isRoute.branchPicker(router.route()) ? router.route() : false}>
          {(r) => {
            const route = r() as {
              sessionId: string
              sessionName: string
              branches: readonly BranchInfo[]
              prompt?: string
            }
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
          <Permissions client={client.client} />
        </Match>
      </Switch>

      {/* Command Palette */}
      <CommandPalette />
    </box>
  )
}

export function App(props: AppProps) {
  return (
    <ThemeProvider mode={undefined}>
      <CommandProvider>
        <AppContent {...props} />
      </CommandProvider>
    </ThemeProvider>
  )
}
