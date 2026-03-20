/**
 * File URL utilities for OSC8 terminal hyperlinks.
 */

export function isAbsPath(path: string): boolean {
  return path.startsWith("/")
}

export function fileUrl(path: string): string {
  return `file://${path}`
}
