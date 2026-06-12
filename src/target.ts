// PR target identification: explicit `owner/repo#123` or full PR URL only —
// no cwd inference, the repo must always be explicit.

export type Target = { owner: string; repo: string; number: number }

const SHORT_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)#(\d+)$/
const URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/

export function parseTarget(input: string): Target | { error: string } {
  const trimmed = input.trim()
  const match = SHORT_RE.exec(trimmed) ?? URL_RE.exec(trimmed)
  if (!match) {
    return {
      error:
        `Invalid PR identifier: "${input}". Use "owner/repo#123" or a full PR URL ` +
        `(https://github.com/owner/repo/pull/123). The repo must always be explicit.`,
    }
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) }
}

export function targetKey(target: Target): string {
  return `${target.owner}/${target.repo}#${target.number}`
}
