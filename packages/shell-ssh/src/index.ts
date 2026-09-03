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
 * `resolve()`/hands specs to this executor.
 *
 * `dshEnv` is a DIFFERENT kind of gap from `sandboxPolicy` — not inert,
 * genuinely dropped, and NOT cheap to add correctly (checked, not assumed;
 * a review asked specifically whether this was a quick fix). Adding a
 * `dshEnv?: Record<string, string>` field to `ExecRequestLike`/
 * `ExecSpecLike` and merging it into `env` is trivial by itself, but it
 * would only be a correct implementation of HALF of dsh's documented
 * contract. `ShellExecRequest.dshEnv`'s own doc comment: "Executors discard
 * ambient `DSH_*` entries before merging this snapshot last, so an
 * unavailable current fact cannot inherit a stale value from the harness
 * process." That "discard ambient entries" half matters concretely here:
 * if the harness stops setting some `DSH_FOO` between one call and the
 * next, a naive merge (export whatever's in the current snapshot, on top
 * of whatever's already there) does nothing to remove a `DSH_FOO` a PRIOR
 * call already exported into that persistent remote shell session — it
 * would keep reading the stale value forever. Doing this correctly over
 * SSH means either enumerating and `unset`-ing every previously-exported
 * `DSH_*` key before applying the current snapshot (this executor has no
 * record of what a past call exported — it isn't a persistent session
 * object, `buildRemoteCommand()` composes one command string per call) or
 * accepting the gap and documenting it. Left undone here; flagging for
 * Task 7 rather than shipping a merge that silently satisfies only the
 * easy half of the contract.
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
   * no stderr in this delta). This exact wording and behavior are copied
   * from `dsh-bash-local`'s own README, verbatim (also present in
   * `README.zh.md` and `lib/index.js`):
   *   /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-bash-local/README.md
   *   "merges offset-based stdout/stderr reads into one consuming delta,
   *   placing stderr under a `[stderr]` marker when present."
   * Not invented here — don't re-derive a different format later.
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
  /**
   * Floor a resolved `timeoutMs` is clamped to (see `resolveSpec`). `0` and
   * negative values are refused rather than passed through as-is: `0 ??
   * DEFAULTS.timeoutMs` keeps `0` (nullish coalescing only replaces
   * `null`/`undefined`), and `execRemote()` feeds `timeoutMs` straight to
   * `setTimeout()`, so `0`/negative would fire the deadline immediately —
   * indistinguishable from a real timeout in the returned `ShellRunResult`.
   */
  minTimeoutMs: 1,
  /**
   * Ceiling a resolved `timeoutMs` is clamped to — `setTimeout`'s maximum
   * valid delay (2^31 - 1 ms, ~24.8 days; see `NO_BACKGROUND_TIMEOUT_MS`).
   * Review finding (measured, not theoretical): an unclamped `timeoutMs`
   * of 3,000,000,000 overflows `setTimeout`'s signed 32-bit argument and
   * Node fires it after ~1ms instead of ~35 days — a command with a 1.5s
   * runtime got killed in 10ms and reported as `timedOut: true`, with
   * nothing in the result distinguishing it from a real timeout. This
   * exact overflow was already documented below to justify
   * `NO_BACKGROUND_TIMEOUT_MS` for the background path; this cap closes
   * the matching gap on the foreground path, which is the one the model
   * actually reaches through `dsh-tool-bash`'s `timeoutMs` parameter.
   */
  maxTimeoutMs: 2_147_483_647,
  /** Foreground stdout capture budget when a request doesn't specify one. */
  stdoutMaxBytes: 256 * 1024,
  /**
   * Floor/ceiling a resolved `stdoutMaxBytes` is clamped to. The floor is
   * deliberately `1`, not some "sane minimum" like a few KB — a caller
   * that resolves e.g. `stdoutMaxBytes: 100` to parse a small, known-shape
   * stdout is a legitimate, real use case (dsh-shell's own doc comment on
   * `ShellExecRequest.stdoutMaxBytes` names exactly this: "Trusted
   * in-process consumers use this when they must parse complete stdout up
   * to their own bounded limit"), and clamping it up to a "safer" floor
   * would silently defeat that. The ceiling exists only to stop an
   * absurd/accidental value (a caller passing bytes when they meant KB, or
   * `Number.MAX_SAFE_INTEGER`) from asking `Buffer.concat()` to hold
   * gigabytes.
   */
  minStdoutMaxBytes: 1,
  maxStdoutMaxBytes: 1024 * 1024 * 1024,
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
   * budget. Injectable per-instance via `SshShellExecutorOptions` (a
   * mobile profile will want to shrink it) — this is only the default.
   */
  liveBufferMaxBytes: 256 * 1024,
} as const

/**
 * `execRemote()` requires a numeric `timeoutMs`; dsh's contract for
 * `start()` is that "no timeout applies to background processes" (see
 * `dsh-shell`'s `ShellExecutor` doc comment), so `DEFAULTS.maxTimeoutMs`
 * (itself `setTimeout`'s maximum valid delay) is the practical stand-in for
 * "no timeout" for any realistic background job while keeping
 * `execRemote()`'s channel-open watchdog logic intact. Same numeric value
 * as `resolveSpec`'s foreground cap, same underlying reason — deliberately
 * not two separate magic numbers.
 */
const NO_BACKGROUND_TIMEOUT_MS = DEFAULTS.maxTimeoutMs

/** Source: `dsh-bash-local`'s README.md (see `ShellProcessReadLike.delta`'s doc comment for the exact path/quote). */
const STDERR_MARKER = '\n[stderr]\n'

/**
 * Clamp `value` into `[min, max]`. `NaN` (a malformed request field) falls
 * back to `min` rather than propagating — `Math.max(NaN, min)` and
 * `Math.min(NaN, max)` both evaluate to `NaN`, so an un-guarded clamp would
 * let a `NaN` through unclamped, defeating the whole point. `Infinity`
 * needs no special case: `Math.min(Math.max(Infinity, min), max) === max`
 * falls out of the two `Math` calls on its own.
 */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

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
    // C1 (review): dsh's own doc comments mandate this cap in two places —
    // `ShellExecRequest.timeoutMs` is "Timeout override in milliseconds
    // (implementations cap it)", and `ShellExecutor.resolve()` is "Apply
    // implementation-owned defaults AND CAPS to a request". `?? DEFAULTS...`
    // alone only fills an absent field; it lets `0`, a negative value, or
    // an overflow-inducing value (e.g. 3_000_000_000, see
    // DEFAULTS.maxTimeoutMs's doc comment) straight through to
    // `execRemote()`'s `setTimeout()` call unmodified. Clamping here is
    // what "cap" actually means in dsh's contract.
    timeoutMs: clamp(request.timeoutMs ?? DEFAULTS.timeoutMs, DEFAULTS.minTimeoutMs, DEFAULTS.maxTimeoutMs),
    stdoutMaxBytes: clamp(
      request.stdoutMaxBytes ?? DEFAULTS.stdoutMaxBytes,
      DEFAULTS.minStdoutMaxBytes,
      DEFAULTS.maxStdoutMaxBytes,
    ),
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
    // I1 (review): DOES reset `this.lossy` here — a previous version of
    // this comment argued the opposite ("stays true about the stream
    // forever") and was wrong. dsh's own `ShellProcessRead` doc comment
    // defines `lossy` per-READ, not per-stream: "One incremental
    // `readOutput` read"; `lossy` is "True when truncation dropped unread
    // bytes THE DELTA cannot include". A second `readOutput()` call after
    // an earlier overflow has genuinely lost nothing NEW — there is
    // nothing left to report as missing from ITS delta — so leaving the
    // flag stuck at `true` forever is a permanent false positive on every
    // later read of an otherwise-healthy long-running background job.
    this.lossy = false
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
  /**
   * Overrides `DEFAULTS.liveBufferMaxBytes` for this instance's `start()`
   * live-read buffer (see `LiveWindow`). Made injectable per I5 (review): a
   * mobile profile — memory-constrained, on a battery — will want a
   * smaller live-buffer bound than the default without forking this class.
   */
  liveBufferMaxBytes?: number
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
  private readonly liveBufferMaxBytes: number

  constructor(options: SshShellExecutorOptions) {
    this.pool = options.pool
    this.machine = options.machine
    this.liveBufferMaxBytes = options.liveBufferMaxBytes ?? DEFAULTS.liveBufferMaxBytes
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
      // I3 (review): `stdoutMaxBytes` is deliberately the ONLY one of the
      // two taken from `spec` here. dsh-shell's own doc comment on
      // `ShellExecSpec.stdoutMaxBytes` is explicit: "run() uses it for
      // stdout; background jobs and stderr keep the executor's own output
      // cap" — a caller resolving a small `stdoutMaxBytes` to parse a known
      // stdout shape must not have that same small budget silently applied
      // to stderr too, or an error message that needed the full budget
      // gets truncated as a side effect nobody asked for.
      stdoutMaxBytes: spec.stdoutMaxBytes,
      stderrMaxBytes: DEFAULTS.stdoutMaxBytes,
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
    return new SshShellProcess(this.pool, this.machine, spec, this.liveBufferMaxBytes)
  }
}

class SshShellProcess implements ShellProcessLike {
  status: ShellProcessStatusLike = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  readonly done: Promise<void>

  private readonly stdoutWindow: LiveWindow
  private readonly stderrWindow: LiveWindow
  private readonly controller = new AbortController()
  private resolveDone!: () => void

  constructor(pool: SshConnectionPool, machine: RemoteMachine, spec: ExecSpecLike, liveBufferMaxBytes: number) {
    this.stdoutWindow = new LiveWindow(liveBufferMaxBytes)
    this.stderrWindow = new LiveWindow(liveBufferMaxBytes)
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
        // I3 (review): background jobs "keep the executor's own output
        // cap" per dsh-shell's doc comment on `ShellExecSpec.stdoutMaxBytes`
        // — NEITHER stream uses `spec.stdoutMaxBytes` here, unlike run()'s
        // stdout. `spec.stdoutMaxBytes` is a foreground-only override; a
        // background job has no foreground caller waiting to receive a
        // capped result the way run() does, so there is no "this caller
        // asked for a small budget" signal to honor for either stream.
        // (Separately, and unaffected by this: `this.stdoutWindow`/
        // `stderrWindow` — fed by `onData` below — are what `readOutput()`
        // actually serves, bounded by `liveBufferMaxBytes`, not by
        // anything passed here; this only bounds `execRemote()`'s own
        // internal, currently-unused-by-us `RemoteExecResult.stdout`/
        // `stderr` accumulation.)
        stdoutMaxBytes: DEFAULTS.stdoutMaxBytes,
        stderrMaxBytes: DEFAULTS.stdoutMaxBytes,
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

  /**
   * ## `kill()` is best-effort SSH-channel teardown, NOT process-group termination
   *
   * dsh's contract for `ShellProcess.kill()` is "Kill the process **group**".
   * This implementation cannot deliver that: `this.controller.abort()`
   * drives `execRemote()`'s abort path, which calls `stream.close()` on the
   * SSH exec channel — that tears down the CHANNEL, not the remote command.
   * For a plain (non-PTY) `exec` channel, OpenSSH does not reliably reap the
   * process on the other end, and is documented to ignore the SSH protocol's
   * own `signal` request in this mode. A command that forked (`make -j8`,
   * a backgrounded daemon, anything with children) can keep running on the
   * remote host indefinitely after this returns — while `status` flips to
   * `'killed'`, `exitCode` reads `null`, and `kill()` itself returns `true`,
   * all of which look exactly like a real, successful kill from the caller's
   * side. This is the same category of problem as claiming a `sandbox` this
   * executor doesn't provide (see the class-level doc comment above) —
   * claiming a constraint that doesn't actually hold — except here the
   * type system gives no field to just omit; the closest available honest
   * signal is this doc comment. Task 7's approval/UI copy should say
   * something like "connection closed" rather than "process killed" when
   * this path fires, since the user will otherwise believe the remote
   * command actually stopped.
   */
  kill(): boolean {
    if (this.status !== 'running') return false
    this.controller.abort()
    return true
  }
}
