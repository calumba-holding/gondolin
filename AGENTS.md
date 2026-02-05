# Agent Notes

Start by reading `README.md` in the repo root for the current status, repo layout, and next steps.

## Repo Layout

- `guest/` — Zig-based `sandboxd` daemon and Alpine initramfs build (cross-compiled, targets aarch64/x86_64 Linux)
- `host/` — TypeScript host controller, networking stack, VFS, and CLI (`pnpm` workspace)
- `scripts/` — Build tooling (`run-parallel` etc.)
- `docs/` — Additional documentation (custom images, etc.)
- `examples/` — Usage examples

## Building & Testing

```bash
make build      # Build everything (guest + host)
make check      # Lint + typecheck (guest + host)
make test       # Run all tests
```

Host tests run with `tsx --test` (Node.js test runner):
```bash
cd host && pnpm test              # All host tests
cd host && pnpm exec tsx --test test/specific.test.ts  # Single test
```

Guest builds use Zig (`zig build`). The image builder is in TypeScript (`host/src/build-alpine.ts`).

## Key Conventions

- **TypeScript:** The host package uses `tsx` for running TypeScript directly. Tests use Node's built-in test runner (`node:test`).
- **Zig version:** 0.15.2 (see `guest/build.zig.zon`).
- **Package manager:** pnpm (workspace root + `host/` package).

## Working with Tests

- Tests are in `host/test/*.test.ts` with shared helpers in `host/test/helpers/`.
- VM integration tests require hardware acceleration (macOS HVF or Linux KVM). Use `shouldSkipVmTests()` from `host/test/helpers/vm-fixture.ts` to gate them.
- Unit tests that don't need a VM should not import VM fixtures. Keep them fast and isolated.
- The test timeout in CI is 120s for VM tests. If adding slow tests, be mindful of this limit.

## CI Notes

- CI runs on GitHub Actions (Ubuntu). Guest is cross-compiled for both aarch64 and x86_64.
- KVM is enabled on CI runners for VM tests.

## Important: Preserving Working Tree Changes

**Do NOT run `git checkout` or `git restore` on files without explicit user approval.** If you notice uncommitted changes that seem unrelated to your task, ask the user before discarding them. Previous sessions have had agents accidentally reset intentional working-tree changes.
