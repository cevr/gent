#!/usr/bin/env bun
import { Command, Flag, Argument } from "effect/unstable/cli"
import { BunFileSystem, BunServices, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Tracer } from "effect"
import { identity } from "effect/Function"
import type { ServiceMap } from "effect"
import { RegistryProvider } from "./atom-solid/solid"
import { type GentClient, type GentRpcError, type SessionInfo } from "@gent/sdk"
import { LinkOpener } from "@gent/core/domain/link-opener.js"
import { OsService } from "@gent/core/domain/os-service.js"
import type { ProviderId } from "@gent/core/domain/model.js"
import type { SessionId } from "@gent/core/domain/ids.js"

import { render } from "@opentui/solid"
import { App } from "./app"
import { ClientProvider } from "./client/index"
import { RouterProvider } from "./router/index"
import { WorkspaceProvider } from "./workspace/index"
import { EnvProvider } from "./env/context"
import { clearClientLog } from "./utils/client-logger"
import { resolveAppBootstrap, type InitialState } from "./app-bootstrap"
import { runHeadless } from "./headless-runner"
import { startWorkerSupervisor } from "./worker/supervisor"

// Clear client log on startup
clearClientLog()

// Pure function for state resolution
const resolveInitialState = (input: {
  client: Pick<GentClient, "getSession" | "createSession" | "listBranches" | "listSessions">
  cwd: string
  session: Option.Option<string>
  continue_: boolean
  headless: boolean
  prompt: Option.Option<string>
  promptArg: Option.Option<string>
  bypass: boolean
}): Effect.Effect<InitialState, GentRpcError> =>
  Effect.gen(function* () {
    const { client, cwd, session, continue_, headless, prompt, promptArg, bypass } = input

    // 1. Headless mode
    if (headless) {
      const promptText = Option.isSome(promptArg) ? promptArg.value : undefined
      if (promptText === undefined || promptText.length === 0) {
        yield* Console.error("Error: --headless requires a prompt argument")
        return process.exit(1)
      }
      // Get or create session
      if (Option.isSome(session)) {
        const sess = yield* client.getSession(session.value as SessionId)
        if (sess === null) {
          yield* Console.error(`Error: session ${session.value} not found`)
          return process.exit(1)
        }
        return { _tag: "headless" as const, session: sess, prompt: promptText }
      }

      const result = yield* client.createSession({ cwd, bypass })
      const sess: SessionInfo = {
        id: result.sessionId,
        name: result.name,
        cwd,
        bypass: result.bypass,
        reasoningLevel: undefined,
        branchId: result.branchId,
        parentSessionId: undefined,
        parentBranchId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      return { _tag: "headless" as const, session: sess, prompt: promptText }
    }

    // 2. Explicit session ID
    if (Option.isSome(session)) {
      const sess = yield* client.getSession(session.value as SessionId)
      if (sess === null) {
        yield* Console.error(`Error: session ${session.value} not found`)
        return process.exit(1)
      }
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* client.listBranches(sess.id)
      if (branches.length > 1) {
        return {
          _tag: "branchPicker" as const,
          session: sess,
          branches,
          prompt: promptText,
        }
      }
      return { _tag: "session" as const, session: sess, prompt: promptText }
    }

    // 3. Continue from cwd
    if (continue_) {
      const sess: SessionInfo = yield* Effect.gen(function* () {
        const existing = yield* client
          .listSessions()
          .pipe(
            Effect.map(
              (sessions) =>
                sessions
                  .filter((candidate) => candidate.cwd === cwd)
                  .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null,
            ),
          )
        if (existing !== null) return existing

        const result = yield* client.createSession({ cwd, bypass })
        return {
          id: result.sessionId,
          name: result.name,
          cwd,
          bypass: result.bypass,
          reasoningLevel: undefined,
          branchId: result.branchId,
          parentSessionId: undefined,
          parentBranchId: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      })
      const promptText = Option.isSome(prompt) ? prompt.value : undefined
      const branches = yield* client.listBranches(sess.id)
      if (branches.length > 1) {
        return {
          _tag: "branchPicker" as const,
          session: sess,
          branches,
          prompt: promptText,
        }
      }
      return { _tag: "session" as const, session: sess, prompt: promptText }
    }

    // 4. Prompt without session - create new
    if (Option.isSome(prompt)) {
      const result = yield* client.createSession({ cwd, bypass })
      const sess: SessionInfo = {
        id: result.sessionId,
        name: result.name,
        cwd,
        bypass: result.bypass,
        reasoningLevel: undefined,
        branchId: result.branchId,
        parentSessionId: undefined,
        parentBranchId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      return { _tag: "session" as const, session: sess, prompt: prompt.value }
    }

    // 5. Home view
    return { _tag: "home" as const }
  })

const formatMissingProviders = (providers: readonly ProviderId[]): string =>
  providers.map((provider) => provider).join(", ")

const ATOM_CACHE_MAX = 256

// Platform layer
const PlatformLayer = Layer.merge(BunServices.layer, BunFileSystem.layer)

const LinkLayer = Layer.provide(LinkOpener.Live, OsService.Live)

const makeUiLayer = () => Layer.mergeAll(PlatformLayer, LinkLayer)

// Main command - launches TUI or runs headless
const main = Command.make(
  "gent",
  {
    session: Flag.string("session").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Session ID to continue"),
      Flag.optional,
    ),
    continue_: Flag.boolean("continue").pipe(
      Flag.withAlias("c"),
      Flag.withDescription("Continue last session from current directory"),
      Flag.withDefault(false),
    ),
    headless: Flag.boolean("headless").pipe(
      Flag.withAlias("H"),
      Flag.withDescription("Run in headless mode (no TUI, streams to stdout)"),
      Flag.withDefault(false),
    ),
    debug: Flag.boolean("debug").pipe(
      Flag.withDescription("Launch TUI renderer playground for widgets and tool renderers"),
      Flag.withDefault(false),
    ),
    prompt: Flag.string("prompt").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Initial prompt (TUI mode)"),
      Flag.optional,
    ),
    promptArg: Argument.string("prompt").pipe(
      Argument.withDescription("Prompt for headless mode"),
      Argument.optional,
    ),
    bypass: Flag.boolean("bypass").pipe(
      Flag.withDescription("Auto-allow all tool calls (default: true, use --no-bypass to disable)"),
      Flag.withDefault(true),
    ),
  },
  ({ session, continue_, headless, debug, prompt, promptArg, bypass }) =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      const scope = yield* Effect.scope
      const uiServices = (yield* Layer.buildWithScope(
        makeUiLayer(),
        scope,
      )) as ServiceMap.ServiceMap<unknown>
      const visualOpt = yield* Config.option(Config.string("VISUAL"))
      const editorOpt = yield* Config.option(Config.string("EDITOR"))
      const env = {
        visual: Option.getOrUndefined(visualOpt),
        editor: Option.getOrUndefined(editorOpt),
      }

      const supervisor = yield* startWorkerSupervisor({ cwd, mode: debug ? "debug" : "default" })
      const gentClient = supervisor.client

      const authProviders = yield* gentClient.listAuthProviders()
      const missingProviders = authProviders
        .filter((provider) => provider.required && !provider.hasKey)
        .map((provider) => provider.provider)

      if (missingProviders.length > 0 && headless && !debug) {
        const hint = formatMissingProviders(missingProviders)
        yield* Console.error(`Error: missing required API keys: ${hint}`)
        return process.exit(1)
      }

      const state = yield* resolveInitialState({
        client: gentClient,
        cwd,
        session,
        continue_: continue_ || debug,
        headless,
        prompt,
        promptArg,
        bypass,
      })

      if (state._tag === "headless") {
        const branchId = state.session.branchId
        if (branchId === undefined) {
          yield* Console.error("Error: session has no branch")
          return process.exit(1)
        }
        const traceIdOpt = yield* Config.option(Config.string("GENT_TRACE_ID"))
        const parentSpanIdOpt = yield* Config.option(Config.string("GENT_PARENT_SPAN_ID"))
        const parentSpan =
          Option.isSome(traceIdOpt) && Option.isSome(parentSpanIdOpt)
            ? Tracer.externalSpan({
                traceId: traceIdOpt.value,
                spanId: parentSpanIdOpt.value,
                sampled: true,
              })
            : undefined
        yield* runHeadless(gentClient, state.session.id, branchId, state.prompt).pipe(
          Effect.withSpan("Headless.run"),
          parentSpan !== undefined ? Effect.withParentSpan(parentSpan) : identity,
        )
        return process.exit(0)
      }
      const bootstrap = resolveAppBootstrap(state, {
        missingProviders: missingProviders as readonly ProviderId[],
        debugMode: debug,
      })

      yield* Effect.sync(() =>
        render(() => (
          <EnvProvider env={env}>
            <WorkspaceProvider cwd={cwd} services={uiServices}>
              <RegistryProvider services={uiServices} maxEntries={ATOM_CACHE_MAX}>
                <ClientProvider
                  client={gentClient}
                  initialSession={bootstrap.initialSession}
                  supervisor={supervisor}
                >
                  <RouterProvider initialRoute={bootstrap.initialRoute}>
                    <App
                      initialPrompt={bootstrap.initialPrompt}
                      missingAuthProviders={bootstrap.missingAuthProviders}
                      debugMode={bootstrap.debugMode}
                    />
                  </RouterProvider>
                </ClientProvider>
              </RegistryProvider>
            </WorkspaceProvider>
          </EnvProvider>
        )),
      )

      return yield* Effect.never
    }),
)

// Sessions subcommand
const sessions = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    const worker = yield* startWorkerSupervisor({ cwd: process.cwd() })
    const allSessions = yield* worker.client.listSessions()

    if (allSessions.length === 0) {
      yield* Console.log("No sessions found.")
      return
    }

    yield* Console.log("Sessions:")
    for (const s of allSessions) {
      const date = new Date(s.updatedAt).toISOString()
      yield* Console.log(`  ${s.id} - ${s.name ?? "Unnamed"} (${date})`)
    }
  }),
)

// Root command with subcommands
const command = main.pipe(
  Command.withSubcommands([sessions]),
  Command.withDescription("Gent - minimal, opinionated agent harness"),
)

// CLI
const cli = Command.run(command, {
  version: "0.0.0",
})

// Run with base platform layers; command handlers provide core layers as needed
const CliLayer = Layer.effectDiscard(cli)

const MainLayer = CliLayer.pipe(Layer.provide(PlatformLayer))

BunRuntime.runMain(Effect.scoped(Layer.launch(MainLayer)))
