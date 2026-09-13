/**
 * Effect OpenTelemetry wiring.
 *
 * If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, exports spans via OTLP/HTTP.
 * Otherwise the Effect default Tracer (a no-op) is left in place.
 */

import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Config, Effect, Layer, Option } from "effect"

const otlpEndpoint = Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"))
const otlpServiceName = Config.option(Config.string("OTEL_SERVICE_NAME"))

export const GentTracerLive: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* otlpEndpoint
    if (Option.isNone(endpoint)) return Layer.empty
    const serviceName = Option.getOrElse(yield* otlpServiceName, () => "gent")
    const exporter = new OTLPTraceExporter({
      url: `${endpoint.value.replace(/\/$/, "")}/v1/traces`,
    })
    return NodeSdk.layer(() => ({
      resource: { serviceName },
      spanProcessor: new BatchSpanProcessor(exporter),
      shutdownTimeout: "500 millis",
    }))
  }).pipe(Effect.catchEager(() => Effect.succeed(Layer.empty))),
)
