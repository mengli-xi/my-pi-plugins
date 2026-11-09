# Optional provider activity and Compact deadlines

`pi-runtime-contracts/provider-activity-v1` owns the pure version-1 protocol, channel
constant and `readProviderActivityV1` validator. Compact has a direct internal `file:`
dependency on that library; it does not import any provider extension. Provider adapters
own observations. Provider-specific event translation belongs outside this package.

Compact subscribes to `PROVIDER_ACTIVITY_CHANNEL` (`provider:activity-v1`) only during a
custom compaction operation, including its shadow. Subscription/timers end at completion,
total expiry, cancellation or session boundary. Reload/new operations do not inherit live
queue state. Missing adapters are normal: all clocks then charge elapsed time normally.

Validated envelopes identify `{version:1, provider, sessionId, kind}`. Compact accepts only
`kind: "lifecycle"` queue events whose session and provider match an open custom request.
`event.channel` is `lifecycle`; `source` is `local` or `upstream`; `type` is `queue.enter`,
`queue.update` or `queue.leave`; optional `attempt` distinguishes source queues and optional
`queuedMs` is an authoritative nonnegative safe-integer duration. Queue identity is the
provider/source/attempt tuple. `queueEnteredAt` is validated by the shared helper but is
not converted to the local monotonic clock. `attempt.start`, `load.update`, `turn.end` and
load counters never affect Compact's clocks. Unknown versions/kinds/types, invalid fields,
missing queue sources, other sessions/providers and idle-provider observations are ignored.

The operation's total deadline excludes the union of matching queue intervals, not their
sum. Each single-attempt deadline excludes only that attempt provider's intervals, clipped
to the same operation-wide pause allowance. Concurrent providers cannot pause each other's
single clocks. Since v1 has no request ID, overlapping requests of the same provider share
one live-request window and its first generation cutoff; no finer attribution is claimed.

The first text/thinking/tool-call delta closes open queues for that provider and forbids
new pauses until its live window ends. Late `queuedMs` can shorten/extend only the closed
past, bounded by the window start, first progress and cap cutoff. Ending the last request
for a provider closes its queues and discards correction identities; retries/backoff cannot
inherit them. A new retry's authoritative duration cannot predate its own window.

`queuePauseCapMinutes` defaults to 30 and must be finite/positive. Its independent wall-time
watchdog bounds the cumulative union even without leave/progress events. Reaching it closes
all queues once; later corrections cannot renew the allowance. `totalTimeoutMinutes`
defaults to 10 active minutes (`0` disables only the total). Single-request limits, retries,
backoff and shadows share the operation scope; native fallback remains outside an exhausted
custom budget. Queue/progress/cap diagnostics stay in the existing private run log.

Verification: `tests/deadline.test.ts` covers union accounting, provider/session isolation,
unknown payloads, first progress, late authoritative corrections, cumulative cap/watchdog,
retry cleanup, per-request/total expiry and cancellation. `scripts/check-host.mjs` emits
this protocol from a neutral faux provider in a fresh offline stock Pi host; it does not
exercise a real adapter, provider, cache, credentials or network.
