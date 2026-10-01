// @ts-nocheck — held-shapes fixture
// Retired: the guard `findSharedTestHomes` (packages/tooling/src/guards.ts),
// with oxlint-plugin-effect 0.25. Product source is read only inside its test
// layers; the product code around them is not a test home.
import { Context, Effect, Layer } from "effect"

export class GentPlatform extends Context.Service<GentPlatform>()("GentPlatform") {
  static Live = Layer.succeed(GentPlatform, { homeDirectory: Effect.succeed("/tmp") })
  static Test = (prefix = "id"): Layer.Layer<GentPlatform> =>
    Layer.succeed(GentPlatform, {
      homeDirectory: Effect.succeed("/tmp"), // held-by: effect/noSharedTestHome
      prefix,
    })
  static readonly TestHome = Layer.succeed(GentPlatform, { home: "/tmp" })
}

export const Layers = {
  Live: Layer.succeed(GentPlatform, { home: "/tmp" }),
  Test: Layer.succeed(GentPlatform, {
    home: "/tmp", // held-by: effect/noSharedTestHome
  }),
}

export const makeTestLayer = () =>
  Layer.succeed(GentPlatform, { home: "/tmp" }) // held-by: effect/noSharedTestHome

export const FakeTestActor = (config: { readonly id: string }) =>
  Layer.succeed(GentPlatform, { home: "/tmp", config }) // held-by: effect/noSharedTestHome

export const NotesTest = Layer.succeed(GentPlatform, {
  home: "/tmp", // held-by: effect/noSharedTestHome
})

export const isTestMode = (config: { home: string }) => config.home === "/tmp"
