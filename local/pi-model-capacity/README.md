# pi-model-capacity

Provider-neutral capacity observation for Pi 1.5.0. This package owns polling, authentication observation, response validation, credential-private caching, and immutable semantic snapshots. It does not own `/model`, statusline UI, SDK assembly, tools, or provider execution. TypeScript loads directly; no build output.

## Builtin adapters

- **OpenAI Codex**: Pi-resolved ChatGPT OAuth; `GET https://chatgpt.com/backend-api/wham/usage`. Windows are classified by the declared duration, never primary/secondary position.
- **Grok**: Pi-resolved xAI subscription OAuth and the Grok CLI token-auth marker; `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`. API-key billing is deliberately unsupported. An omitted proto scalar means 0% only inside a valid current period.
- **DeepSeek**: Pi-resolved API key; official `GET https://api.deepseek.com/user/balance`. Publishes prepaid remaining/granted/topped-up balances, never invented used/limit values. Custom provider origins are rejected.

Environment-specific adapters are not builtin and are never imported by this package. A separately loaded external extension may register them. Provider IDs are lowercase public identifiers matching `[a-z0-9][a-z0-9._-]{0,127}`; there is no closed provider list.

## Observation adapter registration

Public exports: `pi-model-capacity/adapter` (adapter types and shared parsing/HTTP helpers), `pi-model-capacity/contracts` (V2 data validation and channel names), and `pi-model-capacity/registration` (the small event client).

```ts
import { registerCapacityAdapter } from "pi-model-capacity/registration";

const registration = registerCapacityAdapter(pi.events, {
  provider: "example-capacity",
  intervalMs: 30_000,
  staleMs: 90_000,
  async resolveAuth(ctx, signal) {
    // Honor signal for asynchronous discovery or CLI observation.
    // ctx.modelRegistry exposes only config/auth observation methods.
    // Return undefined when unconfigured. fingerprint is private cache identity.
    return { apiKey: "fixture", headers: {}, fingerprint: "account-revision" };
  },
  async fetch(auth, { fetch, now, signal, ctx }) {
    return { models: { example: { loadPercent: 25, quota: { remaining: 9, limit: 10 } } } };
  },
}, (error) => { /* surface admission failure in the integration's diagnostics */ });

// The integration owns this handle and must dispose it at shutdown.
pi.on("session_shutdown", () => registration.dispose());
```

The helper subscribes before its initial synchronous `model-capacity:register-adapter-v1` request. The owner installs that listener, then broadcasts `model-capacity:adapter-ready-v1` with `{ version: 1, ownerId }`. This covers integration-first and owner-first loading, as well as owner replacement. No owner means no admission yet, not a fabricated success. The handle exposes `accepted` and `error`; errors are also delivered to the optional callback.

Raw registration request: `{ version: 1, adapter, reply(result) }`. Reply is `{ version: 1, ownerId, accepted: true, release() }` or `{ version: 1, ownerId, accepted: false, error }`. Duplicate ready for the same owner is ignored; a new owner ID re-admits the integration. Unknown versions are rejected. Duplicate provider IDs (including builtin IDs) fail closed: no replacement or merging. Release is idempotent and identity-bound; an old lease cannot remove a later registration. Release aborts flights, cancels timers, deletes private auth/cache state and publishes the removal with a new revision. Late registration joins existing all-provider watches and explicit watches of that ID. A provider's last watcher release invalidates pending auth resolution and aborts its fetch; stale asynchronous results cannot reappear after release/re-registration.

Admission grants only capacity observation. The passed context projects the registry to `getProviderAuthStatus`, `getAvailable`, `getAll`, `isUsingOAuth`, `getProviderAuth` and a base-URL-only `getProvider`. No `complete`, SDK factory, tool registration/execution, session or UI port is passed. This is an in-process cooperative contract, not an OS sandbox: loading arbitrary JavaScript itself is not a security boundary.

## V2 snapshot/request/watch

V1's closed provider set is intentionally retired. Core and presenters must upgrade together; V1 and unknown versions are not silently accepted or dual-published.

- `model-capacity:snapshot-v2`: immutable `ModelCapacitySnapshotV2` (`version: 2`, required UUID `ownerId`, monotonic owner-local `revision`, optional `sessionId`, `providers`). Consumers compare revision only within one owner, reset on a new owner, and reject late data from retired owners.
- `model-capacity:request-snapshot-v2`: synchronous cache recovery:

```ts
pi.events.emit("model-capacity:request-snapshot-v2", {
  version: 2,
  sessionId,
  reply(snapshot, refreshReceipt) {},
});
```

Add `refreshProviders: ["example-capacity"]` for confirmed refresh. The reply waits for one post-request deduplicated fetch; a flight that started before the request cannot satisfy it. The V2 receipt reports each requested provider's `refreshed`, final `state`, and optional observation/error. Unknown or removed IDs return `unavailable`, never success. Removal/replacement during a refresh cannot produce a successful receipt for the replacement.

- `model-capacity:watch-v2`: `{ version: 2, watcherId, action: "acquire" | "release", sessionId?, providers? }`. Omitted providers means all current **and future** registered adapters. Acquire refreshes immediately. Only the union of live watches is polled, at each adapter's cadence; release cancels only providers no longer watched.

CC keeps its live watch set and uses the same `adapter-ready-v1` handshake to recover after late owner loading/replacement. It first corroborates the announced `ownerId` through a synchronous V2 cache request, then replays only live acquires; snapshots emitted before listener readiness do not prematurely trigger replay. Duplicate/unknown readiness, retired-owner data and late cache/confirmed replies fail closed. Session replacement and client disposal release recorded watches and reject pending refreshes; the existing ready receipt consistency checks remain mandatory.

Schema and validators live in [`src/contracts.ts`](./src/contracts.ts). Provider shape includes state, observed/stale timestamps, optional plan, windows, gateway concurrency, model load/quota and balances. Model and quota source times remain epoch milliseconds; reset times remain epoch seconds. CC is the only presenter and renders these shapes without provider-brand dispatch. No presentation implementation lives in an integration.

## Failure, account and lifecycle policy

- Transient fetch failure retains the last successful data as stale; missing auth clears it to unavailable; malformed data reports error (or stale with the last successful value).
- Auth fingerprints never enter snapshots. A changed fingerprint clears the prior account's data before publishing refreshing. An older auth resolution cannot overwrite a newer resolution.
- Results are validated and copied before caching; snapshots and nested data are frozen, so mutation cannot bypass validation or revisions.
- Confirmed refreshes and fetches deduplicate per provider. All builtin requests have bounded timeout/body size. Auth discovery also receives an optional abort signal; superseding resolution, final-watch release, adapter release and disposal abort it. An external adapter must honor the auth/fetch signals and bound its own I/O; generation/identity checks reject late results even if it ignores abort.
- Session change clears watches, pending work and cached auth/data. Dispose publishes an empty snapshot, cancels timers, aborts work and removes listeners. An integration must dispose its registration handles too.

## `/usage` and Codex history

`/usage` refreshes every registered adapter and formats capacity by data shape. TUI uses a UIKit information panel: cached/loading first frame, then refresh; failures retain cached data and show context. RPC/headless prints text.

Codex burn history remains `<agent-dir>/codex-usage.jsonl`. Only settled Codex traffic or an explicit `/usage` check appends a sample; selector polling never creates zero-traffic history. Legacy history fields remain readable. `<agent-dir>` comes from Pi public `getAgentDir()` (`PI_CODING_AGENT_DIR` override), not a guessed home path.

## Verification

```sh
npm test
npm run typecheck
```

Tests use neutral synthetic adapters and injected HTTP fixtures, without real provider services. Environment-specific parser and discovery tests belong to their external adapters, not to the Core test prerequisites. Real credentials, billing, and full-profile TUI remain separate acceptance gates.
