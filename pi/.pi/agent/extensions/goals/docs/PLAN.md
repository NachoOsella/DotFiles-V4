# Implementation plan: Codex Goals for Pi

Living document. Every task records its owner, files, acceptance criteria, state and evidence.
State values: `pending` | `in_progress` | `done` | `blocked`.

## Phase A - Research (parallel round 1)

| ID  | Task                                                                     | Owner                          | Files                                                   | State       | Acceptance                                          |
| --- | ------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------- | ----------- | --------------------------------------------------- |
| A1  | Codex goal runtime/scheduler/persistence reverse engineering             | /root/research_codex_goals_runtime | docs/research/A-codex-goals-runtime.md                 | in_progress | Source-cited report, sections 1-10                  |
| A2  | Codex goal tools + prompts verbatim                                      | /root/research_codex_goal_prompts_tools | docs/research/B-codex-goal-prompts-tools.md            | in_progress | Verbatim prompts, tool contracts, MUST/MUST NOT     |
| A3  | Pi extension API reference (v1.4.0 installed)                            | /root/research_pi_extension_api | docs/research/C-pi-extension-api.md                     | in_progress | Continuation recipe, persistence, usage, lifecycle  |
| A4  | Effect 4 reference + compiling probe                                     | /root/research_effect_v4        | docs/research/D-effect-v4.md                            | in_progress | Verified API names + typechecked example            |
| A5  | Prior art: mattleong/pi-goals, bnema/pi-goals, JJGO/pi-goal              | /root/research_prior_art_pi_goals | docs/research/E-prior-art.md                          | in_progress | Comparison table + design lessons                   |
| A6  | Risk matrix + mandatory tests                                            | /root/research_risk_matrix      | docs/research/F-risk-matrix.md                          | in_progress | 13 risk classes, invariants, test list              |

## Phase B - Architecture

| ID  | Task                                              | Owner | Files                    | Depends on      | State   | Acceptance                                                        |
| --- | ------------------------------------------------- | ----- | ------------------------ | --------------- | ------- | ----------------------------------------------------------------- |
| B1  | Domain contract (state machine, snapshot schema)   | root  | docs/ARCHITECTURE.md     | A1, A2, A6      | pending | Statuses, transitions, invariants, persistence format documented   |
| B2  | Decide continuation mechanism + dedupe invariant   | root  | docs/ARCHITECTURE.md     | A3, A6          | pending | Boundary protocol documented with evidence from Pi source         |
| B3  | Decide budget accounting + wrap-up protocol        | root  | docs/ARCHITECTURE.md     | A1, A2          | pending | Definition of counted tokens, limit behaviour, guarantees         |
| B4  | Approve module/file ownership for implementation   | root  | docs/PLAN.md             | B1-B3           | pending | One owner per file, no concurrent writes                          |

## Phase C - Implementation (parallel round 2)

| ID  | Task                                             | Owner | Files                                                                 | State   | Acceptance                                        |
| --- | ------------------------------------------------ | ----- | --------------------------------------------------------------------- | ------- | ------------------------------------------------- |
| C1  | Project scaffolding (package.json, tsconfig)      | root  | package.json, tsconfig.json                                           | pending | `pi.extensions` entry resolves, typecheck passes  |
| C2  | Domain: goal, transitions, errors, events         | TBD   | src/domain/*.ts                                                       | pending | Pure, no Pi imports, exhaustive transitions       |
| C3  | Prompts                                           | TBD   | src/prompts/*.ts                                                      | pending | Prompt builders are pure and tested               |
| C4  | Services: controller/engine (Effect)              | TBD   | src/services/goal-controller.ts                                       | pending | Effect 4 idioms, serialized mutations             |
| C5  | Services: repository (session entries)            | TBD   | src/services/goal-repository.ts                                       | pending | Versioned snapshots, corrupt-state handling       |
| C6  | Services: usage accounting                        | TBD   | src/services/usage-accounting.ts                                      | pending | Idempotent, dedupe by entry id                    |
| C7  | Services: continuation policy + progress tracker  | TBD   | src/services/continuation-policy.ts, progress-tracker.ts              | pending | Deterministic boundary decisions                  |
| C8  | Adapters: pi events/commands/tools/ui             | TBD   | src/adapters/*.ts                                                     | pending | Public Pi API only, no invented APIs              |
| C9  | Entry point wiring                                | root  | src/index.ts                                                          | pending | Registers everything, thin                         |

## Phase D - Integration

| ID  | Task                                       | Owner | State   | Acceptance                                                  |
| --- | ------------------------------------------ | ----- | ------- | ----------------------------------------------------------- |
| D1  | Wire modules, resolve type incompatibilities | root | pending | `npm run check:extensions` clean for goals                  |
| D2  | Load extension in real Pi (`--extension`)   | root  | pending | No load errors; commands and tools listed                    |
| D3  | End-to-end goal run                          | root  | pending | Objective runs, continues automatically, completes or stops |

## Phase E - Testing

| ID  | Task                                   | Owner | Files          | State   | Acceptance                              |
| --- | -------------------------------------- | ----- | -------------- | ------- | --------------------------------------- |
| E1  | Unit tests: domain + transitions        | TBD   | test/*.test.ts | pending | All transitions covered, invalid rejected |
| E2  | Unit tests: repository + accounting     | TBD   | test/*.test.ts | pending | Restart/dedupe/corruption covered        |
| E3  | Unit tests: continuation policy         | TBD   | test/*.test.ts | pending | All boundary decisions covered           |
| E4  | Race tests                              | TBD   | test/*.test.ts | pending | Duplicate continuation, pause vs continue, branch vs late event |
| E5  | Full suite runs                          | root  | pending        | All tests pass                           |

## Phase F - Independent audit (round 3)

| ID  | Task                                      | Owner | Files                                     | State   |
| --- | ----------------------------------------- | ----- | ----------------------------------------- | ------- |
| F1  | Correctness + Codex parity review          | TBD   | docs/reviews/F1-correctness.md             | pending |
| F2  | Effect 4 + code quality review             | TBD   | docs/reviews/F2-effect-quality.md          | pending |
| F3  | Concurrency + race review                  | TBD   | docs/reviews/F3-concurrency.md             | pending |
| F4  | Persistence + recovery review              | TBD   | docs/reviews/F4-persistence.md             | pending |
| F5  | Testing + missing scenarios review         | TBD   | docs/reviews/F5-testing.md                 | pending |
| F6  | Safety, loops, resource consumption review | TBD   | docs/reviews/F6-safety.md                  | pending |

## Phase G - Fixes

| ID  | Task                        | Owner | State   |
| --- | --------------------------- | ----- | ------- |
| G1  | Fix critical/high findings  | TBD   | pending |
| G2  | Regression tests per bug    | TBD   | pending |

## Phase H - Second audit

| ID  | Task                                 | Owner | State   |
| --- | ------------------------------------ | ----- | ------- |
| H1  | Fresh independent review of fixes    | TBD   | pending |

## Phase I - Final validation

| ID  | Task                                     | State   |
| --- | ---------------------------------------- | ------- |
| I1  | Clean install/typecheck/lint             | pending |
| I2  | Full test suite                          | pending |
| I3  | Real Pi load + `/goal` command           | pending |
| I4  | Real continuation + completion run       | pending |
| I5  | Interrupt + restore run                  | pending |
| I6  | README (install, usage, limits)          | pending |
