# Create or Update `AGENTS.md`

Create or update the repository's `AGENTS.md`.

The goal is not comprehensive documentation. The goal is maximum operational value per token: a small set of durable instructions that helps coding agents make correct repository-specific decisions.

## 1. Inspect Before Writing

Review only the sources needed to establish repository conventions:

* Existing root and nested `AGENTS.md` files.
* `README`, contributor docs, and architecture docs.
* Package manifests, lockfiles, task runners, and workspace configuration.
* CI workflows.
* Lint, format, type-check, test, build, migration, and deployment configuration.
* A few representative files from each major code area.
* Current `git status`.

Treat repository files as the source of truth. Do not infer commands, paths, versions, or conventions that can be verified.

If `AGENTS.md` already exists:

* Preserve intentional rules that remain correct.
* Remove stale, redundant, vague, contradictory, or tool-enforced instructions.
* Tighten wording instead of rewriting valid content unnecessarily.

Do not modify unrelated files.

## 2. Apply a Strict Inclusion Test

Include an instruction only when it does at least one of the following:

* Changes how an agent should implement or validate work.
* Prevents a likely and costly repository-specific mistake.
* Provides an exact command the agent needs.
* Defines a non-obvious architectural or ownership boundary.
* Points to the authoritative location for information needed during work.

Otherwise, omit it.

In particular, omit:

* Generic engineering advice.
* Repository or product summaries that do not affect implementation.
* Exhaustive directory trees, dependency lists, endpoint lists, or technology inventories.
* Style rules already enforced completely by formatters or linters.
* Information easily discovered from the file currently being edited.
* Temporary status, current tasks, changelogs, roadmaps, or speculative plans.
* Personal preferences that belong in global agent configuration.
* Instructions such as “write clean code,” “follow best practices,” or “be helpful.”

Mention framework or language versions only when they affect compatibility, commands, or implementation choices.

## 3. Optimize the Document Structure

Prefer this order, omitting empty sections:

```md
# AGENTS.md

## Commands
## Architecture Boundaries
## Development Rules
## Testing
## Safety and Constraints
## References
```

Put frequently used commands first.

For each command:

* Copy it exactly from repository configuration.
* State briefly when it should be run if that is not obvious.
* Prefer targeted validation during development.
* Include the full required validation set before completion.
* Do not invent commands or recommend tools the repository does not use.

Describe only non-obvious architecture boundaries, such as:

* Dependency direction.
* Module ownership.
* Generated code.
* Migration policy.
* Public API stability.
* Files that must be changed together.

For behavioral constraints, use these categories when useful:

* **Always:** required actions.
* **Ask first:** consequential or ambiguous actions requiring approval.
* **Never:** prohibited or destructive actions.

Give a safe alternative after a prohibition when the alternative is not obvious.

## 4. Use Progressive Disclosure

Keep root instructions limited to rules that apply across the repository.

For a monorepo or clearly independent subsystem, use a nested `AGENTS.md` only when local rules materially differ and moving them reduces root context.

Do not duplicate root instructions in nested files.

Keep long procedures, tutorials, and rare workflows in their existing documentation. Reference them with a short path instead of copying them into `AGENTS.md`.

Use code examples only when a very small example prevents a likely mistake. Prefer pointing to one canonical implementation file.

## 5. Keep It Compact

Use concise Markdown bullets and imperative language.

* Prefer one rule per bullet.
* Prefer file references over explanations.
* Prefer concrete instructions over background.
* Avoid repeating the same rule in multiple sections.
* Avoid decorative prose and agent personas.
* Target 50–100 lines for the root file.
* Treat 150 lines per file as a soft maximum.
* Exceed the limit only for genuinely distinct, high-impact constraints.

Every line should justify its recurring context cost.

## 6. Verify the Result

Before finishing, confirm that:

* Every referenced path exists.
* Every command exists in the current repository.
* Instructions agree with CI and repository configuration.
* No rules conflict across root and nested files.
* No important existing constraint was removed accidentally.
* The file contains no unverified assumptions.
* The same information is not already better expressed by a referenced source.
* Only intended `AGENTS.md` files were changed.

Apply the changes directly.

In the final response, report only:

1. Which instruction files changed.
2. The most important additions or removals.
3. Any consequential uncertainty that could not be verified.
