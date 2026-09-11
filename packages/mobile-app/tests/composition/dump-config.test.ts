// Task 13: 端到端组合验证 — the one suite in this repo that talks to a REAL
// `dsh` install (`/opt/homebrew/bin/dsh`, 0.1.1-rc.2) and a REAL profile at
// `~/.dsh/profiles/mobile`, instead of our own harnesses. Everything else in
// this repo (253 tests before this file) proves properties of our own code
// in isolation; this file is the only place that proves real dsh actually
// composes the tree the way `cordis.patch.yml` claims it will.
//
// That profile can't be created by a test — it writes into the *user's* dsh
// home, not this repo — so it must already exist, built by hand following
// "Step 1 — create the profile" in the repo root README.md. If it doesn't,
// this whole suite skips instead of failing, but LOUDLY: a silent skip here
// would look identical to "everything passed" in a CI summary, which is
// worse than not having the suite at all.
//
// Two real findings came out of writing this file (both written up in full
// in the README's "Known limitations" section — this header only points at
// them):
//
// 1. `--dump-config` (composition only, no instantiation) succeeds, but a
//    real boot (`dsh --profile mobile "<task>"`) does NOT reach
//    MISSING_CREDENTIAL as Task 13's brief expected. It fails earlier, at
//    plugin-tree instantiation, because two entries dsh-base itself always
//    mounts — `dsh-permission-presets` (inject: ["shell", ...]) and
//    `dsh-tool-fs-search` (inject: [..., "subprocess"], because it shells
//    out to a bundled ripgrep binary rather than searching in pure JS) —
//    stay PENDING forever once every local process backend is disabled and
//    `shell-ssh` declines to register `ctx.shell` without a configured
//    machine. `assertEntriesActivated()` treats that the same as any other
//    boot failure. This can't be exercised from vitest (it needs the real
//    `boot()` call dsh's CLI makes) so it isn't asserted here — see the
//    README for the exact repro and stack trace.
//
// 2. Importing `@dsh-mobile/shell-ssh`'s built entries under `node
//    --jitless` (Step 4 below) does not merely fail to connect — it crashes
//    the process. `ssh2`'s `lib/protocol/crypto.js` unconditionally starts
//    an async WebAssembly instantiation (for its Poly1305 cipher) the
//    moment it's required, with nothing awaiting or catching the resulting
//    promise. Under jitless there is no `WebAssembly`, so that promise
//    rejects, and because nothing observes it, Node reports an unhandled
//    rejection and exits non-zero — before any SSH connection is ever
//    attempted, and regardless of whether one ever will be. This IS
//    asserted below (as a positive, currently-green assertion of the crash
//    signature) precisely so that fixing it — replacing ssh2, or shell-ssh
//    defensively catching that one promise — breaks this test loudly rather
//    than leaving a false sense that jitless import already works.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const ROOT_DIR = fileURLToPath(new URL('../../../..', import.meta.url))
const SHELL_SSH_LIB = join(ROOT_DIR, 'packages', 'shell-ssh', 'lib')
const REMOTE_REGISTRY_LIB = join(ROOT_DIR, 'packages', 'remote-registry', 'lib')

const DSH_BIN = '/opt/homebrew/bin/dsh'
const HOMEBREW_NODE = '/opt/homebrew/bin/node'
const DSH_BIN_JS = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PROFILE_DIR = join(homedir(), '.dsh', 'profiles', 'mobile')

const BUILT_ENTRIES = [
  join(SHELL_SSH_LIB, 'index.js'),
  join(SHELL_SSH_LIB, 'plugin.js'),
  join(REMOTE_REGISTRY_LIB, 'index.js'),
  join(REMOTE_REGISTRY_LIB, 'plugin.js'),
]

/**
 * Everything this suite needs to be meaningful: a real dsh install at the
 * expected homebrew paths, a real `mobile` profile under the user's dsh
 * home, and built `lib/` output for both packages (the profile links
 * against `lib/`, not `src/` — see the root README's Step 1).
 */
const READY =
  existsSync(DSH_BIN) &&
  existsSync(HOMEBREW_NODE) &&
  existsSync(DSH_BIN_JS) &&
  existsSync(PROFILE_DIR) &&
  BUILT_ENTRIES.every((path) => existsSync(path))

if (!READY) {
  console.warn(
    [
      '',
      '========================================================================',
      'SKIPPING packages/mobile-app/tests/composition/dump-config.test.ts',
      '',
      'This suite needs a REAL dsh install and a REAL `mobile` profile under',
      "the user's dsh home — neither can be faked or created by a test.",
      '',
      'Missing at least one of:',
      `  dsh binary:        ${DSH_BIN} (found: ${existsSync(DSH_BIN)})`,
      `  homebrew node:      ${HOMEBREW_NODE} (found: ${existsSync(HOMEBREW_NODE)})`,
      `  dsh bin.js:         ${DSH_BIN_JS} (found: ${existsSync(DSH_BIN_JS)})`,
      `  profile dir:        ${PROFILE_DIR} (found: ${existsSync(PROFILE_DIR)})`,
      `  built lib/ entries: ${BUILT_ENTRIES.filter((p) => !existsSync(p)).join(', ') || '(all present)'}`,
      '',
      'Follow "Step 1 — create the profile" in the repo root README.md, then',
      're-run the tests. This is documented there in full, including the',
      'exact `pnpm-workspace.yaml` overrides needed to make `workspace:*`',
      'dependencies resolve outside this monorepo.',
      '========================================================================',
      '',
    ].join('\n'),
  )
}

/** `!!js <expr>` scalar — the same custom type `dsh-app-boot` uses to print un-evaluated `!!js` config values in `--dump-config` output. */
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const dumpConfigSchema = yaml.JSON_SCHEMA.extend(JsExpr)

interface DumpEntry {
  id: string
  name: string
  disabled?: unknown
  config?: unknown
}

/**
 * Runs a real `dsh --profile mobile --dump-config` (optionally under a given
 * node binary, jitless) and returns {status, stdout, stderr}. Uses
 * `spawnSync`, not `execFileSync` — `execFileSync` only captures stderr when
 * the child exits non-zero, and `--dump-config` prints its two "entry not
 * found" warnings to stderr while still exiting 0.
 */
function runDumpConfig(nodeBin?: string): { status: number; stdout: string; stderr: string } {
  const bin = nodeBin ?? DSH_BIN
  const args = nodeBin
    ? ['--jitless', DSH_BIN_JS, '--profile', 'mobile', '--dump-config']
    : ['--profile', 'mobile', '--dump-config']
  const result = spawnSync(bin, args, { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

/**
 * `--jitless` always prints this one V8 startup line to stderr regardless
 * of what the script does — it's V8 announcing it dropped `--expose_wasm`
 * because `--jitless` already implies no WebAssembly. Benign noise, not a
 * signal; strip it before comparing stderr against a non-jitless baseline
 * or asserting stderr is otherwise empty.
 */
function stripJitlessBanner(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => line.trim() !== 'Warning: disabling flag --expose_wasm due to conflicting flags')
    .join('\n')
}

function parseDump(stdout: string): DumpEntry[] {
  return yaml.load(stdout, { schema: dumpConfigSchema }) as DumpEntry[]
}

function findEntry(entries: DumpEntry[], id: string): DumpEntry | undefined {
  return entries.find((e) => e.id === id)
}

// The 8 local-process rows the patch tries to disable. Two of them
// (`terminal-bash`, `tmux-context`) are never mounted by dsh-base +
// dsh-headless in the first place (they only exist under an agent preset,
// which headless mode doesn't load — see cordis.patch.yml's own comment on
// each) — real dsh confirms this by printing `patch: entry "..." not found`
// to stderr and simply not inserting them, rather than inserting them
// pre-disabled. So those two are asserted ABSENT, not disabled=true.
const DISABLED_AND_PRESENT = [
  // 靠打包的 ripgrep 二进制；最初被误判为纯 JS 而列为存活。
  'tool-fs-search',
  // 行 id 是 permission（包名是 permission-presets）。
  'permission','subprocess', 'bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh', 'sandbox']
// `agent-presets` 同理，但理由不同：它由 dsh-web-app 插入，headless 组合里
// 根本没有这一行。禁用它是因为三个自带 preset 都挂持久 shell，在 iOS 上
// 一个都挂不上——而 preset 挂载失败会让 session.create 整个失败，前端不显示
// 任何报错（表现为"点工作区没反应"）。详见 cordis.patch.yml 的 F 段。
const ABSENT_NOT_DISABLED = ['terminal-bash', 'tmux-context', 'agent-presets', 'ui-layout', 'ui-sidebar']

const MUST_STAY_ENABLED = [
  'tool-fs',
  'tool-str-replace-editor',
  'tool-todo',
  'tool-web',
  'skill',
  'jobs',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
]

const OUR_ADDITIONS: Array<{ id: string; name: string }> = [
  { id: 'storage', name: '@deepseek-ai/dsh-storage' },
  { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json' },
  { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain' },
  { id: 'remote-registry', name: '@dsh-mobile/remote-registry/plugin' },
  { id: 'shell-ssh', name: '@dsh-mobile/shell-ssh/plugin' },
  { id: 'ui-layout-mobile', name: '@dsh-mobile/client-ui-layout-mobile' },
  { id: 'ui-env', name: '@dsh-mobile/client-ui-env' },
  { id: 'tool-fs-search-js', name: '@dsh-mobile/tool-fs-search/plugin' },
]

describe.skipIf(!READY)('real dsh composes the mobile profile (Task 13, Step 2)', () => {
  it('exits 0 and prints only the known "entry not found" patch warnings', () => {
    const { status, stderr } = runDumpConfig()
    expect(status).toBe(0)
    for (const id of ABSENT_NOT_DISABLED) {
      expect(stderr).toContain(`[@dsh-mobile/mobile-app] patch: entry "${id}" not found`)
    }
    // 不多不少——多出来的第 N 条警告是新情况，值得看一眼，而不是默默接受。
    const lines = stderr.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(ABSENT_NOT_DISABLED.length)
  })

  it('marks the six local-process rows that do exist as disabled', () => {
    const { stdout } = runDumpConfig()
    const entries = parseDump(stdout)
    for (const id of DISABLED_AND_PRESENT) {
      const entry = findEntry(entries, id)
      expect(entry, `expected an entry with id "${id}"`).toBeDefined()
      expect(entry!.disabled, `expected "${id}" to be disabled`).toBe(true)
    }
  })

  it('never mounts terminal-bash / tmux-context under dsh-base + dsh-headless (nothing to disable)', () => {
    const { stdout } = runDumpConfig()
    const entries = parseDump(stdout)
    for (const id of ABSENT_NOT_DISABLED) {
      expect(findEntry(entries, id), `expected no entry with id "${id}"`).toBeUndefined()
    }
  })

  it('leaves the pure-JS tool/skill/jobs/subagent rows enabled', () => {
    const { stdout } = runDumpConfig()
    const entries = parseDump(stdout)
    for (const id of MUST_STAY_ENABLED) {
      const entry = findEntry(entries, id)
      expect(entry, `expected an entry with id "${id}"`).toBeDefined()
      expect(entry!.disabled).not.toBe(true)
    }
  })

  it('inserts our three additions (storage x3, remote-registry, shell-ssh) enabled with a profile-relative path (see the rationale block in the patch)', () => {
    const { stdout } = runDumpConfig()
    const entries = parseDump(stdout)
    for (const { id, name } of OUR_ADDITIONS) {
      const entry = findEntry(entries, id)
      expect(entry, `expected an entry with id "${id}"`).toBeDefined()
      expect(entry!.disabled).not.toBe(true)
      expect(entry!.name).toBe(name)
    }
  })
})

describe.skipIf(!READY)('jitless (Task 13, Step 4): what actually runs on-device', () => {
  it('`node --jitless .../bin.js --profile mobile --dump-config` composes an identical tree to the non-jitless run', () => {
    const plain = runDumpConfig()
    const jitless = runDumpConfig(HOMEBREW_NODE)
    expect(jitless.status).toBe(0)
    expect(jitless.stdout).toBe(plain.stdout)
    expect(stripJitlessBanner(jitless.stderr)).toBe(stripJitlessBanner(plain.stderr))
  })

  /** Runs `script` in a real `node --jitless` child process; resolves with {status, stdout, stderr}. Never throws on a non-zero exit. */
  function runJitless(script: string): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(HOMEBREW_NODE, ['--jitless', '--input-type=module', '-e', script], { encoding: 'utf8' })
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  it('confirms the process really is jitless: WebAssembly is undefined', () => {
    const { status, stdout } = runJitless(`console.log(JSON.stringify({ wasm: typeof WebAssembly }))`)
    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ wasm: 'undefined' })
  })

  it('imports @dsh-mobile/remote-registry/index.js and /plugin.js cleanly under jitless', () => {
    for (const file of [join(REMOTE_REGISTRY_LIB, 'index.js'), join(REMOTE_REGISTRY_LIB, 'plugin.js')]) {
      const script = `
        const mod = await import(${JSON.stringify(`file://${file}`)})
        await new Promise((r) => setTimeout(r, 300))
        console.log(JSON.stringify({ keys: Object.keys(mod).sort() }))
      `
      const { status, stdout, stderr } = runJitless(script)
      expect(stripJitlessBanner(stderr), `unexpected stderr importing ${file}`).toBe('')
      expect(status, `unexpected non-zero exit importing ${file}`).toBe(0)
      const { keys } = JSON.parse(stdout) as { keys: string[] }
      expect(keys.length).toBeGreaterThan(0)
    }
  })

  it('crashes importing @dsh-mobile/shell-ssh/plugin.js under jitless — confirmed real defect, not a test bug', () => {
    // plugin.ts re-exports from index.ts, so this documents the same crash
    // as the next test — kept as two separate assertions (one per entry
    // point) so a partial fix (e.g. shell-ssh stops re-exporting the SSH
    // internals from its cordis entry, and only index.js still crashes)
    // would show up as "one of these two now passes" rather than an opaque
    // single pass/fail.
    const file = join(SHELL_SSH_LIB, 'plugin.js')
    const script = `
      const mod = await import(${JSON.stringify(`file://${file}`)})
      await new Promise((r) => setTimeout(r, 300))
      console.log(JSON.stringify({ keys: Object.keys(mod).sort() }))
    `
    const { status, stderr } = runJitless(script)
    // === REAL DEFECT, not a test bug — see this file's header and the ===
    // === README's "Known limitations" for the full writeup.           ===
    // `ssh2@1.17.0`'s `lib/protocol/crypto.js` runs
    // `require('./crypto/poly1305.js')()` inside an un-awaited, un-caught
    // async IIFE the instant it is required, to instantiate a WebAssembly
    // module for its Poly1305 cipher. Jitless has no `WebAssembly`, so that
    // promise rejects, nothing observes the rejection, and Node kills the
    // process. This reproduces merely by importing shell-ssh's built
    // output — no SSH connection is ever attempted.
    expect(status).not.toBe(0)
    expect(stderr).toContain('ReferenceError: WebAssembly is not defined')
    expect(stderr).toContain('poly1305.js')
  })

  it('crashes importing @dsh-mobile/shell-ssh/index.js under jitless — same real defect as plugin.js', () => {
    const file = join(SHELL_SSH_LIB, 'index.js')
    const script = `
      const mod = await import(${JSON.stringify(`file://${file}`)})
      await new Promise((r) => setTimeout(r, 300))
      console.log(JSON.stringify({ keys: Object.keys(mod).sort() }))
    `
    const { status, stderr } = runJitless(script)
    expect(status).not.toBe(0)
    expect(stderr).toContain('ReferenceError: WebAssembly is not defined')
    expect(stderr).toContain('poly1305.js')
  })
})
