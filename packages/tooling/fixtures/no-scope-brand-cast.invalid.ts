// @ts-nocheck — fixture file
// EXPECTED: rule `gent/no-scope-brand-cast` fires three times.
import type {
  ServerProfile,
  CwdProfile,
  EphemeralProfile,
} from "../../core/src/runtime/scope-brands.js"

declare const obj: unknown

export const a = obj as ServerProfile
export const b = obj as CwdProfile
export const c = obj as EphemeralProfile
