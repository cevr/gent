import { FileFinder } from "@ff-labs/fff-bun"
import { describe, expect, it, test } from "effect-bun-test"
import {
  builtinDriver,
  builtinHerdr,
  builtinFiles,
  builtinSkills,
  FINDER_PAGE_BUDGET,
  getFileTag,
  makeHerdrReporter,
  rankListed,
} from "../../src/extensions/builtins"
import { readFrecencyStore } from "../../src/autocomplete"
import { BunServices } from "@effect/platform-bun"
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Scope,
} from "effect"
import { AgentName, BranchId, SessionId } from "@gent/core/protocol"
import {
  type AutocompleteItem,
  type ClientActivitySnapshot,
  type ClientRuntimeServices,
  ClientContext,
  type ClientContextDeps,
  makeClientContextLayer,
} from "../../src/extensions/client-facets"
import { createMockClient, createMockRuntime } from "../render-harness-boundary"
import {
  makeClientTestTransport,
  makePaneSlot,
  makePromiseHold,
  provideClientServices,
  runClientExtensionSetupWithRuntime,
} from "../extension-test-harness-boundary"
import { createSignal } from "solid-js"

// ── file tag ────────────────────────────────────────────────────────────────

describe("getFileTag", () => {
  test("returns [ts] for TypeScript files", () => {
    expect(getFileTag("file.ts")).toBe("[ts]")
    expect(getFileTag("component.tsx")).toBe("[ts]")
    expect(getFileTag("src/utils/helper.ts")).toBe("[ts]")
  })

  test("returns [js] for JavaScript files", () => {
    expect(getFileTag("file.js")).toBe("[js]")
    expect(getFileTag("component.jsx")).toBe("[js]")
  })

  test("returns [md] for Markdown files", () => {
    expect(getFileTag("README.md")).toBe("[md]")
    expect(getFileTag("docs/guide.mdx")).toBe("[md]")
  })

  test("returns [json] for JSON files", () => {
    expect(getFileTag("package.json")).toBe("[json]")
    expect(getFileTag("tsconfig.json")).toBe("[json]")
  })

  test("returns [css] for CSS-like files", () => {
    expect(getFileTag("styles.css")).toBe("[css]")
    expect(getFileTag("theme.scss")).toBe("[css]")
    expect(getFileTag("vars.less")).toBe("[css]")
  })

  test("returns [html] for HTML files", () => {
    expect(getFileTag("index.html")).toBe("[html]")
  })

  test("returns [py] for Python files", () => {
    expect(getFileTag("script.py")).toBe("[py]")
  })

  test("returns [rs] for Rust files", () => {
    expect(getFileTag("main.rs")).toBe("[rs]")
  })

  test("returns [go] for Go files", () => {
    expect(getFileTag("main.go")).toBe("[go]")
  })

  test("returns [yaml] for YAML files", () => {
    expect(getFileTag("config.yaml")).toBe("[yaml]")
    expect(getFileTag("ci.yml")).toBe("[yaml]")
  })

  test("returns [toml] for TOML files", () => {
    expect(getFileTag("Cargo.toml")).toBe("[toml]")
  })

  test("returns [sh] for shell files", () => {
    expect(getFileTag("script.sh")).toBe("[sh]")
    expect(getFileTag("setup.bash")).toBe("[sh]")
    expect(getFileTag("init.zsh")).toBe("[sh]")
  })

  test("returns empty string for unknown extensions", () => {
    expect(getFileTag("file.txt")).toBe("")
    expect(getFileTag("image.png")).toBe("")
    expect(getFileTag("archive.zip")).toBe("")
  })

  test("returns empty string for files without extension", () => {
    expect(getFileTag("Makefile")).toBe("")
    expect(getFileTag("Dockerfile")).toBe("")
  })

  test("is case insensitive", () => {
    expect(getFileTag("FILE.TS")).toBe("[ts]")
    expect(getFileTag("README.MD")).toBe("[md]")
    expect(getFileTag("Config.JSON")).toBe("[json]")
  })
})

// ── files popup ─────────────────────────────────────────────────────────────

/**
 * The `@` popup lists what fs-tools lists (`FilesRpc.List`), lets fff rank
 * those paths in the session's directory, and reads the listing once per open
 * popup. Each listed path is a real file under the session's directory, and
 * `unlisted` names files on disk the listing leaves out.
 */
const withFilesPopup = <A>(
  paths: ReadonlyArray<string>,
  body: (popup: {
    readonly items: (
      filter: string,
    ) => Effect.Effect<ReadonlyArray<AutocompleteItem>, never, ClientRuntimeServices>
    readonly insertion: (id: string) => string
    readonly select: (id: string, filter: string) => void
    /** What the popup does when it mounts. */
    readonly open: () => void
    /** The server's listing from now on. */
    readonly relist: (next: ReadonlyArray<string>) => void
    readonly reads: () => number
  }) => Effect.Effect<A, never, ClientRuntimeServices>,
  options: {
    /** Holds every listing read until it opens. */
    readonly gate?: Effect.Effect<void>
    readonly unlisted?: ReadonlyArray<string>
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped()
    const launchCwd = yield* fs.makeTempDirectoryScoped()
    const sessionCwd = yield* fs.makeTempDirectoryScoped()
    for (const file of [...paths, ...(options.unlisted ?? [])]) {
      if (file.endsWith("/")) continue
      yield* fs.makeDirectory(path.dirname(path.join(sessionCwd, file)), { recursive: true })
      yield* fs.writeFileString(path.join(sessionCwd, file), file)
    }
    let reads = 0
    let listed = paths
    return yield* provideClientServices(
      Effect.gen(function* () {
        const contributions = yield* builtinFiles.setup
        const source = Option.getOrThrow(Option.fromUndefinedOr(contributions.autocomplete?.[0]))
        const items = (filter: string) => {
          const result = source.items(filter)
          if (Effect.isEffect(result)) return Effect.orDie(result)
          return Effect.succeed(result)
        }
        const insertion = (id: string) =>
          Option.getOrThrow(Option.fromUndefinedOr(source.formatInsertion))(id)
        const select = (id: string, filter: string) =>
          Option.getOrThrow(Option.fromUndefinedOr(source.onSelect))(id, filter)
        const open = () => Option.map(Option.fromUndefinedOr(source.onOpen), (onOpen) => onOpen())
        const relist = (next: ReadonlyArray<string>) => {
          listed = next
        }
        return yield* body({ items, insertion, select, open, relist, reads: () => reads })
      }).pipe(Effect.orDie),
      {
        // The session is rooted outside the launch directory: fff scans the session's.
        workspace: { cwd: launchCwd, home, sessionCwd: Effect.succeed(sessionCwd) },
        currentSession: () => Option.some(session),
        requestEffect: () =>
          Effect.sync(() => {
            reads++
          }).pipe(
            Effect.andThen(options.gate ?? Effect.void),
            Effect.andThen(Effect.sync(() => listed)),
          ),
      },
    )
  })

const filesTest = it.scopedLive.layer(BunServices.layer)

describe("files popup across sessions", () => {
  filesTest(
    "a switch shows the new session's paths, and a read in flight stays with its session",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const sessions = {
          a: {
            key: { sessionId: SessionId.make("sess-a"), branchId: BranchId.make("branch-a") },
            dir: yield* fs.makeTempDirectoryScoped(),
            paths: ["alpha/only-a.ts"],
          },
          b: {
            key: { sessionId: SessionId.make("sess-b"), branchId: BranchId.make("branch-b") },
            dir: yield* fs.makeTempDirectoryScoped(),
            paths: ["beta/only-b.ts"],
          },
        }
        for (const entry of Object.values(sessions)) {
          for (const file of entry.paths) {
            yield* fs.makeDirectory(path.dirname(path.join(entry.dir, file)), { recursive: true })
            yield* fs.writeFileString(path.join(entry.dir, file), file)
          }
        }
        let current = sessions.a
        // A's second read waits on this gate, so it is still in flight at the switch.
        const holdA = yield* Deferred.make<void>()
        let readsOfA = 0
        yield* provideClientServices(
          Effect.gen(function* () {
            const contributions = yield* builtinFiles.setup
            const source = Option.getOrThrow(
              Option.fromUndefinedOr(contributions.autocomplete?.[0]),
            )
            const items = (filter: string) => {
              const result = source.items(filter)
              if (Effect.isEffect(result)) return Effect.orDie(result)
              return Effect.succeed(result)
            }
            const ids = (filter: string) =>
              items(filter).pipe(Effect.map((shown) => shown.map((item) => item.id)))

            yield* items("")
            expect(yield* ids("ts")).toEqual(["alpha/only-a.ts"])

            // The popup stays open across the switch: no empty filter re-lists.
            current = sessions.b
            expect(yield* ids("ts")).toEqual(["beta/only-b.ts"])

            // Back on A, a listing read is held; a switch to B meanwhile asks for B's own.
            current = sessions.a
            const heldRead = yield* Effect.forkChild(items(""))
            yield* Effect.yieldNow
            current = sessions.b
            expect(yield* ids("ts")).toEqual(["beta/only-b.ts"])
            yield* Deferred.succeed(holdA, void 0)
            yield* Fiber.join(heldRead)
            expect(yield* ids("ts")).toEqual(["beta/only-b.ts"])
          }).pipe(Effect.orDie),
          {
            workspace: {
              cwd: home,
              home,
              sessionCwd: Effect.sync(() => current.dir),
            },
            currentSession: () => Option.some(current.key),
            requestEffect: () => {
              const asked = current
              if (asked !== sessions.a) return Effect.succeed(asked.paths)
              readsOfA++
              if (readsOfA < 2) return Effect.succeed(asked.paths)
              return Deferred.await(holdA).pipe(Effect.as(asked.paths))
            },
          },
        )
      }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("files popup listing session", () => {
  // The listing is asked for after the session's directory resolves. A switch
  // in that window must not send the request for the session switched to and
  // file its reply under the one that asked.
  filesTest("a switch while the directory resolves leaves the listing with its session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const a = {
        key: { sessionId: SessionId.make("sess-a"), branchId: BranchId.make("branch-a") },
        dir: yield* fs.makeTempDirectoryScoped(),
        paths: ["alpha/only-a.ts"],
      }
      const b = {
        key: { sessionId: SessionId.make("sess-b"), branchId: BranchId.make("branch-b") },
        dir: yield* fs.makeTempDirectoryScoped(),
        paths: ["beta/only-b.ts"],
      }
      for (const entry of [a, b]) {
        for (const file of entry.paths) {
          yield* fs.makeDirectory(path.dirname(path.join(entry.dir, file)), { recursive: true })
          yield* fs.writeFileString(path.join(entry.dir, file), file)
        }
      }
      const bySession = new Map([
        [a.key.sessionId, a],
        [b.key.sessionId, b],
      ])
      let current = a
      let holdCwd = true
      const cwdGate = yield* Deferred.make<void>()
      yield* provideClientServices(
        Effect.gen(function* () {
          const contributions = yield* builtinFiles.setup
          const source = Option.getOrThrow(Option.fromUndefinedOr(contributions.autocomplete?.[0]))
          const ids = (filter: string) => {
            const result = source.items(filter)
            if (!Effect.isEffect(result)) return Effect.succeed(result.map((item) => item.id))
            return Effect.orDie(result).pipe(Effect.map((shown) => shown.map((item) => item.id)))
          }
          const opened = yield* Effect.forkChild(ids(""))
          yield* Effect.yieldNow
          current = b
          holdCwd = false
          yield* Deferred.succeed(cwdGate, void 0)
          yield* Fiber.join(opened)
          current = a
          expect(yield* ids("ts")).toEqual(["alpha/only-a.ts"])
        }).pipe(Effect.orDie),
        {
          workspace: {
            cwd: home,
            home,
            sessionCwd: Effect.suspend(() => {
              const dir = current.dir
              if (!holdCwd) return Effect.succeed(dir)
              return Deferred.await(cwdGate).pipe(Effect.as(dir))
            }),
          },
          currentSession: () => Option.some(current.key),
          requestEffect: (request) =>
            Effect.succeed(
              Option.match(Option.fromUndefinedOr(bySession.get(request.sessionId)), {
                onNone: () => [],
                onSome: (entry) => entry.paths,
              }),
            ),
        },
      )
    }).pipe(Effect.timeout("10 seconds")),
  )
})

describe("files popup page budget", () => {
  const page = (paths: ReadonlyArray<string>, totalMatched: number) => ({ paths, totalMatched })
  const unlistedPage = Array.from({ length: 200 }, (_, index) => `ignored/${index}.ts`)

  test("sparse matches stop at the page budget and report the ranking incomplete", () => {
    let pagesRead = 0
    const result = Effect.runSync(
      rankListed(
        () =>
          Effect.sync(() => {
            pagesRead++
            return page(unlistedPage, 100_000)
          }),
        new Set(["src/kept.ts"]),
        50,
      ),
    )
    expect(pagesRead).toBe(FINDER_PAGE_BUDGET)
    expect(result).toEqual({ kept: [], complete: false })
  })

  test("matches that end inside the budget are complete", () => {
    let pagesRead = 0
    const result = Effect.runSync(
      rankListed(
        () =>
          Effect.sync(() => {
            pagesRead++
            return page(["src/kept.ts", "ignored/x.ts"], 2)
          }),
        new Set(["src/kept.ts"]),
        50,
      ),
    )
    expect(pagesRead).toBe(1)
    expect(result).toEqual({ kept: ["src/kept.ts"], complete: true })
  })
})

describe("files popup", () => {
  filesTest(
    "an empty filter shows the listing's top level, directories labelled with a slash",
    () =>
      Effect.gen(function* () {
        const shown = yield* withFilesPopup(
          ["src/a.ts", "README.md", "src/b/c.ts", ".github/x.yml"],
          (popup) => popup.items(""),
        )
        expect(shown.map((item) => item.id)).toEqual([".github/", "README.md", "src/"])
        expect(shown.map((item) => item.label)).toEqual([".github/", "[md] README.md", "src/"])
      }).pipe(Effect.timeout("10 seconds")),
  )

  filesTest("fff ranks the listed paths", () =>
    Effect.gen(function* () {
      const shown = yield* withFilesPopup(
        ["docs/composer-notes.md", "apps/tui/src/composer.tsx", "packages/core/src/x.ts"],
        (popup) => popup.items("composer.tsx"),
      )
      expect(shown[0]?.id).toBe("apps/tui/src/composer.tsx")
      expect(shown[0]?.label).toBe("[ts] composer.tsx")
      expect(shown.map((item) => item.id)).not.toContain("packages/core/src/x.ts")
    }).pipe(Effect.timeout("10 seconds")),
  )

  filesTest("reopening the popup mid-path offers a file listed since the last open", () =>
    Effect.gen(function* () {
      const shown = yield* withFilesPopup(
        ["src/old.ts"],
        (popup) =>
          Effect.gen(function* () {
            popup.open()
            yield* popup.items("")
            yield* popup.items("src/")
            popup.relist(["src/old.ts", "src/new.ts"])
            // The popup closed; the reader reopens it on a path already typed.
            popup.open()
            return yield* popup.items("src/")
          }),
        { unlisted: ["src/new.ts"] },
      )
      expect(shown.map((item) => item.id)).toContain("src/new.ts")
    }).pipe(Effect.timeout("10 seconds")),
  )

  filesTest("a file the listing leaves out is not offered", () =>
    Effect.gen(function* () {
      const shown = yield* withFilesPopup(["src/kept.ts"], (popup) => popup.items("ts"), {
        unlisted: ["src/ignored.ts", "build/out.ts"],
      })
      expect(shown.map((item) => item.id)).toEqual(["src/kept.ts"])
    }).pipe(Effect.timeout("10 seconds")),
  )

  filesTest("a path with a space or a hash inserts quoted, a directory keeps completing", () =>
    Effect.gen(function* () {
      const inserted = yield* withFilesPopup(["my notes.md"], (popup) =>
        Effect.succeed([
          popup.insertion("my notes.md"),
          popup.insertion("issue#12.md"),
          popup.insertion("src/a.ts"),
          popup.insertion("src/"),
          popup.insertion("my dir/"),
        ]),
      )
      // A quoted directory leaves its quote open, so the popup keeps going inside it.
      expect(inserted).toEqual([
        '@"my notes.md" ',
        '@"issue#12.md" ',
        "@src/a.ts ",
        "@src/",
        '@"my dir/',
      ])
    }).pipe(Effect.timeout("10 seconds")),
  )

  filesTest("keys typed inside one open reuse its listing; the next open reads again", () =>
    Effect.gen(function* () {
      const reads = yield* withFilesPopup(["src/a.ts", "src/b.ts"], (popup) =>
        Effect.gen(function* () {
          popup.open()
          yield* popup.items("")
          yield* popup.items("s")
          yield* popup.items("sa")
          yield* popup.items("")
          const inOneOpen = popup.reads()
          popup.open()
          yield* popup.items("")
          return [inOneOpen, popup.reads()]
        }),
      )
      expect(reads).toEqual([1, 2])
    }).pipe(Effect.timeout("10 seconds")),
  )

  filesTest("typing before the first listing arrives waits for that listing", () =>
    Effect.gen(function* () {
      const open = yield* Deferred.make<void>()
      const reads = yield* withFilesPopup(
        ["src/a.ts", "src/b.ts"],
        (popup) =>
          Effect.gen(function* () {
            const typed = yield* Effect.forkChild(
              Effect.all([popup.items(""), popup.items("s"), popup.items("a.ts")], {
                concurrency: "unbounded",
              }),
            )
            yield* Effect.yieldNow
            yield* Deferred.succeed(open, void 0)
            const [top, one, two] = yield* Fiber.join(typed)
            expect(top.map((item) => item.id)).toEqual(["src/"])
            expect(one.length).toBe(2)
            expect(two[0]?.id).toBe("src/a.ts")
            return popup.reads()
          }),
        { gate: Deferred.await(open) },
      )
      expect(reads).toBe(1)
    }).pipe(Effect.timeout("10 seconds")),
  )
})

/**
 * Counts the fff finders the popup creates and destroys while `body` runs.
 * fff's own constructor is wrapped, so the count is what reached fff.
 */
const countingFinders = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const counts = { created: 0, destroyed: 0 }
    const original = FileFinder.create.bind(FileFinder)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        FileFinder.create = (options) => {
          const created = original(options)
          if (!created.ok) return created
          counts.created++
          const finder = created.value
          const destroy = finder.destroy.bind(finder)
          finder.destroy = () => {
            counts.destroyed++
            destroy()
          }
          return created
        }
      }),
      () =>
        Effect.sync(() => {
          FileFinder.create = original
        }),
    )
    const result = yield* body
    return { result, counts }
  })

describe("files popup finder", () => {
  filesTest("keys typed during the first listing share one finder, destroyed at teardown", () =>
    Effect.gen(function* () {
      const open = yield* Deferred.make<void>()
      // The popup's scope closes inside the count, so teardown is counted too.
      const { counts } = yield* countingFinders(
        Effect.scoped(
          withFilesPopup(
            ["src/a.ts", "src/b.ts"],
            (popup) =>
              Effect.gen(function* () {
                const typed = yield* Effect.forkChild(
                  Effect.all([popup.items(""), popup.items("s"), popup.items("a.ts")], {
                    concurrency: "unbounded",
                  }),
                )
                yield* Effect.yieldNow
                yield* Deferred.succeed(open, void 0)
                yield* Fiber.join(typed)
                yield* popup.items("b")
              }),
            { gate: Deferred.await(open) },
          ),
        ),
      )
      expect(counts).toEqual({ created: 1, destroyed: 1 })
    }).pipe(Effect.timeout("10 seconds")),
  )

  // Each finder holds an index and a watcher. The popup keeps one, for the
  // directory it ranks now: a key in another directory destroys the old one.
  filesTest("a key in another directory destroys the finder of the one before", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const dirs = [
        yield* fs.makeTempDirectoryScoped(),
        yield* fs.makeTempDirectoryScoped(),
        yield* fs.makeTempDirectoryScoped(),
      ]
      for (const dir of dirs) yield* fs.writeFileString(path.join(dir, "note.md"), "note")
      let cwd = dirs[0] ?? ""
      const { counts } = yield* countingFinders(
        provideClientServices(
          Effect.gen(function* () {
            const contributions = yield* builtinFiles.setup
            const source = Option.getOrThrow(
              Option.fromUndefinedOr(contributions.autocomplete?.[0]),
            )
            for (const dir of dirs) {
              cwd = dir
              const result = source.items("note")
              if (Effect.isEffect(result)) yield* result
            }
          }).pipe(Effect.orDie),
          {
            workspace: { cwd: home, home, sessionCwd: Effect.sync(() => cwd) },
            currentSession: () => Option.some(session),
            requestEffect: () => Effect.succeed(["note.md"]),
          },
        ),
      )
      // Three directories, three finders; only the last one is still alive.
      expect(counts).toEqual({ created: 3, destroyed: 2 })
    }).pipe(Effect.timeout("10 seconds")),
  )

  // A key is still waiting on its finder's scan when a key in another
  // directory destroys that finder. fff answers the destroyed finder with an
  // error, and the first key ranks its own listing instead: its files, and no
  // failure for the reader.
  filesTest("a key whose finder is destroyed mid-ranking falls back to its listing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const first = yield* fs.makeTempDirectoryScoped()
      const second = yield* fs.makeTempDirectoryScoped()
      for (const dir of [first, second]) {
        yield* fs.writeFileString(path.join(dir, "note.md"), "note")
      }
      // The first finder's scan waits on this hold.
      const scan = yield* makePromiseHold
      let destroyedWhileWaiting = false
      const original = FileFinder.create.bind(FileFinder)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let created = 0
          FileFinder.create = (options) => {
            const made = original(options)
            if (!made.ok || created++ > 0) return made
            const finder = made.value
            const waitForScan = finder.waitForScan.bind(finder)
            finder.waitForScan = (timeoutMs) => scan.hold(() => waitForScan(timeoutMs))
            const destroy = finder.destroy.bind(finder)
            finder.destroy = () => {
              destroyedWhileWaiting = true
              destroy()
            }
            return made
          }
        }),
        () =>
          Effect.sync(() => {
            FileFinder.create = original
          }),
      )
      let cwd = first
      const ranked = yield* provideClientServices(
        Effect.gen(function* () {
          const contributions = yield* builtinFiles.setup
          const source = Option.getOrThrow(Option.fromUndefinedOr(contributions.autocomplete?.[0]))
          const items = (filter: string) => {
            const result = source.items(filter)
            if (Effect.isEffect(result)) return Effect.orDie(result)
            return Effect.succeed(result)
          }
          const waiting = yield* Effect.forkChild(items("note"))
          // The first key holds its finder and waits on the gated scan.
          yield* scan.started
          cwd = second
          yield* items("note")
          // The second key destroyed the first finder before its scan ended.
          const destroyedFirst = destroyedWhileWaiting
          yield* scan.release
          return { destroyedFirst, items: yield* Fiber.join(waiting) }
        }),
        {
          workspace: { cwd: home, home, sessionCwd: Effect.sync(() => cwd) },
          currentSession: () => Option.some(session),
          requestEffect: () => Effect.succeed(["note.md"]),
        },
      )
      expect(ranked.destroyedFirst).toBe(true)
      expect(ranked.items.map((item) => item.id)).toEqual(["note.md"])
    }).pipe(Effect.timeout("4 seconds")),
  )

  // The session is rooted outside the launch directory, and fff resolves a
  // relative pick against the process's directory. The pick names the
  // session's file, so the next ranking puts it first.
  filesTest("a pick in a session rooted elsewhere raises that file for the same query", () =>
    Effect.gen(function* () {
      const files = ["pick/zeta-note.md", "pick/alpha-note.md"]
      const picked = yield* withFilesPopup(files, (popup) =>
        Effect.gen(function* () {
          yield* popup.items("")
          const first = (yield* popup.items("note")).map((item) => item.id)
          const other = Option.getOrThrow(
            Option.fromUndefinedOr(first.find((id) => id !== first[0])),
          )
          for (let i = 0; i < 5; i++) popup.select(other, "note")
          const second = (yield* popup.items("note")).map((item) => item.id)
          return { first, other, second }
        }),
      )
      expect(picked.first.length).toBe(2)
      expect(picked.second[0]).toBe(picked.other)
    }).pipe(Effect.timeout("10 seconds")),
  )
})

/** A `ClientContext` layer over a test transport; `deps` replaces any default. */
const contextLayer = (deps: Partial<ClientContextDeps> = {}) =>
  makeClientContextLayer({
    transport: makeClientTestTransport({ currentSession: () => Option.none() }),
    workspace: { cwd: "/nonexistent/test-cwd", home: "/nonexistent/test-home" },
    shell: { cast: createMockRuntime().cast, pane: makePaneSlot() },
    ...deps,
  })

// ── driver transport ────────────────────────────────────────────────────────

/**
 * `/driver` routes through `transport.driverSet/driverClear`; the server
 * validates the driver id.
 *
 * The transport seals every shell RPC failure into a
 * `ClientTransportRequestError` that names the RPC and keeps the server's
 * tagged error as `cause`; the slash command reports that failure through
 * `shell.notify`, and a change that lands reports nothing.
 */

class DriverRejected extends Schema.TaggedError<DriverRejected>()("DriverRejected", {
  driverId: Schema.String,
}) {}

const absent = Option.getOrUndefined(Option.none())
const agentName = AgentName.make("main")
const session = { sessionId: SessionId.make("sess-1"), branchId: BranchId.make("branch-1") }

/**
 * Run the `/driver` slash once. Resolves with the notices the shell received
 * once `settled` completes: the transport call the test waits on, or the
 * first notice.
 */
const runDriverSlash = (
  transport: ReturnType<typeof makeClientTestTransport>,
  args: string,
  settled: Deferred.Deferred<void>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const notices: Array<string> = []
    const contributions = yield* runClientExtensionSetupWithRuntime(builtinDriver, {
      transport,
      shell: {
        notify: (message) => {
          notices.push(message)
          Deferred.doneUnsafe(settled, Effect.void)
        },
      },
    })
    const command = Option.fromUndefinedOr(contributions.commands).pipe(
      Option.flatMap((commands) => Option.fromUndefinedOr(commands[0])),
      Option.flatMap((entry) => Option.fromUndefinedOr(entry.onSlash)),
    )
    expect(Option.isSome(command)).toBe(true)
    if (Option.isSome(command)) command.value(args)
    yield* Deferred.await(settled)
    return notices
  })

describe("driver routing through the client transport", () => {
  it.live(
    "driverSet keeps the server's tagged error as the cause of ClientTransportRequestError",
    () => {
      const rejected = new DriverRejected({ driverId: "model:nope" })
      const transport = makeClientTestTransport({ currentSession: () => Option.none() })
      const client = createMockClient({ driver: { set: () => Effect.fail(rejected) } })
      const layer = contextLayer({
        transport: { ...transport, client, runtime: createMockRuntime() },
      })
      return Effect.gen(function* () {
        const { transport: service } = yield* ClientContext
        const error = yield* service
          .driverSet({ agentName, driverId: "model:nope" })
          .pipe(Effect.flip)
        expect(error._tag).toBe("ClientTransportRequestError")
        expect(error.tag).toBe("driver.set")
        const cause = Option.fromUndefinedOr(error.cause)
        expect(Option.isSome(cause)).toBe(true)
        if (Option.isSome(cause)) expect(cause.value).toBe(rejected)
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("/driver <agent> <known-id> sets the override without a notice", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>()
      const seen: Array<{ readonly agentName: string; readonly driverId: string }> = []
      const client = createMockClient({
        driver: {
          set: (input: { agentName: AgentName; driver: { id: string } }) => {
            seen.push({ agentName: input.agentName, driverId: input.driver.id })
            return Deferred.succeed(settled, absent)
          },
        },
      })
      const transport = {
        ...makeClientTestTransport({ currentSession: () => Option.some(session) }),
        client,
      }
      const notices = yield* runDriverSlash(transport, "main model:sonnet", settled).pipe(
        Effect.timeout("5 seconds"),
      )
      expect(notices).toEqual([])
      expect(seen).toEqual([{ agentName: "main", driverId: "model:sonnet" }])
    }),
  )

  it.live("/driver reports the transport error tag when driver.set is rejected", () =>
    Effect.gen(function* () {
      const client = createMockClient({
        driver: {
          set: () => Effect.fail(new DriverRejected({ driverId: "model:sonnet" })),
        },
      })
      const transport = {
        ...makeClientTestTransport({ currentSession: () => Option.some(session) }),
        client,
      }
      const notices = yield* runDriverSlash(
        transport,
        "main model:sonnet",
        yield* Deferred.make<void>(),
      ).pipe(Effect.timeout("5 seconds"))
      const notice = notices.join("\n")
      expect(notice).toContain("Failed to set driver:")
      expect(notice).toContain("ClientTransportRequestError")
      expect(notice).toContain("DriverRejected")
    }),
  )

  it.live("/driver <agent> default clears the override without a notice", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>()
      const cleared: Array<string> = []
      const client = createMockClient({
        driver: {
          clear: (input: { agentName: AgentName }) => {
            cleared.push(input.agentName)
            return Deferred.succeed(settled, absent)
          },
        },
      })
      const transport = {
        ...makeClientTestTransport({ currentSession: () => Option.some(session) }),
        client,
      }
      const notices = yield* runDriverSlash(transport, "main default", settled).pipe(
        Effect.timeout("5 seconds"),
      )
      expect(notices).toEqual([])
      expect(cleared).toEqual(["main"])
    }),
  )

  it.live("/driver with a malformed argument notifies the usage hint", () =>
    Effect.gen(function* () {
      const transport = makeClientTestTransport({ currentSession: () => Option.some(session) })
      const notices = yield* runDriverSlash(transport, "main", yield* Deferred.make<void>()).pipe(
        Effect.timeout("5 seconds"),
      )
      expect(notices).toEqual(["Usage: /driver <agent> <driver-id|default>"])
    }),
  )
})

// ── ../herdr-test-server-boundary ───────────────────────────────────────────

/** Local socket boundary for Herdr acceptance tests. */

const Request = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.Struct({
    pane_id: Schema.String,
    source: Schema.String,
    agent: Schema.String,
    seq: Schema.Finite,
    state: Schema.optional(Schema.String),
    agent_session_id: Schema.optional(Schema.String),
  }),
})
const decode = Schema.decodeOption(Schema.fromJsonString(Request))
const encodeReply = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, result: Schema.Struct({}) })),
)

export const makeHerdrTestServer = Effect.fn("Test.makeHerdrServer")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-herdr-" })
  const socketPath = path.join(directory, "s")
  const requests = yield* Queue.unbounded<typeof Request.Type>()
  let respond = true
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      // eslint-disable-next-line effect/noGlobals -- Real Unix socket peer at the test platform boundary.
      Bun.listen<{ buffer: string }>({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.data = { buffer: "" }
          },
          data(socket, chunk) {
            socket.data.buffer += chunk.toString()
            const end = socket.data.buffer.indexOf("\n")
            if (end < 0) return
            const request = decode(socket.data.buffer.slice(0, end))
            if (request._tag === "None") {
              socket.end()
              return
            }
            Queue.offerUnsafe(requests, request.value)
            if (respond) socket.end(`${encodeReply({ id: request.value.id, result: {} })}\n`)
          },
        },
      }),
    ),
    (listener) => Effect.sync(() => listener.stop(true)),
  )
  return {
    target: { socketPath, paneId: "test:p1" },
    next: Queue.take(requests),
    pauseReplies: () => {
      respond = false
    },
    resumeReplies: () => {
      respond = true
    },
    stop: () => server.stop(true),
  }
})

// ── herdr ───────────────────────────────────────────────────────────────────

const config = (socketPath: string) =>
  ConfigProvider.fromUnknown({
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: "test:p1",
  })

describe("Herdr integration", () => {
  it.scopedLive("reports the active UI state and session changes, then releases the pane", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      const [snapshot, setSnapshot] = createSignal<ClientActivitySnapshot>({
        sessionId: SessionId.make("session-a"),
        state: "working",
      })
      const cleanups: Array<() => void> = []
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      )
      const context = yield* Layer.buildWithScope(
        contextLayer({ activity: snapshot, lifecycle: { addCleanup: (fn) => cleanups.push(fn) } }),
        scope,
      )
      yield* builtinHerdr.setup.pipe(
        Effect.provideContext(context),
        Effect.provideService(ConfigProvider.ConfigProvider, config(server.target.socketPath)),
      )
      const first = yield* server.next
      expect(first.params).toMatchObject({
        source: "herdr:gent",
        agent: "gent",
        state: "working",
        agent_session_id: "session-a",
      })
      for (const state of [
        "blocked",
        "working",
        "idle",
      ] satisfies ClientActivitySnapshot["state"][]) {
        yield* Effect.sync(() => setSnapshot({ sessionId: SessionId.make("session-a"), state }))
        expect((yield* server.next).params.state).toBe(state)
      }
      yield* Effect.sync(() =>
        setSnapshot({ sessionId: SessionId.make("session-b"), state: "idle" }),
      )
      const switched = yield* server.next
      expect(switched.params.agent_session_id).toBe("session-b")
      expect(switched.params.seq).toBeGreaterThan(first.params.seq)
      yield* Effect.sync(() => {
        for (const cleanup of cleanups) cleanup()
      })
      yield* Scope.close(scope, Exit.void)
      const release = yield* server.next
      expect(release.method).toBe("pane.release_agent")
      expect(release.params.seq).toBeGreaterThan(switched.params.seq)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("release follows an in-flight report and discards queued reports", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.pauseReplies()
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      )
      const reporter = yield* makeHerdrReporter(server.target).pipe(Scope.provide(scope))
      reporter.report({ state: "working" })
      const first = yield* server.next
      reporter.report({ state: "idle" })
      server.resumeReplies()
      yield* Scope.close(scope, Exit.void)
      reporter.report({ state: "working" })
      const last = yield* server.next
      expect(last.method).toBe("pane.release_agent")
      expect(last.params.seq).toBeGreaterThan(first.params.seq)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("a missing socket does not fail setup or shutdown", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.stop()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reporter = yield* makeHerdrReporter(server.target)
          reporter.report({ state: "working" })
        }),
      )
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
  )

  it.scopedLive("shutdown is bounded when Herdr never replies", () =>
    Effect.gen(function* () {
      const server = yield* makeHerdrTestServer()
      server.pauseReplies()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reporter = yield* makeHerdrReporter(server.target)
          reporter.report({ state: "working" })
          yield* server.next
        }),
      )
      expect((yield* server.next).method).toBe("pane.release_agent")
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("3 seconds")),
  )

  it.live("does nothing outside Herdr, without pane identity, or in headless mode", () =>
    Effect.gen(function* () {
      for (const env of [
        {},
        { HERDR_ENV: "1" },
        { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/unused", HERDR_PANE_ID: "test:p1" },
        { HERDR_ENV: "0", HERDR_SOCKET_PATH: "/unused", HERDR_PANE_ID: "test:p1" },
      ]) {
        const result = yield* builtinHerdr.setup.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)),
        )
        expect(result).toBeDefined()
      }
    }).pipe(Effect.provide(contextLayer())),
  )
})

describe("skills popup", () => {
  filesTest("a pick made just before the TUI closes is on disk when it has closed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      yield* Effect.scoped(
        provideClientServices(
          Effect.gen(function* () {
            const contributions = yield* builtinSkills.setup
            const source = Option.getOrThrow(
              Option.fromUndefinedOr(contributions.autocomplete?.[0]),
            )
            Option.getOrThrow(Option.fromUndefinedOr(source.onSelect))("triage", "tri")
          }),
          { workspace: { cwd: home, home } },
        ),
      )
      const stored = yield* readFrecencyStore(home)
      expect(
        Option.match(stored, { onNone: () => [], onSome: (store) => Object.keys(store.entries) }),
      ).toEqual(["$triage"])
    }).pipe(Effect.timeout("10 seconds")),
  )
})
