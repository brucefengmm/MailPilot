use crate::imap::client as imap_client;
use crate::imap::types::{
    DeltaCheckRequest, DeltaCheckResult, ImapConfig, ImapDeltaSyncRequest, ImapDeltaSyncResult,
    ImapFetchResult, ImapFolder, ImapFolderSearchBatchResult, ImapFolderSearchResult,
    ImapFolderStatus, ImapFolderSyncResult, ImapFolderSyncSummary, ImapMessage, ImapSyncBatchEvent,
    SearchFolderRequest,
};
use crate::smtp::client as smtp_client;
use crate::smtp::types::{SmtpConfig, SmtpSendResult};
use tauri::{AppHandle, Emitter};

// ---------- IMAP commands ----------

#[tauri::command]
pub async fn imap_test_connection(config: ImapConfig) -> Result<String, String> {
    log::info!(
        "command imap_test_connection invoked for {}:{} security={} auth={}",
        config.host, config.port, config.security, config.auth_method
    );
    imap_client::test_connection(&config).await
}

#[tauri::command]
pub async fn imap_list_folders(config: ImapConfig) -> Result<Vec<ImapFolder>, String> {
    let mut session = imap_client::connect(&config).await?;
    let folders = imap_client::list_folders(&mut session).await?;
    let _ = session.logout().await;
    Ok(folders)
}

#[tauri::command]
pub async fn imap_fetch_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<ImapFetchResult, String> {
    if uids.is_empty() {
        return Err("No UIDs provided".to_string());
    }

    // Build a UID set string like "1,5,10,20"
    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    // Yandex Team servers always return empty via async-imap — skip the wasted connection.
    if imap_client::prefer_raw_imap_fetch(&config.host) {
        log::info!(
            "Using raw TCP fetch directly for {} (async-imap incompatible)",
            config.host
        );
        return imap_client::raw_fetch_messages(&config, &folder, &uid_set).await;
    }

    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::fetch_messages(&mut session, &folder, &uid_set).await;
    let _ = session.logout().await;

    match result {
        Ok(r) => Ok(r),
        Err(e) if e.starts_with("ASYNC_IMAP_EMPTY:") => {
            // async-imap can't parse this server's responses — use raw TCP fallback
            log::info!("Falling back to raw TCP fetch for folder {folder}");
            imap_client::raw_fetch_messages(&config, &folder, &uid_set).await
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn imap_fetch_new_uids(
    config: ImapConfig,
    folder: String,
    since_uid: u32,
) -> Result<Vec<u32>, String> {
    let mut session = imap_client::connect(&config).await?;
    let uids = imap_client::fetch_new_uids(&mut session, &folder, since_uid).await?;
    let _ = session.logout().await;
    Ok(uids)
}

#[tauri::command]
pub async fn imap_search_all_uids(
    config: ImapConfig,
    folder: String,
) -> Result<Vec<u32>, String> {
    let mut session = imap_client::connect(&config).await?;
    let uids = imap_client::search_all_uids(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(uids)
}

#[tauri::command]
pub async fn imap_fetch_message_body(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<ImapMessage, String> {
    imap_client::fetch_message_body_resolved(&config, &folder, uid).await
}

#[tauri::command]
pub async fn imap_fetch_raw_message(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<String, String> {
    let mut session = imap_client::connect(&config).await?;
    let raw = imap_client::fetch_raw_message(&mut session, &folder, uid).await?;
    let _ = session.logout().await;
    Ok(raw)
}

#[tauri::command]
pub async fn imap_set_flags(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    flags: Vec<String>,
    add: bool,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let flag_op = if add { "+FLAGS" } else { "-FLAGS" };

    // Format flags like "(\Seen \Flagged)"
    let flags_str = format!(
        "({})",
        flags
            .iter()
            .map(|f| {
                // Ensure flags have the backslash prefix if they're standard flags
                if f.starts_with('\\') {
                    f.clone()
                } else {
                    format!("\\{f}")
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    );

    imap_client::set_flags(&mut session, &folder, &uid_set, flag_op, &flags_str).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_move_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    destination: String,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::move_messages(&mut session, &folder, &uid_set, &destination).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_delete_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let mut session = imap_client::connect(&config).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::delete_messages(&mut session, &folder, &uid_set).await?;
    let _ = session.logout().await;
    Ok(())
}

#[tauri::command]
pub async fn imap_get_folder_status(
    config: ImapConfig,
    folder: String,
) -> Result<ImapFolderStatus, String> {
    let mut session = imap_client::connect(&config).await?;
    let status = imap_client::get_folder_status(&mut session, &folder).await?;
    let _ = session.logout().await;
    Ok(status)
}

#[tauri::command]
pub async fn imap_fetch_attachment(
    config: ImapConfig,
    folder: String,
    uid: u32,
    part_id: String,
) -> Result<String, String> {
    let mut session = imap_client::connect(&config).await?;
    let data = imap_client::fetch_attachment(&mut session, &folder, uid, &part_id).await?;
    let _ = session.logout().await;
    Ok(data)
}

#[tauri::command]
pub async fn imap_append_message(
    config: ImapConfig,
    folder: String,
    flags: Option<String>,
    raw_message: String,
) -> Result<(), String> {
    let mut session = imap_client::connect(&config).await?;

    // raw_message is base64url-encoded; decode it
    let raw_bytes = base64url_decode(&raw_message)?;

    let flags_ref = flags.as_deref();
    imap_client::append_message(&mut session, &folder, flags_ref, &raw_bytes).await?;
    let _ = session.logout().await;
    Ok(())
}

fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    engine
        .decode(input)
        .map_err(|e| format!("base64url decode failed: {e}"))
}

#[tauri::command]
pub async fn imap_search_folder(
    config: ImapConfig,
    folder: String,
    since_date: Option<String>,
) -> Result<ImapFolderSearchResult, String> {
    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::search_folder(&mut session, &folder, since_date).await;
    let _ = session.logout().await;
    result
}

#[tauri::command]
pub async fn imap_sync_folder(
    config: ImapConfig,
    folder: String,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncResult, String> {
    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::sync_folder(&mut session, &folder, batch_size, since_date).await;
    let _ = session.logout().await;
    result
}

/// Single-connection folder sync that emits `imap-sync-folder-batch` events per fetch batch.
/// Message bodies are delivered via events; the command returns a lightweight summary.
#[tauri::command]
pub async fn imap_sync_folder_streaming(
    app: AppHandle,
    config: ImapConfig,
    account_id: String,
    folder: String,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncSummary, String> {
    let emit_batch = |messages: Vec<ImapMessage>,
                      batch_index: u32,
                      fetched_count: u32,
                      total_uids: u32,
                      is_last: bool,
                      folder_status: &ImapFolderStatus| {
        let event = ImapSyncBatchEvent {
            account_id: account_id.clone(),
            folder: folder.clone(),
            messages,
            fetched_count,
            total_uids,
            batch_index,
            is_last_batch: is_last,
            folder_status: folder_status.clone(),
        };
        app.emit("imap-sync-folder-batch", event)
            .map_err(|e| format!("Failed to emit sync batch event: {e}"))
    };

    if imap_client::prefer_raw_imap_fetch(&config.host) {
        return imap_client::raw_sync_folder_with_batches(
            &config,
            &folder,
            batch_size,
            since_date,
            emit_batch,
        )
        .await;
    }

    let mut session = imap_client::connect(&config).await?;
    let result = imap_client::sync_folder_with_batches(
        &mut session,
        &folder,
        batch_size,
        since_date,
        emit_batch,
    )
    .await;
    let _ = session.logout().await;
    result
}

#[tauri::command]
pub async fn imap_raw_fetch_diagnostic(
    config: ImapConfig,
    folder: String,
    uid_range: String,
) -> Result<String, String> {
    imap_client::raw_fetch_diagnostic(&config, &folder, &uid_range).await
}

#[tauri::command]
pub async fn imap_delta_check(
    config: ImapConfig,
    folders: Vec<DeltaCheckRequest>,
) -> Result<Vec<DeltaCheckResult>, String> {
    let mut session = imap_client::connect(&config).await?;
    let results = imap_client::delta_check_folders(&mut session, &folders).await?;
    let _ = session.logout().await;
    Ok(results)
}

#[tauri::command]
pub async fn imap_search_folders_batch(
    config: ImapConfig,
    folders: Vec<SearchFolderRequest>,
) -> Result<Vec<ImapFolderSearchBatchResult>, String> {
    let mut session = imap_client::connect(&config).await?;
    let results = imap_client::search_folders_batch(&mut session, &folders).await?;
    let _ = session.logout().await;
    Ok(results)
}

#[tauri::command]
pub async fn imap_fetch_messages_batched(
    config: ImapConfig,
    folder: String,
    uid_batches: Vec<Vec<u32>>,
    headers_only: Option<bool>,
) -> Result<ImapFetchResult, String> {
    imap_client::fetch_messages_batched(
        &config,
        &folder,
        &uid_batches,
        headers_only.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn imap_run_delta_sync(
    config: ImapConfig,
    request: ImapDeltaSyncRequest,
) -> Result<ImapDeltaSyncResult, String> {
    imap_client::run_delta_sync(&config, &request).await
}

// ---------- SMTP commands ----------

#[tauri::command]
pub async fn smtp_send_email(
    config: SmtpConfig,
    raw_email: String,
) -> Result<SmtpSendResult, String> {
    smtp_client::send_raw_email(&config, &raw_email).await
}

#[tauri::command]
pub async fn smtp_test_connection(config: SmtpConfig) -> Result<SmtpSendResult, String> {
    log::info!(
        "command smtp_test_connection invoked for {}:{} security={} auth={}",
        config.host, config.port, config.security, config.auth_method
    );
    smtp_client::test_connection(&config).await
}
