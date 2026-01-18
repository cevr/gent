# TUI Guidelines

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Run with `bun --preload @opentui/solid/preload` for dev. Not needed for compiled binary.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`. Use `paddingLeft`/`paddingRight` not `paddingX`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.
- **exactOptionalPropertyTypes** - Use `prop: string | undefined` not `prop?: string` for props that may receive undefined values.

## Binary Compilation

```typescript
// scripts/build.ts
await Bun.build({
  compile: {
    target: "bun-darwin-arm64",
    outfile: "bin/gent",
    autoloadBunfig: false,  // Critical: disable bunfig in compiled binary
  },
  plugins: [solidTransformPlugin],
})
```

- `autoloadBunfig: false` - Prevents runtime bunfig loading in compiled binary
- Symlink to `~/.bun/bin/gent` for global access
- Use `lstatSync` not `existsSync` to detect existing symlinks (broken symlinks return false for existsSync)

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
