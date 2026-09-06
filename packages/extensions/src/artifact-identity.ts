import { Effect, Option, Schema } from "effect"
import { LoadedArtifactIdentity } from "@gent/core/extensions/api"

/**
 * The compiled build replaces this symbol with a build-owned token before it
 * bundles the builtin extensions. Source-mode execution has no trusted build
 * boundary, so it remains unsupported for durable artifact replay.
 */
declare const __GENT_BUILTIN_ARTIFACT_ID__: unknown

const buildArtifactId = Option.flatMap(
  Effect.runSync(
    Effect.try({
      try: () => Option.some(__GENT_BUILTIN_ARTIFACT_ID__),
      catch: () => Option.none<unknown>(),
    }).pipe(Effect.catchEager(() => Effect.succeed(Option.none<unknown>()))),
  ),
  Schema.decodeUnknownOption(Schema.NonEmptyString),
)

export const BuiltinArtifactIdentity: Option.Option<LoadedArtifactIdentity> = Option.map(
  buildArtifactId,
  (value) => LoadedArtifactIdentity.make(value),
)
