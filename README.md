# dsh-mobile

A phone-native [dsh](https://github.com/deepseek-ai) (DeepSeek Harness) — the
agent runtime itself runs on the device (agent loop, session state, skills,
sub-agents, all offline-capable), while any work that needs a real shell is
dispatched over SSH to a machine the user configures. iOS forbids running a
local shell: the app-container sandbox rejects `fork`/`exec` outright, and
AMFI code-signing only executes binaries signed inside this app's own team —
together that rules out anything like Termux. So instead of a local shell,
this repo gives dsh a **remote** one.

The design rationale, feasibility numbers (jitless throughput vs JIT,
confirmed on this machine), and the plugin-by-plugin implementation plan live
in `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## The three packages

| Package | What it is |
|---|---|
| `packages/remote-registry` (`@dsh-mobile/remote-registry`) | The registry of machines a user has configured: add/list/remove, SSH host-key pinning, and credential lookup via `@deepseek-ai/dsh-credentials`. Provides `ctx.remotes`. |
| `packages/shell-ssh` (`@dsh-mobile/shell-ssh`) | Implements `@deepseek-ai/dsh-shell`'s `ShellExecutor` over an SSH connection to one registered machine (via `ssh2`). Provides `ctx.shell` — see **Known limitations** below for what that promise does *not* cover. |
| `packages/mobile-app` (`@dsh-mobile/mobile-app`) | The dsh **bundle**: a `cordis.patch.yml` that disables every local-process plugin dsh-base/dsh-headless would otherwise mount (bash, pwsh, PTY, tmux, the local exec sandbox) and wires `remote-registry` + `shell-ssh` in their place. This is what a profile lists in `dsh.profile.bundles`. |

Each package's own `.` export is a pure barrel (types + dependency-free
functions); the cordis wiring (`name`/`inject`/`apply`) lives behind an
independent `./plugin` subpath, so importing the barrel never pulls in `zod`,
`ssh2`, or any dsh peer dependency. `mobile-app`'s patch references the
`/plugin` form — a bare package name would resolve to a module with no
`apply` and fail the whole plugin tree.

## Setting up the `mobile` profile

### Step 1 — create the profile

This writes into *your* dsh home (`~/.dsh`), so it isn't something a test can
do for you:

```bash
mkdir -p ~/.dsh/profiles/mobile
cat > ~/.dsh/profiles/mobile/package.json <<'JSON'
{
  "name": "dsh-profile-mobile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@dsh-mobile/mobile-app"
      ]
    }
  }
}
JSON
printf '[]\n' > ~/.dsh/profiles/mobile/cordis.patch.yml
printf '[]\n' > ~/.dsh/profiles/mobile/cordis.yml
```

### Step 2 — link the three workspace packages in

`~/.dsh/profiles/mobile` is its own, separate pnpm project — not a member of
this repo's workspace — because that's how the other real profiles
(`~/.dsh/profiles/{web,headless,desktop}`) are laid out. That separation is
exactly what breaks the naive approach: `mobile-app`'s and `shell-ssh`'s own
`package.json` declare their sibling dependencies as `workspace:*`, which
**only resolves inside this repo's pnpm workspace**. Two things that don't
work, in order, before the one that does:

- `pnpm add "@dsh-mobile/mobile-app@file:<path>" ...` fails outright:
  `[ERR_PNPM_WORKSPACE_PKG_NOT_FOUND] "@dsh-mobile/remote-registry@workspace:*"
  is in the dependencies but no package named "@dsh-mobile/remote-registry"
  is present in the workspace`. pnpm reads `mobile-app`'s manifest to resolve
  *its* dependencies and hits the `workspace:*` specifier with no workspace
  to resolve it against.
- `pnpm link <path> <path> <path>` avoids that error (a plain symlink, no
  manifest re-resolution) but pnpm itself warns why that's a trap: peer
  dependencies (`@deepseek-ai/cordis`, `dsh-credentials`, `dsh-shell`,
  `dsh-storage-domain`) and regular dependencies (`ssh2`, `zod`,
  `@deepseek-ai/schemastery`) never get installed, because a `link:`
  specifier only symlinks — it never triggers dependency resolution for the
  linked package.

What actually works: `file:` dependencies **plus** a `pnpm-workspace.yaml`
`overrides` block forcing the two inter-package `workspace:*` specifiers to
resolve to the same local paths, wherever they show up in the graph (as a
top-level dependency, or transitively inside another package's manifest).
`pnpm add` will warn `ignoring workspace root` and pnpm 11 no longer reads a
`"pnpm"` key in `package.json` (it moved to `pnpm-workspace.yaml`) — write
the files directly instead of using `pnpm add`:

```bash
cat > ~/.dsh/profiles/mobile/pnpm-workspace.yaml <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

overrides:
  '@dsh-mobile/remote-registry': file:/absolute/path/to/dsh-mobile/packages/remote-registry
  '@dsh-mobile/shell-ssh': file:/absolute/path/to/dsh-mobile/packages/shell-ssh
YAML

cat > ~/.dsh/profiles/mobile/package.json <<'JSON'
{
  "name": "dsh-profile-mobile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@dsh-mobile/mobile-app"
      ]
    }
  },
  "dependencies": {
    "@dsh-mobile/mobile-app": "file:/absolute/path/to/dsh-mobile/packages/mobile-app",
    "@dsh-mobile/remote-registry": "file:/absolute/path/to/dsh-mobile/packages/remote-registry",
    "@dsh-mobile/shell-ssh": "file:/absolute/path/to/dsh-mobile/packages/shell-ssh"
  }
}
JSON

cd ~/.dsh/profiles/mobile && pnpm install
```

`ssh2`'s optional native `cpu-features` build gets skipped by pnpm's
script-approval gate (`[ERR_PNPM_IGNORED_BUILDS]`) — harmless, `ssh2` falls
back to its pure-JS crypto path without it. The peer dependencies
(`@deepseek-ai/cordis` etc.) are deliberately **not** installed into the
profile at all; every existing profile is the same way (checked
`~/.dsh/profiles/headless`) — dsh resolves those from its own install tree
at `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`,
not from the profile.

Both packages ship built `lib/` output already (`prepare`/`build` run
`tsdown`); after `pnpm install` confirm it's actually there —
`ls ~/.dsh/profiles/mobile/node_modules/@dsh-mobile/*/lib` — since dsh loads
compiled `.js`, never `.ts`.

### Verify

```bash
/opt/homebrew/bin/dsh --profile mobile --dump-config
```

should print the composed tree with `storage`, `storage-json`,
`storage-domain`, `remote-registry`, and `shell-ssh` present, and
`subprocess`, `bash-sandbox`, `pwsh-sandbox`, `tool-bash`, `tool-pwsh`, and
`sandbox` present but `disabled: true`. (Two other rows the patch tries to
disable, `terminal-bash` and `tmux-context`, print
`patch: entry "..." not found` on stderr instead — dsh-base + dsh-headless
never mounts either one in the first place, so there's nothing to disable;
`cordis.patch.yml`'s own comments call this out.) See
`packages/mobile-app/tests/composition/dump-config.test.ts` for the
automated version of this check — it `describe.skipIf`s itself with a loud
console warning if it can't find this profile.

## Registering a machine

There's no chat-facing tool or UI for this yet — `remote-registry` is a
library (`ctx.remotes`, a `RemoteRegistry` instance) with no `dsh-tool-*`
plugin wrapping it in this repo. For now, registering a machine means using
the public API directly, e.g. from a one-off script run against the profile:

```ts
import { RemoteRegistry } from '@dsh-mobile/remote-registry'
// (real setup wires this through storage-domain + credentials via the
//  `remote-registry` plugin — see packages/remote-registry/tests/mock/harness.ts
//  for how the test suite constructs one end-to-end)

await registry.importUrl('dsh-remote://alice@gpu-box.example.com:22/?tags=gpu&workdir=/home/alice')
await registry.setPrivateKey('gpu-box', await readFile('~/.ssh/id_ed25519', 'utf8'))
```

Then point `shell-ssh`'s `machine` config at that name — either in your own
profile-level `cordis.patch.yml` (`~/.dsh/profiles/mobile/cordis.patch.yml`,
applied after every bundle layer including `mobile-app`'s), or via a
`--patch` overlay:

```yaml
- id: shell-ssh
  config:
    machine: gpu-box
```

and, since `tool-bash` ships disabled (see below), also flip it on in the
same file:

```yaml
- id: tool-bash
  disabled: false
```

Registering a machine while dsh is already running does **not** make
`ctx.shell` appear — `shell-ssh`'s `apply()` only checks `ctx.remotes.get()`
once, at mount time, and doesn't subscribe to `remote-registry`'s
`domain/changed` events. Restart dsh after registering a machine.

## Known limitations

- **`tool-bash` ships disabled.** `ctx.shell` doesn't exist until a machine
  is registered (see below), and `tool-bash` hard-depends on it
  (`inject: ['shell', ...]`) — leaving it enabled with no machine configured
  would leave its fiber permanently `PENDING`, which dsh's own
  `assertEntriesActivated()` treats as a boot failure for the *entire*
  plugin tree, not just that one tool. Flip it on yourself once a machine is
  registered (see above).
- **`kill()` is best-effort channel teardown, not process termination.**
  dsh's contract says "kill the process group"; all `shell-ssh` can actually
  do is close the SSH channel. A non-PTY exec channel doesn't reliably
  propagate that to the remote process (OpenSSH is notorious for ignoring
  SSH-level signal requests), so e.g. `make -j8` keeps running on the remote
  machine after `kill()` returns `true` and local status flips to
  `'killed'`.
- **`dshEnv` doesn't cross the SSH boundary.** It isn't part of the
  `ExecRequestLike` shape `shell-ssh` consumes, and structural typing lets
  the extra property through the type checker silently — any managed
  `DSH_*` environment snapshot the caller attached is dropped, not
  forwarded to the remote shell.
- **No local sandbox.** `fs-sandbox`/`sandbox-policy` still constrain the
  pure-JS file tools (`tool-fs`, etc.), but there is no exec-time
  confinement on the remote side — whatever the registered machine's own
  user account can do, a command executed there can do. The iOS app
  container is not a substitute for that; it only sandboxes the *device*
  side, which never executes attacker-influenced code paths.
- **The mobile profile does not currently complete a real boot with zero
  machines registered**, contradicting what Task 12's design intended.
  `dsh --profile mobile "<task>"` fails during plugin-tree instantiation —
  *before* reaching the LLM call or any credential check — with:
  ```
  Error: dsh: plugin tree failed to load: dsh: 2 entries did not activate
  @deepseek-ai/dsh-permission-presets: pending (waiting for service: shell)
  @deepseek-ai/dsh-tool-fs-search: pending (waiting for service: subprocess)
  ```
  Both are plugins **dsh-base itself** always mounts, not anything
  `mobile-app` adds: `dsh-permission-presets` has `static inject =
  ["shell", ...]` (it reads `ctx.shell.sandboxMode` to pick a sandbox
  preset), and `dsh-tool-fs-search` has `inject = ["subprocess", ...]`
  because both its `grep`/`glob` tools shell out to a bundled `ripgrep`
  binary through `ctx.subprocess.spawn()` rather than searching in pure JS
  — i.e. it needs exactly the "spawn a local binary" capability iOS
  forbids, the same as `tool-bash`, and should have been on the disabled
  list from the start rather than classified as pure-JS. With every local
  shell backend disabled and `shell-ssh` correctly declining to register
  `ctx.shell` for an unconfigured machine (Task 12's deliberate choice, to
  avoid mounting a `ctx.shell` that's guaranteed to throw), dsh-base's own
  assumption that *some* `ctx.shell` always exists is never satisfied, and
  `assertEntriesActivated()` fails the whole tree before any task ever
  runs. `--dump-config` doesn't catch this because it only composes the
  tree; it never instantiates it. Fixing this needs either a real
  `ctx.subprocess` alternative for search, or `shell-ssh` registering some
  `ctx.shell` (with a defined `sandboxMode`) even with no machine
  configured, deferring the failure to actual execution instead of mount
  time — a design decision beyond this task's scope.
- **`@dsh-mobile/shell-ssh` cannot be loaded at all under jitless** — not
  "connections fail," the process crashes on import, before any SSH
  connection is attempted. `ssh2@1.17.0`'s `lib/protocol/crypto.js` starts
  an async WebAssembly instantiation (for its Poly1305 cipher) the instant
  it's required, in a promise nothing awaits or catches:
  ```js
  init: (() => new Promise(async (resolve, reject) => {
    try { POLY1305_WASM_MODULE = await require('./crypto/poly1305.js')() /* ... */ }
    catch (ex) { return reject(ex) }
    resolve()
  }))(),
  ```
  Jitless has no `WebAssembly` (confirmed: this repo's own feasibility
  write-up in `docs/superpowers/specs/` already establishes that as a hard
  constraint, for the *Pyodide/WASM-toolchain* case — this is a second,
  unrelated place the same constraint bites, in a dependency chosen for
  something that has nothing to do with WASM). The promise rejects, nothing
  observes the rejection, and Node reports an unhandled rejection and
  exits. Reproduced and asserted in
  `packages/mobile-app/tests/composition/dump-config.test.ts` (both
  `shell-ssh/index.js` and `shell-ssh/plugin.js`, both crash identically);
  `remote-registry`'s two entries import cleanly. This is the single
  highest-priority defect surfaced by this task: the whole premise of
  `shell-ssh` is running on-device where JIT (and WASM) is unavailable, and
  as shipped it cannot even be imported there. A fix needs either replacing
  `ssh2`, or `shell-ssh` defensively catching that one promise
  (`import('ssh2/lib/protocol/crypto.js').then((m) => m.init.catch(() =>
  {}))`) to at least stop the crash — Poly1305 support would still be
  unavailable, which is fine as long as `ssh2` doesn't require it for every
  key exchange / cipher suite it offers.
