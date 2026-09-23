# TUI Guidelines

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Dev only: `bun --preload @opentui/solid/preload`. Binary doesn't need it.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.
- **autoloadBunfig: false** - Required in `Bun.build` compile options, else binary tries to load bunfig at runtime.
- **Message part types** - Import shared message, event, and RPC types from `@gent/core/protocol` when a UI projection needs them. Never redeclare.
- **render() is async** - Use `Effect.promise(() => render(...))`, not `Effect.sync`.
- **File naming** - All files kebab-case: `message-list.tsx`, `workspace.tsx`.
- **Error boundaries** - Always wrap potentially failing operations in try/catch or Effect.tryPromise to prevent TUI crashes.
- **Exit pattern** - Use `renderer.destroy()` then `useEnv().shutdown()` for clean exit. Never `process.exit()` — it bypasses Effect scope finalizers (server lock cleanup, SQLite WAL checkpoint).
- **Solid underscores** - Multi-word components use underscores: `scroll_box`, `tab_select`.
- **Use `<For>`** - Never `.map()` for JSX lists; use `<For each={items}>{item => ...}</For>`.

## Components

```tsx
<box>           # Flexbox container
<text>          # Text with <b>, <span style={{fg: "color"}}>
<scrollbox>     # Scrollable, use stickyScroll stickyStart="bottom"
<input>         # Text input, needs focused prop
```

## Hooks

- `useRenderer()` - Get renderer for `renderer.destroy()` on exit, `renderer.getPalette()` for terminal colors
- `useKeyboard(handler)` - Key events, check `e.name === "escape"`
- `useTheme()` - Returns `{ theme, selected, all, mode, setMode, set }`. Theme colors are RGBA from `@opentui/core`.

## Theme System

Ported from opencode. Key patterns:

- `renderer.getPalette({ size: 16 })` queries terminal's ANSI palette via OSC
- System theme generated from terminal colors; fallback to the `fx` theme
- JSON themes in `src/themes/*.json` with `defs` + dark/light variants
- `resolveTheme(themeJson, mode)` resolves refs to RGBA values
- The palette's "Theme" level enumerates `all()`; "Mode" is the separate Dark/Light toggle. A ported theme may omit `selectedListItemText`/`backgroundMenu`; `resolveTheme` supplies both.

## Command Palette

- `Ctrl+P` opens palette
- One `Command` shape (`id`, `title`, `category`, optional `keybind`, `slash`, `aliases`, `onSelect`, `onSlash`) and one resolved list, `useExtensionUI().commands()`
- `resolveCommands` merges the session's own commands (`setSessionCommands`, builtin scope), client extension commands, and server slash commands (builtin scope). Precedence is project > user > builtin; a higher scope takes a slash or keybind from the earlier owner, and a same-scope claim is dropped and listed with the failed extensions

## Error Handling

- Wrap async operations in try/catch blocks
- Use Effect.tryPromise for operations that might fail
- Display errors in status bar or modal, don't crash the TUI

## Debugging

- Use `console.log()` for debug output - it appears in terminal after TUI exits

## Architecture

Startup blocks before render — `main.tsx` calls `waitForReady` + `resolveInteractiveBootstrap` before `render()`. No loading route.

Providers wrap app in `main.tsx`:

```
WorkspaceProvider → ClientProvider → ExtensionUIProvider → SessionShellProvider → App
```

| Provider                   | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `WorkspaceProvider`        | cwd, gitRoot, gitStatus - static workspace info      |
| `SessionShellProvider`     | the startup prompt, held until a session consumes it |
| `ClientProvider`           | transport client, session state, event stream        |
| `ExtensionUIProvider`      | extension loading, command list, composer dispatch   |
| `SessionControllerContext` | session-scoped: auth gate, overlays, composer state  |

State ownership rules:

- One workflow, one owner. If a flow has modes/transitions, give it one reducer or machine.
- Shared caches live under a provider/registry scope, not module globals.
- Projections stay local and dumb. Do not promote derived display state into a second writer.
- Render-local view unions in `src/` may be plain `_tag` unions. The root `CLAUDE.md` rule requiring `Schema.TaggedUnion` covers wire and domain data; a union built inline by one projection and matched in the same file decodes nothing, so a schema would add a runtime decode to a path with no untrusted input.
- Auth is a view (`auth.tsx`); it mounts as an overlay above the session view when the session controller's auth gate detects missing required providers.
- There is no router. `client.session()` says which session shows, `switchSession` is its one writer, and `App` keys the session mount on it.
- `useRuntime()` is zero-arg — reads `useClient()` internally.
- Composer reads from `SessionControllerContext`, not props.

Views (only 1):

- `src/app.tsx` — the boot flow and the session view; provides
  `SessionControllerContext`
- `src/session.tsx` — `createSessionController()` + context

The branch picker is a docked pane (`pickers.tsx`), not a
view. It draws `PickerFrame` like every other docked pane. The boot flow opens it over the mounted session when the resumed session
has more than one branch; escape quits, because no branch was chosen yet. The
command palette's "Branches" level switches branches after that.

## Compound Components

StatusBar uses compound pattern - compose what you need:

```tsx
<StatusBar.Root>
  <StatusBar.Row>
    <StatusBar.Mode />
    <StatusBar.Separator />
    <StatusBar.Model />
  </StatusBar.Row>
</StatusBar.Root>
```

Components derive state from providers, not props. Add/remove rows per view.

## CLI Flags

| Flag             | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| `-p, --prompt`   | Initial message (goes straight to session view) |
| `-s, --session`  | Resume specific session ID                      |
| `-H, --headless` | Headless mode + prompt arg                      |
| `-a, --agent`    | Agent override for headless mode                |

`gent resume [session-id]` opens a stored session; with no id it opens the last
session in this directory.

Priority: headless → session → continue → prompt → home

## Input Prefixes

Special prefixes at input start trigger different modes:

| Prefix | Behavior                                      |
| ------ | --------------------------------------------- |
| `!`    | Shell mode - prompt changes to `$`, ESC exits |
| `$`    | Skills popup (scans ~/.claude/skills, etc.)   |
| `@`    | File finder popup, supports `@file.ts#10-20`  |
| `/`    | Command popup (/new, /agents, etc.)           |

### Shell Mode

- Type `!` at cursor position 0 → enters shell mode (prompt: `$`)
- Submit executes command, output shown in chat
- ESC or backspace at empty input exits shell mode
- Large output (>2000 lines or 50KB) truncated, full saved to `~/tool-output/`

### File References

`@path/to/file.ts#10-20` expands to code block with lines 10-20 on submit.

### Slash Commands

| Command            | Action                                                           |
| ------------------ | ---------------------------------------------------------------- |
| `/new`, `/clear`   | Start a new session                                              |
| `/sessions`        | Agents pane: every session, live and stored; side threads marked |
| `/agents`, `/tree` | Aliases of `/sessions`                                           |
| `/branch`          | Create new branch                                                |
| `/fork`            | Fork from a message                                              |
| `/thread`          | Thread pane: the sessions and windows this one runs on           |
| `/btw`, `/side`    | Fork pane: ask a parallel session on the side                    |

## Extensions

Every builtin without its own view lives in `src/extensions/builtins.tsx`; a
builtin that owns a view keeps its own `src/extensions/*.client.tsx` file:

| Extension ID                              | Where                    | What                                       |
| ----------------------------------------- | ------------------------ | ------------------------------------------ |
| `@gent/tools` / `@gent/interaction-tools` | `builtins.tsx`           | Tool renderers, interaction renderers      |
| `@gent/skills-ui`                         | `builtins.tsx`           | `$` autocomplete: skills popup             |
| `@gent/files-ui`                          | `builtins.tsx`           | `@` autocomplete: file search popup        |
| `@gent/driver-ui`                         | `builtins.tsx`           | `/driver` slash command                    |
| `@gent/goal`                              | `builtins.tsx`           | Goal label, goal continuation row          |
| `@gent/session-tools`                     | `builtins.tsx`           | Sender row for `session.send`              |
| `@gent/herdr`                             | `builtins.tsx`           | Herdr activity reporter                    |
| `@gent/agents-view`                       | `agents.client.tsx`      | Agents pane (the session browser), tray    |
| `@gent/btw`                               | `btw.client.tsx`         | `/btw` fork pane                           |
| `@gent/delegate`                          | `delegate.client.tsx`    | `delegate.start` row, child-completion row |
| `@gent/thread-view`                       | `thread-view.client.tsx` | `/thread` pane                             |
| `@gent/wake`                              | `wake.client.tsx`        | Wake alarm tray, fired wake row            |

Extension pipeline: `host.tsx` (static builtin imports) → `loader-boundary.ts`, which discovers, loads and resolves contributions

- Builtins are statically imported in `host.tsx` for Bun compiled binary compatibility
- User/project extensions discovered via filesystem scan (`loader-boundary.ts`, Effect-typed)
- `loader-boundary.ts` accepts `disabled` list — skips `setup` for disabled extensions
- One setup shape: Effect-typed `Effect<ClientContributions, E, R>`. Setups yield from the per-provider `clientRuntime` which provides `FileSystem | Path | ClientContext`. A setup yields the facets it needs: `const { transport, shell, lifecycle } = yield* ClientContext`. Never pass `ClientContext` or a facet as a parameter
- **Transport-only widgets**: there is no in-process snapshot cache. A widget reads server state through `sessionQuery` (in `client-facets.ts`), which yields `ClientContext`, keys each reply on `(sessionId, branchId)` and drops a reply for a session the shell has left. `follow: true` reads again on every session move. The widget refreshes it on typed session events or `transport.onExtensionStateChanged` pulses. The goal label (`builtins.tsx`) and the wake tray (`wake.client.tsx`) are the canonical examples.
- **Lifecycle**: register Solid `createRoot(dispose)` disposers AND pulse unsubscribes via `lifecycle.addCleanup`. The provider's `onCleanup` runs them in order on unmount, so widget setups leave no detached roots behind.
- Widgets are zero-prop components that read through `ClientContext`, never the host's Solid contexts (`useClient()`, `useExtensionUI()`). Host chrome that reads them (the connection and queue widgets) renders from `app.tsx`
- Extensions have no overlays. A pane is a `below-input` widget that renders while `shell.pane.isOpen(id)` is true. The extension opens and closes it by name with `shell.pane.open(id)` and `shell.pane.close(id)` (agents, thread, btw). The session view owns the one pane slot: it is the session overlay, shared with the model, reasoning and branch pickers, so at most one pane is open. Opening a pane replaces the open one. `close(id)` of a pane that is no longer open does nothing. A pane does not hold the composer. A pane that takes typed text reads keys through `useScopedKeyboard`, as the agents filter and the btw ask line do: an `<input>` would take the terminal's focus from the composer, and the composer would not get it back.
- The TUI host (`src/` outside `extensions/`) never imports `@gent/extensions`; the `gent/core-entry-boundary` oxlint rule enforces it. One extension's view is a client extension that reads its server state through `ClientContext.transport`
- `useExtensionUI()` provides the resolved contributions (tool renderers excepted: `useToolRenderers()`), the load `failures`, and `clientRuntime`; widgets read the session from `transport.currentSession()`
- **Tool renderers**: `rendererContribution(toolNames, component)` keys a renderer on a real tool id. The model sees only `cell`, so the cell renderer hands each live op to the renderer registered for the op's tool (`RegisteredToolCall` in `tool-renderers.tsx`, the one lookup the transcript also uses). An op draws collapsed, as a sub-row with its own header: a cell that reads thirty files must not draw thirty file bodies. `ToolFrameBody` hides the header of one frame only; a frame nested in its body draws its header again. An op with no renderer keeps its one-line receipt. After a reload the session snapshot projects each cell's ops from the branch's stored tool events (`ToolInteraction.operations`), keyed by the cell's message and call id. A projected op carries only what its collapsed row draws: the tool, the status, the scalar input fields (each string whole or left out, within 4 KB per op), the summary, and a bounded output (top-level scalars such as a bash `exitCode`, each string cut to its first and last 6 lines). It draws through its renderer again, with the same collapsed row as before the reload. A forked branch copies messages, not events, so there the saved result's receipts draw as lines. The host provides the map through `ToolRenderersProvider`. The "tool renderer reach" test in `loader-boundary.test.ts` fails on a renderer name that no shipped extension registers as a tool
- A setup that returns a key outside the contribution buckets fails to load with `unknown contribution "<key>"`
- **Message rows**: `messageRendererContribution(customType, component)` draws the user-role messages whose `metadata.customType` matches exactly. The component composes `UserRow` or `CollapsedRow` from `src/ui.tsx`. `message-list.tsx` names only the runtime's own kinds (`context-window`, `model-change`), and full detail draws every message as the plain row
- Status labels (`statusLabelContribution`) draw on the composer's one status row, after the host's labels and before the right-anchored context gauge and cost, ordered by `priority`. The row has no placement: a label that needs its own place is a widget
- `autocompleteItems` contributions: extensions register prefix triggers + item sources for composer popups
- `workspace.cwd` / `workspace.home` for workspace-relative operations
- **`activity` has one encoding for absence**: `snapshot` is a plain reader, and a surface with nothing to report is given the default that returns `state: "unknown"` (a test takes it by omitting `activity`). Readers call `activity.snapshot()` and never re-test whether a provider exists — the composition root already decided. Do not reintroduce an `Option` around the reader alongside the default.

## Key Files (Composer + Session)

| File               | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `src/session.tsx`  | session-screen orchestration                     |
| `src/app.tsx`      | boot flow, session view, queue widget            |
| `src/composer.tsx` | composer render + wiring, popup, shell execution |
| `src/utils.ts`     | @file#line expansion                             |
| `src/commands.tsx` | Slash command handlers                           |
