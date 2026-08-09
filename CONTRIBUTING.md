# Contributing

Contributions should preserve Capsule's central invariant: model-visible output
may be reduced only when the exact original remains recoverable or when the
operation is explicitly lossy.

## Before submitting

1. Create a focused branch.
2. Add or update tests for behavior changes.
3. Run:

   ```sh
   npm run verify
   ```

4. Document user-visible changes in `CHANGELOG.md`.

Do not commit credentials, local state, generated capsules, machine-specific
absolute paths, user prompts, session databases, or personal benchmark data.
Benchmark receipts may keep reproducible aggregates and bounded sample metadata,
but must not include local roots, session filenames, or raw session content.

Use the shared primitives in `mcp/storage.cjs` for new local JSON state. Do not
reintroduce ad-hoc temporary-file names, direct state writes, or a second
general-purpose compression/router surface. Native `apply_patch`/Write/Edit/
Update remains preferred for small repository edits; temporary scripts are not
required for ordinary text changes.

Keep the user-facing and MCP name `Capsule`. The package/plugin identifiers
`capsule` and `capsule@personal` remain compatibility
identifiers and require a documented migration before they may change.

Pull requests should explain the problem, behavior before and after, test
evidence, portability impact, privacy impact, and any migration requirement.
