import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const PKG = '@dsh-mobile/client-ui-env'

/**
 * 浏览器半边的加载格式**不是** ESM，也不是普通 CJS：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * 这是 `dsh-client-modules` 的 "lazy CJS (web2)" 模型：执行这段脚本只**注册**
 * 工厂函数；模块体的副作用（包括注入 CSS）都在闭包里，等到真正被
 * materialize（`factory(require)`）时才跑。工厂拿到的 `require` 是宿主给的，
 * 能解析 react / react/jsx-runtime / dsh-client-runtime 这些"外部件"——
 * 它们由 shell 预置，不能打进 bundle，否则页面上会出现第二份 React。
 *
 * 所以这里让 esbuild 产出 CJS（它对外部件正好发 `require("react")`），
 * 再套上这层壳。格式是照 dsh 自己编译产物逐字对齐的
 * （`dsh-client-ui-layout/lib/client.js` 开头即是）。
 */
const EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-runtime/client']

async function bundleClient() {
  const result = await build({
    entryPoints: [`${root}src/client/index.tsx`],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: EXTERNAL,
    logLevel: 'warning',
  })
  const [out] = result.outputFiles
  const body = out.text
    .split('\n')
    .map((line) => (line.length > 0 ? `\t\t${line}` : line))
    .join('\n')

  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`
}

/** host 半边：普通 ESM，一个空 apply。 */
async function bundleHost() {
  const result = await build({
    entryPoints: [`${root}src/index.ts`],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'warning',
  })
  return result.outputFiles[0].text
}

await mkdir(`${root}lib`, { recursive: true })
await writeFile(`${root}lib/client.js`, await bundleClient())
await writeFile(`${root}lib/index.js`, await bundleHost())
// 手写一份 .d.ts：host 半边只有一个空 apply，跑 tsc 生成不值当。
await writeFile(`${root}lib/index.d.ts`, 'export declare function apply(): void;\n')

const size = (await readFile(`${root}lib/client.js`)).byteLength
console.log(`client.js ${size} bytes, index.js ok`)
