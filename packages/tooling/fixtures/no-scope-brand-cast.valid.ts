// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-scope-brand-cast` does NOT fire.
// Casting to non-scope-brand types is fine.
declare const obj: unknown

export const a = obj as { id: string }
export const b = obj as Array<number>
