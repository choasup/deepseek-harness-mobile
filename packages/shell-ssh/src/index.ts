/**
 * `SshShellExecutor` — assembles the SSH connection pool (Task 4) and the
 * remote-exec primitive (Task 5) into the shape dsh's `ctx.shell` seam
 * expects (`resolve()` / `run()` / `start()`), without depending on the dsh
 * runtime itself.
 *
 * ## Why this class does NOT `extends ShellExecutor`
 *
 * `@deepseek-ai/dsh-shell`'s `ShellExecutor` is a cordis `Service`: its
 * constructor takes a real `Context` and registers itself into `ctx.shell`.
 * Extending it here would force every unit test in this package to boot the
 * whole dsh/cordis runtime just to construct an executor. Instead this class
 * is plain and dependency-free, and defines *structural* types
 * (`ExecRequestLike`, `ExecSpecLike`, `RunResultLike`, `ShellProcessLike`,
 * `ShellProcessReadLike`) whose fields are written to match dsh's real
 * `ShellExecRequest` / `ShellExecSpec` / `ShellRunResult` / `ShellProcess` /
 * `ShellProcessRead` (checked against
 * `dsh-shell/lib/types/types.d.ts`, not from memory). Task 7 writes a thin
 * `class extends ShellExecutor` adapter that constructs one of these per
 * machine and forwards calls, type-aligning at that one seam.
 *
 * One deliberate structural gap: the real `ShellExecSpec` also carries
 * `sandboxPolicy: SandboxExecutionPolicy | undefined` and an optional
 * `dshEnv`. This executor never reads or acts on either — SSH execution
 * applies no local confinement at all (see the `sandboxMode` doc comment
 * below) and `dshEnv` is a dsh-runtime-owned snapshot type this package has
 * no reason to import. Task 7's adapter is expected to pass
 * `sandboxPolicy: undefined` through untouched when it calls the real
 * `resolve()`/hands specs to this executor, and to merge `dshEnv` into
 * `env` (or extend `ExecSpecLike`) if a future task needs it.
 *
 * Verified this is inert, not just unread by this file: `dsh-shell`'s own
 * `ShellExecutor` base class never reads `sandboxPolicy` at runtime (only
 * in type declarations), and `dsh-tool-bash` gates ALL `sandboxPolicy`
 * handling behind `ctx.shell.sandboxMode !== undefined` — it computes
 * `sandboxPolicy = defaultMode === void 0 ? void 0 : ctx.get("sandboxPolicy")`
 * and builds the request with `...policy !== void 0 ? { sandboxPolicy: policy } : {}`.
 * Since this executor's `sandboxMode` returns `undefined`, `dsh-tool-bash`
 * never even puts `sandboxPolicy` on the `ShellExecRequest` it builds for
 * us — Task 7 setting `sandboxPolicy: undefined` on the resolved spec is
 * exactly the value that would already be there; nothing downstream reads
 * or throws on it.
 */
import type { RemoteMachine } from '@dsh-mobile/remote-registry'
import type { SshConnectionPool } from './connection.ts'
import { execRemote, type RemoteExecResult } from './exec.ts'
import { isSshError } from './errors.ts'

export * from './connection.ts'
export * from './exec.ts'
export * from './errors.ts'

/** Structural mirror of dsh-subprocess's `CollectedOutput` (re-exported by dsh-shell). */
export interface CollectedOutputLike {
  /** Collected text — the TAIL of the stream when truncated. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /**
   * Path to a file holding the complete stream, when truncated and
   * available. Always absent here: `execRemote()` keeps only an in-memory
   * sliding window (see `exec.ts`) and never spills to disk, so a
   * truncated stream's earlier bytes are genuinely unrecoverable — we
   * report that honestly by omitting this field rather than pointing at a
   * file that doesn't exist.
   */
  spillPath?: string
}

/** Structural mirror of dsh-shell's `ShellExecRequest` (the caller-facing, partially-specified shape). */
export interface ExecRequestLike {
  command: string
  workdir?: string | undefined
  timeoutMs?: number | undefined
  stdoutMaxBytes?: number | undefined
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
}

/** Structural mirror of dsh-shell's `ShellExecSpec` (the fully-resolved shape `run()`/`start()` accept). */
export interface ExecSpecLike {
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
}

/** Structural mirror of dsh-shell's `ShellRunResult` — deliberately WITHOUT a `sandbox` field; see `run()`. */
export interface RunResultLike {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: CollectedOutputLike
  stderr: CollectedOutputLike
}

export type ShellProcessStatusLike = 'running' | 'completed' | 'killed'

/** Structural mirror of dsh-shell's `ShellProcessRead`. */
export interface ShellProcessReadLike {
  /**
   * Output produced since the previous read. Stdout and stderr deltas
   * accumulated since the last read are concatenated, with stderr placed
   * under a `[stderr]` marker WHEN PRESENT (no marker at all when there is
   * no stderr in this delta). This exact wording and behavior come from
   * `dsh-bash-local`'s own package description: it "merges offset-based
   * stdout/stderr reads into one consuming delta, placing stderr under a
   * `[stderr]` marker when present" — not invented here, so don't
   * re-derive a different format later.
   */
  delta: string
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

/** Structural mirror of dsh-shell's `ShellProcess`. */
export interface ShellProcessLike {
  status: ShellProcessStatusLike
  exitCode: number | null
  signal: NodeJS.Signals | null
  readonly done: Promise<void>
  readOutput(): ShellProcessReadLike
  kill(): boolean
}

export const DEFAULTS = {
  /** Foreground timeout when a request doesn't specify one. */
  timeoutMs: 120_000,
  /** Foreground stdout capture budget when a request doesn't specify one. */
  stdoutMaxBytes: 256 * 1024,
  /** Remote workdir when neither the request nor the machine specifies one. */
  workdir: '~',
  /**
   * Bound for `start()`'s own incremental-read buffer (see `LiveWindow`
   * below). Deliberately a separate knob from `stdoutMaxBytes`:
   * `stdoutMaxBytes` is `execRemote()`'s *final* per-stream retention
   * budget for `run()`, but `onData` (which feeds `start()`'s live reads)
   * is NOT capped by it — it fires for every chunk received, uncapped, so
   * a naive `pending += chunk` accumulator is an OOM on a command that
   * produces gigabytes between two `readOutput()` calls. This is the cap
   * this executor applies on top, independent of the caller's foreground
   * budget.
   */
  liveBufferMaxBytes: 256 * 1024,
} as const

/**
 * `setTimeout`'s maximum valid delay (2^31 - 1 ms, ~24.8 days) — beyond it,
 * Node fires the timer immediately due to signed 32-bit overflow (verified,
 * documented Node behavior). `execRemote()` requires a numeric `timeoutMs`;
 * dsh's contract for `start()` is that "no timeout applies to background
 * processes" (see `dsh-shell`'s `ShellExecutor` doc comment), so this value
 * is the practical stand-in for "no timeout" for any realistic background
 * job while keeping `execRemote()`'s channel-open watchdog logic intact.
 */
const NO_BACKGROUND_TIMEOUT_MS = 2_147_483_647

/** Source: `dsh-bash-local`'s package description — see `ShellProcessReadLike.delta`'s doc comment. */
const STDERR_MARKER = '\n[stderr]\n'

/**
 * Resolve a caller request into a fully-specified spec. Standalone function
 * (not just a method) so Task 7 — or a future multi-machine router — can
 * reuse the same defaulting logic without an `SshShellExecutor` instance.
 *
 * dsh's `resolve()` signature is synchronous, and `machine.defaultWorkdir`
 * legitimately can be applied synchronously here because the caller (this
 * module's `SshShellExecutor`, constructed per-machine) already holds an
 * already-resolved `RemoteMachine` — the async part of "find this machine
 * in the registry" happens once, earlier, when the executor/machine pairing
 * is constructed (Task 7's job), not on every `resolve()` call.
 */
export function resolveSpec(request: ExecRequestLike, machine: RemoteMachine): ExecSpecLike {
  return {
    command: request.command,
    workdir: request.workdir ?? machine.defaultWorkdir ?? DEFAULTS.workdir,
    timeoutMs: request.timeoutMs ?? DEFAULTS.timeoutMs,
    stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULTS.stdoutMaxBytes,
    signal: request.signal,
    stdin: request.stdin,
    env: request.env,
  }
}

/**
 * Byte-bounded sliding window for `start()`'s live `onData` feed. Mirrors
 * `exec.ts`'s own tail-window algorithm (drop from the front once the
 * window exceeds the budget, UTF-8-boundary-safe) but operates on the
 * already-decoded string chunks `onData` delivers, re-encoding them to
 * bytes only to measure and trim — `execRemote()`'s `StringDecoder` already
 * guarantees each chunk handed to `onData` is complete, valid UTF-8, so the
 * only place a multi-byte character can get split is here, when trimming a
 * chunk's own front to fit the budget.
 */
class LiveWindow {
  private chunks: Buffer[] = []
  private windowBytes = 0
  private lossy = false
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  push(chunk: string): void {
    if (chunk.length === 0) return
    const buf = Buffer.from(chunk, 'utf8')
    this.chunks.push(buf)
    this.windowBytes += buf.length
    if (this.windowBytes > this.maxBytes) this.lossy = true
    while (this.chunks.length > 0 && this.windowBytes > this.maxBytes) {
      const front = this.chunks[0]!
      const excess = this.windowBytes - this.maxBytes
      if (front.length <= excess) {
        this.chunks.shift()
        this.windowBytes -= front.length
      } else {
        this.chunks[0] = front.subarray(excess)
        this.windowBytes -= excess
      }
    }
  }

  /** Mark this window's next drain as lossy for a reason other than its own overflow (e.g. a lost connection). */
  markLossy(): void {
    this.lossy = true
  }

  drain(): { text: string; lossy: boolean } {
    let buf = Buffer.concat(this.chunks)
    if (this.lossy) buf = trimIncompleteUtf8Head(buf)
    const text = buf.toString('utf8')
    const lossy = this.lossy
    this.chunks = []
    this.windowBytes = 0
    // Deliberately NOT resetting `this.lossy` here: once a window has lost
    // data (overflow or a disconnect), that fact stays true about the
    // stream forever — a later read reporting `lossy: false` would wrongly
    // imply the earlier gap had been resolved.
    return { text, lossy }
  }
}

/** Same head-trim as `exec.ts`'s private helper — small enough, and independent enough (bytes, not stream state), to duplicate rather than export a private from that module for one caller. */
function trimIncompleteUtf8Head(buf: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  let start = 0
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
  return start === 0 ? buf : buf.subarray(start)
}

function toRunResultLike(result: RemoteExecResult, timeoutMs: number): RunResultLike {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs,
    stdout: { text: result.stdout, truncated: result.stdoutTruncated },
    stderr: { text: result.stderr, truncated: result.stderrTruncated },
  }
}

export interface SshShellExecutorOptions {
  pool: SshConnectionPool
  machine: RemoteMachine
}

/**
 * Assembles `SshConnectionPool` (Task 4) and `execRemote()` (Task 5) into
 * the `resolve()`/`run()`/`start()` shape dsh's `ctx.shell` seam expects.
 * One instance targets one `RemoteMachine`; Task 7's cordis adapter is
 * expected to construct one per configured machine.
 *
 * ## The target machine name is NOT surfaced here — deliberately
 *
 * An earlier version of this class prepended a `[ssh:<name> user@host]`
 * line to every `run()` result's stderr, reasoning that the model has no
 * other way to learn which machine its commands ran on. That was wrong:
 * `ShellRunResult.stderr.text` is real command output, and prepending to it
 * means a successful command that wrote nothing to stderr now reports
 * *non-empty* stderr on every single call — anything that treats empty
 * stderr as "clean run" (the model's own reading included) is misled on
 * every command, which is worse than the model not knowing the machine
 * name. The machine name is genuine context, but it belongs stated ONCE,
 * not stamped onto every command's output, and stderr is not the channel
 * for standing context.
 *
 * This is Task 7's job instead: the cordis plugin composing this class
 * knows the target machine at load time and can contribute it via
 * `ctx.systemPrompt.section(...)` (the same mechanism `dsh-tool-bash` uses
 * for its own standing tool guidance) or the tool description — wherever
 * dsh puts standing context about what a tool does, once, rather than
 * repeated on every call.
 */
export class SshShellExecutor {
  private readonly pool: SshConnectionPool
  private readonly machine: RemoteMachine

  constructor(options: SshShellExecutorOptions) {
    this.pool = options.pool
    this.machine = options.machine
  }

  /**
   * SSH execution applies NO local confinement whatsoever — no landlock, no
   * sandbox-exec, nothing runs between this process and the remote shell.
   * Returning `'danger-full-access'` (or any other `SandboxMode`) would be
   * type-correct but semantically false: that value describes a *local*
   * sandbox executor's own state, and claiming it here would tell the model
   * or the UI "this ran unconfined by choice within a sandboxing scheme"
   * when the truth is "no sandboxing concept applies to this executor at
   * all". `undefined` is the only honest answer. The real gate on what a
   * remote command is allowed to do is `dsh-user-approval` (policy `ask` in
   * the mobile profile), not this field.
   */
  get sandboxMode(): undefined {
    return undefined
  }

  resolve(request: ExecRequestLike): ExecSpecLike {
    return resolveSpec(request, this.machine)
  }

  /**
   * ## `run()`'s error-mapping decision
   *
   * `execRemote()` rejects (not resolves) when the connection is lost —
   * either before the command ever reached the server (`started: false`,
   * safe to retry) or mid-execution (`started: true`, a non-idempotent
   * command may have half-run). `pool.acquire()` can also reject, for
   * connections that never got established at all (`SSH_UNREACHABLE`,
   * `SSH_AUTH_FAILED`, `SSH_FINGERPRINT_MISMATCH`).
   *
   * This method does NOT catch either kind of rejection and does NOT
   * synthesize a `RunResultLike` from it — both are left to propagate as
   * thrown `SshError`s. This matches `ShellExecutor`'s own documented
   * contract for `run()` to the letter: "rejects only for infrastructure
   * failures. Nonzero exits, timeout kills, and abort kills resolve with a
   * ShellRunResult." A lost SSH connection — whether at acquire-time or
   * mid-command — is exactly an infrastructure failure, not an execution
   * outcome: unlike a timeout or an abort, there is no well-formed
   * `exitCode`/`signal` to report (the process may still be running on the
   * remote host, unreachable), and cramming it into `RunResultLike` would
   * require either inventing a fake `exitCode: null` (indistinguishable
   * from "killed by signal") or overloading `timedOut`/`aborted` with a
   * meaning neither name carries. `SshError` already carries strictly more
   * of the information a caller needs to react correctly — `started`
   * (safe to retry or not) and `partialStdout`/`partialStderr` (output
   * already produced before the link died) — than any resolved result
   * shape could without inventing new fields on a type this package must
   * not own. Task 7's adapter inherits this: a lost connection during
   * `run()` becomes a rejected promise, which the caller (dsh's bash tool
   * layer) is expected to treat as a tool-call error, not a command result.
   */
  async run(spec: ExecSpecLike): Promise<RunResultLike> {
    const client = await this.pool.acquire(this.machine)
    const result = await execRemote(client, {
      command: spec.command,
      timeoutMs: spec.timeoutMs,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      workdir: spec.workdir,
      env: spec.env,
      stdin: spec.stdin,
      signal: spec.signal,
    })
    return toRunResultLike(result, spec.timeoutMs)
  }

  /**
   * Background processes get no executor timeout (dsh's contract), so
   * `execRemote()` is fed `NO_BACKGROUND_TIMEOUT_MS` instead of
   * `spec.timeoutMs` — `spec.timeoutMs` is a foreground-only concept.
   *
   * Unlike `run()`, a lost connection here does NOT propagate as a
   * rejection — `ShellProcess.done` "never rejects" per dsh's contract
   * (mirroring `LocalBashExecutor`: "spawn failures settle as `killed` with
   * the error on stderr"). So `SSH_DISCONNECTED` here settles the process
   * as `killed` and marks the next `readOutput()` as `lossy` — the process
   * outcome genuinely cannot be known (the remote command may still be
   * running, unreachable), which is exactly what `lossy` on a truncated
   * read is for.
   */
  start(spec: ExecSpecLike): ShellProcessLike {
    return new SshShellProcess(this.pool, this.machine, spec)
  }
}

class SshShellProcess implements ShellProcessLike {
  status: ShellProcessStatusLike = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  readonly done: Promise<void>

  private readonly stdoutWindow = new LiveWindow(DEFAULTS.liveBufferMaxBytes)
  private readonly stderrWindow = new LiveWindow(DEFAULTS.liveBufferMaxBytes)
  private readonly controller = new AbortController()
  private resolveDone!: () => void

  constructor(pool: SshConnectionPool, machine: RemoteMachine, spec: ExecSpecLike) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })

    if (spec.signal) {
      if (spec.signal.aborted) this.controller.abort()
      else spec.signal.addEventListener('abort', () => this.controller.abort(), { once: true })
    }

    void this.run(pool, machine, spec)
  }

  private async run(pool: SshConnectionPool, machine: RemoteMachine, spec: ExecSpecLike): Promise<void> {
    try {
      const client = await pool.acquire(machine)
      const result = await execRemote(client, {
        command: spec.command,
        timeoutMs: NO_BACKGROUND_TIMEOUT_MS,
        stdoutMaxBytes: spec.stdoutMaxBytes,
        workdir: spec.workdir,
        env: spec.env,
        stdin: spec.stdin,
        signal: this.controller.signal,
        onData: (chunk, stream) => {
          if (stream === 'stdout') this.stdoutWindow.push(chunk)
          else this.stderrWindow.push(chunk)
        },
      })
      // `aborted` covers both this.kill() and a caller-supplied spec.signal
      // firing — either way the process didn't run to natural completion.
      this.status = result.aborted ? 'killed' : 'completed'
      this.exitCode = result.exitCode
      this.signal = result.signal
    } catch (err) {
      // Either pool.acquire() failed (never even got a connection) or
      // execRemote() rejected with SSH_DISCONNECTED (lost mid-command).
      // Both settle the same way here: the outcome is unknowable, so the
      // process is `killed` (not `completed`) and the loss is recorded as
      // `lossy` rather than silently absorbed. See the class-level
      // `start()` doc comment for why this differs from `run()`.
      this.status = 'killed'
      this.exitCode = null
      this.signal = null
      const message = isSshError(err) ? err.message : err instanceof Error ? err.message : String(err)
      this.stderrWindow.push(`[ssh] connection lost: ${message}\n`)
      // Only claim data loss when the command genuinely had a chance to
      // produce some. `SshError.started` is `true` only when the command
      // actually reached the remote and began running (see errors.ts) — a
      // mid-command disconnect. Both `false` (execRemote confirmed the
      // command never reached the server) and `undefined` (a pool-level
      // failure — handshake, auth, fingerprint mismatch — "unrelated to
      // whether the command started", per errors.ts's own doc comment, and
      // in every one of those cases the command in fact never started)
      // mean nothing was ever produced to lose. Marking `lossy` in either
      // case would overclaim exactly the kind of false constraint point 3
      // warns against (there for `sandbox`, but the same principle
      // applies). A non-SshError is an unexpected/unclassified failure —
      // safer to assume something may be missing than to assert
      // completeness — so it marks lossy.
      const genuinelyLossy = !isSshError(err) || err.started === true
      if (genuinelyLossy) {
        this.stdoutWindow.markLossy()
        this.stderrWindow.markLossy()
      }
    } finally {
      this.resolveDone()
    }
  }

  readOutput(): ShellProcessReadLike {
    const stdout = this.stdoutWindow.drain()
    const stderr = this.stderrWindow.drain()
    const delta = stderr.text.length > 0 ? `${stdout.text}${STDERR_MARKER}${stderr.text}` : stdout.text
    return { delta, lossy: stdout.lossy || stderr.lossy }
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.controller.abort()
    return true
  }
}
