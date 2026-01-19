# TUI Guidelines

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Dev only: `bun --preload @opentui/solid/preload`. Binary doesn't need it.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.
- **autoloadBunfig: false** - Required in `Bun.build` compile options, else binary tries to load bunfig at runtime.
- **Types from core** - Import `MessagePart`, `TextPart` from `@gent/core`. Never redeclare.
- **render() is async** - Use `Effect.promise(() => render(...))`, not `Effect.sync`.
- **File naming** - All files kebab-case: `message-list.tsx`, `use-git-status.ts`.
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
