# Frozen storage ABI 1 fixture

`src/child-capability-{manifest,registry}.ts` are unmodified copies from repository
commit `8aec9f458498e70e1ef20c4435caf652299bce5d`. They intentionally retain the
closed pre-SDK target validator and `pi.child-capability-registry.v1` manager.
Do not update them with the current implementation: mixed-generation tests need
an actual old register closure, not two copies of the current schema. The small
package/import shim makes this a physically separate, portable old library.
