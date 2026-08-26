# Release Guide

How MailPilot publishes desktop builds to GitHub Releases and delivers in-app updates.

## Workflows overview

| Workflow | Manual run | Triggered by |
| --- | --- | --- |
| **Release Please** | Yes | Every push to `main`; creates Release PRs |
| **Build & Release** | Yes | Release Please (after merge), manual dispatch, or new GitHub Release |
| **Build & Package** | No | Release Please only (Flatpak + SRPM) |
| **Update Homebrew Tap** | Yes | Release Please only (updates `homebrew-mailpilot`) |

```text
feat/fix commits → push main
       ↓
Release Please (opens Release PR, bumps version)
       ↓
Merge Release PR
       ↓
GitHub Release created (tag: v0.0.x)
       ↓
Build & Release  →  Win / Linux / macOS + latest.json
Build & Package  →  Flatpak + SRPM
Update Homebrew  →  homebrew-mailpilot cask
```

Direct links:

- [Release Please](https://github.com/brucefengmm/MailPilot/actions/workflows/release-please.yml)
- [Build & Release](https://github.com/brucefengmm/MailPilot/actions/workflows/release.yml)

## Recommended flow (automated)

### 1. Use Conventional Commits

Release Please reads commit messages to decide version bumps:

| Commit type | Bump (pre-1.0) | Example |
| --- | --- | --- |
| `feat:` | minor (`0.1.0`) | `feat(ai): add DeepSeek provider` |
| `fix:` / `perf:` | patch (`0.0.3`) | `fix(imap): sync read flag to server` |
| `docs:` / `chore:` / `test:` | usually none | `docs: update README` |

See [Conventional Commits](https://www.conventionalcommits.org/) and `.claude/skills/commit/SKILL.md`.

### 2. Push to `main`

Each push runs **Release Please**. When enough releasable commits accumulate, the bot opens a PR titled like `chore(main): release 0.0.3`.

That PR updates:

- `package.json`
- `.release-please-manifest.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `com.mailpilot.app.metainfo.xml`
- `mailpilot.spec`
- `CHANGELOG.md` (auto-generated from commits)

### 3. Merge the Release PR

Merging triggers the full release pipeline. You do **not** need to run Build & Release manually.

### 4. Verify the release

Open [GitHub Releases](https://github.com/brucefengmm/MailPilot/releases) and confirm:

- [ ] Tag is `v0.0.x` (e.g. `v0.0.2`)
- [ ] Windows `.msi` / `.exe` uploaded
- [ ] macOS `.dmg` uploaded
- [ ] Linux `.deb` / `.AppImage` uploaded
- [ ] **`latest.json`** present (required for in-app updates)
- [ ] Optional: `mailpilot.flatpak`, `.src.rpm`

## Manual release (first time or hotfix)

Use when you want to ship the version already in `tauri.conf.json` without waiting for Release Please.

1. Ensure version is correct in `package.json` and `src-tauri/tauri.conf.json`
2. Push to GitHub
3. **Actions → Build & Release → Run workflow** → branch `main`
4. Wait for `test`, `build`, and `build-macos` jobs to pass
5. Check the Releases page

Build & Release creates tag **`v__VERSION__`** from `tauri.conf.json` (e.g. `v0.0.2`).

## In-app auto-update

Installed builds check for updates every 4 hours. Users can also check in **Settings → Developer → Updates**, or install from the update toast.

```text
App (v0.0.2)
  → GET .../releases/latest/download/latest.json
  → newer version found (v0.0.3)
  → download signed bundle → verify → install → restart
```

Configuration lives in `src-tauri/tauri.conf.json`:

| Setting | Purpose |
| --- | --- |
| `bundle.createUpdaterArtifacts: true` | Generate signed update bundles in CI |
| `plugins.updater.pubkey` | Public key compiled into the app |
| `plugins.updater.endpoints` | Points to GitHub `latest.json` |

Implementation: `src/services/updateManager.ts`, `src/components/ui/UpdateToast.tsx`.

### Generate signing keys (one-time)

```bash
npm run tauri -- signer generate -w "$HOME/.tauri/mailpilot.key"
```

- **Private key** → GitHub Secret `TAURI_SIGNING_PRIVATE_KEY` (full file contents)
- **Public key** (`.pub` file) → `plugins.updater.pubkey` in `tauri.conf.json`
- If the key has a password → Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Never commit the private key.

## GitHub Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | **Yes** | Sign update artifacts; generate `latest.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | If key has password | Unlock signing key in CI |
| `HOMEBREW_TAP_TOKEN` | For Homebrew job | Push to `brucefengmm/homebrew-mailpilot` |
| `RELEASE_PLEASE_TOKEN` | Optional | PAT if org blocks Actions from opening PRs |
| `APPLE_CERTIFICATE` + related | Optional | macOS code signing and notarization |

### Repository settings

**Settings → Actions → General:**

- Workflow permissions: **Read and write permissions**
- Enable **Allow GitHub Actions to create and approve pull requests**

## Version sources of truth

All should match before a release:

```text
.release-please-manifest.json  →  "0.0.2"
package.json                   →  "0.0.2"
src-tauri/tauri.conf.json      →  "0.0.2"
Git tag                        →  v0.0.2
```

Release Please keeps the first four in sync via the Release PR.

## CHANGELOG

`CHANGELOG.md` is **managed by [release-please](https://github.com/googleapis/release-please)** — do not edit it manually.

When enough `feat:` / `fix:` / `perf:` commits land on `main`, release-please opens a **Release PR** that:

1. Bumps the version in `package.json`, `tauri.conf.json`, and related files
2. Moves unreleased commits into a new `CHANGELOG.md` section for that version

**Your job:** write clear conventional commit messages. Release notes are derived from commit titles.

After merging the Release PR, GitHub Actions builds and publishes the release. See [docs/release.md](release.md) for the full workflow.

## Homebrew

After each release, **Update Homebrew Tap** downloads the universal DMG, computes SHA256, and pushes an updated cask to [homebrew-mailpilot](https://github.com/brucefengmm/homebrew-mailpilot).

Release tags use the format **`v{version}`** (e.g. `v0.0.2`), matching Build & Release and the cask download URL.

Requires `HOMEBREW_TAP_TOKEN` with write access to the tap repo.

### CI: "A public key has been found, but no private key"

`createUpdaterArtifacts` + `pubkey` require signing in CI. Set **`TAURI_SIGNING_PRIVATE_KEY`** to the full `.key` file contents (all lines). If the key has a password, set **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** too. The workflow verifies the secret before building.

### CI: Linux/macOS verify OK, Windows verify fails

Your secret is probably fine. GitHub Actions on **`windows-latest`** can inject `\r` into multiline secrets. The workflow strips CR before signing; re-run **Build & Release** after pulling the latest `release.yml`. If it still fails, delete and re-add **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** when the key has **no** password (a blank password secret causes "wrong password" errors).

## Quick reference

| Goal | Action |
| --- | --- |
| Ship next version automatically | `feat:`/`fix:` commits → push `main` → merge Release PR |
| Ship current version now | Actions → **Build & Release** → Run workflow |
| Check if a release PR is pending | Actions → **Release Please**; or open PRs from `release-please` bot |
| Test in-app update | Install older build → publish newer Release with `latest.json` → Check for updates |
| Update Homebrew only | Actions → **Update Homebrew Tap** → Run workflow (optional version input) |

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Build fails: public key but no private key | `TAURI_SIGNING_PRIVATE_KEY` secret missing, empty, or truncated |
| No `latest.json` on Release | Missing signing secret or `createUpdaterArtifacts: false` |
| Update check fails in app | Pubkey/private key mismatch, or no newer Release |
| Homebrew job fails | Missing `HOMEBREW_TAP_TOKEN`, or DMG not uploaded yet (wait for Build & Release) |
| Release Please does not open PR | No releasable commits since last tag, or Actions PR permission blocked |
| CI test job fails | Fix tests locally with `npm run test` before pushing |
