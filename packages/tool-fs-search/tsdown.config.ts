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
  // dsh's own packages are host/consumer-provided at runtime and must
  // never be bundled into lib/ — this includes `@deepseek-ai/dsh-tool-fs-search`
  // and `@deepseek-ai/dsh-output-retention`, whose pure exports we reuse
  // by value (see src/index.ts and src/presentation.ts): they are real
  // npm dependencies of this package, not cordis services, but bundling
  // them would duplicate the exact classes/functions dsh's OWN copy of
  // these packages defines — `SearchError instanceof` and similar checks
  // must see the SAME class identity dsh's other plugins see.
  external: [/^@deepseek-ai\//],
})
