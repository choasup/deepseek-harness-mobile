// Task 11: verifies the tsdown build output (`lib/`), not the source. This
// is deliberately NOT a vitest-transform test of `.ts` files — every other
// test in this repo imports `src/*.ts` for fast iteration, but that path
// goes through vitest's esbuild transform, which is known (see Task 11's
// brief) to accept things real Node ESM rejects. So every assertion here
// loads the actual built `.js` file with a genuine `node` child process via
// `execFileSync` + `import()`, the same way dsh itself will load this
// package once Task 13 links it into a real profile.
//
// The property under test that matters most: `src/index.ts` (the barrel)
// is a pure re-export with zero runtime dependency on zod / dsh-storage-
// domain / dsh-credentials — those only live behind `src/plugin.ts`, which
// ships as an independent `./plugin` subpath export (see index.ts's own
// top-of-file comment). Nothing before this task guarded that property
// against the *build* silently collapsing it (e.g. a future edit that adds
// `export * from './plugin.ts'` to index.ts). The last test below proves
// it survives the build by loading `lib/index.js` from a directory with NO
// node_modules anywhere above it — if the built barrel held even one bare
// `import ... from 'zod'`, that import would throw `ERR_MODULE_NOT_FOUND`
// before any of its exports could be inspected.
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const PKG_DIR = fileURLToPath(new URL('../..', import.meta.url))
const ROOT_DIR = fileURLToPath(new URL('../../../..', import.meta.url))
const LIB_DIR = join(PKG_DIR, 'lib')
const TSDOWN_BIN = join(ROOT_DIR, 'node_modules', '.bin', 'tsdown')

/** Runs `script` as a real Node ESM program (never through vitest) and returns its parsed JSON stdout. */
function runNodeEsm(script: string, cwd: string = PKG_DIR): unknown {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd,
  })
  return JSON.parse(stdout)
}

describe('tsdown build output: @dsh-mobile/remote-registry', () => {
  beforeAll(() => {
    // Rebuild from the current src/*.ts before asserting anything about
    // lib/ — this must fail on stale output, not just on a bad config.
    execFileSync(TSDOWN_BIN, [], { cwd: PKG_DIR, stdio: 'pipe' })
  }, 30_000)

  it("lib/index.js loads under real Node and exports exactly the barrel's value exports", () => {
    const script = `
      const mod = await import(${JSON.stringify(pathToFileURL(join(LIB_DIR, 'index.js')).href)})
      console.log(JSON.stringify({ keys: Object.keys(mod).sort() }))
    `
    const result = runNodeEsm(script) as { keys: string[] }
    expect(result.keys).toEqual(
      [
        'DuplicateKeyRefError',
        'DuplicateMachineError',
        'MissingCredentialError',
        'PROBE_STAGES',
        'REMOTE_URL_SCHEME',
        'RemoteRegistry',
        'RemoteUrlError',
        'UnknownMachineError',
        'formatRemoteUrl',
        'isMissingCredentialError',
        'keyRefForName',
        'normalizeFingerprint',
        'normalizeMachine',
        'parseRemoteUrl',
        'probeMachine',
      ].sort(),
    )
  })

  it('lib/plugin.js loads under real Node and exports name/inject/apply for cordis', () => {
    const script = `
      const mod = await import(${JSON.stringify(pathToFileURL(join(LIB_DIR, 'plugin.js')).href)})
      console.log(JSON.stringify({ name: mod.name, inject: mod.inject, applyType: typeof mod.apply }))
    `
    const result = runNodeEsm(script) as { name: string; inject: string[]; applyType: string }
    expect(result.name).toBe('remote-registry')
    expect(result.inject).toEqual(['storageDomain', 'credentials'])
    expect(result.applyType).toBe('function')
  })

  describe('the index.ts/plugin.ts entry split survives the build', () => {
    it('lib/index.js contains no static reference to zod, dsh-storage-domain, or dsh-credentials', async () => {
      const { readFile } = await import('node:fs/promises')
      const source = await readFile(join(LIB_DIR, 'index.js'), 'utf8')
      expect(source).not.toContain('zod')
      expect(source).not.toContain('dsh-storage-domain')
      expect(source).not.toContain('dsh-credentials')
    })

    it('lib/index.js loads to completion in a process where zod / dsh-storage-domain / dsh-credentials cannot resolve at all', async () => {
      // A fresh scratch directory under the OS tmp root has no node_modules
      // above it, so any bare `import ... from 'zod'` (etc.) reachable from
      // the copied entry file would throw ERR_MODULE_NOT_FOUND — this is a
      // dynamic, not just textual, proof that the barrel never asks for
      // those packages.
      const isolated = await mkdtemp(join(tmpdir(), 'remote-registry-lib-isolated-'))
      try {
        await cp(LIB_DIR, isolated, { recursive: true })
        const entry = join(isolated, 'index.js')
        const script = `
          const mod = await import(${JSON.stringify(pathToFileURL(entry).href)})
          console.log(JSON.stringify({ keys: Object.keys(mod).sort() }))
        `
        const result = runNodeEsm(script, isolated) as { keys: string[] }
        expect(result.keys.length).toBeGreaterThan(0)
        expect(result.keys).toContain('RemoteRegistry')
      } finally {
        await rm(isolated, { recursive: true, force: true })
      }
    })
  })
})
