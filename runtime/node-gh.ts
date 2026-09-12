// GitHub CLI runner for Node-based adapters.

import { execFile } from "node:child_process"
import { ghHttpStatus, PollError, type GhRunner } from "../core/github"

export function createNodeGhRunner(): GhRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message
          const notFound =
            /could not resolve to|not found|404/i.test(message) && !/could not resolve host/i.test(message)
          const exitCode = typeof error.code === "number" || typeof error.code === "string"
            ? error.code
            : undefined
          reject(new PollError(message, { notFound, httpStatus: ghHttpStatus({ message }), exitCode }))
          return
        }
        resolve(stdout)
      })
    })
}
