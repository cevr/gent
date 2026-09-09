import { Schema } from "effect"

export const CellInput = Schema.Struct({
  code: Schema.String,
  reset: Schema.optionalKey(Schema.Boolean),
})
export interface CellInput extends Schema.Schema.Type<typeof CellInput> {}
