---
name: update-changelog
description: Summarize git changes for the current package.json version and write CHANGELOG.md. Use when the user says 更新记录, 更新 changelog, update changelog, 汇总变更, or 生成发布记录.
---

# Update Changelog

Summarize project changes into `CHANGELOG.md` for the **current version** in `package.json`. Do not run this on every commit — only when the user requests a changelog update.

## Steps

1. Read `package.json` → `version` (e.g. `0.0.2`).

2. Find change boundary:
   - Previous section in `CHANGELOG.md` (version below `[Unreleased]`), or
   - Previous git tag: `git tag --sort=-v:refname | head -5`

3. Collect history:
   ```bash
   git log v0.0.1..HEAD --pretty=format:"%s"    # adjust tag
   git diff v0.0.1..HEAD --stat
   ```
   Include uncommitted changes if relevant (`git diff`, `git status`).

4. Summarize into Keep a Changelog sections:
   - **Added** — `feat`
   - **Fixed** — `fix`
   - **Changed** — `perf`, behavior changes, refactors with UX impact
   - **Removed** — deprecations/removals

   Merge duplicate scopes; one clear bullet per user-visible change.

5. Update `CHANGELOG.md`:
   - Set `## [VERSION] - YYYY-MM-DD` with summarized bullets
   - Clear `[Unreleased]` subsections (keep headers, empty content)

6. Report to user: version written, bullet count, git range used.

## Example output

```markdown
## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.0.2] - 2026-08-26

### Added
- IMAP batched delta sync with header-only fetch
- Configurable auto-refresh interval (default 120s)
- Manual sync button in email list header

### Fixed
- IMAP mark-as-read syncs `\Seen` to server
```
