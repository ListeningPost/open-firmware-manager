## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran and what you saw. -->

## Checklist

- [ ] `pnpm -r build && pnpm typecheck && pnpm lint && pnpm -r test` pass
- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` pass (if `cli/` changed)
- [ ] Docs updated if behaviour, flags, env vars or lexicons changed
- [ ] No secrets, tokens or private keys in the diff
