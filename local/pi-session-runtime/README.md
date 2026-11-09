# pi-session-runtime

Source-only shared library for Pi 1.5 session owners, not a standalone extension.
Subagents and Side Chat share its capture, selection, seed, SDK assembly and managed
view APIs; Session Compact consumes capture/selection without creating child views.
Consumers use `file:../pi-session-runtime` and TypeScript subpath exports. There is
no build, root barrel or Pi registration. Install consumers separately; this library
does not register commands, start tasks or discover external providers on its own.

## Explicit SDK provider grants

`pi-session-runtime/sdk-provider` owns the shared exact grant reader, frozen proof
codec, live file checks, binding fence and approved factory/observer assembly.
See the optional Subagents consumer's [SDK provider contract](../pi-subagents/docs/sdk-providers.md)
for the complete JSON format and scope/lifecycle rules. That consumer and its
configuration are not installed or loaded by this library. The source-only helper imports
`pi-runtime-contracts/child-capabilities-v1` and `provider-activity-v1`. Child registry
storage ABI 2 uses `pi.child-capability-registry.v2`; V1 DTO/API names remain, but
old physical ABI-1 validators/managers never supply new SDK authority. Core
publishers must use the current library; old external provider registrations stay
isolated while independent external supplemental owners use ABI 2. No provider
implementation or brand-specific policy lives here. Unchanged descriptor and grant
metadata is cached. `factory-loader` pins loaded canonical path code digests across
loader copies/SDK realms and demands a fresh process after code drift.


`session-assembly` creates a headless SDK child with its own native SessionManager,
in-memory settings, resource loader and ModelRuntime. The owner supplies the frozen
settings/model/tool selection, explicit extension factories, native writer and a
child-local shutdown callback. Ambient packages and extensions are disabled; built-in
extension owners are also disabled unless explicitly approved as described below.
No cwd or process environment is changed. Compaction is always
enabled with deterministic child defaults: reserve=min(16384, window/8) and
keepRecent=min(20000, window/16), including the selected model's override. Caller
settings are deep-copied. The caller owns task admission, deadline, abort and disposal.

### Explicit built-in extension assembly

`ChildSessionAssemblyOptions.extensions` accepts `readonly InlineExtension[]`; existing
plain `ExtensionFactory` functions still work. The optional
`approvedBuiltinExtensions?: readonly ("codemode" | "tool-search" | "mcp")[]` defaults
to an empty list. Each approved name requires exactly one matching
`{ name, factory, builtin: true }` entry in `extensions`. Unknown or duplicate approvals,
missing or invalid factories, duplicate built-in factories and unapproved built-in
factories reject before any factory runs. Other built-in names, including `llama.cpp`,
cannot be approved. Parent settings and factory metadata never grant permission.
Explicit non-built-in inline factories retain their ordinary SDK behavior; a name alone
does not grant built-in identity or cause another factory to be discovered.

The consumer creates each factory through the canonical public SDK namespace:

```typescript
const sdk = getSessionAssemblyPublicModules()["@earendil-works/pi-coding-agent"];
const builtinOptions = {
  approvedBuiltinExtensions: ["codemode", "tool-search"] as const,
  extensions: [
    { name: "codemode", builtin: true, factory: sdk.createCodemodeExtension({ mode: "on", models: false }) },
    { name: "tool-search", builtin: true, factory: sdk.createToolSearchExtension() },
  ],
  tools: ["read", "codemode", "tool_search"],
};
// Supply these fields with the owner's other assembleChildSession options.
```

Assembly keeps `noExtensions: true` and derives `additionalExtensionPaths` only from
approved names as canonical `builtin:<name>` tokens. Every other built-in stays disabled;
skills, prompts, context files and themes remain undiscovered. Pi's public resource
loader gives the approved tools canonical built-in `sourceInfo`, rather than inline
provenance. Approval loads a factory; the explicit `tools` selection still determines
the initial active tools. Model scope, frozen settings, native writer and shutdown
ownership do not change.

This library does not create factories, discover configuration or authorize access to
conversation data, credentials, files, tools or models. A `builtin: true` label or
canonical `sourceInfo` is provenance, not a sandbox or data grant. Consumers must check
their own authority and supply appropriately restricted factory options before assembly
(for example `models: false` when codemode must not expose the model catalog).
MCP is opt-in through `sdk.createMcpExtension(...)`; that SDK factory reads MCP
configuration by default and connects on `session_start`, so the consumer owns its
configuration and transport policy. The local regression supplies `loadConfig` with
`{ servers: [], errors: [] }` and a rejecting transport factory; it never connects to
real servers.

### SDK realm ownership

This library owns one immutable, process-wide child SDK realm, shared by native ESM
and Root Jiti copies of `session-assembly`. Equal Pi versions do not imply equal class
prototypes or callback/registry state: Side and Subagents can otherwise resolve different
physical SDK copies while loading the very same CC factory path. Jiti's process-wide CJS
cache would then keep the first factory's realm while the second assembly created a
child in another realm.

`getSessionAssemblyPublicModules()` returns the canonical frozen table of the existing
public `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and
`@earendil-works/pi-tui` peers. The first use publishes
`Symbol.for("pi.session-runtime.session-assembly-realm.v1")` as a non-writable,
non-configurable property containing a frozen
`{ version: 1, sdkVersion: codingAgent.VERSION, publicModules }`. All later library
copies with the same SDK version use that exact table. Both `assembleChildSession()`
and the managed view dispatch their SDK operations through it, not through their own
physical imports. `TerminalOwner.acquire()` dynamically loads this accessor on first
handoff and captures the exact canonical TUI keybindings object plus its matching setter.
Return restores that same reference in the state cell the child actually changed, never
in the owner's unrelated physical TUI copy. The idle owner module has only type imports
from Pi; constructing a Main binding does not initialize the SDK realm. Both the lazy
import and input-drain continuations recheck abort, lease generation, current owner and
disposal before changing Main's terminal state. An unknown schema, mutable/malformed registry, missing public function
or differing SDK version throws; no registry is replaced or downgraded. The managed
view also rejects a genuinely noncanonical AgentSession before terminal handoff.
The registry lasts for the process, not a session, because both owners and the CJS cache
outlive individual child sessions.

Consumers should retain their first-use `session-assembly` import and pass its getter's
table to `loadApprovedFactoryModule()`. Neither importing the module nor getting the
table creates sessions, model runtimes, stores or loaders. Caller-supplied SessionManager
objects remain caller-owned; consumers needing manager class identity also construct
those managers through the canonical namespace. This is not a conversion or clone of
an existing native writer.

The library also owns `Symbol.for("pi.session-runtime.factory-loader-realms.v1")`:
`{ version: 1, paths: Map<approvedPath, frozen [codingAgent, ai, tui]>, digests: Map<canonicalPath, sha256> }`. Before any
factory import/cache lookup, each path claims its three namespace references. All loader
copies reject a conflicting claim visibly rather than returning a factory from a wrong
CJS-cache realm. Claims survive failures and session shutdown because partially loaded
modules may still be cached. A malformed/version-mismatched registry also rejects loads.
This guard does not change the owner's approved path/package/hash/export checks or
Pi compatibility probes, and does not provide arbitrary multi-realm module isolation.
Core/TypeBox mappings remain the consumer's existing responsibility; no dependency or
namespace discovery is added for them.

The local regression uses two real, same-version physical SDK copies, two actual
assembly/loader instances and one unchanged factory path. It covers native-first and
Jiti-first claims in isolated processes, alternates each owner twice in the same process,
checks actual session/runner/manager and native mode class identity, rejects conflicting
same-path mappings, and tests malformed/mixed-version registries. Native and Jiti
TerminalOwners also alternate over a FakeTerminal using real canonical get/set functions:
every child keybindings replacement restores Main's original object identity, while the
other physical TUI state cell stays unchanged. Separate regressions cover idle bindings
and cancellation/release/disposal during the first-use import. No terminal is started
and no provider request is sent.

## Capture ownership

`fork-turns` is only the small shared grammar used by cold tool schema/parser paths.
`effective-context` has no runtime Pi imports. `acquireEffectiveCapture` leases a session
generation using the public SessionManager object as binding identity. Consumers sharing
that identity share a capture and provider decorator. Tokens are reference counted; the
last release removes the observation and capture. Main calls `retire()` on binding
shutdown/reload, even when Side still holds a lease on the same SessionManager. A
replacement binding retires its old generation, and a stale release cannot touch the new binding.

On each business `context_with_system` event, record a `RequestCandidate` with its leaf,
selected model/effort, active tool and capability fingerprints, native message provenance,
and the Main run's public `ctx.signal`. Refresh public providers at that boundary (both
registered extension providers and model-catalog built-ins). The public provider
`streamSimple` wrapper copies only normalized messages and permitted metadata, then calls
the original with the original receiver/options and returns its stream unchanged. It uses
`AsyncLocalStorage` to associate native Pi provider callbacks with that exact invocation.
Captures retain normalized message bodies, not authentication options, headers,
callbacks or the provider's encoded wire payload. Those messages can include text,
images, thinking/signatures, tool arguments/results and usage. Sensitive content
already present in a message is not redacted. When a child inherits selected messages,
its later model requests send them to its selected provider, including a different
provider from Main. Selecting `none` avoids inheriting the parent conversation; the
owner still supplies the child's own instructions and tools.

Each session/generation retains only its latest capture and frozen native-message
copy in process memory. The store deep-copies on put/get; it is not an archive or a
provider sandbox. Granted factories receive the full ExtensionAPI and run as trusted
code in the same process. Grant/file checks do not sandbox their filesystem, network
or transitive dependencies.

Consumers call `lease.confirmRequest(ctx.signal)` from Pi's public
`before_provider_request` and `after_provider_response` events. The matching session,
signal, async invocation, candidate and revision must all agree before committing a
capture. An anchor or even an identical transcript does not establish Main ownership;
direct summaries cannot consume the candidate just by reusing sessionId/signal. Requests
whose providers emit neither native callback remain unconfirmed and unavailable. An
already confirmed candidate is not consumed again by retries. Every new candidate uses
its own frozen leaf, even when two genuine Main requests have identical transcripts;
otherwise a response removed by a later transformer could reappear as a native tail.
No provider payload is parsed, changed or used as wire proof.
Provider replacement is detected by object/function identity; restoration only occurs
while the function is still this library's wrapper. Undecoratable providers make capture
unavailable. `wirePrefix` is always `unknown`: wire encoders/onPayload reconciliation is
reserved for a later provider-specific implementation.

`EffectiveContextStore` is process memory, partitioned by session and generation. The
shared cell is `Symbol.for("pi.session-runtime.effective-context.v1")`, owned solely by
this library so bundled consumers share it. A capture represents the **last context
actually sent by Main**, not the current Magic database contents. Background updates may
make it older than the database without invalidating it; this is the context Main saw
when it chose to spawn. There is no Magic epoch subscription. Validity is structural:
session/generation, branch membership, projection-reset entries and model/tool/capability
fingerprints. Release leases on session shutdown/reload.

`requiresEffectiveCapture` is true for unknown/transformed request state, canonical
Magic package provenance in public tool/command `sourceInfo`, or any current-branch
`compaction.details.source === "magic-context"`. Source paths are realpathed and their
owning package manifest is read; command names do not establish provenance. Native-only
evidence belongs to the current capture: `requestTransforms` lazily compares its provider
hash with the frozen native messages only when a consumer asks to fork, then memoizes
that capture's result. Each new request/capture and every structural invalidation discard
the memo; missing capture or changed capability returns unknown. No generation-wide
native-only assumption survives a later transformed request. Consumers invalidate a
structurally unsuitable capture before consulting this evidence for fallback permission,
so evidence from another branch/projection cannot authorize native replay. Absence of a marker proves nothing.

## Selection and seeds

`native-child-context` is a first-use import. `selectEffectiveContext` checks generation,
branch membership, selected/physical model (when available), effort, tool/capability
fingerprints, and compaction/context-edit/branch-summary resets after the captured leaf.
It combines the latest valid normalized request with only the new native tail. Pending
assistant messages and incomplete, duplicate or mismatched tool batches are truncated
at the largest replayable prefix. `none` needs no capture.

Without valid capture, `requiresCapture: true` throws `EffectiveContextUnavailableError`
with `code = "effective-context-unavailable"` and a machine-readable reason. Side decides
whether to prompt for a Main turn or explicitly accept native data; this library never
silently authorizes raw fallback. An explicitly established native-only session can use
Pi's public `buildSessionProjection`; its `exactRequestPrefix` is false.

Numeric N counts complete native business turns (user, bash/custom input and branch
summary), with exact provenance mapping. Only system/compaction and explicitly identified
memory preambles survive across unselected turns. Ordinary custom/bashing text is not
global preamble; attached body messages follow their turn. Unknown request-only custom
injections or ambiguous user rewrites make N unavailable (all can still work). Missing
historical turns are never fetched from raw history to fill N. Repeated/self-retaining
compactions and context edits are materialized by Pi projection before selection.

`src/magic-context-format.ts` owns the optional Magic Context 0.41.1 request-format
decoder. Only a leading, untagged m[0]/m[1] user pair with the producer's ordered block
vocabulary, content shape and body-relative timestamps enables its additive identity
matching: one canonical `§N§ ` prefix on text blocks and one temporal comment on the
first text block. The complete remaining message (including timestamp, images and
metadata) must match exactly one native origin in order. Duplicate identities, native
turns colliding with the envelope, unknown blocks, edits and metadata changes refuse N.
MC replaces existing tag notation before adding a new tag. With an MC envelope,
any native user-shaped text block beginning with `§` followed by a digit therefore
refuses N, regardless of whether its origin is turn, preamble or body. This deliberately
covers well-formed, malformed and dangling tag prefixes conservatively, including
inherited tagged seed messages. Without an MC envelope, literal input still exact-maps.
Multiple native matches also refuse N across all origin kinds.
The pair is preamble; it is retained verbatim with system/native summaries, including
folded history and memory updates. No text is cleaned in the selection or child seed,
and `all` retains the same messages as before. No database lookup or raw-history fill
is used. Unavailability errors recommend `none`; another Main turn cannot repair an
unknown format or an ambiguous identity.
During MC's first materialization a dropped user sentinel can remain in the request
until its native compaction marker takes effect. It has no proven native identity, so
N refuses that capture; it never recovers the dropped user's original text to fill N.

This decoder remains only for legacy session/request compatibility. Magic Context is
not installed or migrated with this library, and no producer source is imported or copied.
`test/magic-context-mapping.test.ts` uses self-contained 0.41.1 request-format samples
with explicit tags, temporal comments, m[0]/m[1] blocks and image/string/multi-block bodies.
It tests decoder rejection, exact selection/seed round trips, lossy-prefix collisions after
an older turn is removed, and nested native seed/provenance collisions. Unknown formats,
edits, metadata changes and ambiguous identities still refuse numeric selection.
These tests do not execute a Magic producer or fence future producer changes; database
rendering, tag persistence/accounting, trim implementation and pipeline scheduling are
outside this legacy decoder's verification scope.

`buildNativeChildSnapshot` accepts the complete `EffectiveContextSelection`, writes its
effective messages into a fresh native session and appends the owner's hidden boundary
plus optional frozen model/effort. It
returns JSONL and inherited entry IDs for Side UI filtering. Compactions/edits have already
been materialized, so old raw bodies are absent; there is no generic raw-entry rebaser.
IDs and parent chains are allocated directly, while model toolCallId, thinking/signatures,
usage and nestedCalls are preserved. A model-invisible `custom` entry with type
`pi-session-runtime-provenance-v1` is first in the seed: its data is
`{version:1, entries: Record<freshEntryId, "turn"|"preamble"|"body"|"unknown">}`.
It classifies inherited user-shaped messages and marks the boundary as body. Describers
restore that provenance on reopen/capture and subsequent numeric forks, without guessing
from summary text. Unknown mappings stay unknown; native compaction may discard their
messages normally. Use `inheritedEntryIds`, not array offsets, to identify inherited rows.
The optional writer
creates private directories/files and exclusively creates the caller's chosen path.
Session lifetime, permissions to use tools, cleanup and domain state remain owner duties.

Run `npm run check`. Core fixtures cover fork matrices, exact seed round trips, capture
ownership/fences/invalidation, nested seed provenance, and real public Pi SDK requests with
force-prompt/late-hook/direct-summary negative controls. They do not prove remote cache
hits or real Magic database behavior.

`factory-loader` lazily imports Jiti for the owner's approved named factory exports.
For SDK children, the caller passes `getSessionAssemblyPublicModules()` from the actual
assembly module instance (not namespaces resolved by its own extension); virtual modules
preserve the child's Pi class/provider identity in compiled binaries.
Modules are cached by host coding-agent namespace and canonical path. Factory options
and installed sessions are never cached. This API does not discover or authorize paths:
the consuming factory catalog checks provenance, file hash, owner and exported names.

## Managed native views

`managed-interactive` owns one disposable `InteractiveMode` for an existing SDK runtime.
Install its `extension` after the caller's explicit presentation factories,
and pass its `lifecycle` to the participating factories. `open(runtime, terminalOwner, inputPolicy)`
attaches presentation, calls only `init()`, and waits until return. `close()` saves the
expanded editor draft, awaits presentation detach, stops the view, removes runtime UI
callbacks and binds a headless context. It never disposes the execution runtime. The
caller must await close before runtime eviction/disposal and Main replacement/shutdown.
Main `session_start` is never replayed. Child `bindExtensions` emits session_start twice;
execution factories must treat that as idempotent binding, not a new Task.
Stock `init()` starts its TUI before extension binding. The public Terminal writer
withholds synchronized-output frames through init, theme/draft restoration and onLoaded,
while forwarding terminal negotiation and mode changes. Normal readiness discards those
frames and requests a full repaint of the ready tree. One 2000 ms deadline covers the
whole attempt, including prepare/handoff: on expiry, release the gate, repaint the current
public TUI and report one diagnostic, while initialization continues. Before extensions
expose a TUI, the deadline instead reveals the retained initialization output so a stuck
native init cannot leave a blank terminal. Only this deadline path may show a native footer.

Return keys work before extension binding. Close cancels initialization without awaiting
its pending native init/bind/onLoaded; each continuation has an attempt-local abort fence.
A public runtime/session facade fences native bind completion, and an abandoned terminal
remains output-gated after teardown so late writes cannot reach Main or a later view.
Cancelled Main-input drains cannot acquire or clear a newer terminal lease. Headless
rebind is initiated synchronously but not awaited on this abandonment path; late completion
does not repaint or rebind the retired mode. Normal close retains the existing drain order.
Both consumers use this policy without reading Pi's private renderer or adding probes.

`terminal-owner` captures Main's public TUI from a widget factory; it never replaces Main's
editor or calls Main mode.stop(). The `pi.session-runtime.terminal-owner.v1` process registry
allows only one child lease across consumers. Main and child Terminal write/title/progress/
program-status are gated, with Main's latest semantic state restored on return. Keybindings
and theme are restored using public APIs. Arbitrary stdout writes are not isolated. Main
must install the gate at session_start so background title changes can be retained.
Gate release is reference-owned: it never overwrites a newer gate or third-party wrapper.
Retired wrappers become transparent and cannot replay state; directly linked retired gates
are skipped on release, restoring the original methods once all gates are released. Opaque
third-party wrappers stay intact, including any transparent retired callbacks they captured.
The library owns function-local `Symbol.for("pi.session-runtime.terminal-gate.v1")` links:
`{ version: 1, previous: Function, retired: () => boolean }`. They compose across loader
copies; malformed/unknown versions remain opaque, never unwrapped. Reloaded owners cannot
displace a newer reference. This does not change the single foreground lease. Only an
exposed, foreground gate replays its own semantic state on resume.

`process-ownership` checks the reference multiset around child init. Pi 1.5 adds one handler
per SIGTERM/SIGHUP/uncaughtException and each stdio error surface (SIGHUP is POSIX-only).
All deltas are validated before removing exactly those new functions. Unknown/missing
listeners abort entry; native stop then unregisters its own handlers. Main remains the
only signal/crash owner, and its shutdown handler must await child cleanup. This is a
public-API behavior contract, not a private-field probe.

`input-policy` composes the native editor's public onSubmit and terminal input API. The
caller provides the canonical command table, blocked actions, durable admission, busy/
interrupt and return ports. Completion uses the same table. Native Editor clears input
before submission; the adapter restores its expanded text immediately and clears it only
after admission resolves. Rejected input remains retryable. Ctrl+C returns when idle and
interrupts when busy; nonempty Ctrl+D retains native delete behavior; Ctrl+Z is disabled.
Kitty release/repeat filtering is local to the actions actually intercepted or rerouted by
this policy. Other keys and event types pass unchanged to Pi, including context-specific
shortcuts that are ordinary text in the editor. Consumer callbacks filter only their own
control keys. Nonempty Ctrl+D retains native deletion; empty Ctrl+D requires independent presses.
Esc uses the public CustomEditor.onEscape callback, so native overlays/autocomplete
keep priority before the caller's interrupt port. Public CustomEditor members are
checked structurally because class identity can differ across Jiti module graphs.
Its key-event parsing functions do not read/write the global keybindings state, and its
autocomplete provider is instance-local and structural. They may remain direct TUI imports;
action matching uses the actual keybindings manager passed by the native editor factory.

Only current presentation is retained. Child draft text survives return; child undo/history
cursor/scroll position do not. Main editor state survives because its object stays alive.
Native theme callback ownership can differ across physical SDK loader copies; immediate
heap reclamation is not promised. Rebuild compiled direct consumers after library changes.

`TerminalOwner(tui, ui, readThemeSetting)` 接收 Main 原始主题设置的 live getter。
当前只支持显式单个命名主题；automatic `light/dark` pair、隐式默认值与匿名 in-memory theme
在 Main stop 前拒绝，且不修改设置。`ui.theme` 是 live proxy，不能当 Theme instance 传回。
进入时通过 `getTheme(name)` 取得可加载主题，并把同一命名设置交给 native child。
补丁宿主始终用 `setTheme(name)` 恢复命名主题监听；原版在 native init 后和返回时跳过重复的同名应用。

### theme-watch 与原版降级

`src/theme-watch-contract.ts` 在首次 SDK import 后、input drain/Main stop/前台转移前，
分别检查 Main native `ExtensionUIContext.themeWatchCapability` 与 canonical SDK root
`THEME_WATCH_CAPABILITY`：

- 两面都精确为 `"pi.theme-watch.file-version.v1"`：沿用 patched 路径，按名恢复并启用
  cache-only repaint bridge；文件版本热更新由 SDK 负责。
- 两面都为 `undefined`（原版 Pi 1.5.0）：允许 child 视图交接。沿用交接时的命名配色，
  不依赖主题文件热更新，不安装 repaint bridge。native init 已应用同名主题时不再次
  `setTheme`，返回 Main 同名时也不重复应用，避免原版同步关闭 FSWatcher 的慢路径叠加。
  原生初始化/stop 自身的 watcher 生命周期仍由 Pi 管理，主题文件热更新不作保证，可能显示旧配色。
  首次交接通过 Main `ui.notify` 给一次 warning（同进程跨 Main binding/consumer 去重），
  说明降级及补丁文档 `host-patches/pi/v1.5.0/README.md`，不静默降级。
- 仅一面声明、任一未知值（含 null），或 getter 抛错：仍拒绝交接、保留 Main；错误保留
  安装/rebuild/restart 指引和 getter cause。不能用 shim 伪造 marker。

这是 public SDK 合同，不 import Pi private path、不改 prototype、不另写 theme loader。
headless/tool-only assembly 与从未打开 child 的 Main binding 不要求这些 marker。
补丁安装见 [host patch](../../host-patches/pi/v1.5.0/README.md)；需要同步安装 CLI 与完整
canonical SDK peer graph、重启 Pi 并重建 compiled consumer。只补一面是装配错误，不是原版降级。

Patched 路径的 reference-owned、non-persistent Node `watchFile` bridge 只在文件变化后
通过 public `setTheme()` 重应用 Main 注册 cache，不读/parse 主题文件；SDK 独占 file-version
reload/cache invalidation/native repaint。两种 loader 的 callbacks/cache 不必共享。
路径来自 public `getAllThemes()`；Main 输入后观察命名设置变化，replacement/disposal 精确
移除本 listener/watcher。process registry 只记录启用过 patched managed entry，替换的 Main
binding 因此仍安装该 bridge。 No private theme/controller field is read or patched. Full automatic/in-memory
theme support needs a public Pi view lifecycle or theme-state capture/restore API with
owner-scoped subscriptions.

`ManagedInteractive(report, interrupt)` requires a session-owned Host interrupt
port. Both interactive and headless extension abort bindings use that port; closing
a view clears only its input policy and never disables `ctx.abort()`.
`close("quit")` and `TerminalOwner.restore/dispose("quit")` release the child and
terminal lease without restarting Main, restoring progress, or repainting. This is
required because native Main `/quit` stops its TUI before session_shutdown. A quit
can promote an already pending ordinary return while init/admission drains. Normal
return and session replacement keep the stop/detach/headless/restart sequence.

Side may supply optional `configureMode(mode)` before native init renders history;
its returned disposer runs on every close, including init failure. It must patch only
that instance and reject incompatible hosts before inherited history can render.
`InputPolicy.onInput` may consume a key before shared handling; `emptyDelete` replaces
only the empty-editor Ctrl+D return path. Omitting both preserves Subagents behavior.
`ManagedInteractive.yieldTerminal(action)` fences input and stops the current view TUI
while an external editor owns the terminal. Close aborts and awaits the action; normal
completion restores that same foreground TUI, while concurrent close leaves restoration
to the normal Main handoff. Consumers must honor the provided AbortSignal.

## Usage regression checklist

默认 `npm test` 只运行 stock Pi 可用的离线测试。`npm run test:patched-host` 单独运行
`session-realm`、`terminal-frames`、`terminal-owner`；需要同步安装主题补丁 CLI/SDK（Pi 1.5.0），
缺少补丁会明确失败，不会 skip。`npm run check` 包含默认测试与 typecheck。
原版 Pi 1.5.0 的合同测试覆盖双面缺失可交接、一次提示及同名恢复跳过；双面精确 marker
fixtures 保留 patched 恢复断言，单面/未知 marker 保留交接前拒绝断言。
根 `npm run test:integration:stock-host` 用 npm 安装的原版 SDK/CLI、faux provider、真实 PTY
打开/返回无 CC child 视图，检查 2000ms deadline、配色、Main editor identity 与零额外请求。
`test:patched-host` 的真实补丁/dual-loader 回归仍要求匹配补丁 SDK，不能用 marker fixture 替代。
The existing fixtures use faux providers, temporary sessions and fake terminal ports;
no remote provider, legacy producer/database or daily configuration is required.
Use fresh processes, not `/reload`. This library has no compiled output; rebuild any
compiled consumer after changing it. Test success is not proof of real provider wire
identity/cache hits, memory performance or a complete consumer profile.

After separately installing a consumer, use a disposable profile and local faux
provider for the following checks; real TUI/IME and provider acceptance remain separate:

- Fork with `none`, `2` and `all` after several complete turns. Check that `none`
  excludes the parent conversation, numeric selection excludes earlier unselected
  turns, and `all` follows the effective context after compaction/context edits,
  without resurrecting deleted raw bodies. Ambiguous numeric mappings must reject.
- Change branch, model, effort or tool/capability selection. Missing/stale required
  captures must refuse inheritance rather than silently replaying raw history.
  Replacing/retiring a Main binding must prevent stale leases from affecting the new one.
- Assemble two children with different cwd, tools and settings. Confirm that neither
  loads ambient extensions, reads the other's working directory or changes Main's
  settings; disposing one must leave the other usable. Resume with a narrower tool
  allowlist and confirm that persisted broader tools do not regain authority.
- Use temporary factory/grant fixtures only. Missing/revoked grants, changed code,
  binding replacement and undeclared observer channels must reject. Approval for
  one owner/target must not authorize another; code drift requires a fresh process.
- With a single named theme, open a child view, edit its draft and return. Main's draft,
  original keybindings and terminal state must survive; reentry restores the child
  draft, not its undo/history cursor. A second simultaneous view must reject. An
  automatic theme pair or anonymous theme must reject before stopping Main.
- 在补丁宿主返回 Main 后编辑当前命名主题文件，Main 应重绘；
  replacement/disposal 必须移除 owner 的 watcher 与 input listener。
- Check autocomplete/overlay Escape priority, busy interrupt versus idle return,
  rejected-input preservation and external-editor cancellation. Delayed/failed init
  must not leave a blank or stolen terminal; late writes must not repaint a later view.
- Return without cancelling the task, then separately stop it through the consumer.
  On Main quit, child cleanup must not restart or repaint Main. Seed/session files
  remain the owner's cleanup responsibility, not this library's automatic garbage.
