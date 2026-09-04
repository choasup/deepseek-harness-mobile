import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Task 11 flipped both packages' package.json `exports`/`main` to
    // `lib/*.js` (dsh loads compiled output, not `.ts`). Both packages'
    // src also cross-references the other by BARE specifier (e.g.
    // shell-ssh's `src/connection.ts` does
    // `import { isMissingCredentialError } from '@dsh-mobile/remote-registry'`,
    // not a relative path) — so without this, Vite/vitest would resolve
    // that bare specifier through the default export condition to the
    // *compiled* `lib/index.js`, a SEPARATE module instantiation from the
    // `src/*.ts` copy that composition tests boot via relative imports
    // (e.g. `remote-registry/tests/mock/harness.ts` importing
    // `../../src/plugin.ts`). Two separate classes named `MissingCredentialError`
    // (one from src, one from the stale-or-fresh lib build) means
    // `instanceof`/`isMissingCredentialError()` checks silently fail across
    // that boundary — this was caught for real: a shell-ssh composition
    // test started asserting `SSH_AUTH_FAILED` instead of
    // `SSH_NO_CREDENTIAL` the moment the exports flip landed, with zero
    // src changes.
    //
    // `dsh-mobile-source` is a matching custom export condition both
    // packages' `package.json` declare (ahead of `default`, pointing at
    // `./src/*.ts`) — activating it here makes every in-repo bare-specifier
    // cross-package import resolve to the same `src/*.ts` module graph the
    // rest of the suite already uses, restoring "one class, one identity"
    // for the whole test run. It has no effect on `lib/`'s own runtime
    // resolution (real Node, real dsh, and this repo's `lib.test.ts` build
    // checks never set it) or on `ctx.loader.create()`'s raw `import()`
    // calls in `loader.test.ts` (those use explicit relative/built paths,
    // bypassing package resolution and this condition entirely).
    conditions: ['dsh-mobile-source'],
  },
  ssr: {
    // Vitest executes test files through vite-node's SSR pipeline (Node
    // environment), which resolves imports via `ssr.resolve.conditions`,
    // NOT the top-level `resolve.conditions` above (that one only governs
    // client/browser-style resolution). Both must carry the condition for
    // it to take effect here.
    resolve: {
      conditions: ['dsh-mobile-source'],
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
