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
- **Exit pattern** - Use `renderer.destroy()` then `process.exit(0)` for clean exit.
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

Providers wrap app in `main.tsx`:

```
ThemeProvider → CommandProvider → ModelProvider → AgentStateProvider → RouterProvider → ClientProvider
```

| Provider             | Purpose                                          |
| -------------------- | ------------------------------------------------ |
| `WorkspaceProvider`  | cwd, gitRoot, gitStatus - static workspace info  |
| `AgentStateProvider` | mode, status, cost, error - reactive agent state |
| `RouterProvider`     | route, navigate - discriminated union routes     |
| `ClientProvider`     | RPC client, event subscriptions                  |

Routes: `home-view.tsx` (logo, first message) → `session-view.tsx` (messages, streaming)

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
| `-c, --continue` | Resume last session for cwd                     |
| `-p, --prompt`   | Initial message (goes straight to session view) |
| `-s, --session`  | Resume specific session ID                      |
| `-H, --headless` | Headless mode + prompt arg                      |

Priority: headless → session → continue → prompt → home

## Input Prefixes

Special prefixes at input start trigger different modes:

| Prefix | Behavior                                        |
| ------ | ----------------------------------------------- |
| `!`    | Shell mode - prompt changes to `$`, ESC exits   |
| `$`    | Skills popup (scans ~/.claude/skills, etc.)     |
| `@`    | File finder popup, supports `@file.ts#10-20`    |
| `/`    | Command popup (/model, /clear, /sessions, etc.) |

### Shell Mode

- Type `!` at cursor position 0 → enters shell mode (prompt: `$`)
- Submit executes command, output shown in chat
- ESC or backspace at empty input exits shell mode
- Large output (>2000 lines or 50KB) truncated, full saved to `~/tool-output/`

### File References

`@path/to/file.ts#10-20` expands to code block with lines 10-20 on submit.

### Slash Commands

| Command     | Action                  |
| ----------- | ----------------------- |
| `/model`    | Open model picker       |
| `/clear`    | Clear messages          |
| `/sessions` | Open sessions picker    |
| `/compact`  | Compact history (TODO)  |
| `/branch`   | Create new branch       |

## Key Files (Input System)

| File                                         | Purpose                           |
| -------------------------------------------- | --------------------------------- |
| `src/routes/session-view.tsx`                | Input mode state, prefix handling |
| `src/components/autocomplete-popup.tsx`      | Popup component for $, @, /       |
| `src/hooks/use-skills.ts`                    | Skill dir scanning + caching      |
| `src/hooks/use-file-search.ts`               | Glob + fuzzy file search          |
| `src/utils/shell.ts`                         | Shell execution + truncation      |
| `src/utils/file-refs.ts`                     | @file#line expansion              |
| `src/commands/slash-commands.ts`             | Slash command handlers            |
