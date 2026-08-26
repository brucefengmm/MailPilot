# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**This file is updated by [release-please](https://github.com/googleapis/release-please) in Release PRs.** Do not edit manually — write clear conventional commits (`feat:`, `fix:`, `perf:`) instead.

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.0.2] - 2026-08-26

### Added

- AI: per-feature trigger modes for thread summary and smart replies (automatic / manual with toolbar buttons)
- AI: output language settings for summary and replies (English, Chinese, Russian)
- AI: message fingerprint cache invalidation when thread content changes
- AI: DeepSeek, Kimi, and GLM providers via OpenAI-compatible API
- IMAP: batched delta sync — single connection for folder search + delta check, batched UID fetch per folder
- IMAP: header-only fetch during delta sync; bodies loaded on demand and cached locally after first read
- IMAP: raw TCP batched fetch for Yandex and other async-imap-incompatible servers
- IMAP: background auto-sync after folder sync setup and first manual sync complete
- IMAP: sync prompt banner until account is configured and initial sync finishes
- Settings: configurable auto-refresh interval (default 120 seconds; was 60 seconds)
- Email list: manual sync button in main UI header (also available via F5)
- Database migrations v26–v28 (AI preferences, AI cache fingerprint, sync interval setting)

### Changed

- AI: thread summary works on single-message threads (removed ≥2 messages requirement)
- IMAP: initial sync persists message bodies to local DB when fetched (avoids redundant body downloads)
- IMAP: `imapDeltaSync` uses unified `imap_run_delta_sync` command for fewer TCP connections
- Version bumped to 0.0.2 across package, Tauri, and release manifest

### Fixed

- IMAP: mark-as-read syncs `\Seen` flag to server when opening a thread (resolves message IDs from DB)
- IMAP: archive, trash, star, spam, and move actions work when callers pass empty message ID lists
- IMAP: in-flight deduplication for concurrent on-demand body loads (`messageBodyLoader`)
- Local DB: `messages.is_read` updated when marking threads read

## [0.0.1] - 2026-08-25

Initial MailPilot release — Tauri desktop client with Gmail API and IMAP/SMTP support.
