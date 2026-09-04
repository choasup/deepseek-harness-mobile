// Task 11: verifies the tsdown build output (`lib/`), not the source — see
// the sibling file `packages/remote-registry/tests/build/lib.test.ts` for
// the full rationale (vitest's esbuild transform is known to accept things
// real Node ESM rejects). Every assertion here loads the actual built
// `.js` file with a genuine `node` child process via `execFileSync` +
// `import()`.
//
// `lib/index.js` is the one entry point in this whole repo that
// transitively imports `ssh2`, a CommonJS package. `import { Client } from
// 'ssh2'` throws `SyntaxError: Named export not found` under real Node
// ESM, but vitest's esbuild-based transform happily accepts it — this
// package's src already uses the safe `import ssh2 from 'ssh2'` + destructure
// form, and this test is what actually proves that shape survives the
// build (tsdown/rolldown rewriting the external `ssh2` import is exactly
// the kind of transform that could silently reintroduce a named import).
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url))
const ROOT_DIR = fileURLToPath(new URL('../../../..', import.meta.url))
const REMOTE_REGISTRY_PKG_DIR = join(ROOT_DIR, 'packages', 'remote-registry')
const LIB_DIR = join(PKG_DIR, 'lib')
const TSDOWN_BIN = join(ROOT_DIR, 'node_modules', '.bin', 'tsdown')

/** Runs `script` as a real Node ESM program (never through vitest) and returns its parsed JSON stdout. */
function runNodeEsm(script: string): unknown {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: PKG_DIR,
  })
  return JSON.parse(stdout)
}

describe('tsdown build output: @dsh-mobile/shell-ssh', () => {
  beforeAll(() => {
    // shell-ssh's lib/index.js resolves the `@dsh-mobile/remote-registry`
    // workspace dependency through its published lib/ (it's declared
    // `external`, not bundled — see tsdown.config.ts), so that sibling
    // package must have current build output too, independent of whichever
    // test file vitest happens to run first.
    execFileSync(TSDOWN_BIN, [], { cwd: REMOTE_REGISTRY_PKG_DIR, stdio: 'pipe' })
    execFileSync(TSDOWN_BIN, [], { cwd: PKG_DIR, stdio: 'pipe' })
  }, 30_000)

  it('lib/index.js loads under real Node (transitively imports the CommonJS `ssh2` package) and exports what the barrel promises', () => {
    const script = `
      const mod = await import(${JSON.stringify(pathToFileURL(join(LIB_DIR, 'index.js')).href)})
      console.log(JSON.stringify({ keys: Object.keys(mod).sort() }))
    `
    const result = runNodeEsm(script) as { keys: string[] }
    expect(result.keys).toEqual(
      [
        'DEFAULTS',
        'SshConnectionPool',
        'SshError',
        'SshShellExecutor',
        'buildRemoteCommand',
        'execRemote',
        'fingerprintOfHostKey',
        'isSshError',
        'resolveSpec',
        'shellQuote',
      ].sort(),
    )
  })

  it('lib/plugin.js loads under real Node and exports name/inject/apply for cordis', () => {
    const script = `
      const mod = await import(${JSON.stringify(pathToFileURL(join(LIB_DIR, 'plugin.js')).href)})
      console.log(JSON.stringify({ name: mod.name, inject: mod.inject, applyType: typeof mod.apply }))
    `
    const result = runNodeEsm(script) as { name: string; inject: string[]; applyType: string }
    expect(result.name).toBe('shell-ssh')
    expect(result.inject).toEqual(['remotes', 'credentials'])
    expect(result.applyType).toBe('function')
  })

  it('lib/index.js does not bundle the external ssh2 / @dsh-mobile/remote-registry dependencies', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(join(LIB_DIR, 'index.js'), 'utf8')
    // A default import (`import ssh2 from "ssh2"`), not a named one — the
    // named form is exactly what throws under real Node ESM against ssh2's
    // CommonJS shape (the failure mode this test file's header describes).
    expect(source).toMatch(/import ssh2 from ["']ssh2["']/)
    expect(source).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["']ssh2["']/)
    expect(source).toContain('@dsh-mobile/remote-registry')
  })
})
