import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', plugin: 'src/plugin.ts' },
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
  // dsh's own packages (and zod, its storage stack's validator) are
  // host-provided at runtime and must never be bundled into lib/.
  external: [/^@deepseek-ai\//, 'zod'],
})
