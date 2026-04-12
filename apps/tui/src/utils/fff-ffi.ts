/**
 * bun:ffi bindings for libfff_c — the Rust native file finder from fff.nvim.
 *
 * Replaces the Node.js ffi-rs binding from @ff-labs/fff-node which segfaults
 * in Bun. Uses bun:ffi (dlopen) to call the same libfff_c.dylib directly.
 *
 * Struct layouts derived from the #[repr(C)] definitions in the fff-c crate
 * and validated against the ffi-rs reference binding.
 */

// @effect-diagnostics nodeBuiltinImport:off
import { join } from "node:path"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, readdirSync } from "node:fs"
import { dlopen, FFIType, ptr, read as _read, CString, type Pointer } from "bun:ffi"

// bun:ffi types use branded Pointer for everything, but read.ptr() returns number
// at runtime. Loosen the read API to accept number addresses for struct field access.
const read = _read as unknown as {
  u8: (ptr: number, offset: number) => number
  u32: (ptr: number, offset: number) => number
  i32: (ptr: number, offset: number) => number
  u64: (ptr: number, offset: number) => bigint
  i64: (ptr: number, offset: number) => bigint
  ptr: (ptr: number, offset: number) => number
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileItem {
  readonly path: string
  readonly relativePath: string
  readonly fileName: string
  readonly gitStatus: string
  readonly size: number
  readonly modified: number
  readonly accessFrecencyScore: number
  readonly modificationFrecencyScore: number
  readonly totalFrecencyScore: number
}

export interface Score {
  readonly total: number
  readonly baseScore: number
  readonly filenameBonus: number
  readonly specialFilenameBonus: number
  readonly frecencyBoost: number
  readonly distancePenalty: number
  readonly currentFilePenalty: number
  readonly comboMatchBoost: number
  readonly exactMatch: boolean
  readonly matchType: string
}

export interface Location {
  readonly type: "line" | "position" | "range"
  readonly line: number
  readonly col?: number
  readonly endLine?: number
  readonly endCol?: number
}

export interface SearchResult {
  readonly items: ReadonlyArray<FileItem>
  readonly scores: ReadonlyArray<Score>
  readonly totalMatched: number
  readonly totalFiles: number
  readonly location?: Location
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Library resolution
// ---------------------------------------------------------------------------

/** Resolve the platform-specific native binary path from @ff-labs/fff-bin-* */
function findBinaryPath(): string | undefined {
  const { platform, arch } = process
  const platformMap = {
    "darwin-arm64": { pkg: "fff-bin-darwin-arm64", lib: "libfff_c.dylib" },
    "darwin-x64": { pkg: "fff-bin-darwin-x64", lib: "libfff_c.dylib" },
    "linux-x64": { pkg: "fff-bin-linux-x64-gnu", lib: "libfff_c.so" },
    "linux-arm64": { pkg: "fff-bin-linux-arm64-gnu", lib: "libfff_c.so" },
  } as const
  const key = `${platform}-${arch}` as keyof typeof platformMap
  if (!(key in platformMap)) return undefined
  const { pkg, lib } = platformMap[key]

  // Bun stores optional deps under node_modules/.bun/@scope+name@version/...
  // Walk the .bun directory to find the binary

  // Try standard require.resolve first
  try {
    const resolved = require.resolve(`@ff-labs/${pkg}/package.json`)
    const candidate = join(resolved, "..", lib)
    if (existsSync(candidate)) return candidate
  } catch {
    // Expected in Bun — optional deps aren't resolvable via require
  }

  // Walk node_modules/.bun/ for the platform binary
  // Start from the package root and walk up to find node_modules
  let dir = import.meta.dir
  for (let i = 0; i < 10; i++) {
    const bunDir = join(dir, "node_modules", ".bun")
    try {
      for (const entry of readdirSync(bunDir)) {
        if (entry.includes(pkg)) {
          const candidate = join(bunDir, entry, "node_modules", "@ff-labs", pkg, lib)
          if (existsSync(candidate)) return candidate
        }
      }
    } catch {
      // No .bun dir here, keep going up
    }
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Library loading
// ---------------------------------------------------------------------------

let lib: ReturnType<typeof openLibrary> | undefined

function openLibrary() {
  const binaryPath = findBinaryPath()
  if (binaryPath === undefined) throw new Error("fff native binary not found for this platform")

  return dlopen(binaryPath, {
    fff_create_instance: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.bool,
        FFIType.bool,
        FFIType.bool,
      ],
      returns: FFIType.ptr,
    },
    fff_destroy: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    fff_wait_for_scan: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.ptr,
    },
    fff_is_scanning: {
      args: [FFIType.ptr],
      returns: FFIType.bool,
    },
    fff_scan_files: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    fff_search: {
      args: [
        FFIType.ptr,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.f64,
        FFIType.u32,
      ],
      returns: FFIType.ptr,
    },
    fff_search_result_get_item: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.ptr,
    },
    fff_search_result_get_score: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.ptr,
    },
    fff_track_query: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.cstring],
      returns: FFIType.ptr,
    },
    fff_free_result: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    fff_free_search_result: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    fff_free_string: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    fff_restart_index: {
      args: [FFIType.ptr, FFIType.cstring],
      returns: FFIType.ptr,
    },
    fff_health_check: {
      args: [FFIType.ptr, FFIType.cstring],
      returns: FFIType.ptr,
    },
  })
}

function getLib() {
  if (lib === undefined) lib = openLibrary()
  return lib
}

// ---------------------------------------------------------------------------
// Helpers — null-terminated string encoding + struct reading
// ---------------------------------------------------------------------------

/**
 * Cast a bun:ffi Pointer to a numeric address for read.* functions.
 * At runtime Pointer is already a number — this is a type-level bridge.
 */
const ptrNum = (p: Pointer | null): number => p as unknown as number

/** Encode a string as a null-terminated buffer suitable for FFI cstring args */
const encode = (s: string): Buffer => Buffer.from(s + "\0")

/** Read a null-terminated C string from a numeric pointer address, or null if 0 */
function readCStr(p: number): string | null {
  if (p === 0) return null
  try {
    return new CString(numPtr(p)).toString()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// FffResult struct reading
//
// #[repr(C)] layout (40 bytes, validated by hex dump):
//   offset  0: success   u8 (1 byte + 7 padding)
//   offset  8: error     *mut c_char
//   offset 16: handle    *mut c_void
//   offset 24: int_value i64
// ---------------------------------------------------------------------------

interface FffResultFields {
  success: boolean
  error: string | null
  handle: number
  intValue: number
}

function readFffResult(p: Pointer | null): FffResultFields {
  const addr = ptrNum(p)
  return {
    success: read.u8(addr, 0) !== 0,
    error: readCStr(read.ptr(addr, 8)),
    handle: read.ptr(addr, 16),
    intValue: Number(read.i64(addr, 24)),
  }
}

// ---------------------------------------------------------------------------
// FffFileItem struct reading
//
// #[repr(C)] layout (80 bytes):
//   offset  0: path                      *mut c_char
//   offset  8: relative_path             *mut c_char
//   offset 16: file_name                 *mut c_char
//   offset 24: git_status                *mut c_char
//   offset 32: size                      u64
//   offset 40: modified                  u64
//   offset 48: access_frecency_score     i64
//   offset 56: modification_frecency_score i64
//   offset 64: total_frecency_score      i64
//   offset 72: is_binary                 u8 (+ 7 padding)
// ---------------------------------------------------------------------------

function readFileItem(p: number): FileItem {
  return {
    path: readCStr(read.ptr(p, 0)) ?? "",
    relativePath: readCStr(read.ptr(p, 8)) ?? "",
    fileName: readCStr(read.ptr(p, 16)) ?? "",
    gitStatus: readCStr(read.ptr(p, 24)) ?? "",
    size: Number(read.u64(p, 32)),
    modified: Number(read.u64(p, 40)),
    accessFrecencyScore: Number(read.i64(p, 48)),
    modificationFrecencyScore: Number(read.i64(p, 56)),
    totalFrecencyScore: Number(read.i64(p, 64)),
  }
}

// ---------------------------------------------------------------------------
// FffScore struct reading
//
// #[repr(C)] layout (48 bytes):
//   offset  0: total                 i32
//   offset  4: base_score            i32
//   offset  8: filename_bonus        i32
//   offset 12: special_filename_bonus i32
//   offset 16: frecency_boost        i32
//   offset 20: distance_penalty      i32
//   offset 24: current_file_penalty  i32
//   offset 28: combo_match_boost     i32
//   offset 32: exact_match           u8 (+ 7 padding)
//   offset 40: match_type            *mut c_char
// ---------------------------------------------------------------------------

function readScore(p: number): Score {
  return {
    total: read.i32(p, 0),
    baseScore: read.i32(p, 4),
    filenameBonus: read.i32(p, 8),
    specialFilenameBonus: read.i32(p, 12),
    frecencyBoost: read.i32(p, 16),
    distancePenalty: read.i32(p, 20),
    currentFilePenalty: read.i32(p, 24),
    comboMatchBoost: read.i32(p, 28),
    exactMatch: read.u8(p, 32) !== 0,
    matchType: readCStr(read.ptr(p, 40)) ?? "",
  }
}

// ---------------------------------------------------------------------------
// FffSearchResult struct reading
//
// #[repr(C)] layout:
//   offset  0: items         *mut FffFileItem
//   offset  8: scores        *mut FffScore
//   offset 16: count         u32
//   offset 20: total_matched u32
//   offset 24: total_files   u32
//   offset 28: location_tag  u8 (+ 3 padding)
//   offset 32: location_line i32
//   offset 36: location_col  i32
//   offset 40: location_end_line i32
//   offset 44: location_end_col  i32
// ---------------------------------------------------------------------------

function readSearchResultHeader(p: number) {
  return {
    count: read.u32(p, 16),
    totalMatched: read.u32(p, 20),
    totalFiles: read.u32(p, 24),
    locationTag: read.u8(p, 28),
    locationLine: read.i32(p, 32),
    locationCol: read.i32(p, 36),
    locationEndLine: read.i32(p, 40),
    locationEndCol: read.i32(p, 44),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Opaque native handle — a Pointer at the type level, number at runtime. */
export type NativeHandle = Pointer

/** Cast a numeric address back to a Pointer for FFI calls. */
const numPtr = (n: number): Pointer => n as unknown as Pointer

/** Create a new file finder instance. */
export function create(opts: {
  basePath: string
  frecencyDbPath?: string
  historyDbPath?: string
  aiMode?: boolean
}): Result<NativeHandle> {
  const { symbols } = getLib()
  const basePath = encode(opts.basePath)
  const frecencyDb = encode(opts.frecencyDbPath ?? "")
  const historyDb = encode(opts.historyDbPath ?? "")

  const resultPtr = symbols.fff_create_instance(
    ptr(basePath),
    ptr(frecencyDb),
    ptr(historyDb),
    false, // useUnsafeNoLock
    false, // warmupMmapCache
    opts.aiMode ?? true,
  )

  const r = readFffResult(resultPtr)
  symbols.fff_free_result(resultPtr)

  if (!r.success) return { ok: false, error: r.error ?? "Unknown error" }
  if (r.handle === 0) return { ok: false, error: "create returned null handle" }
  return { ok: true, value: numPtr(r.handle) }
}

/** Wait for the initial file scan to complete. */
export function waitForScan(handle: NativeHandle, timeoutMs: number): Result<boolean> {
  const { symbols } = getLib()
  const resultPtr = symbols.fff_wait_for_scan(handle, timeoutMs)
  const r = readFffResult(resultPtr)
  symbols.fff_free_result(resultPtr)
  if (!r.success) return { ok: false, error: r.error ?? "scan failed" }
  return { ok: true, value: r.intValue !== 0 }
}

/** Check if the finder is currently scanning. */
export function isScanning(handle: NativeHandle): boolean {
  return getLib().symbols.fff_is_scanning(handle)
}

/** Perform a fuzzy file search. */
export function search(
  handle: NativeHandle,
  query: string,
  opts?: { pageSize?: number; currentFile?: string },
): Result<SearchResult> {
  const { symbols } = getLib()
  const q = encode(query)
  const currentFile = encode(opts?.currentFile ?? "")
  const pageSize = opts?.pageSize ?? 50

  const resultPtr = symbols.fff_search(
    handle,
    ptr(q),
    ptr(currentFile),
    0, // max_threads (0 = auto)
    0, // page_index
    pageSize,
    1.5, // combo_boost_multiplier
    2, // min_combo_count
  )

  // Read FffResult envelope
  const envelope = readFffResult(resultPtr)
  symbols.fff_free_result(resultPtr)

  if (!envelope.success) return { ok: false, error: envelope.error ?? "search failed" }
  if (envelope.handle === 0) return { ok: false, error: "search returned null result" }

  const searchResultAddr = envelope.handle

  // Read FffSearchResult header
  const header = readSearchResultHeader(searchResultAddr)

  // Read items and scores via accessor functions
  const items: FileItem[] = []
  const scores: Score[] = []
  const searchResultPtr = numPtr(searchResultAddr)
  for (let i = 0; i < header.count; i++) {
    const itemPtr = symbols.fff_search_result_get_item(searchResultPtr, i)
    items.push(readFileItem(ptrNum(itemPtr)))
    const scorePtr = symbols.fff_search_result_get_score(searchResultPtr, i)
    scores.push(readScore(ptrNum(scorePtr)))
  }

  // Parse location
  let location: Location | undefined
  if (header.locationTag === 1) {
    location = { type: "line", line: header.locationLine }
  } else if (header.locationTag === 2) {
    location = { type: "position", line: header.locationLine, col: header.locationCol }
  } else if (header.locationTag === 3) {
    location = {
      type: "range",
      line: header.locationLine,
      col: header.locationCol,
      endLine: header.locationEndLine,
      endCol: header.locationEndCol,
    }
  }

  // Free native search result
  symbols.fff_free_search_result(searchResultPtr)

  const result: SearchResult = {
    items,
    scores,
    totalMatched: header.totalMatched,
    totalFiles: header.totalFiles,
  }
  if (location !== undefined) return { ok: true, value: { ...result, location } }
  return { ok: true, value: result }
}

/** Track a query + selected file path for frecency learning. */
export function trackQuery(handle: NativeHandle, query: string, filePath: string): Result<boolean> {
  const { symbols } = getLib()
  const q = encode(query)
  const fp = encode(filePath)
  const resultPtr = symbols.fff_track_query(handle, ptr(q), ptr(fp))
  const r = readFffResult(resultPtr)
  symbols.fff_free_result(resultPtr)
  if (!r.success) return { ok: false, error: r.error ?? "trackQuery failed" }
  return { ok: true, value: r.intValue !== 0 }
}

/** Destroy a file finder instance and free all native resources. */
export function destroy(handle: NativeHandle): void {
  getLib().symbols.fff_destroy(handle)
}

/** Check if the native library is available on this platform. */
export function isAvailable(): boolean {
  try {
    getLib()
    return true
  } catch {
    return false
  }
}
