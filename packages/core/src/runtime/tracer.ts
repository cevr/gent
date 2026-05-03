/**
 * Effect Tracer wiring.
 *
 * If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, exports spans via OTLP/JSON.
 * Otherwise the Effect default Tracer (a no-op) is left in place.
 */

import { Config, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

const otlpEndpoint = Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"))
const otlpServiceName = Config.option(Config.string("OTEL_SERVICE_NAME"))

export const GentTracerLive: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* otlpEndpoint
    if (Option.isNone(endpoint)) return Layer.empty
    const serviceName = Option.getOrElse(yield* otlpServiceName, () => "gent")
    return OtlpTracer.layer({
      url: `${endpoint.value.replace(/\/$/, "")}/v1/traces`,
      resource: { serviceName },
    }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
  }).pipe(Effect.catchEager(() => Effect.succeed(Layer.empty))),
)
