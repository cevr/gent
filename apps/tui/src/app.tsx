import { Effect } from "effect"
import { Switch, Match, Show, ErrorBoundary, createEffect, createSignal, on } from "solid-js"
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
import { resolveInteractiveBootstrap } from "./app-bootstrap"
import { ConnectionWidget } from "./components/connection-widget"

type SessionRoute = Extract<AppRoute, { _tag: "session" }>
type BranchPickerRoute = Extract<AppRoute, { _tag: "branchPicker" }>
type AuthGateState = "checking" | "open" | "closed"

export interface AppProps {
  missingAuthProviders?: readonly string[]
  debugMode?: boolean
  startup?: {
    readonly cwd: string
    readonly sessionId?: string
    readonly continue_: boolean
    readonly prompt?: string
  }
}

function AppContent(props: AppProps) {
  const router = useRouter()
  const client = useClient()
  const [authGateState, setAuthGateState] = createSignal<AuthGateState>(
    !props.debugMode && (props.missingAuthProviders?.length ?? 0) > 0 ? "open" : "closed",
  )
  const [authGateKey, setAuthGateKey] = createSignal<string | null>(null)
  const [bootError, setBootError] = createSignal<string | null>(null)
  let authGateVersion = 0
  let bootstrapVersion = 0

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

  createEffect(
    on(
      () =>
        [
          router.route()._tag,
          client.connectionGeneration(),
          client.connectionState()?._tag,
        ] as const,
      ([routeTag, _generation, connectionTag]) => {
        if (
          props.startup === undefined ||
          routeTag !== "loading" ||
          connectionTag !== "connected"
        ) {
          return
        }

        const version = ++bootstrapVersion
        setBootError(null)
        client.runtime.cast(
          resolveInteractiveBootstrap({
            client: client.client,
            cwd: props.startup.cwd,
            sessionId: props.startup.sessionId,
            continue_: props.startup.continue_,
            prompt: props.startup.prompt,
            debugMode: props.debugMode ?? false,
          }).pipe(
            Effect.exit,
            Effect.tap((exit) =>
              Effect.sync(() => {
                if (version !== bootstrapVersion || router.route()._tag !== "loading") return
                if (exit._tag === "Failure") {
                  const error = String(exit.cause)
                  setBootError(error)
                  client.log.error("app:bootstrap", { error })
                  return
                }

                const { bootstrap, initialAgent } = exit.value
                const session = bootstrap.initialSession
                if (session !== undefined) {
                  client.switchSession(
                    session.sessionId,
                    session.branchId,
                    session.name,
                    initialAgent,
                  )
                } else {
                  client.clearSession()
                }
                // Bootstrap already resolved auth — seed the gate with the result
                // so the session Match callback's first evaluation sees "closed".
                // The bootstrap called auth.listProviders and knows missingProviders.
                const preseedKey = desiredAuthGateKey(bootstrap.initialRoute._tag, initialAgent)
                authGateVersion += 1
                setAuthGateKey(preseedKey)
                setAuthGateState(bootstrap.missingAuthProviders !== undefined ? "open" : "closed")
                router.navigate(bootstrap.initialRoute)
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
    (desiredAuthGateKey() !== authGateKey() || authGateState() === "checking")

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Switch>
        <Match when={isRoute.loading(router.route())}>
          <box flexDirection="column" paddingLeft={1} paddingTop={1}>
            <text>Loading Gent…</text>
            <Show when={bootError() !== null}>
              <text>{bootError()}</text>
            </Show>
            <ConnectionWidget />
          </box>
        </Match>
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
