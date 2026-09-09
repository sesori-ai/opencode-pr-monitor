import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("Hermes Python adapter and packaged worker contracts", { timeout: 60000 }, () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "test/hermes_adapter_test.py"], {
    encoding: "utf8", timeout: 55000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""))
})
