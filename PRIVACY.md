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
- Automatic hook event, phase, and final-memory capture is disabled by default.
  Set `CAPSULE_CAPTURE_MEMORY=1` only when you intentionally want sanitized,
  bounded excerpts stored in local memory; this setting never sends them to a
  Capsule-controlled service.
- Hook failure diagnostics keep only an error class, optional code, bounded
  length, and a short message fingerprint; stack traces, paths, and error text
  are not persisted by the hook logger.
- Provider/compaction telemetry responses omit session identifiers and absolute
  session paths by default. Use `include_identity:true` (or the explicit
  `CAPSULE_INCLUDE_SESSION_METADATA=1` setting) only for local diagnostics.
- MCP error responses expose only a bounded error class by default. Set
  `CAPSULE_VERBOSE_ERRORS=1` temporarily when a local diagnostic needs the
  bounded message detail.
- GitHub Pages, GitHub Actions, and any other hosting provider process their own
  access logs under their policies. Those services are not Capsule telemetry.

## Local state and deletion

Capsule may store bounded caches, exact-recovery capsules, hashes, and
hash-only audit records in the user's local Codex state. The user controls that
directory and may remove it using the documented local-state and cache cleanup
commands. Raw session text and automatic final/phase excerpts are not implicitly
copied into Capsule state; content memory requires the explicit opt-in above.

If a future release changes these data flows, this policy and the release notes
will be updated before the change is presented as a default behavior.
