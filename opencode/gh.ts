// GitHub CLI runner for OpenCode's injected Bun shell.

import type { PluginInput } from "@opencode-ai/plugin"
import { ghHttpStatus, PollError, type GhRunner } from "../core/github"

export function createOpenCodeGhRunner({ shell }: { shell: PluginInput["$"] }): GhRunner {
  return async (args) => {
    const result = await shell`gh ${args}`.quiet().nothrow()
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      const message = stderr || `gh exited with code ${result.exitCode}`
      const notFound = /could not resolve to|not found|404/i.test(message) && !/could not resolve host/i.test(message)
      throw new PollError(message, {
        notFound,
        httpStatus: ghHttpStatus({ message }),
        exitCode: result.exitCode,
      })
    }
    return result.stdout.toString()
  }
}
