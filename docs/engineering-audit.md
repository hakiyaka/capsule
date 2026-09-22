Engineering audit, 22 September 2026

This review extends the public-readiness fixes in PR #2. The baseline was
`c112404521da8cf1c8a8e2bbaafcb84afb9401c2`; the upstream main branch was still
`06fb5e308b1d09e5056426072a0579d17dbcd173` when checked.

The new regression file contains 21 cases. Before the fixes, all 19 cases that
could run on the local Windows host failed; the two POSIX/filesystem-specific
cases were skipped. These are separate regression cases, not a claim of 21
independent vulnerabilities. The existing Windows CI logs also independently
showed a source-lock EPERM race and premature background scratch cleanup.

| Area | Confirmed defect | Resulting behavior |
| --- | --- | --- |
| Execution evidence | Passthrough rendering hid nonzero exit codes, including silent failures. | Failed, signalled and timed-out executions retain structured status on the wire. |
| Process timeout | Asynchronous execution returned a null or platform-specific exit code without a timeout indicator. | Timeout reports `exit_code:124` and `timed_out:true`; a direct child ignoring termination receives a subsequent forced termination. |
| Runtime cleanup | Invalid language selection or compiler launch errors could leave scratch directories. | Both setup failure paths remove their scratch directory. Compiler failures also retain exit metadata. |
| Batch failures | One failed spawn rejected the batch while other workers continued, losing their results. | Each failed item receives an error result and successful siblings remain available. |
| Batch validation | A malformed later command could be discovered after earlier commands had started. | Command names and argument arrays are checked before workers start. |
| Batch limits | A shared `max_output_bytes` setting was ignored. | Per-command overrides inherit the shared byte limit. |
| Flow dependency status | A batch containing failed commands could be treated as successful. | Nested execution failures prevent dependent steps with the default success requirement. |
| Flow validation | Cycles and invalid regular expressions were detected only after unrelated steps could run. | Graph cycles and regex syntax are validated before execution. |
| Project cache | Same-size modifications preserving mtime reused stale facts. Millisecond truncation weakened freshness further. | Metadata reuse also requires precise mtime, ctime, inode and device identity. `fast_cache:false` remains the option for rehashing every file. |
| Project identity | Project paths were lowercased on every operating system. | Case is preserved outside Windows, avoiding collisions between distinct case-sensitive roots. |
| State permissions | Atomic replacement could broaden a restrictive existing POSIX file mode. | Replacement files inherit the existing mode, including at temporary-file creation, unless explicitly overridden. |
| Edit encoding | Invalid UTF-8 was decoded with replacement characters and silently rewritten. | Editing rejects invalid UTF-8 before changing any target. |
| Edit recovery | The recovery manifest was written after target files changed. | Backups and the manifest are created before the first target write. Failed rollback attempts continue through other targets and preserve recovery material. |
| Undo integrity | A modified or corrupted backup could overwrite the target. | All backup hashes are checked before any restoration begins. |
| Windows locking | Reading a directory concurrently being removed could raise EPERM and fail a valid save/GC operation. | Transient deletion races follow the existing bounded contention retry path. |
| Windows process cleanup | A background child could appear stopped before Windows released its working directory. | Locally launched jobs remain busy until their close event; asynchronous scratch cleanup permits event-loop progress and bounded filesystem retries. |
| MCP negotiation | Unknown protocol versions were echoed as though supported. | The server returns a supported version. |
| MCP notifications | Some notifications received responses despite having no request identifier. | Notifications produce no response. |
| MCP input validation | Object identifiers and scalar parameters were accepted. | Invalid identifiers and parameters receive protocol errors. |
| MCP shutdown | Input EOF terminated the server before asynchronous calls could respond. | Accepted calls drain and stdout is flushed before normal process termination. |
| MCP framing | An unterminated or oversized input frame could grow without a bound. | Frames default to a 16 MiB limit; rejected frames are discarded through the next newline, allowing subsequent requests to proceed. |

`CAPSULE_MCP_MAX_MESSAGE_BYTES` configures the frame limit between 1 KiB and
128 MiB. The default is 16 MiB. The limit applies to each incoming JSON message,
including its arguments; it does not change the separate command output limits.

The review included project structure, runtime and protocol entry points, state
storage, editing and undo, cache identity/freshness, batch and conditional flow,
fetch/cache boundaries, hook installation, release/CI definitions, public
documentation, and the token-measurement claims investigated earlier. The complete
verification command covers the existing test suite plus source integrity,
public readiness, documentation and SEO publishing checks:

```sh
npm run verify
git diff --check
```

The targeted regressions are in [deep-review.test.cjs](../tests/deep-review.test.cjs).
Earlier fetch, installation, archive-identity and concurrency regressions remain
in [review-regressions.test.cjs](../tests/review-regressions.test.cjs).

Verification result on Windows with Node 22.17.0: `npm run verify` passed.
The full suite ran 365 tests: 362 passed, 0 failed and 3 platform-specific tests
were skipped. Source integrity, public readiness, documentation and SEO audits
also passed, as did `git diff --check`. All 19 locally executable new regression
cases passed after reproducing their failures on the baseline. The first grouped
run exposed the background-child cleanup race again; tracking the close event
and allowing asynchronous cleanup resolved it in the completed verification run.

Coverage has limits. The changes do not establish a security sandbox, make
multi-file edits crash-atomic, prove the safety of user-supplied programs or
regular expressions, or establish provider-billed token savings. The new changes
were developed on Windows; the case-sensitive filesystem and POSIX mode tests
need the Linux/macOS CI jobs. Passing the suite is evidence for the tested
behaviors, not a guarantee that every line or possible runtime environment is
defect-free. No new throughput or large-project performance claim is made.

Protocol behavior was checked against the primary specifications:
[MCP lifecycle and version negotiation](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)
and [JSON-RPC 2.0](https://www.jsonrpc.org/specification).
