import { describe, expect, it } from "effect-bun-test"
import { ConfigProvider, Effect, Layer } from "effect"
import { GentTracerLive } from "../../src/runtime/tracer"

const tracerWithConfig = (env: Record<string, string>) =>
  Layer.provide(GentTracerLive, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe("GentTracerLive", () => {
  it.live("keeps the default Effect tracer when OTLP is not configured", () =>
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      expect(span.constructor.name).not.toBe("OtelSpan")
    }).pipe(Effect.withSpan("no-otel"), Effect.provide(tracerWithConfig({}))),
  )

  it.live("installs the OpenTelemetry tracer when OTLP is configured", () =>
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      expect(span.constructor.name).toBe("OtelSpan")
    }).pipe(
      Effect.withSpan("otel"),
      Effect.provide(
        tracerWithConfig({
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
          OTEL_SERVICE_NAME: "gent-test",
        }),
      ),
    ),
  )
})
