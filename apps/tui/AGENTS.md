# TUI Guidelines

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Run with `bun --preload @opentui/solid/preload`.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`. Use `paddingLeft`/`paddingRight` not `paddingX`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.

## Components

```tsx
<box>           # Flexbox container
<text>          # Text with <b>, <span style={{fg: "color"}}>
<scrollbox>     # Scrollable, use stickyScroll stickyStart="bottom"
<input>         # Text input, needs focused prop
```

## Hooks

- `useRenderer()` - Get renderer for `renderer.destroy()` on exit
- `useKeyboard(handler)` - Key events, check `e.name === "escape"`
