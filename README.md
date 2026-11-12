# pi-yet-another-handoff

Confirmation-free session handoff for **Pi 1.5.0**, Node.js **>=22.19.0**.
Based on `@jackice/pi-handoff@0.1.4` (MIT). The handoff document template and
`<handoff-context>` wrapper are retained; the runtime implementation is new.
Source, comments, UI strings and documentation contain no Chinese characters.

## Behavior

- `/handoff [additional focus]` generates a document, saves it, creates a child
  session with `parentSession`, injects the document as a visible custom message,
  and **starts continuation immediately**. No editor or text confirmation.
- `autoHandoffAt: 90` performs the same operation when context usage reaches 90%
  **and the model is still making tool calls**. The entire tool batch finishes
  before the handoff begins. It does not interrupt an executing tool.
- The old session remains on disk. Documents are saved to
  `<old-session-file-without-.jsonl>/handoff-<timestamp>.md` (mode 0600).
  In-memory sessions can hand off but have no artifact file.
- Repeated handoffs include the previous handoff document. Pi's canonical
  projection handles compaction, tree summaries and context edits.
- TUI shows a cancellable loader and a status with elapsed time, stream phase
  and generated character count. Escape cancels generation, not an executing tool.
- RPC, JSON and print modes do not require a terminal dialog. Session replacement
  must be supported by the host (Pi CLI supports it; SDK hosts must wire the
  command-context actions).

The document structure is unchanged:

```text
Goal
Constraints & Preferences
Progress: Done / In Progress / Pending
Key Decisions
Critical Context
Next Steps
```

The legacy `autoSaveOnCompact` / `--handoff-auto-save` feature is not implemented:
this extension switches sessions instead of paying for a second summary followed
by ordinary compaction. Old `autoSaveOnCompact` config keys have no effect.

## Local installation from an immutable Git tag

From the repository, after reviewing and testing the changes:

```bash
npm ci
npm test
npm run check
npm run test:package

git add .
git commit -m "Initial confirmation-free automatic handoff"
git tag v0.1.1

# Remove the old command registration to avoid /handoff:1 and /handoff:2.
pi remove 'npm:@jackice/pi-handoff'
pi install 'npm:pi-yet-another-handoff@git+file:///Users/iisaev/IdeaProjects/pi-yet-another-handoff#v0.1.1'
```

Then `/reload` or restart Pi. This is an npm install from a local Git ref, not a
live symlink. Working-tree changes do not affect the installed version. For an
update, bump `package.json`, commit, create a **new** tag and install that new
specification. Do not move existing release tags. `pi list` shows the pinned spec.
Add `--local` to `pi install` / `pi remove` for project scope instead of personal
scope. A package installed under personal scope can still use project settings.

For a quick development trial without installation:

```bash
pi -e ./src/extension.js
```

Do not load both this trial and an installed copy simultaneously.

## Configuration

Global configuration: **`<agent-dir>/handoff.json`**, normally
**`~/.pi/agent/handoff.json`**. The agent directory is resolved with Pi's
`getAgentDir()` API and respects `PI_CODING_AGENT_DIR`. Optional
`PI_HANDOFF_CONFIG` replaces the global config path (useful for isolated testing).
A trusted project's **`.pi/handoff.json`** overlays global values. Untrusted
project configuration is not read. The old `~/.pi/handoff.json` path is not read.

Enable automatic handoff:

```json
{
  "autoHandoffAt": 90
}
```

All defaults:

```json
{
  "autoHandoffAt": false,
  "reasoning": "low",
  "maxTokens": 8192,
  "timeoutMs": 180000
}
```

- `autoHandoffAt`: `false`, or a number strictly between 0 and 100 (percentage,
  not a token count). Automatic handoff is opt-in.
- `reasoning`: summarization-only effort, independent of the main session's
  effort. The provider/model may clamp this level. `off` is supported.
- `maxTokens`: positive output-token limit, including reasoning where applicable.
  Limited further by the model's max output and estimated available context
  headroom. Too low a value can produce a truncated document, which is rejected.
- `timeoutMs`: positive end-to-end generation deadline. A timeout cancels waiting
  even if a provider ignores cancellation; cooperative providers also stop work.

Reload after changing automatic settings. `/handoff` rereads configuration on use.
Malformed JSON / invalid values are reported, not silently interpreted as enabled.
Unknown legacy keys are ignored.

## Automatic handoff lifecycle and safety

1. Read `ctx.getContextUsage()` at `turn_end` (provider usage plus estimated
   trailing tool messages; this is **not** total lifetime/billed session tokens).
2. If usage is known and meets the threshold, and a completed, non-terminating
   tool batch indicates another request is needed, request an abort **at that
   boundary**, after tool results have been persisted. No extra ordinary provider
   request is made in the old session.
3. At `agent_settled`, dispatch an internal command. Commands can use `newSession`;
   event handlers cannot safely replace sessions directly.
4. Generate exactly one document with the active model, save it, and switch.
   Use only the replacement-session context for the continuation prompt.

A final answer without tool calls, a terminating tool batch, an error, an aborted
turn or unknown usage **does not** trigger handoff. This is a conservative
scheduler signal, not a semantic oracle for task completion. If the model stops
with a final response despite unfinished requirements, the extension does not
second-guess it or create an endless automatic restart loop.

Queued user messages take priority: automatic handoff is skipped/deferred rather
than discarding steering/follow-ups. Escape/user abort is not auto-resumed.
Generation failure, timeout, empty/truncated output or artifact write failure
leaves the original session active. Automatic retry is paused after a failed
auto handoff until `/reload` or a new session; `/handoff` can explicitly retry.
A session-switch veto from another extension is respected, with the saved
artifact available. This extension does not bypass other extensions' prompts.

### Interaction with built-in compaction

Pi normally compacts at `contextWindow - reserveTokens`. That may happen before
90% (for example, a 16K reserve in a 128K window). With automatic handoff enabled,
while tool work is ongoing and usage is known, this extension cancels **threshold**
compactions so the requested percentage can be reached. Manual `/compact` and
overflow recovery are left alone. If auto handoff fails, built-in threshold
compaction is allowed again. Outside ongoing tool work, normal compaction remains
unchanged. You do not need to disable Pi's compaction globally.

A single huge tool result can jump beyond the threshold or even fill the window.
No extension can guarantee an exact 90.000% interrupt or recover context that the
provider refuses to accept. Use an earlier threshold for large/variable outputs.

### Other extensions and background jobs

This is a real `/new`-style session replacement, not in-place compaction. Pi
reloads extension instances; private in-memory state and active jobs are **not**
migrated by this package. In particular, it does not migrate/reparent running
`pi-yet-another-subagents` children or their coordinator registry. Those jobs are
subject to that extension's normal `session_shutdown` policy. A handoff document
is not a substitute for live coordinator state. Disable auto handoff in workflows
that require active children to survive, or add an explicit lifecycle integration
before using it there. New-session model/tool defaults follow the host's normal
`newSession` behavior, as in the original extension.

## Why upstream handoff can take a long time

Source inspection of `@jackice/pi-handoff@0.1.4`:

1. It sends the full active conversation (including tool output), not only the
   new instructions. Near the context limit this is a large summarization input.
2. It supplies `cacheRetention: "none"` and a fresh UUID `sessionId`. This does
   not request retention/reuse of the main session's provider cache identity.
   Whether that actually causes a cache miss depends on the provider.
3. In modern Pi, system messages already live in the transcript. Also passing
   `ctx.getSystemPrompt()` prepends the replayed prompt again, duplicating prompt
   text and changing the cache prefix. This implementation avoids that duplicate.
4. It waits for `complete()` before showing any progress beyond the spinner.
   Provider queueing, prefill, reasoning and answer generation all look identical.
5. There is no explicit summarization reasoning/output budget or deadline in
   that call. Actual provider defaults and model latency can dominate.
6. Its optional save-before-compaction does one additional full summary, followed
   by the built-in compaction summary. That feature only saves a file, it does
   not automatically continue in a fresh session.

This version uses `streamSimple`, the same session ID, short cache retention,
explicit low reasoning/output bounds, and live progress. It preserves the full
projected history and original document schema rather than silently truncating
important tool output for speed. Shared cache reuse is an opportunity, not a
promise: model, reasoning mode, prompt/tool layout, provider and TTL matter.
Generation of thousands of tokens still takes time. Streaming improves visibility,
not the model's intrinsic generation speed.

### Inspect actual timings

Timing data is stored in session JSONL files, without a diagnostic slash command.
Each `pi-yet-another-handoff.metrics` custom entry contains:

- `elapsedMs`: total streamed model-call time (not session reload/continuation);
- `firstEventMs`: time until the first normalized stream event;
- `firstTextMs`: time until the first text delta;
- `chars`, `provider`, `model`, full reported `usage`, including `cacheRead`,
  `output`, reasoning where supplied, and provider cost fields;
- `automatic`, `parentSession`, saved artifact `path`.

The record is persisted as a non-model-visible custom entry
`pi-yet-another-handoff.metrics` in the old and new sessions. Generation usage is
also recorded once as a standard `usage` entry in the **new** session for Pi's
session totals. No full transcript, API keys or raw provider payloads are added
to diagnostic logs (the handoff artifact itself contains conversation-derived
content and should be treated as private).

Large `firstTextMs` can include network/queueing/prefill/reasoning; it does not
isolate those stages. Small `cacheRead` suggests poor reported cache reuse, but
some providers do not report it. There is no paid live-model latency benchmark
in this repository; speed claims above describe code paths, not measured gains.

## Validation

```bash
npm ci
npm test
npm run check
npm run test:package
```

Tests use the real Pi 1.5.0 session runtime with a scripted offline provider:
automatic/manual replacement, immediate continuation, repeated handoffs, parent
links, artifacts and usage, compaction interaction, context projection,
terminating batches, user abort, steering priority, invalid config, truncated/error
responses, timeout, failed writes and switch veto. No credentials or LLM calls.
The package smoke test packs/unpacks, installs in isolated Pi directories, checks
command discovery, disables resources and removes the installation.
