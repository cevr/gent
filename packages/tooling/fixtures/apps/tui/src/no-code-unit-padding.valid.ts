export const columns = [
  "ascii".padEnd(8),
  String(42).padStart(4, "0"),
  ((value & 0x0f) | 0x40).toString(16).padStart(2, "0"),
  (cents / 100).toFixed(2).padStart(8),
  String(Math.floor(secs / 60)).padStart(2, "0"),
]
