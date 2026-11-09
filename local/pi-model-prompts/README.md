# pi-model-prompts

Per-model calibration and system-prompt fragment assembly for Pi 1.5.0.

## What it does

On `before_agent_start`, this package collects three sources and appends their
text to the assembled system prompt for that run:

1. `<agent-dir>/model-prompts/<model-id>.md`: one name-matched model rule.
2. `<agent-dir>/model-prompts/prompts/<name>.md`: named prompts selected by
   `bindings.json`, so one prompt can serve several model ids without symlinks.
3. Other extensions' synchronous contributions over `prompt:fragments-v1`.
   For example, Effort can contribute `effort:ultra` when its own gate permits it.

The map is sorted by key and joined once. `model:` precedes `prompt:` among file
sources; package-contributed keys participate in the same sort. Repeated keys
replace earlier values, as defined in `contracts.ts`. Appending text does not
create a higher instruction priority or grant execution/tool permissions.
Other extensions and the provider can still transform the final request.

The package does not make a separate network request. Selected prompt text goes
to the current provider as part of the normal model request. Keep credentials
and unrelated private data out of prompt files. Reports expose current prompt
text only when explicitly requested; ordinary diagnostics do not log it.

## Files and matching

```text
<agent-dir>/model-prompts/
  model-a.md
  prompts/zh-writing.md
  bindings.json
```

```json
{ "zh-writing": ["model-a", "model-b"] }
```

Binding keys are prompt names, not provider ids. Two providers using the same
model id share its bindings and name-matched rule. Model ids containing `/` or
`\` map those characters to `_`; this preserves existing filename matching,
including possible normalized-name collisions. Prompt names cannot contain path
separators or start with a dot. Dictionary keys such as `constructor` and
`__proto__` work without inheriting object-prototype properties.

Existing prompt symlinks remain supported. They are trusted operator-controlled
configuration, not a filesystem sandbox. Migration/install does not copy user
prompt files, bindings, model configuration or credentials into the package.

`<agent-dir>` comes from Pi's public `getAgentDir()`, honoring its runtime
environment. This package requires Pi 1.5.0 and the adjacent workspace UIKit.

## Hot updates and failures

Every run checks file versions using device/inode/size/mtime/ctime. Unchanged
text and parsed bindings, including failures, are cached. Edits, replacements,
creation and deletion become visible on the next run without rewriting files or
restarting Pi. This is a plugin feature; it does not change Pi's native
`AGENTS.md` reload behavior. A run is not each streamed token or tool call.

Missing/blank prompt files contribute nothing. Missing bindings mean no bound
prompts. Unreadable files and invalid JSON produce safe diagnostics, once per
failed version. Valid entries of partially malformed bindings remain readable,
but settings cannot save over that file until it is repaired. File contents and
JSON-parser excerpts are not included in diagnostics.

## `/model-prompt settings`

Pick a named prompt, then select the model ids it applies to:

- One named prompt skips the first picker; name-matched rules remain outside it.
- Candidates come from `ctx.modelRegistry.getAll()`, plus already-bound and current
  model ids. No raw `models.json` or credential file reads are needed. The host
  owns refreshing its registry; this panel does not probe provider services.
- Space toggles, `a` toggles all, Enter saves, `d` unbinds selected rows and Esc
  cancels. The panel title explains these meanings above the generic table footer.
- UIKit owns both overlays' layout, focus restoration and input lifecycle.
- Saving skips canonically unchanged content. Changed content is written to a
  same-directory temporary file and atomically renamed, retaining existing mode.
- If the binding version changed while the panel was open, save refuses and asks
  you to reopen. Invalid/unreadable bindings are read-only. A binding-file symlink
  is not replaced; prompt symlinks are unaffected. Atomic rename prevents partial
  JSON visibility, not a cross-process database transaction or distributed lock.

Settings require the interactive TUI. RPC/headless callers receive an explanation
and do not write bindings.

## `/model-prompt`

The UIKit text panel reports current rules, bound prompts, current file text,
rule/symlink inventory, and bindable prompts. RPC/headless uses `ctx.ui.notify`.

Current prompt sources are distinct from the last run's contribution record.
The latter stores model id plus fragment keys and character counts, not historical
plaintext or the final provider payload. Editing a file after a run changes the
current-source section, not that record. Session start/shutdown clears the record.
An actual final-request inspection requires a separate, explicitly chosen probe.

## Checks and daily regression

Use an isolated HOME/config/cache and official Pi 1.5.0 dependencies:

```sh
npm ci # 在仓库根运行
npm run typecheck
npm test
```

Tests use temporary files and Pi/UI stand-ins. Fake-provider checks are not proof
of real provider or terminal compatibility. No build step or `dist/` is required.

When checking actual use, explicitly verify:

- Edit a calibration file and send the next message: the new text applies; an
  unchanged file does not need another full read/parse.
- Switch models: only matching/bound sources apply. Switch sessions: the report
  no longer claims the preceding session's contribution record.
- Save/clear a binding, cancel the picker, and check restored editor focus. A
  concurrent edit or corrupt binding file must survive a refused save unchanged.
- With Effort separately enabled, only ultra with a confirmed selected delegation
  tool contributes its fragment; plain max and unknown toolsets do not.

Normal user messages can call the configured provider. These manual cases are
not automatically run against a daily profile or a real service by the package.
