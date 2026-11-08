# Explicit SDK provider factories

Subagents discovers external providers through the existing child capability registry,
not provider/package brand names. The manager uses storage ABI 2:
`Symbol.for("pi.child-capability-registry.v2")`, `version: 2`,
`operationVersion: 2`, brand `pi-child-capability-registry-v2`. Historical V1
export/type names and manifest/register/bind/snapshot DTO versions stay V1.
The ABI-1 cell remains untouched and isolated; its old register closure cannot
validate the expanded schema or supply authority to the new manager. All Core
publishers must resolve the current library (and rebuild compiled consumers).
Old provider packages can keep publishing legacy ABI-1 declarations while external
publishes an independent ABI-2 supplemental owner, in either loading order.
A malformed/ABI-1-shaped holder at the ABI-2 key fails closed, with no fallback.

A target may add `sdk_provider_factory`:

```ts
{
  provider_id: "example",
  package_manifest: captureEntrypointDescriptorV1("/actual/package/package.json"),
  module: captureEntrypointDescriptorV1("/actual/package/src/child-factory.ts"),
  export: "createChildFactory",
  config: {},
  artifacts: [captureEntrypointDescriptorV1("/actual/package/src/delegate.ts")],
  observer: { // optional
    module: captureEntrypointDescriptorV1("/approved/observer.ts"),
    export: "installActivityBridge",
    input_channel: "example:activity"
  }
}
```

The target declares exactly this provider, no tools/commands/dependencies. The package
manifest must be the actual nearest package.json of factory and child entrypoint.
All descriptors pin canonical current-UID regular files, identity and SHA256. A
canonical path replaced with a symlink fails live identity validation. Artifacts
must list the known delegates/assets used by the approved factory; this is not a
transitive JavaScript dependency sandbox. Config is a closed, bounded JSON object
(12 levels, 2048 nodes, 32 KiB; strings at most 8192 UTF-16 units).

The administrator independently reviews and writes `<actual-agentDir>/sdk-provider-grants.json`:

```ts
{
  version: 1,
  grants: [sdkProviderApprovalV1(manifest, "pi-subagents")]
}
```

`sdkProviderApprovalV1` returns `{owner_id,target_id,manifest}` with exactly one
target. The grant exactly approves owner, actual Main descriptor, child, package,
factory/export/config/artifacts and optional observer. It is not enough for two
self-reported hashes to agree: discovery and execution verify the actual files.
The grant file itself must be a non-symlink current-UID regular file. Readers
cache parsed metadata by inode/size/mtime/ctime; unchanged files are not re-parsed.
No runtime API writes grants. No grant means no external factory execution.

Frozen entries carry `sdk_provider: {version:1,owner_id,target_id,manifest,model_scope}`.
The fingerprint includes the complete proof. Main/role/frozen/parent model scope
remains the sole model authority; the proof binds the exact scope of this assembly.
Nested children may only narrow a parent proof. A new declaration or grant cannot
add a provider to an old frozen role. Old profiles without proofs remain readable
as presentation-only history, but cannot execute external providers.

Assembly passes exactly:

```ts
{ version: 1, target: "pi-subagents", agentDir, providerId, modelIds, config }
```

Config is nested and cannot overwrite core fields. Factory export must return a
Pi extension factory. Discovery never imports it. Execution revalidates grant,
files, frozen scope and live registry binding around awaits, then uses the approved
loader with `getSessionAssemblyPublicModules()` unchanged. Loaded same-path code
or known delegate digest changes demand a fresh process, even after re-granting.
Current public provider references only fence replacement during preparation;
they are not host-attested provenance. Registry/grants/disposal are cooperative:
already-loaded malicious JavaScript is outside this boundary. There is no new host
private seam, owner receipt or sandbox.

The optional observer uses the same approved loader/grant. Its only argument is a
narrow bus: `on` permits only `input_channel`, and `emit` permits only validated
`provider:activity-v1` for this provider. It never receives ExtensionAPI. Startup
failure, execution dispose and reload release listeners; ordinary view detach does
not. Missing observer means no provider-specific activity translation.

Side requires an independent `pi-side-chat` declaration and grant; Subagents grants
never imply Side support. External supplemental owners coexist with legacy provider
owners; root closure selects only explicitly granted SDK proofs. Generic builtin,
Timeout, Processes and Search tool-owner guards remain separate. Search factories
receive the actual parent Main event bus for explicit backend discovery.
