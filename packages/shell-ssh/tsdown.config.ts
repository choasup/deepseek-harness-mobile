import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', plugin: 'src/plugin.ts', 'jitless-poly1305': 'src/jitless-poly1305.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  sourcemap: true,
  // platform: 'node' defaults fixedExtension to true, which forces a
  // `.mjs` extension regardless of package.json's `type` field. This
  // package declares `"type": "module"`, so plain `.js` is already
  // unambiguously ESM — keep `.js` to match the exports map above.
  fixedExtension: false,
  // dsh's own packages, the CommonJS `ssh2` runtime dependency, and the
  // sibling workspace package are all host/consumer-provided at runtime
  // and must never be bundled into lib/.
  external: [/^@deepseek-ai\//, 'ssh2', '@dsh-mobile/remote-registry'],
})
