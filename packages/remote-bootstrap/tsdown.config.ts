import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { plugin: 'src/plugin.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  // platform: 'node' 默认 fixedExtension，会强制产出 .mjs。这个包声明了
  // "type": "module"，.js 本身已经无歧义地是 ESM——保持 .js 以匹配 exports。
  fixedExtension: false,
  // dsh 自己的包由宿主在运行时提供，绝不能打进 lib：打进去会复制出一份
  // 同名但不同身份的类，`instanceof` 之类的判断会静默失效。
  external: [/^@deepseek-ai\//],
})
