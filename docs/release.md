# Release Guide

How MailPilot publishes desktop builds to GitHub Releases and delivers in-app updates.

## Workflows overview

| Workflow | Manual run | Triggered by |
| --- | --- | --- |
| **Release Please** | Yes | Every push to `main`; creates Release PRs |
| **Build & Release** | Yes | Release Please (after merge), manual dispatch, or new GitHub Release |
| **Build & Package** | No | Release Please only (Flatpak + SRPM) |

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

When prompted for a password, press **Enter** for none (simplest for CI).

**GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`** — paste the **entire** private key file:

```powershell
# PowerShell — copies full key to clipboard
Get-Content "$env:USERPROFILE\.tauri\mailpilot.key" -Raw | Set-Clipboard
```

The secret must be the **exact** contents of `mailpilot.key`. On Windows Tauri often stores this as **one base64 line** (no visible `untrusted comment:` text) — that is normal; paste the whole line as-is.

To validate locally (shows only the header line, not the secret):

```powershell
$b64 = (Get-Content "$env:USERPROFILE\.tauri\mailpilot.key" -Raw).Trim()
([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) -split "`n")[0]
```

- **`minisign secret key`** → no password secret needed
- **`encrypted secret key`** → set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

- **Public key** (`.pub` file) → `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`
- **Password** → only if you set one at generate time → Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- **No password** → do **not** create `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` at all

Never commit the private key.

## GitHub Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | **Yes** | Sign update artifacts; generate `latest.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | If key has password | Unlock signing key in CI |
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

Homebrew Tap auto-update has been removed. macOS users should install via the universal DMG attached to each GitHub Release.

Release tags use the format **`v{version}`** (e.g. `v0.0.2`), matching Build & Release and the DMG download URL.

### CI: "A public key has been found, but no private key"

`createUpdaterArtifacts` + `pubkey` require signing in CI. Set **`TAURI_SIGNING_PRIVATE_KEY`** to the full `.key` file contents (all lines). If the key has a password, set **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** too. The workflow verifies the secret before building.

### CI: "Wrong password for that key"

Your private key is loaded, but **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` does not match**.

| How you generated `mailpilot.key` | What to do in GitHub Secrets |
| --- | --- |
| **No password** (pressed Enter) | **Delete** `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` entirely — do not leave a blank or space secret |
| **With password** | Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the **exact** password you used when running `tauri signer generate` |

### CI: Linux/macOS verify OK, Windows verify fails

GitHub Actions on **`windows-latest`** can inject `\r` into multiline secrets. Pull the latest `release.yml` (includes CR stripping) and re-run **Build & Release**.

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
| Release Please does not open PR | No releasable commits since last tag, or Actions PR permission blocked |
| CI test job fails | Fix tests locally with `npm run test` before pushing |
