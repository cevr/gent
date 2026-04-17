import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Path } from "effect"
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import * as Os from "node:os"
import type {
  ExtensionLoadError,
  GentExtension,
  LoadedExtension,
} from "@gent/core/domain/extension"
import {
  reconcileLoadedExtensions,
  setupBuiltinExtensions,
  setupDiscoveredExtensions,
  validateLoadedExtensions,
} from "@gent/core/runtime/extensions/activation"
import {
  job as jobContribution,
  onStartup as onStartupContribution,
  tool as toolContribution,
  type Contribution,
} from "@gent/core/domain/contribution"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)

const makeBuiltin = (
  id: string,
  setup: () => Effect.Effect<ReadonlyArray<Contribution>, ExtensionLoadError>,
): GentExtension => ({
  manifest: { id },
  setup: () => setup(),
})

const makeLoaded = (id: string, contributions: ReadonlyArray<Contribution>): LoadedExtension => ({
  manifest: { id },
  kind: "builtin",
  sourcePath: "builtin",
  contributions,
})

describe("extension activation isolation", () => {
  it.live("builtin setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const good = makeBuiltin("good-ext", () =>
        Effect.succeed([
          toolContribution({
            name: "good_tool",
            description: "good",
            params: {} as never,
            execute: () => Effect.void,
          }),
        ]),
      )
      const bad = makeBuiltin("bad-ext", () =>
        Effect.sync(() => {
          throw new Error("setup boom")
        }),
      )

      const result = yield* setupBuiltinExtensions({
        extensions: [good, bad],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual(["good-ext"])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]!.manifest.id).toBe("bad-ext")
      expect(result.failed[0]!.phase).toBe("setup")
      expect(result.failed[0]!.error).toContain("setup boom")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live("discovered setup failure is isolated instead of crashing activation", () =>
    Effect.gen(function* () {
      const result = yield* setupDiscoveredExtensions({
        extensions: [
          {
            extension: makeBuiltin("good-ext", () => Effect.succeed([])),
            kind: "user",
            sourcePath: "/tmp/good.ts",
          },
          {
            extension: makeBuiltin("bad-ext", () =>
              Effect.sync(() => {
                throw new Error("setup boom")
              }),
            ),
            kind: "project",
            sourcePath: "/tmp/bad.ts",
          },
        ],
        cwd: "/tmp",
        home: "/tmp",
        disabled: new Set(),
      })

      expect(result.active.map((ext) => ext.manifest.id)).toEqual(["good-ext"])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0]).toMatchObject({
        manifest: { id: "bad-ext" },
        kind: "project",
        sourcePath: "/tmp/bad.ts",
        phase: "setup",
      })
      expect(result.failed[0]?.error).toContain("setup boom")
    }).pipe(Effect.provide(fsLayer)),
  )

  it.live(
    "validation collisions fail the conflicting extensions instead of crashing host activation",
    () =>
      Effect.gen(function* () {
        const result = yield* validateLoadedExtensions([
          makeLoaded("healthy-ext", [
            toolContribution({
              name: "healthy_tool",
              description: "healthy",
              params: {} as never,
              execute: () => Effect.void,
            }),
          ]),
          makeLoaded("collider-a", [
            toolContribution({
              name: "shared_tool",
              description: "a",
              params: {} as never,
              execute: () => Effect.void,
            }),
          ]),
          makeLoaded("collider-b", [
            toolContribution({
              name: "shared_tool",
              description: "b",
              params: {} as never,
              execute: () => Effect.void,
            }),
          ]),
        ])

        expect(result.active.map((ext) => ext.manifest.id)).toEqual(["healthy-ext"])
        expect(result.failed).toHaveLength(2)
        expect(result.failed.map((ext) => ext.manifest.id).sort()).toEqual([
          "collider-a",
          "collider-b",
        ])
        expect(result.failed.every((ext) => ext.phase === "validation")).toBe(true)
        expect(result.failed.every((ext) => ext.error.includes("shared_tool"))).toBe(true)
      }),
  )

  it.live("reconciler owns startup and scheduler degradation in one result", () =>
    Effect.gen(function* () {
      const home = Fs.mkdtempSync(NodePath.join(Os.tmpdir(), "gent-reconcile-"))

      const result = yield* reconcileLoadedExtensions({
        extensions: [
          makeLoaded("healthy-ext", [
            toolContribution({
              name: "healthy_tool",
              description: "healthy",
              params: {} as never,
              execute: () => Effect.void,
            }),
            jobContribution({
              id: "reflect",
              schedule: "0 21 * * 1-5",
              target: {
                kind: "headless-agent",
                agent: "memory:reflect" as never,
                prompt: "Reflect.",
              },
            }),
          ]),
          makeLoaded("failing-ext", [
            toolContribution({
              name: "failing_tool",
              description: "failing",
              params: {} as never,
              execute: () => Effect.void,
            }),
            onStartupContribution(
              Effect.sync(() => {
                throw new Error("startup boom")
              }),
            ),
          ]),
        ],
        failedExtensions: [
          {
            manifest: { id: "broken-setup" },
            kind: "user",
            sourcePath: "/tmp/broken.ts",
            phase: "setup",
            error: "setup boom",
          },
        ],
        home,
        command: ["/usr/local/bin/gent"],
        env: { HOME: home },
        schedulerRuntime: {
          install: (_entryPath, _schedule, name) =>
            name.includes("reflect")
              ? Effect.fail(new Error("cron install boom") as never)
              : Effect.void,
          remove: () => Effect.void,
        },
      })

      expect(result.resolved.extensions.map((ext) => ext.manifest.id)).toEqual(["healthy-ext"])
      expect(result.resolved.tools.size).toBe(1)
      expect(result.resolved.failedExtensions).toEqual([
        {
          manifest: { id: "broken-setup" },
          kind: "user",
          sourcePath: "/tmp/broken.ts",
          phase: "setup",
          error: "setup boom",
        },
        {
          manifest: { id: "failing-ext" },
          kind: "builtin",
          sourcePath: "builtin",
          phase: "startup",
          error: "startup boom",
        },
      ])
      expect(result.scheduledJobFailures).toHaveLength(1)
      expect(result.scheduledJobFailures[0]).toMatchObject({
        extensionId: "healthy-ext",
        jobId: "reflect",
      })
      expect(result.scheduledJobFailures[0]?.error).toContain("cron install boom")
      expect(result.resolved.extensionStatuses).toEqual([
        {
          manifest: { id: "healthy-ext" },
          kind: "builtin",
          sourcePath: "builtin",
          status: "active",
          scheduledJobFailures: [{ jobId: "reflect", error: "Error: cron install boom" }],
        },
        {
          manifest: { id: "broken-setup" },
          kind: "user",
          sourcePath: "/tmp/broken.ts",
          phase: "setup",
          error: "setup boom",
          status: "failed",
        },
        {
          manifest: { id: "failing-ext" },
          kind: "builtin",
          sourcePath: "builtin",
          phase: "startup",
          error: "startup boom",
          status: "failed",
        },
      ])
    }).pipe(Effect.provide(fsLayer)),
  )
})
