import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const npmCli = process.env["npm_execpath"]
if (npmCli === undefined) throw new Error("npm_execpath is missing; run this check through npm run pack:check")
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pr-monitor-pack-"))

function runNpm({ args, cwd = process.cwd(), encoding, stdio }) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding,
    stdio,
    env: { ...process.env, npm_config_dry_run: "false" },
  })
}

function packWorkspace({ workspace, destination }) {
  const raw = runNpm({
    args: [
      "pack",
      "--workspace",
      workspace,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ],
    encoding: "utf8",
  })
  const parsed = JSON.parse(raw)
  const metadata = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  if (!metadata || !Array.isArray(metadata.files) || typeof metadata.filename !== "string") {
    throw new Error(`npm pack returned no file manifest for ${workspace}`)
  }
  return metadata
}

function assertFiles({ metadata, expected, name }) {
  const files = metadata.files.map((file) => file.path).sort()
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`unexpected ${name} package files: ${files.join(", ")}`)
  }
}

async function assertLicense({ packageDirectory }) {
  const rootLicense = await readFile(new URL("../LICENSE", import.meta.url), "utf8")
  const packageLicense = await readFile(new URL(`../${packageDirectory}/LICENSE`, import.meta.url), "utf8")
  if (rootLicense !== packageLicense) throw new Error(`${packageDirectory}/LICENSE has drifted`)
}

async function installConsumer({ name, metadata, dependencies, smoke }) {
  const consumerDirectory = join(temporaryDirectory, `${name}-consumer`)
  await mkdir(consumerDirectory)
  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }))
  runNpm({
    args: [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerDirectory,
      ...dependencies,
      resolve(temporaryDirectory, metadata.filename),
    ],
    stdio: "pipe",
  })
  execFileSync(process.execPath, ["--input-type=module", "--eval", smoke], {
    cwd: consumerDirectory,
    stdio: "pipe",
  })
  return consumerDirectory
}

try {
  const openCode = packWorkspace({
    workspace: "@sesori/pr-monitor-opencode",
    destination: temporaryDirectory,
  })
  assertFiles({
    metadata: openCode,
    name: "OpenCode",
    expected: [
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
      "skills/monitor-pr/SKILL.md",
    ],
  })
  await assertLicense({ packageDirectory: "opencode" })
  const openCodeConsumer = await installConsumer({
    name: "opencode",
    metadata: openCode,
    dependencies: [],
    smoke:
      'const root = await import("@sesori/pr-monitor-opencode");' +
      'const server = await import("@sesori/pr-monitor-opencode/server");' +
      'const {createRequire} = await import("node:module");' +
      'const manifest = createRequire(import.meta.url)("@sesori/pr-monitor-opencode/package.json");' +
      'const expected = "PrMonitorPlugin";' +
      'if (Object.keys(root).join() !== expected || Object.keys(server).join() !== expected) process.exit(1);' +
      'if (manifest.name !== "@sesori/pr-monitor-opencode") process.exit(1);',
  })
  await writeFile(
    join(openCodeConsumer, "index.ts"),
    'import type { Plugin } from "@opencode-ai/plugin"\n' +
      'import { PrMonitorPlugin } from "@sesori/pr-monitor-opencode"\n' +
      'import { PrMonitorPlugin as ServerPlugin } from "@sesori/pr-monitor-opencode/server"\n' +
      "const root: Plugin = PrMonitorPlugin\nconst server: Plugin = ServerPlugin\nvoid root\nvoid server\n",
  )
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      join(openCodeConsumer, "index.ts"),
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  )

  const pi = packWorkspace({ workspace: "@sesori/pr-monitor-pi", destination: temporaryDirectory })
  assertFiles({
    metadata: pi,
    name: "Pi/OMP",
    expected: [
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/omp.d.ts",
      "dist/omp.js",
      "package.json",
      "skills/monitor-pr/SKILL.md",
    ],
  })
  await assertLicense({ packageDirectory: "pi" })
  const canonicalSkill = await readFile(new URL("../skills/monitor-pr/SKILL.md", import.meta.url), "utf8")
  const openCodeSkill = await readFile(new URL("../opencode/skills/monitor-pr/SKILL.md", import.meta.url), "utf8")
  const piSkill = await readFile(new URL("../pi/skills/monitor-pr/SKILL.md", import.meta.url), "utf8")
  const deepSeekSkill = await readFile(new URL("../deepseek/skills/monitor-pr/SKILL.md", import.meta.url), "utf8")
  if (openCodeSkill !== canonicalSkill || piSkill !== canonicalSkill || deepSeekSkill !== canonicalSkill) {
    throw new Error("generated package skills have drifted from skills/monitor-pr/SKILL.md")
  }
  const piConsumer = await installConsumer({
    name: "pi",
    metadata: pi,
    dependencies: [
      "@earendil-works/pi-ai@0.84.2",
      "@earendil-works/pi-coding-agent@0.84.2",
      "typebox@1.3.7",
    ],
    smoke:
      'const pi = await import("@sesori/pr-monitor-pi");' +
      'const omp = await import("@sesori/pr-monitor-pi/omp");' +
      'const {createRequire} = await import("node:module");' +
      'const manifest = createRequire(import.meta.url)("@sesori/pr-monitor-pi/package.json");' +
      'if (Object.keys(pi).join() !== "default" || Object.keys(omp).join() !== "default") process.exit(1);' +
      'if (manifest.name !== "@sesori/pr-monitor-pi") process.exit(1);',
  })
  await writeFile(
    join(piConsumer, "index.ts"),
    'import piExtension from "@sesori/pr-monitor-pi"\n' +
      'import ompExtension from "@sesori/pr-monitor-pi/omp"\n' +
      "void piExtension\nvoid ompExtension\n",
  )
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      join(piConsumer, "index.ts"),
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  )

  const deepSeek = packWorkspace({
    workspace: "@sesori/pr-monitor-deepseek",
    destination: temporaryDirectory,
  })
  assertFiles({
    metadata: deepSeek,
    name: "DeepSeek Harness",
    expected: [
      "LICENSE",
      "README.md",
      "cordis.patch.yml",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
      "skills/monitor-pr/SKILL.md",
    ],
  })
  await assertLicense({ packageDirectory: "deepseek" })
  const deepSeekConsumer = await installConsumer({
    name: "deepseek",
    metadata: deepSeek,
    dependencies: [
      "@deepseek-ai/cordis@4.0.2",
      "@deepseek-ai/dsh-agent@0.1.5-rc.2",
      "@deepseek-ai/dsh-launch-environment@0.1.5-rc.2",
      "@deepseek-ai/dsh-llm@0.1.5-rc.2",
      "@deepseek-ai/dsh-skill@0.1.5-rc.2",
      "@deepseek-ai/dsh-tools@0.1.5-rc.2",
    ],
    smoke:
      'const plugin = await import("@sesori/pr-monitor-deepseek");' +
      'const {createRequire} = await import("node:module");' +
      'const {readFileSync} = await import("node:fs");' +
      'const require = createRequire(import.meta.url);' +
      'const manifest = require("@sesori/pr-monitor-deepseek/package.json");' +
      'const patch = readFileSync(require.resolve("@sesori/pr-monitor-deepseek/cordis.patch.yml"), "utf8");' +
      'if (Object.keys(plugin).sort().join() !== "apply,inject,name") process.exit(1);' +
      'if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") process.exit(1);' +
      'if (!patch.includes("name: \'@sesori/pr-monitor-deepseek\'")) process.exit(1);',
  })
  await writeFile(
    join(deepSeekConsumer, "index.ts"),
    'import type { Context } from "@deepseek-ai/cordis"\n' +
      'import { apply, inject, name } from "@sesori/pr-monitor-deepseek"\n' +
      "const plugin: (ctx: Context) => void = apply\nvoid plugin\nvoid inject\nvoid name\n",
  )
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      join(deepSeekConsumer, "index.ts"),
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  )

  console.log(
    `pack check passed: ${openCode.filename}, ${pi.filename}, and ${deepSeek.filename}; ` +
      "exact files, skills, types, exports, and DeepSeek bundle metadata",
  )
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
