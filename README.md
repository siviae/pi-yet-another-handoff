# pi-yet-another-handoff

Session handoff for **Pi 1.5.0** and **Node.js >=22.19.0**. Summarizes the current
conversation, opens a new session, and continues unfinished work without an editor
or confirmation step.

## Installation

Install from a GitHub release tag:

```bash
pi install 'npm:pi-yet-another-handoff@git+https://github.com/siviae/pi-yet-another-handoff.git#v0.1.4'
```

Run `/reload` or restart Pi. Add `--local` to install for the current project
instead of globally. Do not load another extension that registers `/handoff`.

The installation is pinned to the tag. To update, install the specification for a
new release tag, then run `/reload`.

## Usage

```text
/handoff
/handoff Focus on the remaining tests and deployment steps
```

The extension generates a handoff document using the active model, saves it,
creates a new session linked to the previous one, and starts continuation
immediately. The document appears as a visible message wrapped in
`<handoff-context>` and includes:

- Goal
- Constraints & Preferences
- Progress: Done / In Progress / Pending
- Key Decisions
- Critical Context
- Next Steps

The new session preserves the selected provider/model and thinking level before
its first continuation request, rather than reverting to the configured defaults.
The `reasoning` setting below applies only to generating the handoff document;
it does not change the continuation's thinking level.

The previous session remains on disk. Documents are saved to
`<session-file-without-.jsonl>/handoff-<timestamp>.md` with private file permissions
(`0600`). In-memory sessions have no saved artifact. Treat handoff documents as
private: they contain information from the conversation.

During generation, the TUI shows a loading indicator. Press Escape to cancel
generation and stay in the current session.

## Configuration

Global settings live in **`~/.pi/agent/handoff.json`**. If `PI_CODING_AGENT_DIR` is
set, the file lives in that agent directory instead. `PI_HANDOFF_CONFIG` can
override the global configuration file path.

A trusted project's **`.pi/handoff.json`** overrides global values. Configuration
from untrusted projects is not read.

Available settings and their defaults:

| Setting | Default | Description |
| --- | --- | --- |
| `templateFile` | `null` | Path to a custom handoff prompt template. `null` uses the bundled `handoff-document.md`. |
| `reasoning` | `"low"` | Reasoning effort for handoff generation, independent of the main session. Supports `"off"`; availability depends on the model. |
| `maxTokens` | `8192` | Output-token limit, including reasoning where applicable. Also capped by the model and available context. |
| `timeoutMs` | `600000` | Generation timeout in milliseconds (10 minutes). |

Configuration is reread on every `/handoff`. Invalid JSON or values are reported.
The removed `autoHandoffAt` setting is ignored; it no longer triggers handoff.

### Custom handoff template

Copy [handoff-document.md](handoff-document.md), edit it, and set its path in
`handoff.json`:

```json
{
  "templateFile": "./my-handoff.md"
}
```

Relative paths resolve against the directory containing that configuration file,
not the current working directory. Absolute paths are also supported. A trusted
project can override the global template, or set `"templateFile": null` to restore
the bundled default. The default template remains in the repository and package,
unchanged.

The file is the prompt used to generate the document, not the document itself.
It is reread for each handoff. Missing, unreadable, or empty custom files stop
handoff rather than silently falling back to the default.

Templates support `{{additionalFocus}}` for the optional `/handoff <focus>`
argument, and optional blocks:

```text
{{#if additionalFocus}}
Additional focus: {{additionalFocus}}
{{/if}}
```

Blocks are omitted when no focus is supplied. These are the only supported
template constructs (not a general Handlebars engine). Custom templates can
change the document structure; ask the model to output only the handoff document.

## Optional automation (bring your own extension)

This package deliberately does **not** trigger handoff automatically or change
Pi's compaction behavior. A context percentage alone cannot tell whether the
agent needs to finish additional work first: cleanup, verification, background
jobs, or another critical step may still be pending. Use `/handoff` when it is
safe to replace the session.

If you need automation, implement it in a separate Pi extension:

1. Observe `turn_end` and `ctx.getContextUsage()?.percent`. Treat a threshold
   (for example, 90%) as a request to prepare for handoff, not proof it is safe.
2. Define workflow-specific readiness checks. Finish any required extra work and
   stop or persist background jobs. Do not switch while tools are executing,
   user messages are queued, a run is aborted, or context usage is unknown.
3. At a safe idle boundary, dispatch the public command:
   `pi.sendUserMessage("/handoff", { expandPromptTemplates: true })`.
   The flag is required for Pi to execute the slash command rather than send it
   to the model as text. Event contexts do not expose `newSession`; reuse the
   command instead of duplicating session-switch logic.
4. Guard against repeated dispatch, clear pending requests on session changes,
   and pause automation after failure until an explicit retry. If stopping an
   active run, wait for its complete tool batch to persist before requesting
   abort, then dispatch only after `agent_settled`.
5. Leave enough headroom for document generation. Pi may compact before your
   threshold; any custom compaction policy belongs in that separate extension,
   not this package. Keep manual compaction and overflow recovery available.

There is no generic readiness check provided by this package. The separate
extension must decide whether unfinished work can safely move to a new session.

If generation fails, times out, returns an empty or truncated document, or cannot
save the artifact, the current session stays active. Use `/handoff` to retry.
Other extensions can veto the session switch.

## Limitations

- A large tool result can fill the context window before handoff is possible.
  Run `/handoff` early enough to leave room for generation.
- Handoff uses the full projected conversation, including tool results. Large
  contexts and long documents take time to summarize; generation speed depends
  on the model and provider.
- This is a new session, not in-place compaction. Extension instances reload, and
  private in-memory state and active background jobs are not migrated. Finish
  or persist any work that must survive before running `/handoff`.

## Development

```bash
npm ci
npm test
npm run check
npm run test:package
```

Tests use an offline provider and require no API credentials or paid model calls.
The package smoke test checks installation and extension loading in isolated Pi
directories.

To try the source without installing it:

```bash
pi -e ./src/extension.js
```

Do not load the development copy alongside an installed copy. Release updates
with a new version and Git tag; do not move existing release tags.

## License

MIT. Based on `@jackice/pi-handoff`; see [LICENSE](LICENSE).
