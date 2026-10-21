import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { expect, it } from "effect-bun-test"
import { ExtensionContext, PermitSpec, request } from "@gent/core/extensions/api"
import { PermitStatus } from "@gent/core/protocol"
import { RequestReply } from "../../src/domain/capability"
import { ExtensionId } from "../../src/domain/ids"
import type { LoadedExtension } from "../../src/domain/extension"
import {
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import {
  createRpcHarness,
  fixedSessionProfiles,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  testAgent,
  waitFor,
} from "../../src/test-utils/harness"

it.scopedLive(
  "permits.list shares a named limit across user extensions in different cwd profiles",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const entries: string[] = []
      const extensionId = ExtensionId.make("@test/user-permits")
      const makePermitExtension = (label: string): LoadedExtension => ({
        manifest: { id: extensionId },
        scope: "user",
        sourcePath: `user-${label}.ts`,
        contributions: {
          requests: [
            request({
              id: "hold",
              input: PermitSpec,
              output: Schema.String,
              execute: (spec) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  return yield* ctx.Permits.with(
                    spec.name,
                    spec.limit,
                    Effect.gen(function* () {
                      entries.push(label)
                      yield* Deferred.await(release)
                      return ctx.cwd
                    }),
                  )
                }),
            }),
          ],
        },
      })
      const alphaCwd = yield* makeTempDirectoryScoped("gent-permit-alpha-")
      const betaCwd = yield* makeTempDirectoryScoped("gent-permit-beta-")
      const profiles = Context.get(yield* Layer.build(fixedSessionProfiles()), SessionProfileCache)
      const makeProfile = (cwd: string, extension: LoadedExtension) =>
        Effect.gen(function* () {
          const base = yield* profiles.resolve(cwd)
          const resolved = resolveExtensions([extension])
          const context = yield* Layer.build(ExtensionRegistry.fromResolved(resolved))
          return {
            ...base,
            resolved,
            layerContext: context,
            registryService: Context.get(context, ExtensionRegistry),
          }
        })
      const alpha = yield* makeProfile(alphaCwd, makePermitExtension("alpha"))
      const beta = yield* makeProfile(betaCwd, makePermitExtension("beta"))
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        providerLayer,
        agents: [testAgent],
        extensions: [],
        cwd: alphaCwd,
        sessionProfileCacheLayer: fixedSessionProfiles(
          new Map([
            [alphaCwd, alpha],
            [betaCwd, beta],
          ]),
        ),
      })
      const second = yield* client.session.create({ cwd: betaCwd })
      expect(yield* client.permits.list()).toEqual([])
      const firstCall = yield* client.extension
        .request({
          sessionId,
          branchId,
          extensionId,
          capabilityId: "hold",
          input: { name: "shared-gate", limit: 1 },
        })
        .pipe(Effect.forkScoped)
      const holding = yield* waitFor(client.permits.list(), (rows) => rows[0]?.holders.length === 1)
      expect(entries).toEqual(["alpha"])
      expect(Schema.is(Schema.Array(PermitStatus))(holding)).toBe(true)
      expect(holding).toEqual([
        {
          name: "shared-gate",
          limit: 1,
          holders: [{ id: expect.any(Number), acquiredAt: expect.any(Number) }],
          waiters: [],
        },
      ])
      const secondCall = yield* client.extension
        .request({
          ...second,
          extensionId,
          capabilityId: "hold",
          input: { name: "shared-gate", limit: 1 },
        })
        .pipe(Effect.forkScoped)
      const queued = yield* waitFor(client.permits.list(), (rows) => rows[0]?.waiters.length === 1)
      expect(entries).toEqual(["alpha"])
      expect(queued).toEqual([
        {
          name: "shared-gate",
          limit: 1,
          holders: holding[0]!.holders,
          waiters: [{ id: expect.any(Number), queuedAt: expect.any(Number) }],
        },
      ])
      expect(queued[0]!.holders[0]!.id).not.toBe(queued[0]!.waiters[0]!.id)
      yield* Deferred.done(release, Exit.void)
      expect(yield* Fiber.join(firstCall)).toEqual(
        RequestReply.cases.Value.make({ value: alphaCwd }),
      )
      expect(yield* Fiber.join(secondCall)).toEqual(
        RequestReply.cases.Value.make({ value: betaCwd }),
      )
      expect(entries).toEqual(["alpha", "beta"])
      expect(yield* client.permits.list()).toEqual([])
      yield* controls.assertDone
    }).pipe(Effect.timeout("8 seconds")),
)
