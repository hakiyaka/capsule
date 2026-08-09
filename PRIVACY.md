# Privacy

Capsule is local-first. The plugin and bundled MCP server do not send prompts,
session transcripts, files, or local capsules to a Capsule-controlled service.
The exact result remains on the machine where Capsule runs unless the user
explicitly selects an external operation.

## Explicit external operations

- `fetch` and web-search actions contact the URL or provider requested by the
  user and return a bounded view while retaining exact local recovery.
- The GitHub visibility audit calls the GitHub API through the user's
  authenticated `gh` CLI. It writes only aggregate repository metadata,
  traffic/referral summaries, release metadata, and repository-search snapshots;
  it does not store GitHub credentials or prompt/session text.
- GitHub Pages, GitHub Actions, and any other hosting provider process their own
  access logs under their policies. Those services are not Capsule telemetry.

## Local state and deletion

Capsule may store bounded caches, exact-recovery capsules, hashes, and
hash-only audit records in the user's local Codex state. The user controls that
directory and may remove it using the documented local-state and cache cleanup
commands. Raw session text is not implicitly copied into Capsule state.

If a future release changes these data flows, this policy and the release notes
will be updated before the change is presented as a default behavior.
