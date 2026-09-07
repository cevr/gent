/**
 * TUI extension integration contracts.
 *
 * Keep one end-to-end story per user-visible outcome:
 * discovery, override precedence, disabled gating, invalid-file tolerance,
 * overlay state, autocomplete visibility, and startup with an active session.
 */
import { it, describe, expect, test } from "effect-bun-test"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs" // eslint-disable-line effect/noNodeBuiltinImport -- synchronous filesystem fixture setup is a test boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path" // eslint-disable-line effect/noNodeBuiltinImport -- synchronous path fixture setup is a test boundary.
import { Cause, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { loadTuiExtensions as _loadTuiExtensions } from "../src/extensions/loader-boundary"
import {
  makeClientComposerLayer,
  makeClientDriverLayer,
  makeClientLifecycleLayer,
  makeClientShellLayer,
  makeClientWorkspaceLayer,
} from "../src/extensions/client-services"
import { makeClientTransportLayer } from "../src/extensions/client-transport"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
class ExtensionIntegrationTestError extends Schema.TaggedError<ExtensionIntegrationTestError>()(
  "ExtensionIntegrationTestError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) },
) {}
import { SessionUiState, transitionSessionUi } from "../src/routes/session-ui-state"
import { builtinClientModules } from "../src/extensions/builtins/index"
import { createMockClient, createMockRuntime } from "./render-harness-boundary"
import { makeClientExtensionRuntime } from "./extension-test-harness-boundary"
const absent = Option.getOrUndefined(Option.none())
const throwOnAccess = (label: string): never =>
  Effect.runSync(Effect.die(`unexpected transport call in pure load test: ${label}`))
const stubClient = new Proxy(createMockClient(), {
  get: (_target, prop) =>
    new Proxy(
      {},
      {
        get: (_target2, method) => () => throwOnAccess(`client.${String(prop)}.${String(method)}`),
      },
    ),
})
const stubRuntime = new Proxy(createMockRuntime(), {
  get: (_target, method) => () => throwOnAccess(`runtime.${String(method)}`),
})

const runTestShellEffect = <A, E>(_effect: Effect.Effect<A, E, never>): Promise<A> =>
  stubRuntime.run(_effect)

const castTestShellEffect = <A, E>(effect: Effect.Effect<A, E, never>): void => {
  Effect.runFork(effect)
}

const testRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    BunFileSystem.layer,
    BunServices.layer,
    makeClientWorkspaceLayer({ cwd: "/tmp/test-cwd", home: "/tmp/test-home" }),
    makeClientShellLayer({
      sendMessage: () => {},
      openOverlay: () => {},
      closeOverlay: () => {},
      run: runTestShellEffect,
      cast: castTestShellEffect,
    }),
    makeClientDriverLayer({
      list: Effect.succeed({ drivers: [], overrides: {} }),
      set: () => Effect.void,
      clear: () => Effect.void,
    }),
    makeClientComposerLayer({
      state: () => ({
        draft: "",
        mode: "editing" satisfies "editing",
        inputFocused: false,
        autocompleteOpen: false,
      }),
    }),
    makeClientTransportLayer({
      client: stubClient,
      runtime: stubRuntime,
      currentSession: () => Option.getOrUndefined(Option.none()),
      onExtensionStateChanged: () => () => {},
      onSessionEvent: () => () => {},
    }),
    makeClientLifecycleLayer({ addCleanup: () => {} }),
  ),
)
const loadTuiExtensions = (
  opts: Omit<Parameters<typeof _loadTuiExtensions>[0], "runtime"> & {
    runtime?: Parameters<typeof _loadTuiExtensions>[0]["runtime"]
  },
): ReturnType<typeof _loadTuiExtensions> =>
  _loadTuiExtensions({ ...opts, runtime: opts.runtime ?? testRuntime })
const TEST_DIR = join(import.meta.dir, "../.tmp-ext-integration")
const encodeTrustGrant = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ trustedProjects: Schema.Array(Schema.String) })),
)
const USER_DIR = join(TEST_DIR, "user")
const PROJECT_DIR = join(TEST_DIR, "project")
const integrationFixture = Effect.acquireRelease(
  Effect.sync(() => {
    mkdirSync(USER_DIR, { recursive: true })
    mkdirSync(PROJECT_DIR, { recursive: true })
    writeFileSync(
      join(TEST_DIR, "config.json"),
      encodeTrustGrant({ trustedProjects: [realpathSync(join(PROJECT_DIR, "../.."))] }),
    )
    mkdirSync(join(USER_DIR, "custom-read"), { recursive: true })
    writeFileSync(
      join(USER_DIR, "custom-read", "index.ts"),
      `export default { manifest: { id: "custom-read" }, setup: () => [] }`,
    )
    writeFileSync(
      join(USER_DIR, "custom-read", "client.ts"),
      `import { Effect } from "effect"
import {
  defineClientExtension,
  clientContributions,
  clientCommandContribution,
  overlayContribution,
  rendererContribution,
  widgetContribution,
} from "../../../src/extensions/client-facets.js"

export default defineClientExtension("@test/custom-read", {
  setup: Effect.succeed(clientContributions(
    rendererContribution(["my_custom_tool"], () => "custom-tool-renderer"),
    widgetContribution({ id: "test-widget", slot: "below-messages", priority: 50, component: () => "test-widget" }),
    clientCommandContribution({ id: "test-cmd", title: "Test Command", category: "test", onSelect: () => {} }),
    overlayContribution({ id: "test-overlay", component: (_props) => "test-overlay" }),
  )),
})`,
    )
    writeFileSync(
      join(PROJECT_DIR, "override-bash.client.ts"),
      `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "../../src/extensions/client-facets.js"

export default defineClientExtension("@test/override-bash", {
  setup: Effect.succeed(
    rendererContribution(["bash"], () => "project-bash-override"),
  ),
})`,
    )
    writeFileSync(
      join(USER_DIR, "alpha.client.ts"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '../../src/extensions/client-facets.js'; export default defineClientExtension('@test/alpha', { setup: Effect.succeed(clientCommandContribution({ id: 'alpha', title: 'Alpha', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(USER_DIR, "zeta.client.ts"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '../../src/extensions/client-facets.js'; export default defineClientExtension('@test/zeta', { setup: Effect.succeed(clientCommandContribution({ id: 'zeta', title: 'Zeta', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(USER_DIR, ".hidden.client.tsx"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '../../src/extensions/client-facets.js'; export default defineClientExtension('@test/hidden', { setup: Effect.succeed(clientCommandContribution({ id: 'hidden', title: 'Hidden', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(USER_DIR, "_internal.client.tsx"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '../../src/extensions/client-facets.js'; export default defineClientExtension('@test/internal', { setup: Effect.succeed(clientCommandContribution({ id: 'internal', title: 'Internal', onSelect: () => {} })) })",
    )
    mkdirSync(join(USER_DIR, "__tests__"), { recursive: true })
    writeFileSync(
      join(USER_DIR, "__tests__", "test.client.tsx"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '../../../src/extensions/client-facets.js'; export default defineClientExtension('@test/spec-only', { setup: Effect.succeed(clientCommandContribution({ id: 'spec-only', title: 'Spec Only', onSelect: () => {} })) })",
    )
    writeFileSync(
      join(PROJECT_DIR, "prebuilt.client.mjs"),
      "import { Effect } from 'effect'; import { defineClientExtension, clientCommandContribution } from '../../src/extensions/client-facets.js'; export default defineClientExtension('@test/prebuilt', { setup: Effect.succeed(clientCommandContribution({ id: 'prebuilt', title: 'Prebuilt', onSelect: () => {} })) })",
    )
  }),
  () => Effect.sync(() => rmSync(TEST_DIR, { recursive: true, force: true })),
)
describe("loadTuiExtensions", () => {
  it.scopedLive("loads builtin surfaces when no user or project extensions exist", () =>
    Effect.gen(function* () {
      yield* integrationFixture
      const emptyUser = join(TEST_DIR, "empty-user")
      const emptyProject = join(TEST_DIR, "empty-project")
      mkdirSync(emptyUser, { recursive: true })
      mkdirSync(emptyProject, { recursive: true })
      const resolved = yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: builtinClientModules,
          userDir: emptyUser,
          projectDir: emptyProject,
        }),
      )
      expect(resolved.renderers.has("read")).toBe(true)
      expect(resolved.renderers.has("bash")).toBe(true)
      expect(resolved.interactionRenderers.has("handoff")).toBe(true)
      expect(resolved.commands.some((command) => command.id === "plan.create")).toBe(false)
      rmSync(emptyUser, { recursive: true, force: true })
      rmSync(emptyProject, { recursive: true, force: true })
    }),
  )
  it.scopedLive(
    "user extensions can add visible renderer, widget, command, and overlay surfaces",
    () =>
      Effect.gen(function* () {
        yield* integrationFixture
        const resolved = yield* Effect.promise(() =>
          loadTuiExtensions({
            builtins: builtinClientModules,
            userDir: USER_DIR,
            projectDir: join(TEST_DIR, "no-project"),
          }),
        )
        expect(resolved.renderers.has("my_custom_tool")).toBe(true)
        expect(resolved.widgets.some((widget) => widget.id === "test-widget")).toBe(true)
        expect(resolved.commands.some((command) => command.id === "test-cmd")).toBe(true)
        expect(resolved.overlays.has("test-overlay")).toBe(true)
      }),
  )
  it.scopedLive(
    "discovery ignores hidden and test-only files but still loads prebuilt modules deterministically",
    () =>
      Effect.gen(function* () {
        yield* integrationFixture
        const resolved = yield* Effect.promise(() =>
          loadTuiExtensions({
            builtins: [],
            userDir: USER_DIR,
            projectDir: PROJECT_DIR,
          }),
        )
        const commandIds = resolved.commands.map((command) => command.id)
        expect(commandIds).toContain("prebuilt")
        expect(commandIds).not.toContain("hidden")
        expect(commandIds).not.toContain("internal")
        expect(commandIds).not.toContain("spec-only")
        expect(commandIds.filter((id) => id === "alpha" || id === "zeta")).toEqual([
          "alpha",
          "zeta",
        ])
      }),
  )
  it.scopedLive("project scope overrides builtin and user tool renderers", () =>
    Effect.gen(function* () {
      yield* integrationFixture
      const userOverrideDir = join(TEST_DIR, "user-bash")
      mkdirSync(userOverrideDir, { recursive: true })
      writeFileSync(
        join(userOverrideDir, "override.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "../../src/extensions/client-facets.js"

export default defineClientExtension("@test/user-bash", {
  setup: Effect.succeed(
    rendererContribution(["bash"], () => "user-bash-override"),
  ),
})`,
      )
      const resolved = yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: builtinClientModules,
          userDir: userOverrideDir,
          projectDir: PROJECT_DIR,
        }),
      )
      const bashRenderer = Option.fromNullishOr(resolved.renderers.get("bash"))
      if (Option.isNone(bashRenderer)) return yield* Effect.die("expected bash renderer")
      expect(
        bashRenderer.value({
          toolCall: {
            id: "test",
            toolName: "bash",
            status: "completed",
            input: absent,
            summary: absent,
            output: absent,
          },
          expanded: false,
        }),
      ).toBe("project-bash-override")
      rmSync(userOverrideDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("disabled extensions are removed before setup runs", () =>
    Effect.gen(function* () {
      yield* integrationFixture
      const disabledDir = join(TEST_DIR, "disabled-user")
      mkdirSync(disabledDir, { recursive: true })
      writeFileSync(
        join(disabledDir, "bomb.client.ts"),
        `import { Effect } from "effect"
export default {
  id: "@test/bomb",
  setup: Effect.sync(() => { throw new Error("setup() should not be called for disabled extension") }),
}`,
      )
      const resolved = yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: builtinClientModules,
          userDir: disabledDir,
          projectDir: join(TEST_DIR, "no-project"),
          disabled: ["@gent/tools", "@test/bomb"],
        }),
      )
      expect(resolved.renderers.has("read")).toBe(false)
      expect(resolved.renderers.has("bash")).toBe(false)
      expect(resolved.interactionRenderers.has("handoff")).toBe(true)
      expect(resolved.commands.some((command) => command.id === "plan.create")).toBe(false)
      rmSync(disabledDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("invalid extension files are skipped without breaking the builtin bundle", () =>
    Effect.gen(function* () {
      yield* integrationFixture
      const badDir = join(TEST_DIR, "bad-ext")
      mkdirSync(badDir, { recursive: true })
      writeFileSync(join(badDir, "bad.client.ts"), "export default { not: 'an extension' }")
      const resolved = yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: builtinClientModules,
          userDir: badDir,
          projectDir: join(TEST_DIR, "no-project"),
        }),
      )
      expect(resolved.renderers.has("read")).toBe(true)
      rmSync(badDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("same-scope collisions still fail through the public load path", () =>
    Effect.gen(function* () {
      yield* integrationFixture
      const collisionDir = join(TEST_DIR, "collision-tool")
      mkdirSync(collisionDir, { recursive: true })
      writeFileSync(
        join(collisionDir, "a.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "../../src/extensions/client-facets.js"

export default defineClientExtension("@test/a", {
  setup: Effect.succeed(rendererContribution(["my_tool"], () => "a")),
})`,
      )
      writeFileSync(
        join(collisionDir, "b.client.ts"),
        `import { Effect } from "effect"
import { defineClientExtension, rendererContribution } from "../../src/extensions/client-facets.js"

export default defineClientExtension("@test/b", {
  setup: Effect.succeed(rendererContribution(["my_tool"], () => "b")),
})`,
      )
      const exit = yield* Effect.tryPromise({
        try: () =>
          loadTuiExtensions({
            builtins: builtinClientModules,
            userDir: collisionDir,
            projectDir: join(TEST_DIR, "no-project"),
          }),
        catch: (cause) => new ExtensionIntegrationTestError({ message: String(cause), cause }),
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(String(Cause.squash(exit.cause))).toContain("Same-scope TUI renderer collision")
      }
      rmSync(collisionDir, { recursive: true, force: true })
    }),
  )
  it.scopedLive("builtin autocomplete sources stay visible", () =>
    Effect.gen(function* () {
      yield* integrationFixture
      const emptyUser = join(TEST_DIR, "empty-user-ac")
      const emptyProject = join(TEST_DIR, "empty-project-ac")
      mkdirSync(emptyUser, { recursive: true })
      mkdirSync(emptyProject, { recursive: true })
      const resolved = yield* Effect.promise(() =>
        loadTuiExtensions({
          builtins: builtinClientModules,
          userDir: emptyUser,
          projectDir: emptyProject,
        }),
      )
      const prefixes = new Set(resolved.autocompleteItems.map((entry) => entry.prefix))
      expect(prefixes.has("$")).toBe(true)
      expect(prefixes.has("@")).toBe(true)
      rmSync(emptyUser, { recursive: true, force: true })
      rmSync(emptyProject, { recursive: true, force: true })
    }),
  )
  it.scopedLive("startup with an active session does not break transport-only widgets", () => {
    const activeSessionRuntime = makeClientExtensionRuntime({
      transport: {
        client: createMockClient({ extension: { request: () => Effect.void } }),
        runtime: createMockRuntime(),
        currentSession: () => ({
          sessionId: SessionId.make("test-session-id"),
          branchId: BranchId.make("test-branch-id"),
        }),
        onExtensionStateChanged: () => () => {},
        onSessionEvent: () => () => {},
      },
    })
    return Effect.gen(function* () {
      yield* integrationFixture
      const emptyUser = join(TEST_DIR, "active-session-user")
      const emptyProject = join(TEST_DIR, "active-session-project")
      mkdirSync(emptyUser, { recursive: true })
      mkdirSync(emptyProject, { recursive: true })
      yield* Effect.gen(function* () {
        const resolved = yield* Effect.promise(() =>
          loadTuiExtensions({
            builtins: builtinClientModules,
            userDir: emptyUser,
            projectDir: emptyProject,
            runtime: activeSessionRuntime,
          }),
        )
        const widgetIds = new Set(resolved.widgets.map((widget) => widget.id))
        const borderPositions = new Set(resolved.borderLabels.map((label) => label.position))
        expect(widgetIds.has("todos")).toBe(true)
        expect(borderPositions.has("top-left")).toBe(true)
        expect(borderPositions.has("bottom-right")).toBe(true)
        expect(borderPositions.has("bottom-left")).toBe(true)
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            rmSync(emptyUser, { recursive: true, force: true })
            rmSync(emptyProject, { recursive: true, force: true })
            yield* Effect.promise(() => activeSessionRuntime.dispose())
          }),
        ),
      )
    })
  })
})
describe("session UI state", () => {
  test("extension overlays replace the current overlay and close cleanly", () => {
    const withMermaid = transitionSessionUi(SessionUiState.initial(), { _tag: "OpenMermaid" })
    const withExtension = transitionSessionUi(withMermaid.state, {
      _tag: "OpenExtensionOverlay",
      overlayId: "my-ext:panel",
    })
    const closed = transitionSessionUi(withExtension.state, { _tag: "CloseOverlay" })
    expect(withExtension.state.overlay).toEqual({
      _tag: "extension",
      overlayId: "my-ext:panel",
    })
    expect(closed.state.overlay).toEqual({ _tag: "none" })
  })
})
