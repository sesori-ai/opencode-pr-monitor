import type { Context } from "@deepseek-ai/cordis"
import { registerDeepSeekMonitor } from "./extension"

export const name = "pr-monitor"
export const inject = ["agents", "skills", "tools"] as const

export function apply(ctx: Context): void {
  registerDeepSeekMonitor({ ctx })
}
