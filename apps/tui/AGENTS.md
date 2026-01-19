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
- `process.exit()` cleanly exits TUI without cleanup warnings

## Architecture

Providers wrap app in `main.tsx`:
```
ThemeProvider → CommandProvider → ModelProvider → AgentStateProvider → RouterProvider → ClientProvider
```

| Provider | Purpose |
|----------|---------|
| `WorkspaceProvider` | cwd, gitRoot, gitStatus - static workspace info |
| `AgentStateProvider` | mode, status, cost, error - reactive agent state |
| `RouterProvider` | route, navigate - discriminated union routes |
| `ClientProvider` | RPC client, event subscriptions |

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

| Flag | Purpose |
|------|---------|
| `-c, --continue` | Resume last session for cwd |
| `-p, --prompt` | Initial message (goes straight to session view) |
| `-s, --session` | Resume specific session ID |
| `-H, --headless` | Headless mode + prompt arg |

Priority: headless → session → continue → prompt → home
