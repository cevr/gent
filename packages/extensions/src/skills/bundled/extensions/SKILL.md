---
name: extensions
description: Write, test, turn on or off, add and remove gent extensions while gent runs.
---

An extension adds tools, requests, agents, hooks and Resources to gent. Gent loads extension files at the start of each turn. There is no restart and no file watcher.

## Where extensions live

- User scope: `~/.gent/extensions/`. It reaches every project on this server.
- Project scope: `<project>/.gent/extensions/`. It loads only when the user trusts the project (`trustedProjects` in `~/.gent/config.json`). Only the user can trust a project.

An extension is one `.ts`, `.js` or `.mjs` file, or a directory with an `index.ts`, `index.js` or `index.mjs`. A file named `*.client.*` belongs to the TUI, not to the server. Names that start with `.` or `_` are not loaded.

## Write one

Write the file with the file tools. Import only `effect`, `@gent/core/extensions/api` and `@gent/core/extensions/branch-tools`; gent binds these to the modules it runs. A module that the file imports by a relative path is built with it. Do not install npm packages for an extension.

```ts
import { Effect, Schema } from "effect"
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api"

const Greet = tool({
  id: "greet.say",
  description: "Greet a person by name",
  params: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  execute: ({ name }) => Effect.succeed(`Hello, ${name}`),
})

export default defineExtension({
  id: "greet",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", Greet)
  }),
})
```

Export one `defineExtension(...)`. Register each contribution through `yield* ExtensionHost` in `setup`; `setup` returns nothing. Host facades (`Session`, `Interaction`, `FileLock`, `Extensions`, `State`) come from `yield* ExtensionContext` inside a handler.

## Test it

1. Write or edit the file.
2. Call `tools.extensions.status({ id })`. It loads the files as they are now and runs the real loader. A failure names its phase: `load` (the file did not build or import), `setup`, `validation` (a tool id or an agent name collides) or `startup` (a Resource did not build), with the error.
3. Fix and call it again until the extension is `Active`.
4. Use the new tool in the next turn. To continue in the same task, pass `resume` to a verb below, or start a child agent: its first turn loads the new files.

When an edit breaks an extension that loaded before, gent keeps the last good version running. `extensions.status` reports it `Active` with `reloadFailed`: the phase and the error of the new version. Fix the file; the next turn loads the fix.

## Change what loads

Each of these asks the user once. A headless run declines. The change reaches the next turn of every session in the scope, not the running turn.

- `tools.extensions.disable({ id, scope })` and `tools.extensions.enable({ id, scope })` edit `disabledExtensions` in the scope's `config.json`.
- `tools.extensions.add({ path, scope })` copies a file or directory into the scope's extensions directory. A name that exists is refused: edit that extension in place.
- `tools.extensions.remove({ id, scope })` moves the extension's file or directory to `extension-trash` in gent's data directory, where the user can get it back. A shipped extension cannot be removed; disable it.
- `tools.extensions.reload({ id })` sets the extensions up again over the same files. It does not ask. A file edit needs no reload.

Name the `scope` (`user` or `project`) unless the session runs from the home directory. Pass `resume: "<what to do next>"` to queue that message as your next turn once the change is made. Use `resume` only to go on with the task the user gave you.

The ask is consent for the change, not a sandbox: the file tools and bash can write the same files without an ask. Tell the user what you change.
