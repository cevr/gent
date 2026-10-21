# TUI Guidelines

The rules every TUI change keeps. The topic files under `apps/tui/docs/` hold the rest; each line under Topics says when to read one.

## Gotchas

- **jsxImportSource** - Must be `@opentui/solid`, not `solid-js`. Set in tsconfig.json.
- **Preload required** - Source runs only: `apps/tui/bunfig.toml` declares `scripts/dev-preload-boundary.ts` for `bun` (top level) and `@opentui/solid/preload` for `bun test` (`[test]`); run from `apps/tui`. Binary doesn't need it. The source preload caches each `.tsx` transform under `$XDG_CACHE_HOME/gent/solid-transform/` (else `~/.cache`), keyed by `bun.lock` and the file's path and text, and loads Babel only on a miss.
- **No shorthand props** - Use `marginTop`/`marginBottom` not `marginY`.
- **Border placement** - `border` prop goes on `<box>`, not `<input>`.
- **autoloadBunfig: false** - Required in `Bun.build` compile options, else binary tries to load bunfig at runtime.
- **Message part types** - Import shared message, event, and RPC types from `@gent/core/protocol` when a UI projection needs them. Never redeclare.
- **render() is async** - Use `Effect.promise(() => render(...))`, not `Effect.sync`.
- **File naming** - All files kebab-case: `message-list.tsx`, `workspace.tsx`.
- **Errors** - A failure is a typed error in the Effect channel; a Promise boundary enters through `Effect.tryPromise` with a tagged error. It shows in the status row or the open pane's note row and never crashes the TUI. No try/catch (`effect/noTryCatch`).
- **Debug output** - Goes to `clientLog` (`client.tsx`), JSON lines in `<data dir>/logs/<hash>-<ts>-client.log`. `console` is banned (`effect/noGlobals`): it would draw over the TUI.
- **Exit pattern** - Exit through `useExit()` (`session.tsx`): it leaves the terminal through `leaveTerminal` (`message-list.tsx`: commit the live transcript tail with `flushTranscriptForExit`, then `renderer.destroy()`), then runs `useEnv().shutdown()`. SIGINT, SIGTERM and SIGHUP take the same path: the entry's hold on the renderer (`holdUntilRendererDestroyed`) runs `leaveTerminal` when it is interrupted, and the renderer leaves those signals to gent (`exitSignals` in `main.tsx`), so its own listener does not destroy it first. Never `process.exit()` — it bypasses Effect scope finalizers (server lock cleanup, SQLite WAL checkpoint).
- **Intrinsic names** - Take the names from the opentui catalogue: some multi-word intrinsics use underscores (`tab_select`, `ascii_font`), `scrollbox` is one word.
- **Use `<For>`** - Never `.map()` for JSX lists; use `<For each={items}>{item => ...}</For>`.
- **Theme tokens** - Every color a component draws is a token from `useTheme()` (an extension names one through `NamedThemeColor`): no hex, color name or `dim` at a call site (`gent/theme-token-colors`).
- **One copy path** - Every copy goes through `useClipboard` (`terminal.tsx`).
- **One key ladder** - Esc and ctrl+c belong to `createSessionController` (`handleEscape`, `handleInterrupt` in `session.tsx`); Esc never quits.

## Components

`<box>` is the flexbox container. `<text>` holds text, with `<b>` and `<span style={{ fg }}>` inside. `<scrollbox>` scrolls; `stickyScroll stickyStart="bottom"` keeps it at the end. `<input>` takes keys only with its `focused` prop.

```tsx
import type { RGBA } from "@opentui/core"
// In a component: `const { theme } = useTheme()` (src/theme.tsx).
declare const theme: { readonly primary: RGBA }

;<box flexDirection="column" border>
  <text>
    Plain, <b>bold</b> and <span style={{ fg: theme.primary }}>colored</span> text
  </text>
  <scrollbox stickyScroll stickyStart="bottom">
    <text>A line that scrolls</text>
  </scrollbox>
  <input focused placeholder="Type here" />
</box>
```

Hooks: `useRenderer()` (`renderer.destroy()` on exit, `renderer.getPalette()`), `useKeyboard(handler)` (check `e.name === "escape"`), `useTheme()` (`{ theme, selected, all, mode, setMode, set }`, RGBA colors from `@opentui/core`).

## State ownership

- One workflow, one owner. If a flow has modes/transitions, give it one reducer or machine.
- Shared caches live under a provider/registry scope, not module globals.
- Projections stay local and dumb. Do not promote derived display state into a second writer.
- Render-local view unions in `src/` are Schema unions too (`effect/preferSchemaTaggedUnion` reads every tag spelling): `Schema.TaggedStruct` variants with `Schema.toTaggedUnion("_tag")` for a lowercase or kebab-case tag. Test the tag with `_tag ===` on a value whose payload holds class instances; `.guards` runs the full schema check.

## Acceptance

Every TUI change also needs `bun run test:e2e` and a live Herdr check before acceptance (the root `AGENTS.md`, Testing, says how).

## Topics

- `apps/tui/docs/layout.md` — providers, the one view, docked panes, key-hint rows, the live line, the queue, footer sizing, key files; read when you change the session view's chrome or a pane.
- `apps/tui/docs/transcript.md` — the native transcript: the split region, history commits, replays, markdown and mermaid, tool groups, the `ctrl+o` ladder, session rows, the sticky prompt, the renderer facts; read when you change what the transcript draws or when it commits.
- `apps/tui/docs/input.md` — the command palette, the Esc and ctrl+c ladder, the clipboard, input prefixes, shell mode, refused submissions, file references, slash commands; read when you change keys, the composer or a command.
- `apps/tui/docs/theme.md` — the theme system, token roles and the contrast rule; read when you add a color, a token or a theme.
- `apps/tui/docs/cli.md` — CLI flags and headless runs; read when you change the CLI or headless exit codes.
- `apps/tui/docs/extensions.md` — client extensions: the builtin roster, the public entry, loading and reload, the setup shape, panes, handover, every contribution bucket; read when you write or change a client extension.
- `apps/tui/docs/shipped-extensions.md` — `@gent/herdr`, `@gent/interaction-tools`, `@gent/cache`, `@gent/extension-admin`, `@gent/git`; read when you change one of them.
