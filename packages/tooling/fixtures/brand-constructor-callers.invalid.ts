// @ts-nocheck — fixture file
// EXPECTED: rule `gent/brand-constructor-callers` fires
// This file is not the authorised composition root for any brand.
import {
  brandServerScope,
  brandCwdScope,
  brandEphemeralScope,
} from "../../core/src/runtime/scope-brands.js"

export const a = brandServerScope({} as never)
export const b = brandCwdScope({} as never)
export const c = brandEphemeralScope({} as never)
