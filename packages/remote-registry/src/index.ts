// 包的公开入口。package.json 的 main/exports 都指向这个文件——之前只有
// types.ts 和 url.ts 存在，没有汇总导出，下游包（如 shell-ssh）没法
// `import type { RemoteMachine, SshCredentials } from '@dsh-mobile/remote-registry'`。
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
export type { ProbeDeps, ProbeOptions, ProbeReport, ProbeStage, ProbeStageResult } from './probe.ts'
