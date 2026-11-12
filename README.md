# pi-yet-another-handoff

Session handoff for **Pi 1.5.0** and **Node.js >=22.19.0**. Summarizes the current
conversation, opens a new session, and continues unfinished work without an editor
or confirmation step.

## Installation

Install from a GitHub release tag:

```bash
pi install 'npm:pi-yet-another-handoff@git+https://github.com/siviae/pi-yet-another-handoff.git#v0.1.2'
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

To enable automatic handoff at 90% context usage:

```json
{
  "autoHandoffAt": 90
}
```

Available settings and their defaults:

| Setting | Default | Description |
| --- | --- | --- |
| `autoHandoffAt` | `false` | Disable automatic handoff, or set a context percentage strictly between 0 and 100. |
| `reasoning` | `"low"` | Reasoning effort for handoff generation, independent of the main session. Supports `"off"`; availability depends on the model. |
| `maxTokens` | `8192` | Output-token limit, including reasoning where applicable. Also capped by the model and available context. |
| `timeoutMs` | `180000` | Generation timeout in milliseconds. |

Run `/reload` after changing automatic settings. Manual `/handoff` rereads
configuration on use. Invalid JSON or values are reported.

## Automatic handoff

Automatic handoff runs when context usage reaches the configured threshold and
the model is continuing tool-based work. It waits for the entire tool batch to
finish; executing tools are not interrupted. A final response without tool calls,
an error, a user abort, or unknown context usage does not trigger a handoff.
Queued user messages take priority.

While tool work is ongoing, automatic handoff defers Pi's threshold-based
compaction so the configured percentage can be reached. Manual `/compact` and
context-overflow recovery remain available. There is no need to disable Pi's
compaction globally.

If generation fails, times out, returns an empty or truncated document, or cannot
save the artifact, the current session stays active. Further automatic attempts
are paused until `/reload` or a new session; use `/handoff` to retry manually.
Other extensions can veto the session switch.

## Limitations

- A large tool result can exceed the threshold or fill the context window before
  handoff is possible. Use an earlier threshold for large or unpredictable outputs.
- Handoff uses the full projected conversation, including tool results. Large
  contexts and long documents take time to summarize; generation speed depends
  on the model and provider.
- This is a new session, not in-place compaction. Extension instances reload, and
  private in-memory state and active background jobs are not migrated. Disable
  automatic handoff if your workflow requires those jobs to survive.

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
