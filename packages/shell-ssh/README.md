# @dsh-mobile/shell-ssh

Remote bash execution over SSH for the `@deepseek-ai/dsh-shell` executor seam. `SshShellExecutor` (Task 4–6) assembles a reusable SSH connection pool and a bounded remote-exec primitive into the `resolve()`/`run()`/`start()` shape `ctx.shell` expects; the `./plugin` subpath wraps it into a real `ShellExecutor` subclass, registers it as `ctx.shell` for one configured machine, and assembles the layered connection probe that `@dsh-mobile/remote-registry` defines but cannot implement itself (see that package's `probe.ts` for why).

This exists because iOS cannot fork/exec — the whole `dsh-mobile` project routes command execution to a real machine over SSH instead of running it locally.

## Exports

- `.` — `SshShellExecutor`, `SshConnectionPool`, `execRemote`, `SshError`/`isSshError`. Zero cordis/dsh-shell/dsh-credentials runtime dependency; safe to import from a UI or a test that only needs the types.
- `./plugin` — the cordis wiring (`name`, `inject`, `Config`, `apply`), plus `createProbeDeps`/`probeConfiguredMachine`. Pulls in `@deepseek-ai/dsh-shell`, `@deepseek-ai/dsh-credentials`, and `@deepseek-ai/schemastery`.

## Config

```yaml
- id: shell-ssh
  name: '@dsh-mobile/shell-ssh/plugin'
  config:
    machine: gpu-h20            # required: a name already registered in ctx.remotes
    liveBufferMaxBytes: 262144  # optional: start()'s background read buffer cap (default 256 KiB)
    connectTimeoutMs: 15000     # optional: TCP + handshake timeout (default 15s)
```

`machine` must already exist in `ctx.remotes` (`@dsh-mobile/remote-registry`) when this plugin loads — an unknown name fails the whole plugin load with `SSH_NO_MACHINE` rather than degrading. `inject: ['remotes', 'credentials']`.

## Behavior

- **One connection per `user@host:port`, reused across calls** — `SshConnectionPool` keeps a cache keyed on that triple; a fingerprint change (pinned via `RemoteRegistry.pinFingerprint`) or a disconnect evicts and reconnects on the next `acquire()`.
- **TOFU + fingerprint pinning** — an unpinned machine accepts whatever host key it sees on first connect; a pinned one rejects a mismatch as `SSH_FINGERPRINT_MISMATCH`. `observedFingerprintFor()` exposes what was actually seen, which is what the probe's `discoveredFingerprint` comes from.
- **Keepalive is on by default** — the pool sets `keepaliveInterval`/`keepaliveCountMax` so a black-holed connection (the Wi-Fi → cellular handoff this project is built around) is detected by ssh2 itself instead of only being discovered the next time a command is attempted.
- **Unexpected disconnects are logged** — `apply()` wires the pool's `onDisconnect` hook to `ctx.logger.warn`; nothing auto-reconnects (that's just the next `acquire()`), but the event is no longer silently dropped.
- **Disconnects mid-command are not silently lossy** — `run()`'s rejection carries the machine's message, a retry-safety note derived from whether the command had already reached the remote host, and any `[stdout before disconnect]`/`[stderr before disconnect]` output collected before the link dropped — all folded into `.message`, the only field a tool-calling error renderer reads.
- **The probe is five stages** — `tcp → credential → handshake → os → gpu`, assembled here because `sshHandshake`/`exec` need this package's pool while `credentialSource` needs `ctx.credentials.describe()` (never `resolve()` — the probe never touches key material). `probeConfiguredMachine(ctx, name, options)` is the one function a settings UI needs; it owns a throwaway pool it disposes when done.
- **The machine name reaches the model exactly once**, as a `ctx.systemPrompt` section (order 106, after `dsh-tool-bash`'s own order-105 guidance) — not stamped onto every command's stderr. The section is registered through `ctx.inject(['systemPrompt'], ...)`, a non-blocking child fiber, so it works regardless of whether `dsh-system-prompt` mounts before or after this plugin, and is replayed if `dsh-system-prompt` itself reloads.

## Known Limitations and Deferred Work

- **`ShellExecRequest.dshEnv` does not cross the SSH boundary.** Correctly forwarding it requires discarding stale `DSH_*` keys a *previous* call exported into the remote shell before applying the current snapshot — this executor composes one command string per call and holds no record of what an earlier call exported, so it cannot `unset` a key it never tracked. A merge that only exports (never evicts) would silently satisfy half the contract and look supported while serving a stale value forever, which is worse than the gap being visible. Left undone; `request.dshEnv` is read by neither `SshShellExecutor` nor the cordis adapter. A future fix needs either a session-tracking layer here or an `unset`-capable command-building path in `exec.ts`.
- **`kill()` is best-effort SSH-channel teardown, not process-group termination.** For a plain (non-PTY) exec channel, OpenSSH does not reliably reap the remote process when the channel closes. A command that forked children (a backgrounded build, a daemon) may keep running on the remote host after `kill()` returns `true` and `status` reads `'killed'`. Approval/UI copy should say "connection closed", not "process killed".
- **No local sandbox.** SSH execution applies zero local confinement — `sandboxMode` is `undefined`, not a specific mode, because no sandboxing concept applies here at all. Whatever the remote command is allowed to do is gated entirely by the approval layer composed above this executor (`dsh-user-approval` in the real profile), not by this package.
- **POSIX-only remote shell assumed** — commands are composed as `sh`-compatible `cd`/`export`/subshell chains (`exec.ts`'s `buildRemoteCommand`); a Windows remote target is not supported.
