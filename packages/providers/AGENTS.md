# Providers Guidelines

## Supported Providers

- `anthropic/` - Direct Anthropic API
- `openai/` - OpenAI API
- `bedrock/` - AWS Bedrock (uses `~/.aws/credentials` via `fromIni()`)

## Methods

- `stream(request)` - Streaming chat with tools
- `generate(request)` - Simple text generation, no streaming

## Tool Schema Conversion

`JSONSchema.make(schema)` + AI SDK `jsonSchema()` wrapper. Effect's `standardSchemaV1` lacks `~standard.jsonSchema`.

## Stream.async Pattern

```typescript
Stream.async((emit) => {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  ;(async () => {
    await emit.single(chunk) // Must await
    await emit.end()
  })()
})
```

## AI SDK + exactOptionalPropertyTypes

Can't pass `undefined` for optional fields. Build opts object conditionally:

```typescript
const opts: Parameters<typeof generateText>[0] = { model, prompt }
if (systemPrompt) opts.system = systemPrompt
if (maxTokens) opts.maxOutputTokens = maxTokens
```
