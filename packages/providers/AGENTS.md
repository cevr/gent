# Providers Guidelines

## Supported Providers

- `anthropic/` - Direct Anthropic API
- `openai/` - OpenAI API
- `bedrock/` - AWS Bedrock (uses `~/.aws/credentials` via `fromIni()`)

## Tool Schema Conversion

`JSONSchema.make(schema)` + AI SDK `jsonSchema()` wrapper. Effect's `standardSchemaV1` lacks `~standard.jsonSchema`.

## Stream.async Pattern

```typescript
Stream.async((emit) => {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  ;(async () => {
    await emit.single(chunk)  // Must await
    await emit.end()
  })()
})
```
