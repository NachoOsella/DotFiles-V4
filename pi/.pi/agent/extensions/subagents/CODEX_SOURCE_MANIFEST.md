# Codex source manifest

| Item | Value |
|---|---|
| Repository | `openai/codex` |
| Revision (SHA) | `9d83c48e5c4761c4fe29995305914021dcfbe7cd` |
| Feature | `MultiAgentV2` |
| Capture date | 2026-09-08 (research snapshot) |
| Pi host | `@earendil-works/pi-coding-agent@0.84.2` (see `docs/PI_API_BINDINGS.md`) |
| Effect | `effect@4.0.0-beta.98` (pinned in root `package.json` overrides) |

## License status (blocking before verbatim reuse)

- [ ] Read pinned revision root `LICENSE`.
- [ ] Read pinned revision `NOTICE` (if present).
- [ ] Record obligations in `NOTICE` / `THIRD_PARTY_NOTICES.md`.
- [ ] Confirm prompt/behavioral-reuse scope.

Until then: behavioral reimplementation only. `src/prompts.ts`
contains original wording preserving the upstream meaning clauses;
no Rust source or upstream prompt text is copied into this repo.
Every translated module cites its upstream file in a header comment.
This is a third-party Pi extension, not an OpenAI product.
