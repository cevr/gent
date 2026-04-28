# TUI Guidelines

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Dev only: `bun --preload @opentui/solid/preload`. Binary doesn't need it.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.
- **autoloadBunfig: false** - Required in `Bun.build` compile options, else binary tries to load bunfig at runtime.
- **Types from core** - Import `MessagePart`, `TextPart` from `@gent/core`. Never redeclare.
- **render() is async** - Use `Effect.promise(() => render(...))`, not `Effect.sync`.
- **File naming** - All files kebab-case: `message-list.tsx`, `workspace/context.tsx`.
- **Error boundaries** - Always wrap potentially failing operations in try/catch or Effect.tryPromise to prevent TUI crashes.
- **Exit pattern** - Use `renderer.destroy()` then `useEnv().shutdown()` for clean exit. Never `process.exit()` — it bypasses Effect scope finalizers (worker cleanup, SQLite WAL checkpoint).
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
- `useTheme()` - Returns `{ theme, mode, setMode, all, set }`. Theme colors are RGBA from `@opentui/core`.

## Theme System

Ported from opencode. Key patterns:

- `renderer.getPalette({ size: 16 })` queries terminal's ANSI palette via OSC
- System theme generated from terminal colors; fallback to "opencode" theme
- JSON themes in `src/theme/themes/*.json` with `defs` + dark/light variants
- `resolveTheme(themeJson, mode)` resolves refs to RGBA values

## Command Palette

- `Ctrl+P` opens palette
- Register commands via `command.register([...])` in `onMount`
- Commands have `id`, `title`, `category`, optional `keybind`, `onSelect`

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
RegistryProvider → WorkspaceProvider → RouterProvider → ClientProvider → ExtensionUIProvider → App
```

| Provider                   | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `WorkspaceProvider`        | cwd, gitRoot, gitStatus - static workspace info        |
| `RouterProvider`           | route, navigate - routes are `session \| branchPicker` |
| `ClientProvider`           | transport client, session state, event stream          |
| `ExtensionUIProvider`      | extension loading, overlay/composer dispatch           |
| `SessionControllerContext` | session-scoped: auth gate, overlays, composer state    |

State ownership rules:

- One workflow, one owner. If a flow has modes/transitions, give it one reducer or machine.
- Shared caches live under a provider/registry scope, not module globals.
- Projections stay local and dumb. Do not promote derived display state into a second writer.
- Auth and permissions are session overlays, not routes. Auth gate lives in session-controller.
- `useRuntime()` is zero-arg — reads `useClient()` internally.
- Composer reads from `SessionControllerContext`, not props.

Routes (only 2):

- `src/routes/session.tsx` — provides `SessionControllerContext`
- `src/routes/session-controller.ts` — `createSessionController()` + context

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

| Flag             | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `-c, --continue` | Resume last session for cwd                              |
| `-p, --prompt`   | Initial message (goes straight to session view)          |
| `-s, --session`  | Resume specific session ID                               |
| `-H, --headless` | Headless mode + prompt arg                               |
| `-a, --agent`    | Agent override for headless mode (e.g. `memory:reflect`) |

Priority: headless → session → continue → prompt → home

## Input Prefixes

Special prefixes at input start trigger different modes:

| Prefix | Behavior                                       |
| ------ | ---------------------------------------------- |
| `!`    | Shell mode - prompt changes to `$`, ESC exits  |
| `$`    | Skills popup (scans ~/.claude/skills, etc.)    |
| `@`    | File finder popup, supports `@file.ts#10-20`   |
| `/`    | Command popup (/auto, /clear, /sessions, etc.) |

### Shell Mode

- Type `!` at cursor position 0 → enters shell mode (prompt: `$`)
- Submit executes command, output shown in chat
- ESC or backspace at empty input exits shell mode
- Large output (>2000 lines or 50KB) truncated, full saved to `~/tool-output/`

### File References

`@path/to/file.ts#10-20` expands to code block with lines 10-20 on submit.

### Slash Commands

| Command     | Action               |
| ----------- | -------------------- |
| `/auto`     | Toggle auto mode     |
| `/clear`    | Clear messages       |
| `/sessions` | Open sessions picker |
| `/branch`   | Create new branch    |
| `/tree`     | Browse branch tree   |
| `/fork`     | Fork from a message  |

## Extensions

Builtins are individual `.client.{ts,tsx}` files in `src/extensions/builtins/`:

| File                              | Extension ID              | What                                           |
| --------------------------------- | ------------------------- | ---------------------------------------------- |
| `builtins/tools.client.ts`        | `@gent/tools`             | Tool renderers                                 |
| `builtins/plan.client.ts`         | `@gent/plan`              | /plan and /audit slash commands                |
| `builtins/artifacts.client.ts`    | `@gent/artifacts`         | Artifact count border label                    |
| `builtins/auto.client.ts`         | `@gent/auto`              | Auto loop progress                             |
| `builtins/tasks.client.tsx`       | `@gent/task-tools`        | Task widget, dialog overlay, border label      |
| `builtins/connection.client.ts`   | `@gent/connection`        | Connection status widget                       |
| `builtins/interactions.client.ts` | `@gent/interaction-tools` | Interaction renderers (questions, permissions) |
| `builtins/handoff.client.ts`      | `@gent/handoff`           | Handoff interaction renderer                   |
| `builtins/skills.client.ts`       | `@gent/skills-ui`         | `$` autocomplete: skills popup                 |
| `builtins/files.client.ts`        | `@gent/files-ui`          | `@` autocomplete: file search popup            |

Extension pipeline: `context.tsx` (static builtin imports) + `discovery.ts` → `loader-boundary.ts` → `resolve.ts`

- Builtins are statically imported in `context.tsx` for Bun compiled binary compatibility
- User/project extensions discovered via filesystem scan (`discovery.ts`, Effect-typed)
- `loader-boundary.ts` accepts `disabled` list — skips `setup` for disabled extensions
- One setup shape: Effect-typed `Effect<Array, E, R>`. Setups yield from the per-provider `clientRuntime` which provides `FileSystem | Path | ClientTransport | ClientWorkspace | ClientShell | ClientComposer | ClientLifecycle`
- **Transport-only widgets (B11.6)**: there is no in-process snapshot cache. Widgets subscribe to `ClientTransport.onExtensionStateChanged` for invalidation pulses and call `client.extension.request(...)` via `ClientTransport` for current state. Each widget owns its own Solid signal, keyed on `(sessionId, branchId)` so stale data from the prior session can never render. Read accessors like `liveModel()` gate on `(sid, bid)` match against the live session. `auto.client.ts` / `artifacts.client.ts` / `tasks.client.tsx` are the canonical examples.
- **Lifecycle**: register Solid `createRoot(dispose)` disposers AND pulse unsubscribes via `ClientLifecycle.addCleanup`. The provider's `onCleanup` runs them in order on unmount, so widget setups leave no detached roots behind.
- Widgets are zero-prop components that self-source from `useClient()` or `useExtensionUI()`
- `useExtensionUI()` provides `sessionId()`, `branchId()`, `clientRuntime`
- Border labels support 4 positions: `top-left`, `top-right`, `bottom-left`, `bottom-right`
- `ClientComposer.state()` exposes the reactive composer snapshot: `{ draft, mode, inputFocused, autocompleteOpen }`
- `autocompleteItems` contributions: extensions register prefix triggers + item sources for composer popups
- `ClientWorkspace.cwd` / `ClientWorkspace.home` for workspace-relative operations

## Key Files (Composer + Session)

| File                                        | Purpose                             |
| ------------------------------------------- | ----------------------------------- |
| `src/routes/session-controller.ts`          | session-screen orchestration        |
| `src/routes/session.tsx`                    | session presentation + route keys   |
| `src/components/composer.tsx`               | composer render surface             |
| `src/components/use-composer-controller.ts` | composer interaction wiring         |
| `src/components/autocomplete-popup.tsx`     | Generic contribution-driven popup   |
| `src/utils/fuzzy-score.ts`                  | Fuzzy match scoring for file search |
| `src/utils/shell.ts`                        | Shell execution + truncation        |
| `src/utils/file-refs.ts`                    | @file#line expansion                |
| `src/commands/slash-commands.ts`            | Slash command handlers              |
