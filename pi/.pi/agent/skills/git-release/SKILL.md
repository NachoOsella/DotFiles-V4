---
name: git-release
description: "Create consistent releases and changelogs following semantic versioning. Use when you need to: (1) prepare a tagged release, (2) draft release notes from PRs, (3) determine version bump (major/minor/patch), (4) identify breaking changes, or (5) create GitHub releases."
---

# Git Release Workflow

## Semantic Versioning

```
MAJOR.MINOR.PATCH
  │     │     └── Bug fixes, no API changes
  │     └──────── New features, backwards compatible
  └────────────── Breaking changes
```

## Release Checklist

1. **Verify all tests pass**
   ```bash
   npm test  # or equivalent
   ```

2. **Review commits since last release**
   ```bash
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```

3. **Determine version bump**
   - Breaking changes → MAJOR
   - New features → MINOR
   - Bug fixes only → PATCH

4. **Update version**
   ```bash
   npm version minor  # or major/patch
   # or manually edit package.json/pyproject.toml
   ```

5. **Generate changelog**
   - Group by: Features, Fixes, Breaking Changes
   - Reference PR/issue numbers
   - Credit contributors

6. **Create release**
   ```bash
   gh release create v1.2.0 \
     --title "v1.2.0" \
     --notes-file CHANGELOG.md
   ```

## Changelog Format

```markdown
## [1.2.0] - 2024-01-15

### Added
- New authentication flow (#123)

### Fixed
- Memory leak in cache handler (#456)

### Breaking Changes
- Removed deprecated `oldMethod()` (#789)
```

## Guidelines

- Never release on Fridays
- Verify CI is green before releasing
- Tag releases with `v` prefix (e.g., `v1.2.0`)
- Keep changelog entries user-focused
