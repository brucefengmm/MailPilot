# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**This file is updated by [release-please](https://github.com/googleapis/release-please) in Release PRs.** Do not edit manually — write clear conventional commits (`feat:`, `fix:`, `perf:`) instead.

## [0.1.1](https://github.com/brucefengmm/MailPilot/compare/mailpilot-v0.1.0...mailpilot-v0.1.1) (2026-08-26)


### Bug Fixes

* **imap:** fall back to raw TCP when async-imap returns empty stream ([8daf84a](https://github.com/brucefengmm/MailPilot/commit/8daf84a95616af01eacbca926e3c240d1f686c45))

## [0.1.0](https://github.com/brucefengmm/MailPilot/compare/mailpilot-v0.0.2...mailpilot-v0.1.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* Migration 18 adds 3 new database tables (writing_style_profiles, tasks, task_tags) and 2 new default settings. The migration runner now wraps each migration in a transaction. The taskStore is the 9th Zustand store and is initialized on app startup. These changes require a fresh app restart to run the new migration.

### Features

* accept self-signed certificates for IMAP/SMTP ([#148](https://github.com/brucefengmm/MailPilot/issues/148)) ([a5f7cec](https://github.com/brucefengmm/MailPilot/commit/a5f7cec2d8a4bd2701acd96a36fd62c8ac00c93a))
* add About page to settings ([fa03431](https://github.com/brucefengmm/MailPilot/commit/fa03431f091a3f84d78eab1122267c35fdd8c722))
* add AI auto-draft replies with writing style learning and full task manager ([c75dfc5](https://github.com/brucefengmm/MailPilot/commit/c75dfc5b3cf7b08abc9c8a9c15018dc480413516))
* add AI smart labels for automatic email labeling ([986a7ae](https://github.com/brucefengmm/MailPilot/commit/986a7aef3f13171f0a0cebd8f523aa67a7cb34f5))
* add attachment library, keyboard shortcut, and update docs ([b69f042](https://github.com/brucefengmm/MailPilot/commit/b69f042e74b42ba4680ee60730959e7de08e6dc7))
* add auto-update via Tauri updater plugin ([7ac2362](https://github.com/brucefengmm/MailPilot/commit/7ac2362c3ef1c9e9f628fd2232cd16f8ccfc194b))
* add CalDAV calendar integration for IMAP and standalone accounts ([08e05ff](https://github.com/brucefengmm/MailPilot/commit/08e05ff571652c73cce6261a3c5f875a6a013e9a)), closes [#113](https://github.com/brucefengmm/MailPilot/issues/113)
* add Flatpak and RPM packaging for Linux distribution ([95c1e29](https://github.com/brucefengmm/MailPilot/commit/95c1e2954a465982c3feec8d90bbe1aee8fb8c86))
* add GitHub Copilot (GitHub Models) as 5th AI provider ([9b8e162](https://github.com/brucefengmm/MailPilot/commit/9b8e1628d9cd784bb3e1a5d3a310724e198ce1cd))
* add Homebrew tap auto-update to release workflow ([4a817b0](https://github.com/brucefengmm/MailPilot/commit/4a817b0dba3bba3b8d4650e3c1a3b57a9f0a72f0))
* add local AI support via Ollama and LMStudio ([1cee002](https://github.com/brucefengmm/MailPilot/commit/1cee00291df37c46ba2d46a95346152a6ac7dc1f)), closes [#98](https://github.com/brucefengmm/MailPilot/issues/98)
* add Microsoft OAuth2 support for Outlook/Hotmail/Live accounts ([019a5e2](https://github.com/brucefengmm/MailPilot/commit/019a5e241dc558d6eb384efc5b6e9880643d7383))
* add model selection dropdowns for AI providers ([#158](https://github.com/brucefengmm/MailPilot/issues/158)) ([74244ca](https://github.com/brucefengmm/MailPilot/commit/74244caf5c0072272abad7c3e7481eb1674eb2ef))
* add Move to Folder/Label shortcut (V key) ([751aeaa](https://github.com/brucefengmm/MailPilot/commit/751aeaa4b98002ebdc99156ce76a256786ccf042))
* add sidebar nav item reordering and visibility customization ([3f96837](https://github.com/brucefengmm/MailPilot/commit/3f96837dfeaf65647889633d297766b6e5be079c))
* add standalone workflow to manually sync homebrew tap ([5a33e67](https://github.com/brucefengmm/MailPilot/commit/5a33e6707175bfa13a443c2e2489e6f40996ee7b))
* add View Source option to message context menu ([c657b0f](https://github.com/brucefengmm/MailPilot/commit/c657b0f798d70bda0436acbd0ea435afd3f84b63))
* auto-advance to next thread after removal actions ([520ea01](https://github.com/brucefengmm/MailPilot/commit/520ea01ab78bbd7a8cc8fa019246fe4a7d181034))
* chunked IMAP sync with lightweight UID search and batched transactions ([7440215](https://github.com/brucefengmm/MailPilot/commit/7440215fe1bf923afc666486ec2c999ed1e5c266))
* consolidate release pipeline — packaging and homebrew on release only ([7e4ac8c](https://github.com/brucefengmm/MailPilot/commit/7e4ac8cc40da62c8d23716b4f5c21fea27e263c3))
* **nav:** add arrow key navigation between messages in thread view ([efd213d](https://github.com/brucefengmm/MailPilot/commit/efd213d2f0420852be2432e7ef09a1c12231f110))
* **nav:** add arrow key navigation in email list and thread view ([e87c712](https://github.com/brucefengmm/MailPilot/commit/e87c712a284cee6918f21042764ca90119e8cbb1))
* **nav:** add arrow key navigation in email list with auto-scroll ([9f4b0d8](https://github.com/brucefengmm/MailPilot/commit/9f4b0d826100492dc781bab6c48b4e0e5ba191af))
* optimize IMAP delta sync with single-connection batch check ([0a62b73](https://github.com/brucefengmm/MailPilot/commit/0a62b7363c6c7d34592781a711eb8695b8e5ed52))
* parallelize Gmail sync and add 429 rate limit retry ([ff3580b](https://github.com/brucefengmm/MailPilot/commit/ff3580b29807c844a81cb79586168700c84c1dc3))
* pass releaseId from release-please to tauri-action ([9587dfd](https://github.com/brucefengmm/MailPilot/commit/9587dfdd1eae8d2b3364c93ddb07533087246cd9))
* prioritize new account sync to eliminate 20-30s delay ([49bce0f](https://github.com/brucefengmm/MailPilot/commit/49bce0fc8227d75923642cef26700c13504ee046))
* ship v0.0.2 with IMAP sync improvements, new AI providers, and in-app updates ([16f1d35](https://github.com/brucefengmm/MailPilot/commit/16f1d35d7395fbfef98518c12c96ef176046a7aa))
* **signatures:** add HTML source editor toggle and sanitize signature output ([e1ca851](https://github.com/brucefengmm/MailPilot/commit/e1ca8512dc5f54278d64cda0f1fc8721f97a525d)), closes [#99](https://github.com/brucefengmm/MailPilot/issues/99)
* **sync:** add per-folder sync via F5 shortcut and sidebar context menu ([d11c642](https://github.com/brucefengmm/MailPilot/commit/d11c642013ed538aaad67f56158e6d9ba37695e9)), closes [#101](https://github.com/brucefengmm/MailPilot/issues/101)
* **ui:** highlight spam threads with dimmed red background ([5766ecb](https://github.com/brucefengmm/MailPilot/commit/5766ecbc72ea5e121c486d2f21fd7a40a3cd2179))


### Bug Fixes

* add --repo flag to gh release upload in SRPM job ([5b863c0](https://github.com/brucefengmm/MailPilot/commit/5b863c0048a49635b560d921dacbc04ef96b6a15))
* add appdata read/write permissions for Tauri FS baseDir operations ([f9750de](https://github.com/brucefengmm/MailPilot/commit/f9750de942535e3c245fcfd86b034446bfb37233))
* add Escape key to close inline reply editor ([386b403](https://github.com/brucefengmm/MailPilot/commit/386b40303e5dece542eb2617e485e352cc3f5c07))
* add missing path separator in attachment cache directory ([de4355b](https://github.com/brucefengmm/MailPilot/commit/de4355b799abf316cb4ee729d22c6f03138174f2))
* add reduce motion setting to prevent animated background strobe on some Windows GPUs ([981f2b5](https://github.com/brucefengmm/MailPilot/commit/981f2b51aabf95e7335f08ef8ce7c0f4ec9b0ca7)), closes [#156](https://github.com/brucefengmm/MailPilot/issues/156)
* add TCP timeouts and keepalive to IMAP client ([#147](https://github.com/brucefengmm/MailPilot/issues/147)) ([a77b474](https://github.com/brucefengmm/MailPilot/commit/a77b474bcc3f59abf49e5c67665cffdb7459058d))
* align release pipeline version sync for SRPM and Homebrew ([ebf21ff](https://github.com/brucefengmm/MailPilot/commit/ebf21ffe3f22bbbaeeb9d8e598df876f23c8c34f))
* align test files — remove stale mocks, add cleanup, fix brittle assertions ([4acf9e3](https://github.com/brucefengmm/MailPilot/commit/4acf9e3343e377a989f80bc26bd650f988e5bf47))
* allow homebrew tap update on workflow_dispatch triggers ([c31ddc8](https://github.com/brucefengmm/MailPilot/commit/c31ddc86c022005d1aa02ea9f6e828a39e2bff46))
* allow optional space after colon in search operators ([d1e9495](https://github.com/brucefengmm/MailPilot/commit/d1e9495ec5efa247406941d0b5ebfec55d699927))
* attachments not showing in attachment list ([fdf8c75](https://github.com/brucefengmm/MailPilot/commit/fdf8c75ed5d42e29fdd90e96c88b2b33a90d48b4))
* **attachments:** use EmailProvider for IMAP attachment preview and download ([228ca5e](https://github.com/brucefengmm/MailPilot/commit/228ca5e86be56e080c3a109acbdd07e63c63bdd4)), closes [#100](https://github.com/brucefengmm/MailPilot/issues/100)
* bind OAuth server to 127.0.0.1 instead of localhost ([ec47a7a](https://github.com/brucefengmm/MailPilot/commit/ec47a7a5095bb5deffc24e9b6812e39107508dbe))
* call sep() as function, not use as string ([b65888b](https://github.com/brucefengmm/MailPilot/commit/b65888b70578c767a330ec13087c38f66880bda5))
* **ci:** auto-sync Homebrew tap when workflow files change ([2958a35](https://github.com/brucefengmm/MailPilot/commit/2958a35a2ac01c29bdf5f3e3ec9c359a5bf131dd))
* **ci:** fix Homebrew cask 404 and deprecation warning ([b39d402](https://github.com/brucefengmm/MailPilot/commit/b39d402bd36f3415c25ecb160dc4c5ec92d67195))
* **ci:** fix version parsing in standalone update-homebrew workflow ([41b3390](https://github.com/brucefengmm/MailPilot/commit/41b3390652b6f2055c7cb523a2153d6d4359b069))
* **ci:** grant contents write to reusable workflow caller jobs ([1d4868e](https://github.com/brucefengmm/MailPilot/commit/1d4868eb53a265adfe5410c8a6bc4da27d4a2f42))
* **ci:** grant release-please PR permissions and PAT fallback ([0ee3f9f](https://github.com/brucefengmm/MailPilot/commit/0ee3f9ffdfc6d98405ebcd90ab3b0208057cf7b8))
* **ci:** keep base64 signing key format for Tauri CLI ([79855f9](https://github.com/brucefengmm/MailPilot/commit/79855f9375b2e7b4520d1e33704285e2ba8de3fa))
* **ci:** normalize Tauri signing key for windows-latest runners ([7d5e48c](https://github.com/brucefengmm/MailPilot/commit/7d5e48c68f480ed57771f4fe16743c9383bbe69d))
* **ci:** remove invalid makeLatest input and fix Homebrew update skip ([236e81b](https://github.com/brucefengmm/MailPilot/commit/236e81ba33b95a134bd7852840809039c24561c0))
* **ci:** verify DMG exists before updating Homebrew cask ([2cdc3d2](https://github.com/brucefengmm/MailPilot/commit/2cdc3d2fd3e54f5c5dcb99d1c8fe92fe59305861))
* **ci:** verify Tauri signing secret and bump Node to 22 ([325c7d5](https://github.com/brucefengmm/MailPilot/commit/325c7d56a10036443488323d6bf6c26faa238301))
* create placeholder thread before message insert during IMAP sync ([6c2d013](https://github.com/brucefengmm/MailPilot/commit/6c2d0135a6b3683dfbce4075a032b9df12ed699a)), closes [#89](https://github.com/brucefengmm/MailPilot/issues/89)
* decode IMAP folder names from modified UTF-7 and use real UIDs for sync ([19a919e](https://github.com/brucefengmm/MailPilot/commit/19a919eece270efaa0751e8d74b42dca6e6f4f54))
* guard against undefined payload in parseIdToken ([120b0d7](https://github.com/brucefengmm/MailPilot/commit/120b0d7668791773a976b192c45c5e20bedfbcba))
* handle missing router context in pop-out thread windows ([b484d86](https://github.com/brucefengmm/MailPilot/commit/b484d86e7b68b7950c432b9d077b5258ed8fdb15))
* IMAP emails not displaying in UI after sync ([18521cf](https://github.com/brucefengmm/MailPilot/commit/18521cf2cbcb87f75cab25cff21dba9876fb0e31))
* IMAP fetch fallback for servers incompatible with async-imap ([fcc7a45](https://github.com/brucefengmm/MailPilot/commit/fcc7a45f52e2fe04595d40c0c34926adca5678b4))
* IMAP messages downloaded but not stored in database ([1c28a8e](https://github.com/brucefengmm/MailPilot/commit/1c28a8e7c3e55dfdd3197ba2011e7b82025767f5)), closes [#39](https://github.com/brucefengmm/MailPilot/issues/39)
* IMAP trash not working for servers with non-standard folder names ([b6cf2c6](https://github.com/brucefengmm/MailPilot/commit/b6cf2c6d3aae86fa261fd3b20d938ff8c16f36a9))
* **imap:** fix sync locks, lazy body load, and FTS corruption after bulk sync ([3756967](https://github.com/brucefengmm/MailPilot/commit/3756967de11433c78c7ece06e40dc08e49abf494))
* **imap:** persist attachments on body fetch and improve parsing ([c2edf3f](https://github.com/brucefengmm/MailPilot/commit/c2edf3f376dca131999226d4fef35d8d62f768c2))
* improve IMAP sync error handling and reliability ([29ce210](https://github.com/brucefengmm/MailPilot/commit/29ce210b78c1dccaf0cdef02f1342dcd14f0aedf))
* improve sync status bar UX ([dc76dd7](https://github.com/brucefengmm/MailPilot/commit/dc76dd7e60fec0460a39a4ed5c5427723a52ad32))
* move release-please annotation to own line in RPM spec ([134746f](https://github.com/brucefengmm/MailPilot/commit/134746f1c5c5d209d609bec9c8376fe688f6d0d0))
* only show sync status bar for initial syncs, not delta syncs ([b925610](https://github.com/brucefengmm/MailPilot/commit/b9256103b9f9f07bb2573f4e539607cbab024e96))
* **popout:** set active account in thread pop-out window ([ae60695](https://github.com/brucefengmm/MailPilot/commit/ae606950a8c1692a5c935d4ea60d384d1093e7e0))
* prevent IMAP sync OOM on large mailboxes and surface sync errors ([61ebc6e](https://github.com/brucefengmm/MailPilot/commit/61ebc6ef7b1993c2a15f8c0c022657b275fa62c2)), closes [#74](https://github.com/brucefengmm/MailPilot/issues/74) [#76](https://github.com/brucefengmm/MailPilot/issues/76)
* reduce IMAP sync connection storm with single-connection folder sync ([6b90b7a](https://github.com/brucefengmm/MailPilot/commit/6b90b7a1bfa0a2a048de6b0746acbf01511eb9cb)), closes [#147](https://github.com/brucefengmm/MailPilot/issues/147)
* resolve context menu bugs on attachment preview and submenu opening ([f1d26b9](https://github.com/brucefengmm/MailPilot/commit/f1d26b97410a596f8562e175470dddf9eafba433))
* resolve IMAP attachment fetching and display ([2c40b51](https://github.com/brucefengmm/MailPilot/commit/2c40b51d87a7c83de6204c170ab057bc11efc08e)), closes [#124](https://github.com/brucefengmm/MailPilot/issues/124)
* resolve local AI (Ollama/LMStudio) connection failures ([adfc09f](https://github.com/brucefengmm/MailPilot/commit/adfc09f6900ab40c11b73767a24fad07d97547c2)), closes [#145](https://github.com/brucefengmm/MailPilot/issues/145)
* resolve nested button warning and 204 response parsing ([e44f063](https://github.com/brucefengmm/MailPilot/commit/e44f063927b179444711771e87923343b6599a26))
* resolve nested button warnings, TipTap duplicate extensions, FS scope, and CI type errors ([65c0028](https://github.com/brucefengmm/MailPilot/commit/65c0028e03315fc7150a1882ed0775344ec345fd))
* resolve SQLite transaction errors during IMAP initial sync ([6044f42](https://github.com/brucefengmm/MailPilot/commit/6044f429581f6c2142cc536f1eb6299347bfdbeb)), closes [#192](https://github.com/brucefengmm/MailPilot/issues/192)
* save IMAP/SMTP sent messages to local DB and Sent folder ([3133ee9](https://github.com/brucefengmm/MailPilot/commit/3133ee9b24324cd2e6e2098a8e66ad48d6cccbe0)), closes [#121](https://github.com/brucefengmm/MailPilot/issues/121)
* **settings:** use Tauri OS plugin for reliable platform detection ([07b6890](https://github.com/brucefengmm/MailPilot/commit/07b6890f9a7daeba666414ccf7b66c2e626902a2))
* smart folder unread count SQL error and sync progress visibility ([7c2eb4e](https://github.com/brucefengmm/MailPilot/commit/7c2eb4edb6fa2d14f847d194e86fe48d3ee94ee0))
* starred threads not appearing in Starred folder ([a03db9f](https://github.com/brucefengmm/MailPilot/commit/a03db9f4877988d7d979980f750ff5daf63bc052))
* suppress notifications for muted threads in deltaSync ([4d21334](https://github.com/brucefengmm/MailPilot/commit/4d21334efc8d2e6d078173fad28c76f1bd1fcc46))
* **sync:** clear sync spinner on velo-sync-done event instead of promise ([a502f04](https://github.com/brucefengmm/MailPilot/commit/a502f040969f8dc4ba29ecacc057aec26c184e6f))
* **sync:** hide delta sync progress bar when no new mail ([06e3c61](https://github.com/brucefengmm/MailPilot/commit/06e3c61f92bcaa4ced2184d80c522441ca08c4a2))
* **test:** update HelpPage test for 14 categories (added tasks) ([ca97b65](https://github.com/brucefengmm/MailPilot/commit/ca97b656290781f1d81d944e57445a6f1158f287))
* **ui:** replace loading text with skeleton animation and fix platform detection ([02eda9f](https://github.com/brucefengmm/MailPilot/commit/02eda9fd35f7272222aa4c5e9f28661230bc754b))
* update velo.spec version to 0.4.11 and fix release-please annotation ([d1d08b2](https://github.com/brucefengmm/MailPilot/commit/d1d08b2ee6951c71fb6ae7d8bcfceadff465e827))
* use background-image instead of background shorthand in dark mode ([9107b50](https://github.com/brucefengmm/MailPilot/commit/9107b5081c37082469decc47b178fcd7c15540fb)), closes [#168](https://github.com/brucefengmm/MailPilot/issues/168)
* use baseDir option for Tauri FS operations to resolve scope errors ([7b463dc](https://github.com/brucefengmm/MailPilot/commit/7b463dcba326e45c59ac5d2d47b967d05591384a))
* use join() for paths and hash long attachment IDs for filenames ([d01dd79](https://github.com/brucefengmm/MailPilot/commit/d01dd794dbe02ef0820bc293e7af39bc37deaa45))
* use server-side IMAP SINCE date filter to prevent sync timeouts on large folders ([99d9301](https://github.com/brucefengmm/MailPilot/commit/99d9301f836b24b2917b1aae05980073a86f4f3d)), closes [#147](https://github.com/brucefengmm/MailPilot/issues/147)
* use Tauri native fetch for local AI to bypass CORS ([6e84ab2](https://github.com/brucefengmm/MailPilot/commit/6e84ab2884c261db0ed0a4fec6d223295355a7dc)), closes [#127](https://github.com/brucefengmm/MailPilot/issues/127)
* wire phishing sensitivity setting and improve brand impersonation detection ([e063c9d](https://github.com/brucefengmm/MailPilot/commit/e063c9df676dea3757357bebc092e48cbc181513))


### Performance Improvements

* memoize calendar event buckets, filter descriptions, and contact search ([3eb6042](https://github.com/brucefengmm/MailPilot/commit/3eb60425bcff8e60a9fc34e23e2abe6f77fdce09))
* optimize rendering, store subscriptions, and DB queries ([0fd4d8c](https://github.com/brucefengmm/MailPilot/commit/0fd4d8c784a326f30f334cbf4ace46cd7347677e))
* pre-parse filter JSON and lazy load route components ([33440b7](https://github.com/brucefengmm/MailPilot/commit/33440b7ed272ac04adbb3186f5d81f77f1e45dec))

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
