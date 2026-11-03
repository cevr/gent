/**
 * Prints this checkout's link contract as a fresh process computes it, on
 * the Bun platform: the link tests compare two runs of it with their own.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import { linkContract } from "../../src/server/link"

BunRuntime.runMain(
  linkContract.pipe(Effect.flatMap(Console.log), Effect.provide(BunGentPlatformLive)),
)
