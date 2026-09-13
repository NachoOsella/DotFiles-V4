# Codex source manifest

| Item | Value |
|---|---|
| Repository | `openai/codex` |
| Revision (SHA) | `a592c38c16cdd7623dacc9168926ebccedfb67d3` |
| Feature | `MultiAgentV2` |
| Capture date | 2026-09-13 (refreshed after V3 lifecycle fixes) |
| Pi host | `@earendil-works/pi-coding-agent@0.85.1` (see `docs/PI_API_BINDINGS.md`) |
| Effect | `effect@4.0.0-beta.98` (pinned in root `package.json` overrides) |

## License status (blocking before verbatim reuse)

- [ ] Read pinned revision root `LICENSE`.
- [ ] Read pinned revision `NOTICE` (if present).
- [ ] Record obligations in `NOTICE` / `THIRD_PARTY_NOTICES.md`.
- [ ] Confirm prompt/behavioral-reuse scope.

The revision is a behavioral reference, not a claim of complete source parity.
Pi-specific omissions are tracked in `docs/CODEX_PARITY.md`, including
parent-authoritative cold reload, environment, permissions, execution policy,
and inherited instruction handling.

Until then: behavioral reimplementation only. `src/prompts.ts`
contains original wording preserving the upstream meaning clauses;
no Rust source or upstream prompt text is copied into this repo.
Every translated module cites its upstream file in a header comment.
This is a third-party Pi extension, not an OpenAI product.
