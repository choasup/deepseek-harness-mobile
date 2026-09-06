/**
 * 检查点 4.2：在设备上逐包 import，把失败的挑出来。
 *
 * 为什么不直接启动 dsh：那样一个包的失败会被 AggregateError 裹进几十个里，
 * 而且第一个失败就中止，看不到全貌。这里每个包独立 try，一次跑完拿到完整清单。
 *
 * 清单不是手写的，是从**真实组合**里导出来的（`dsh --profile mobile
 * --dump-config` 的 name 字段），共 83 个。计划文档里那份手写清单只有
 * 10 个，会漏掉绝大多数。
 *
 * 用法：node probe-imports.mjs [装有 dsh 的目录]   （默认当前目录）
 * 输出：JSON，failed 为空数组即通过。
 *
 * 注意那个目录参数不是多余的：裸 `import(name)` 按**这个脚本自己的位置**解析，
 * 不是按 cwd。设备上脚本在 app bundle 里、dsh 在另一个目录，不给根目录就
 * 83 个包全报 ERR_MODULE_NOT_FOUND——而那是解析问题，不是"包不能用"，
 * 会把整个探测结果变成噪音。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'

const root = process.argv[2] ?? process.cwd()
// createRequire 需要一个"文件"锚点，这个文件不必存在。
const require = createRequire(pathToFileURL(resolvePath(root, '_probe-anchor.cjs')))
const packages = [
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-code-runtime-worker-thread',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-command-feedback',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-goal',
  '@deepseek-ai/dsh-goal-round-driver',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-headless/startup',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-repeat-tool-reminder',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-telemetry-otel',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
  '@deepseek-ai/dsh-settings-file',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-badge',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-spill-local',
  '@deepseek-ai/dsh-spill-policy',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents',
  '@deepseek-ai/dsh-tool-subagent-report',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-loader',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-web-search-deepseek',
  '@deepseek-ai/dsh-workflow-worker-thread',
]

const failed = []
for (const name of packages) {
  try {
    // 先按根目录解析成绝对路径，再 import——绕开"按脚本位置解析"。
    await import(pathToFileURL(require.resolve(name)).href)
  } catch (err) {
    failed.push({ name, code: err?.code, message: String(err?.message ?? err).slice(0, 300) })
  }
}

console.log(JSON.stringify({
  root,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  jitless: typeof WebAssembly === 'undefined',
  total: packages.length,
  ok: packages.length - failed.length,
  failed,
}, null, 2))
