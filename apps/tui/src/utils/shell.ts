/**
 * Shell execution utility with truncation and output saving
 */

import { spawn } from "bun"
import { mkdir, writeFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024 // 50KB

export interface ShellResult {
  output: string
  truncated: boolean
  savedPath?: string
}

/**
 * Execute shell command with truncation
 * If output exceeds limits, saves full output to ~/tool-output/
 */
export async function executeShell(command: string, cwd: string): Promise<ShellResult> {
  const proc = spawn(["bash", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  await proc.exited

  // Combine stdout and stderr
  const fullOutput = stderr ? `${stdout}\n${stderr}` : stdout

  // Check if truncation needed
  const lines = fullOutput.split("\n")
  const needsTruncation = lines.length > MAX_LINES || fullOutput.length > MAX_BYTES

  if (!needsTruncation) {
    return { output: fullOutput.trim(), truncated: false }
  }

  // Save full output
  const savedPath = await saveFullOutput(fullOutput, command)

  // Truncate
  let truncated = fullOutput
  if (lines.length > MAX_LINES) {
    truncated = lines.slice(0, MAX_LINES).join("\n")
  }
  if (truncated.length > MAX_BYTES) {
    truncated = truncated.slice(0, MAX_BYTES)
  }

  return {
    output: truncated.trim(),
    truncated: true,
    savedPath,
  }
}

async function saveFullOutput(output: string, command: string): Promise<string> {
  const toolOutputDir = join(homedir(), "tool-output")
  await mkdir(toolOutputDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const filename = `shell_${timestamp}.txt`
  const filepath = join(toolOutputDir, filename)

  const header = `# Command: ${command}\n# Timestamp: ${new Date().toISOString()}\n\n`
  await writeFile(filepath, header + output, "utf-8")

  return filepath
}
