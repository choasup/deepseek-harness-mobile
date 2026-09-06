// 包的公开入口。package.json 的 main/exports 都指向这个文件——之前只有
// types.ts 和 url.ts 存在，没有汇总导出，下游包（如 shell-ssh）没法
// `import type { RemoteMachine, SshCredentials } from '@dsh-mobile/remote-registry'`。
//
// 这个文件只做纯 barrel re-export，零运行时副作用、零对 dsh 服务包的硬依赖
// ——shell-ssh/src/connection.ts 就是从这里 value-import `isMissingCredentialError`
// 和 `normalizeFingerprint` 的，而 shell-ssh/package.json 并没有声明 zod /
// dsh-storage-domain / dsh-credentials 这几个包。cordis 的插件接线（name /
// inject / apply，以及它们背后对 zod、dsh-storage-domain、dsh-credentials
// 的硬依赖）单独放在 ./plugin.ts、走 `@dsh-mobile/remote-registry/plugin`
// 这个独立子路径导出——静态 `export ... from` 会强制加载被导出的整个模块，
// 所以这里不 re-export plugin.ts 的任何东西，哪怕只是类型：只要有一条
// value 级别的桥接，任何仅仅想要一个类型守卫的消费者就会被迫连带加载
// plugin.ts 的运行时依赖。见 Task 10 复审 I2。
export { MACHINES_TABLE, REMOTE_DOMAIN_NAME } from './types.ts'
export type { RemoteMachine, SshCredentials } from './types.ts'
export {
  REMOTE_URL_SCHEME,
  RemoteUrlError,
  formatRemoteUrl,
  keyRefForName,
  normalizeFingerprint,
  normalizeMachine,
  parseRemoteUrl,
} from './url.ts'
export type { RemoteUrlErrorCode } from './url.ts'
export {
  DuplicateKeyRefError,
  DuplicateMachineError,
  isMissingCredentialError,
  MissingCredentialError,
  RemoteRegistry,
  UnknownMachineError,
} from './registry.ts'
export type { RegistryStore } from './registry.ts'
export { PROBE_STAGES, probeMachine } from './probe.ts'
export type {
  FingerprintStatus,
  ProbeDeps,
  ProbeOptions,
  ProbeReport,
  ProbeStage,
  ProbeStageResult,
} from './probe.ts'
