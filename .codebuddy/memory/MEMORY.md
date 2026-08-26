# MailPilot 长期记忆

## 项目结构
- Tauri 桌面应用 (Rust 后端 + TS/React 前端)
- 后端: `src-tauri/src/` (imap client, commands, lib)
- 前端: `src/` (services/imap, db, gmail, threading 等)
- IMAP 同步逻辑入口: `src/services/imap/imapSync.ts` (`imapInitialSync`, `imapDeltaSync`)
- 后端 IMAP 命令: `src-tauri/src/commands.rs`
- 后端 IMAP 客户端: `src-tauri/src/imap/client.rs`

## IMAP 同步关键事实
- `prefer_raw_imap_fetch(host)` (client.rs:13) 目前仅对 `yandex-team`/`yandex.ru` 返回 true，走 raw TCP 路径
- `fetch_message_body` (单邮件) 已有 `ASYNC_IMAP_EMPTY` fallback 到 raw TCP
- `fetch_uid_batches` (批量同步) 原本没有 fallback，已在 2026-08-26 于 `imap_sync_folder_streaming` 命令层加入
- `raw_sync_folder_with_batches` 用裸 TCP 实现 SELECT/SEARCH/FETCH，与 async-imap 路径签名兼容

## 开发约定
- Windows 环境，PowerShell
- 编译命令: `cd src-tauri; cargo check --no-default-features` 或 `cargo run --no-default-features`
