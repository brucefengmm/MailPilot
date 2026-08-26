use async_imap::{types::Flag, Authenticator, Client, Session};
use base64::Engine;
use futures::StreamExt;
use mail_parser::{MessageParser, MimeHeaders};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

use super::types::*;

/// Some IMAP servers (e.g. Yandex Team) return empty responses via async-imap.
pub fn prefer_raw_imap_fetch(host: &str) -> bool {
    let h = host.to_lowercase();
    h.contains("yandex-team") || h.contains("yandex.ru")
}

// ---------- Timeout constants ----------

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const IMAP_CMD_TIMEOUT: Duration = Duration::from_secs(30);
const IMAP_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const IMAP_SEARCH_TIMEOUT: Duration = Duration::from_secs(60);
const OVERALL_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// Log connection settings without exposing secrets.
fn log_imap_config(stage: &str, config: &ImapConfig) {
    log::info!(
        "IMAP [{stage}] host={} port={} security={} auth_method={} accept_invalid_certs={} username={} credential_len={}",
        config.host,
        config.port,
        config.security,
        config.auth_method,
        config.accept_invalid_certs,
        config.username,
        config.password.len()
    );
}

/// Configure TCP keepalive and nodelay on a connected socket.
fn configure_tcp_socket(stream: &TcpStream) {
    // Set TCP nodelay via tokio's built-in API
    if let Err(e) = stream.set_nodelay(true) {
        log::warn!("Failed to set TCP_NODELAY: {e}");
    }

    // Set TCP keepalive via socket2
    let sock_ref = socket2::SockRef::from(stream);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(60))
        .with_interval(Duration::from_secs(60));
    if let Err(e) = sock_ref.set_tcp_keepalive(&keepalive) {
        log::warn!("Failed to set TCP keepalive: {e}");
    }
}

// ---------- XOAUTH2 authenticator ----------

struct XOAuth2 {
    response: Vec<u8>,
}

impl XOAuth2 {
    fn new(user: &str, access_token: &str) -> Self {
        // XOAUTH2 format: "user=" {user} "\x01auth=Bearer " {token} "\x01\x01"
        let s = format!("user={}\x01auth=Bearer {}\x01\x01", user, access_token);
        Self {
            response: s.into_bytes(),
        }
    }
}

impl Authenticator for XOAuth2 {
    type Response = Vec<u8>;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        // Return the initial XOAUTH2 string on the first (empty) challenge.
        // If the server sends a second challenge it means auth failed; we send
        // an empty response to let the server return a proper error.
        std::mem::take(&mut self.response)
    }
}

// ---------- Stream wrapper ----------

/// Wrapper to unify TLS / plain streams so Session can be generic.
pub(crate) enum ImapStream {
    Tls(TlsStream<TcpStream>),
    Plain(TcpStream),
}

impl tokio::io::AsyncRead for ImapStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for ImapStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_flush(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

impl std::fmt::Debug for ImapStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImapStream::Tls(_) => write!(f, "ImapStream::Tls"),
            ImapStream::Plain(_) => write!(f, "ImapStream::Plain"),
        }
    }
}

// ---------- TLS helper ----------

/// Build a TLS connector, optionally accepting invalid certificates
/// (for local mail bridges like ProtonMail Bridge with self-signed certs).
fn build_tls_connector(accept_invalid_certs: bool) -> Result<native_tls::TlsConnector, String> {
    let mut builder = native_tls::TlsConnector::builder();
    if accept_invalid_certs {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder.build().map_err(|e| format!("Failed to create TLS connector: {e}"))
}

// ---------- Public API ----------

type ImapSession = Session<ImapStream>;

/// Establish an IMAP connection and authenticate.
///
/// Supports TLS (direct), STARTTLS (upgrade), and plain connections.
/// Auth methods: "password" (LOGIN) or "oauth2" (XOAUTH2).
///
/// Wraps the entire connection + auth sequence in a 60s overall timeout.
pub async fn connect(config: &ImapConfig) -> Result<ImapSession, String> {
    log::info!("IMAP connect: starting (overall timeout {}s)", OVERALL_CONNECT_TIMEOUT.as_secs());
    log_imap_config("connect", config);
    let result = tokio::time::timeout(OVERALL_CONNECT_TIMEOUT, connect_inner(config))
        .await
        .map_err(|_| format!(
            "IMAP connection to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, OVERALL_CONNECT_TIMEOUT.as_secs()
        ))?;
    match &result {
        Ok(_) => log::info!("IMAP connect: success for {}:{}", config.host, config.port),
        Err(e) => log::error!("IMAP connect: failed for {}:{} — {e}", config.host, config.port),
    }
    result
}

async fn connect_inner(config: &ImapConfig) -> Result<ImapSession, String> {
    log::info!("IMAP connect_inner: security mode={}", config.security);
    if config.security == "starttls" {
        log::info!("IMAP connect_inner: using STARTTLS path");
        return connect_starttls(config).await;
    }

    log::info!("IMAP connect_inner: opening stream (tls/none)");
    let stream = connect_stream(config).await?;
    log::info!("IMAP connect_inner: stream ready, creating client");
    let client = Client::new(stream);

    log::info!("IMAP connect_inner: authenticating (timeout {}s)", AUTH_TIMEOUT.as_secs());
    tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))?
}

/// List all IMAP folders/mailboxes.
pub async fn list_folders(session: &mut ImapSession) -> Result<Vec<ImapFolder>, String> {
    let names_stream = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.list(Some(""), Some("*")))
        .await
        .map_err(|_| format!("LIST timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("LIST failed: {e}"))?;

    let names: Vec<_> = tokio::time::timeout(IMAP_CMD_TIMEOUT, names_stream.collect::<Vec<_>>())
        .await
        .map_err(|_| format!("LIST stream timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut folders = Vec::new();
    for name in &names {
        let raw_path = name.name().to_string();
        let delimiter = name.delimiter().unwrap_or("/").to_string();

        // Decode modified UTF-7 (RFC 3501 §5.1.3) to UTF-8 for display
        let path = utf7_imap::decode_utf7_imap(raw_path.clone());

        // Extract display name (last segment after delimiter)
        let display_name = path
            .rsplit_once(&delimiter)
            .map(|(_, last)| last.to_string())
            .unwrap_or_else(|| path.clone());

        // Detect special-use from attributes (RFC 6154)
        let special_use = detect_special_use(name);

        // Get message counts via STATUS — use raw_path for IMAP commands
        let (exists, unseen) = match tokio::time::timeout(
            IMAP_CMD_TIMEOUT,
            session.status(&raw_path, "(MESSAGES UNSEEN)"),
        ).await {
            Ok(Ok(mailbox)) => (mailbox.exists, mailbox.unseen.unwrap_or(0)),
            _ => (0, 0),
        };

        folders.push(ImapFolder {
            path,
            raw_path,
            name: display_name,
            delimiter,
            special_use,
            exists,
            unseen,
        });
    }

    Ok(folders)
}

/// Fetch messages from a folder by UID range (e.g. "1:100" or "500:*").
pub async fn fetch_messages(
    session: &mut ImapSession,
    folder: &str,
    uid_range: &str,
) -> Result<ImapFetchResult, String> {
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    log::info!(
        "IMAP SELECT {folder}: exists={}, uidvalidity={}, uidnext={}, fetching UIDs: {uid_range}",
        mailbox.exists,
        mailbox.uid_validity.unwrap_or(0),
        mailbox.uid_next.unwrap_or(0),
    );

    // Try UID FETCH first; if the stream is empty, fall back to sequence-number FETCH.
    // Some IMAP servers return empty streams for UID FETCH despite valid UIDs.
    let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(uid_range, "UID FLAGS INTERNALDATE BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH {folder} uids={uid_range} failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH {folder} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?;

    let raw_fetches: Vec<_> = fetches?;
    let mut fetch_ok = 0u32;
    let mut fetch_err = 0u32;
    let mut fetches = Vec::new();
    for r in raw_fetches {
        match r {
            Ok(f) => { fetch_ok += 1; fetches.push(f); }
            Err(e) => { fetch_err += 1; log::warn!("IMAP fetch stream error in {folder}: {e}"); }
        }
    }
    log::info!("IMAP FETCH {folder}: {fetch_ok} ok, {fetch_err} errors from uid_fetch");

    // If async-imap returned nothing but messages exist, fallback to raw TCP fetch
    if fetches.is_empty() && mailbox.exists > 0 {
        log::warn!("IMAP {folder}: async-imap returned 0 items but exists={}. Falling back to raw TCP fetch...", mailbox.exists);
        // Return early with raw fetch result — caller doesn't need to know about the fallback
        return Err(format!("ASYNC_IMAP_EMPTY:{folder}"));
    }

    let parser = MessageParser::default();
    let mut messages = Vec::new();
    for fetch in &fetches {
        let uid = match fetch.uid {
            Some(u) => u,
            None => { log::warn!("IMAP FETCH {folder}: response missing UID"); continue; }
        };

        let raw = match fetch.body() {
            Some(b) => b,
            None => { log::warn!("IMAP FETCH {folder}: UID {uid} has no body"); continue; }
        };

        let raw_size = raw.len() as u32;

        // Parse flags
        let flags: Vec<_> = fetch.flags().collect();
        let is_read = flags.iter().any(|f| matches!(f, Flag::Seen));
        let is_starred = flags.iter().any(|f| matches!(f, Flag::Flagged));
        let is_draft = flags.iter().any(|f| matches!(f, Flag::Draft));

        // Extract INTERNALDATE as fallback for messages with unparseable Date headers
        let internal_date = fetch.internal_date().map(|dt| dt.timestamp());

        match parse_message(&parser, raw, uid, folder, raw_size, is_read, is_starred, is_draft, internal_date) {
            Ok(msg) => messages.push(msg),
            Err(e) => {
                log::warn!("Failed to parse message UID {uid}: {e}");
            }
        }
    }

    Ok(ImapFetchResult {
        messages,
        folder_status,
    })
}

/// Fetch message headers only (no body) for a UID set — used during delta sync.
pub async fn fetch_message_headers(
    session: &mut ImapSession,
    folder: &str,
    uid_range: &str,
) -> Result<ImapFetchResult, String> {
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(uid_range, "UID FLAGS INTERNALDATE BODY.PEEK[HEADER]")
            .await
            .map_err(|e| format!("UID FETCH headers {folder} uids={uid_range} failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH headers {folder} timed out after {}s", IMAP_FETCH_TIMEOUT.as_secs()))?;

    let raw_fetches: Vec<_> = fetches?;
    let parser = MessageParser::default();
    let mut messages = Vec::new();
    for r in raw_fetches {
        let fetch = match r {
            Ok(f) => f,
            Err(e) => {
                log::warn!("IMAP header fetch stream error in {folder}: {e}");
                continue;
            }
        };

        let uid = match fetch.uid {
            Some(u) => u,
            None => continue,
        };

        let raw = match fetch.body() {
            Some(b) => b,
            None => continue,
        };

        let raw_size = raw.len() as u32;
        let flags: Vec<_> = fetch.flags().collect();
        let is_read = flags.iter().any(|f| matches!(f, Flag::Seen));
        let is_starred = flags.iter().any(|f| matches!(f, Flag::Flagged));
        let is_draft = flags.iter().any(|f| matches!(f, Flag::Draft));
        let internal_date = fetch.internal_date().map(|dt| dt.timestamp());

        match parse_message(&parser, raw, uid, folder, raw_size, is_read, is_starred, is_draft, internal_date) {
            Ok(msg) => messages.push(msg),
            Err(e) => log::warn!("Failed to parse headers UID {uid}: {e}"),
        }
    }

    Ok(ImapFetchResult {
        messages,
        folder_status,
    })
}

/// Fetch a single message body by UID.
pub async fn fetch_message_body(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<ImapMessage, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "UID FLAGS BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH for UID {uid} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Message UID {uid} not found in {folder}"))?;

    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    let raw_size = raw.len() as u32;
    let flags: Vec<_> = fetch.flags().collect();
    let is_read = flags.iter().any(|f| matches!(f, Flag::Seen));
    let is_starred = flags.iter().any(|f| matches!(f, Flag::Flagged));
    let is_draft = flags.iter().any(|f| matches!(f, Flag::Draft));

    let parser = MessageParser::default();
    parse_message(&parser, raw, uid, folder, raw_size, is_read, is_starred, is_draft, None)
}

/// Fetch one message body, using raw TCP when async-imap is unreliable (e.g. Yandex Team).
pub async fn fetch_message_body_resolved(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
) -> Result<ImapMessage, String> {
    let uid_str = uid.to_string();

    if prefer_raw_imap_fetch(&config.host) {
        log::info!(
            "Using raw TCP fetch for message body on {} (async-imap incompatible)",
            config.host
        );
        let result = raw_fetch_messages(config, folder, &uid_str).await?;
        return result
            .messages
            .into_iter()
            .next()
            .ok_or_else(|| format!("Message UID {uid} not found in {folder}"));
    }

    let mut session = connect(config).await?;
    let result = fetch_message_body(&mut session, folder, uid).await;
    let _ = session.logout().await;

    match result {
        Ok(msg) => Ok(msg),
        Err(e) if e.starts_with("ASYNC_IMAP_EMPTY:") => {
            log::info!("Falling back to raw TCP fetch for message body UID {uid} in {folder}");
            let fetch = raw_fetch_messages(config, folder, &uid_str).await?;
            fetch
                .messages
                .into_iter()
                .next()
                .ok_or_else(|| format!("Message UID {uid} not found in {folder}"))
        }
        Err(e) => Err(e),
    }
}

/// Get UIDs of messages newer than `last_uid`.
pub async fn fetch_new_uids(
    session: &mut ImapSession,
    folder: &str,
    last_uid: u32,
) -> Result<Vec<u32>, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let query = format!("{}:*", last_uid + 1);
    let uids = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&query))
        .await
        .map_err(|_| format!("UID SEARCH timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH failed: {e}"))?;

    // Filter out last_uid itself (IMAP returns it if it's the highest UID)
    let mut result: Vec<u32> = uids.into_iter().filter(|&u| u > last_uid).collect();
    result.sort();
    Ok(result)
}

/// Search for all UIDs in a folder using `UID SEARCH ALL`.
/// Returns real UIDs sorted ascending — avoids the sparse UID gap problem.
pub async fn search_all_uids(
    session: &mut ImapSession,
    folder: &str,
) -> Result<Vec<u32>, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uids = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search("ALL"))
        .await
        .map_err(|_| format!("UID SEARCH ALL timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH ALL failed: {e}"))?;

    let mut result: Vec<u32> = uids.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Set or remove flags on messages.
///
/// `flag_op`: "+FLAGS" to add, "-FLAGS" to remove
/// `flags`: e.g. "(\\Seen)" or "(\\Flagged)"
pub async fn set_flags(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
    flag_op: &str,
    flags: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let query = format!("{flag_op} {flags}");
    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let stream = session
            .uid_store(uid_set, &query)
            .await
            .map_err(|e| format!("UID STORE failed: {e}"))?;
        let _: Vec<_> = stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| format!("UID STORE timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
}

/// Move messages between folders.
///
/// Tries MOVE first; falls back to COPY + flag Deleted + EXPUNGE.
pub async fn move_messages(
    session: &mut ImapSession,
    source_folder: &str,
    uid_set: &str,
    dest_folder: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(source_folder))
        .await
        .map_err(|_| format!("SELECT {source_folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {source_folder} failed: {e}"))?;

    // Try MOVE extension first
    match tokio::time::timeout(IMAP_CMD_TIMEOUT, session.uid_mv(uid_set, dest_folder)).await {
        Ok(Ok(())) => return Ok(()),
        _ => {
            // Fallback: COPY, then mark Deleted, then EXPUNGE
            tokio::time::timeout(IMAP_CMD_TIMEOUT, session.uid_copy(uid_set, dest_folder))
                .await
                .map_err(|_| format!("UID COPY timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
                .map_err(|e| format!("UID COPY failed: {e}"))?;

            tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
                let store_stream = session
                    .uid_store(uid_set, "+FLAGS (\\Deleted)")
                    .await
                    .map_err(|e| format!("UID STORE +Deleted failed: {e}"))?;
                let _: Vec<_> = store_stream.collect().await;
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| format!("UID STORE +Deleted timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;

            tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
                let expunge_stream = session
                    .expunge()
                    .await
                    .map_err(|e| format!("EXPUNGE failed: {e}"))?;
                let _: Vec<_> = expunge_stream.collect().await;
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| format!("EXPUNGE timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;
        }
    }

    Ok(())
}

/// Flag messages as deleted and expunge them.
pub async fn delete_messages(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let store_stream = session
            .uid_store(uid_set, "+FLAGS (\\Deleted)")
            .await
            .map_err(|e| format!("UID STORE +Deleted failed: {e}"))?;
        let _: Vec<_> = store_stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| format!("UID STORE +Deleted timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;

    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let expunge_stream = session
            .expunge()
            .await
            .map_err(|e| format!("EXPUNGE failed: {e}"))?;
        let _: Vec<_> = expunge_stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| format!("EXPUNGE timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;

    Ok(())
}

/// Append a raw message to a folder (for saving sent mail or drafts).
pub async fn append_message(
    session: &mut ImapSession,
    folder: &str,
    flags: Option<&str>,
    raw_message: &[u8],
) -> Result<(), String> {
    tokio::time::timeout(IMAP_FETCH_TIMEOUT, session.append(folder, flags, None, raw_message))
        .await
        .map_err(|_| format!("APPEND timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("APPEND failed: {e}"))
}

/// Get folder status (UIDVALIDITY, UIDNEXT, MESSAGES, UNSEEN).
pub async fn get_folder_status(
    session: &mut ImapSession,
    folder: &str,
) -> Result<ImapFolderStatus, String> {
    let mailbox = tokio::time::timeout(
        IMAP_CMD_TIMEOUT,
        session.status(folder, "(UIDVALIDITY UIDNEXT MESSAGES UNSEEN)"),
    )
    .await
    .map_err(|_| format!("STATUS timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
    .map_err(|e| format!("STATUS failed: {e}"))?;

    Ok(ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    })
}

/// Fetch a specific MIME part (attachment) by UID and part ID.
/// Returns the decoded binary data as standard base64.
///
/// Fetches the full message via `BODY.PEEK[]`, parses it with `mail-parser`
/// (which handles all content-transfer-encoding decoding), and extracts
/// the requested part's decoded bytes.
pub async fn fetch_attachment(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
    part_id: &str,
) -> Result<String, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH attachment failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH attachment timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("No response for UID {uid}"))?;

    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    // Parse the full message — mail-parser decodes content-transfer-encoding
    let parser = MessageParser::default();
    let message = parser
        .parse(raw)
        .ok_or_else(|| format!("Failed to parse message UID {uid}"))?;

    // Build section map and find the part index for the requested section path
    let section_map = build_imap_section_map(&message);
    let target_part_idx = section_map
        .iter()
        .find(|(_, section)| section.as_str() == part_id)
        .map(|(&idx, _)| idx)
        .ok_or_else(|| format!("Section {part_id} not found in message UID {uid}"))?;

    let part = message
        .parts
        .get(target_part_idx)
        .ok_or_else(|| format!("Part index {target_part_idx} out of range for UID {uid}"))?;

    // Extract the decoded binary content from the part
    let data = match &part.body {
        mail_parser::PartType::Binary(data) | mail_parser::PartType::InlineBinary(data) => {
            data.as_ref().to_vec()
        }
        mail_parser::PartType::Text(text) => text.as_bytes().to_vec(),
        mail_parser::PartType::Html(html) => html.as_bytes().to_vec(),
        mail_parser::PartType::Message(msg) => {
            // Nested message — encode the raw bytes
            msg.raw_message.as_ref().to_vec()
        }
        mail_parser::PartType::Multipart(_) => {
            return Err(format!("Part {part_id} is a multipart container, not a leaf part"));
        }
    };

    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

/// Fetch the raw RFC822 source of a single message by UID.
/// Returns the full message as a UTF-8 string (lossy conversion for non-UTF-8 bytes).
pub async fn fetch_raw_message(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<String, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH raw message timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Message UID {uid} not found in {folder}"))?;

    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    Ok(String::from_utf8_lossy(raw).to_string())
}

/// Check multiple folders for new UIDs in a single IMAP session.
///
/// For each folder: SELECT, compare UIDVALIDITY, UID SEARCH for new messages.
/// This replaces N separate connections (status + fetch_new_uids per folder)
/// with a single connection that checks all folders.
pub async fn delta_check_folders(
    session: &mut ImapSession,
    folders: &[DeltaCheckRequest],
) -> Result<Vec<DeltaCheckResult>, String> {
    let mut results = Vec::with_capacity(folders.len());

    for req in folders {
        let mailbox = match tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(&req.folder)).await {
            Ok(Ok(m)) => m,
            Ok(Err(e)) => {
                log::warn!("delta_check: SELECT {} failed: {e}", req.folder);
                continue;
            }
            Err(_) => {
                log::warn!("delta_check: SELECT {} timed out after {}s", req.folder, IMAP_CMD_TIMEOUT.as_secs());
                continue;
            }
        };

        let current_uidvalidity = mailbox.uid_validity.unwrap_or(0);
        let uidvalidity_changed = req.uidvalidity != 0 && current_uidvalidity != req.uidvalidity;

        if uidvalidity_changed {
            results.push(DeltaCheckResult {
                folder: req.folder.clone(),
                uidvalidity: current_uidvalidity,
                new_uids: vec![],
                uidvalidity_changed: true,
            });
            continue;
        }

        // UID SEARCH for messages newer than last_uid
        let query = format!("{}:*", req.last_uid + 1);
        let new_uids = match tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&query)).await {
            Ok(Ok(uids)) => {
                let mut result: Vec<u32> = uids.into_iter().filter(|&u| u > req.last_uid).collect();
                result.sort();
                result
            }
            Ok(Err(e)) => {
                log::warn!("delta_check: UID SEARCH {} failed: {e}", req.folder);
                vec![]
            }
            Err(_) => {
                log::warn!("delta_check: UID SEARCH {} timed out after {}s", req.folder, IMAP_SEARCH_TIMEOUT.as_secs());
                vec![]
            }
        };

        results.push(DeltaCheckResult {
            folder: req.folder.clone(),
            uidvalidity: current_uidvalidity,
            new_uids,
            uidvalidity_changed: false,
        });
    }

    Ok(results)
}

/// Search a folder: SELECT → UID SEARCH, returning UIDs and folder status without fetching bodies.
///
/// This is a lightweight alternative to `sync_folder` for callers that want to
/// fetch messages in smaller IPC-friendly chunks on the TypeScript side.
pub async fn search_folder(
    session: &mut ImapSession,
    folder: &str,
    since_date: Option<String>,
) -> Result<ImapFolderSearchResult, String> {
    // SELECT the folder
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    // UID SEARCH with optional SINCE date filter (RFC 3501 §6.4.4)
    let search_query = match &since_date {
        Some(date) => format!("SINCE {date}"),
        None => "ALL".to_string(),
    };
    let uids_raw = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&search_query))
        .await
        .map_err(|_| format!("UID SEARCH {search_query} {folder} timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH {search_query} {folder} failed: {e}"))?;

    let mut uids: Vec<u32> = uids_raw.into_iter().collect();
    uids.sort();

    log::info!(
        "IMAP search_folder {folder}: {} UIDs found (search={search_query}), uidvalidity={}",
        uids.len(),
        folder_status.uidvalidity,
    );

    Ok(ImapFolderSearchResult {
        uids,
        folder_status,
    })
}

/// Search multiple folders in one IMAP session.
pub async fn search_folders_batch(
    session: &mut ImapSession,
    requests: &[SearchFolderRequest],
) -> Result<Vec<ImapFolderSearchBatchResult>, String> {
    let mut results = Vec::with_capacity(requests.len());
    for req in requests {
        match search_folder(session, &req.folder, req.since_date.clone()).await {
            Ok(r) => results.push(ImapFolderSearchBatchResult {
                folder: req.folder.clone(),
                uids: r.uids,
                folder_status: r.folder_status,
            }),
            Err(e) => {
                log::warn!("search_folders_batch: {} failed: {e}", req.folder);
            }
        }
    }
    Ok(results)
}

/// Fetch UID batches for one folder on an existing session.
pub async fn fetch_messages_batched_on_session(
    session: &mut ImapSession,
    folder: &str,
    uid_batches: &[Vec<u32>],
    headers_only: bool,
) -> Result<ImapFetchResult, String> {
    let mut all_messages = Vec::new();
    let mut folder_status = ImapFolderStatus {
        uidvalidity: 0,
        uidnext: 0,
        exists: 0,
        unseen: 0,
        highest_modseq: None,
    };

    for batch in uid_batches {
        if batch.is_empty() {
            continue;
        }
        let uid_set: String = batch
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let result = if headers_only {
            fetch_message_headers(session, folder, &uid_set).await?
        } else {
            fetch_messages(session, folder, &uid_set).await?
        };
        folder_status = result.folder_status;
        all_messages.extend(result.messages);
    }

    Ok(ImapFetchResult {
        messages: all_messages,
        folder_status,
    })
}

/// Fetch all UID batches for one folder using a single connection.
pub async fn fetch_messages_batched(
    config: &ImapConfig,
    folder: &str,
    uid_batches: &[Vec<u32>],
    headers_only: bool,
) -> Result<ImapFetchResult, String> {
    if uid_batches.is_empty() || uid_batches.iter().all(|b| b.is_empty()) {
        return Err("No UIDs provided".to_string());
    }

    if prefer_raw_imap_fetch(&config.host) {
        return raw_fetch_messages_batched(config, folder, uid_batches, headers_only).await;
    }

    let mut session = connect(config).await?;
    let result = fetch_messages_batched_on_session(&mut session, folder, uid_batches, headers_only).await;
    let _ = session.logout().await;
    result
}

/// Run delta sync network operations in minimal connections.
pub async fn run_delta_sync(
    config: &ImapConfig,
    request: &ImapDeltaSyncRequest,
) -> Result<ImapDeltaSyncResult, String> {
    let mut search_results = Vec::new();
    let mut delta_results = Vec::new();

    if !request.new_folder_searches.is_empty() || !request.delta_checks.is_empty() {
        let mut session = connect(config).await?;
        if !request.new_folder_searches.is_empty() {
            search_results = search_folders_batch(&mut session, &request.new_folder_searches).await?;
        }
        if !request.delta_checks.is_empty() {
            delta_results = delta_check_folders(&mut session, &request.delta_checks).await?;
        }
        // UIDVALIDITY changed — re-search affected folders in the same session
        for dr in &delta_results {
            if dr.uidvalidity_changed {
                if let Some(since) = &request.resync_since_date {
                    match search_folder(&mut session, &dr.folder, Some(since.clone())).await {
                        Ok(r) => search_results.push(ImapFolderSearchBatchResult {
                            folder: dr.folder.clone(),
                            uids: r.uids,
                            folder_status: r.folder_status,
                        }),
                        Err(e) => {
                            log::warn!("run_delta_sync: resync search {} failed: {e}", dr.folder);
                        }
                    }
                }
            }
        }
        let _ = session.logout().await;
    }

    let mut fetches = request.fetches.clone();
    if fetches.is_empty() {
        let full_body = !request.headers_only;
        for sr in &search_results {
            if !sr.uids.is_empty() {
                fetches.push(FolderUidFetch {
                    folder: sr.folder.clone(),
                    uids: sr.uids.clone(),
                    full_body,
                });
            }
        }
        for dr in &delta_results {
            if !dr.uidvalidity_changed && !dr.new_uids.is_empty() {
                fetches.push(FolderUidFetch {
                    folder: dr.folder.clone(),
                    uids: dr.new_uids.clone(),
                    full_body,
                });
            }
        }
    }

    let mut fetch_results = Vec::new();
    for fetch in &fetches {
        if fetch.uids.is_empty() {
            continue;
        }
        let headers_only = request.headers_only && !fetch.full_body;
        let batches: Vec<Vec<u32>> = fetch
            .uids
            .chunks(50)
            .map(|chunk| chunk.to_vec())
            .collect();
        match fetch_messages_batched(config, &fetch.folder, &batches, headers_only).await {
            Ok(r) => fetch_results.push(ImapFolderFetchBatchResult {
                folder: fetch.folder.clone(),
                messages: r.messages,
                folder_status: r.folder_status,
            }),
            Err(e) => {
                log::warn!("run_delta_sync: fetch {} failed: {e}", fetch.folder);
            }
        }
    }

    Ok(ImapDeltaSyncResult {
        search_results,
        delta_results,
        fetch_results,
    })
}

/// Sync a folder in a single IMAP session: SELECT → UID SEARCH → batched UID FETCH.
///
/// When `since_date` is provided (format `DD-Mon-YYYY`), uses `UID SEARCH SINCE <date>`
/// to only fetch messages from that date onward, avoiding timeouts on large folders.
///
/// This avoids creating multiple TCP connections per folder (one for search,
/// one per batch for fetch) which causes connection storms on servers with
/// many folders.
pub async fn sync_folder(
    session: &mut ImapSession,
    folder: &str,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncResult, String> {
    // SELECT the folder
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    // UID SEARCH with optional SINCE date filter (RFC 3501 §6.4.4)
    let search_query = match &since_date {
        Some(date) => format!("SINCE {date}"),
        None => "ALL".to_string(),
    };
    let uids_raw = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&search_query))
        .await
        .map_err(|_| format!("UID SEARCH {search_query} {folder} timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH {search_query} {folder} failed: {e}"))?;

    let mut uids: Vec<u32> = uids_raw.into_iter().collect();
    uids.sort();

    log::info!(
        "IMAP sync_folder {folder}: {} UIDs found (search={search_query}), uidvalidity={}, batch_size={}",
        uids.len(),
        folder_status.uidvalidity,
        batch_size,
    );

    if uids.is_empty() {
        return Ok(ImapFolderSyncResult {
            uids,
            messages: vec![],
            folder_status,
        });
    }

    // Fetch in batches on the SAME session
    let parser = MessageParser::default();
    let mut all_messages = Vec::new();
    let bs = batch_size as usize;

    for chunk in uids.chunks(bs) {
        let uid_set: String = chunk
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
            let stream = session
                .uid_fetch(&uid_set, "UID FLAGS INTERNALDATE BODY.PEEK[]")
                .await
                .map_err(|e| format!("UID FETCH {folder} uids={uid_set} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        })
        .await
        .map_err(|_| format!("UID FETCH {folder} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?;

        let raw_fetches: Vec<_> = fetches?;
        for r in raw_fetches {
            match r {
                Ok(f) => {
                    let uid = match f.uid {
                        Some(u) => u,
                        None => { log::warn!("IMAP sync_folder {folder}: response missing UID"); continue; }
                    };
                    let raw = match f.body() {
                        Some(b) => b,
                        None => { log::warn!("IMAP sync_folder {folder}: UID {uid} has no body"); continue; }
                    };
                    let raw_size = raw.len() as u32;
                    let flags: Vec<_> = f.flags().collect();
                    let is_read = flags.iter().any(|fl| matches!(fl, Flag::Seen));
                    let is_starred = flags.iter().any(|fl| matches!(fl, Flag::Flagged));
                    let is_draft = flags.iter().any(|fl| matches!(fl, Flag::Draft));
                    let internal_date = f.internal_date().map(|dt| dt.timestamp());

                    match parse_message(&parser, raw, uid, folder, raw_size, is_read, is_starred, is_draft, internal_date) {
                        Ok(msg) => all_messages.push(msg),
                        Err(e) => log::warn!("sync_folder: failed to parse UID {uid}: {e}"),
                    }
                }
                Err(e) => log::warn!("IMAP sync_folder fetch stream error in {folder}: {e}"),
            }
        }
    }

    log::info!("IMAP sync_folder {folder}: fetched {} messages", all_messages.len());

    Ok(ImapFolderSyncResult {
        uids,
        messages: all_messages,
        folder_status,
    })
}

/// Fetch UIDs in batches on an existing session, invoking `on_batch` after each batch.
async fn fetch_uid_batches<F>(
    session: &mut ImapSession,
    folder: &str,
    uids: &[u32],
    batch_size: u32,
    mut on_batch: F,
) -> Result<u32, String>
where
    F: FnMut(Vec<ImapMessage>, u32, bool) -> Result<(), String>,
{
    if uids.is_empty() {
        return Ok(0);
    }

    let parser = MessageParser::default();
    let bs = batch_size as usize;
    let total_batches = uids.len().div_ceil(bs);
    let mut messages_fetched = 0u32;

    for (batch_index, chunk) in uids.chunks(bs).enumerate() {
        let uid_set: String = chunk
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
            let stream = session
                .uid_fetch(&uid_set, "UID FLAGS INTERNALDATE BODY.PEEK[]")
                .await
                .map_err(|e| format!("UID FETCH {folder} uids={uid_set} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        })
        .await
        .map_err(|_| {
            format!(
                "UID FETCH {folder} timed out after {}s — check your server settings or network connection",
                IMAP_FETCH_TIMEOUT.as_secs()
            )
        })?;

        let raw_fetches: Vec<_> = fetches?;
        let mut batch_messages = Vec::new();

        for r in raw_fetches {
            match r {
                Ok(f) => {
                    let uid = match f.uid {
                        Some(u) => u,
                        None => {
                            log::warn!("IMAP fetch {folder}: response missing UID");
                            continue;
                        }
                    };
                    let raw = match f.body() {
                        Some(b) => b,
                        None => {
                            log::warn!("IMAP fetch {folder}: UID {uid} has no body");
                            continue;
                        }
                    };
                    let raw_size = raw.len() as u32;
                    let flags: Vec<_> = f.flags().collect();
                    let is_read = flags.iter().any(|fl| matches!(fl, Flag::Seen));
                    let is_starred = flags.iter().any(|fl| matches!(fl, Flag::Flagged));
                    let is_draft = flags.iter().any(|fl| matches!(fl, Flag::Draft));
                    let internal_date = f.internal_date().map(|dt| dt.timestamp());

                    match parse_message(
                        &parser,
                        raw,
                        uid,
                        folder,
                        raw_size,
                        is_read,
                        is_starred,
                        is_draft,
                        internal_date,
                    ) {
                        Ok(msg) => batch_messages.push(msg),
                        Err(e) => log::warn!("fetch_uid_batches: failed to parse UID {uid}: {e}"),
                    }
                }
                Err(e) => log::warn!("IMAP fetch stream error in {folder}: {e}"),
            }
        }

        messages_fetched += batch_messages.len() as u32;
        let is_last = batch_index + 1 >= total_batches;
        on_batch(batch_messages, batch_index as u32, is_last)?;
    }

    Ok(messages_fetched)
}

/// SELECT → UID SEARCH → batched UID FETCH with a callback per batch (single connection).
pub async fn sync_folder_with_batches<F>(
    session: &mut ImapSession,
    folder: &str,
    batch_size: u32,
    since_date: Option<String>,
    mut on_batch: F,
) -> Result<ImapFolderSyncSummary, String>
where
    F: FnMut(Vec<ImapMessage>, u32, u32, u32, bool, &ImapFolderStatus) -> Result<(), String>,
{
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| {
            format!(
                "SELECT {folder} timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    let search_query = match &since_date {
        Some(date) => format!("SINCE {date}"),
        None => "ALL".to_string(),
    };
    let uids_raw = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&search_query))
        .await
        .map_err(|_| {
            format!(
                "UID SEARCH {search_query} {folder} timed out after {}s — check your server settings or network connection",
                IMAP_SEARCH_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("UID SEARCH {search_query} {folder} failed: {e}"))?;

    let mut uids: Vec<u32> = uids_raw.into_iter().collect();
    uids.sort();

    log::info!(
        "IMAP sync_folder_with_batches {folder}: {} UIDs found (search={search_query}), uidvalidity={}, batch_size={}",
        uids.len(),
        folder_status.uidvalidity,
        batch_size,
    );

    let total_uids = uids.len() as u32;
    if uids.is_empty() {
        return Ok(ImapFolderSyncSummary {
            uids,
            folder_status,
            messages_fetched: 0,
        });
    }

    let mut cumulative_fetched = 0u32;
    let messages_fetched = fetch_uid_batches(session, folder, &uids, batch_size, |batch, batch_index, is_last| {
        cumulative_fetched += batch.len() as u32;
        on_batch(
            batch,
            batch_index,
            cumulative_fetched,
            total_uids,
            is_last,
            &folder_status,
        )
    })
    .await?;

    log::info!(
        "IMAP sync_folder_with_batches {folder}: fetched {} messages",
        messages_fetched,
    );

    Ok(ImapFolderSyncSummary {
        uids,
        folder_status,
        messages_fetched,
    })
}

/// Parse UIDs from a raw IMAP SEARCH response (`* SEARCH 1 2 3`).
fn parse_raw_search_uids(response: &str) -> Vec<u32> {
    let mut uids = Vec::new();
    for line in response.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("* SEARCH") {
            for part in trimmed[8..].split_whitespace() {
                if let Ok(uid) = part.parse::<u32>() {
                    uids.push(uid);
                }
            }
        }
    }
    uids.sort();
    uids
}

/// Raw TCP sync for servers where async-imap returns empty responses (e.g. Yandex Team).
pub async fn raw_sync_folder_with_batches<F>(
    config: &ImapConfig,
    folder: &str,
    batch_size: u32,
    since_date: Option<String>,
    mut on_batch: F,
) -> Result<ImapFolderSyncSummary, String>
where
    F: FnMut(Vec<ImapMessage>, u32, u32, u32, bool, &ImapFolderStatus) -> Result<(), String>,
{
    log::info!(
        "RAW IMAP sync_folder: connecting to {}:{} for folder {folder}, since_date={:?}",
        config.host,
        config.port,
        since_date,
    );

    let stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut reader = BufReader::new(stream);
    let mut tag_num = 1u32;

    if config.security != "starttls" {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("greeting: {e}"))?;
    }

    let login_cmd = if config.auth_method == "oauth2" {
        let xoauth2 = format!(
            "user={}\x01auth=Bearer {}\x01\x01",
            config.username, config.password
        );
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            xoauth2.as_bytes(),
        );
        format!("a{tag_num} AUTHENTICATE XOAUTH2 {b64}\r\n")
    } else {
        format!(
            "a{tag_num} LOGIN \"{}\" \"{}\"\r\n",
            config.username, config.password
        )
    };
    let tag = format!("a{tag_num}");
    raw_send_and_wait(&mut reader, login_cmd.as_bytes(), &tag).await?;
    tag_num += 1;

    let select_cmd = format!("a{tag_num} SELECT \"{folder}\"\r\n");
    let tag = format!("a{tag_num}");
    let select_response = raw_send_and_wait(&mut reader, select_cmd.as_bytes(), &tag).await?;
    tag_num += 1;

    let mut exists = 0u32;
    let mut uidvalidity = 0u32;
    let mut unseen = 0u32;
    for line in select_response.lines() {
        if let Some(n) = parse_untagged_number(line, "EXISTS") {
            exists = n;
        }
        if line.contains("[UIDVALIDITY") {
            if let Some(v) = extract_bracket_number(line, "UIDVALIDITY") {
                uidvalidity = v;
            }
        }
        if line.contains("[UNSEEN") {
            if let Some(v) = extract_bracket_number(line, "UNSEEN") {
                unseen = v;
            }
        }
    }

    let folder_status = ImapFolderStatus {
        uidvalidity,
        uidnext: 0,
        exists,
        unseen,
        highest_modseq: None,
    };

    let search_query = match &since_date {
        Some(date) => format!("UID SEARCH SINCE {date}"),
        None => "UID SEARCH ALL".to_string(),
    };
    let search_cmd = format!("a{tag_num} {search_query}\r\n");
    let tag = format!("a{tag_num}");
    let search_response = raw_send_and_wait(&mut reader, search_cmd.as_bytes(), &tag).await?;
    tag_num += 1;

    let uids = parse_raw_search_uids(&search_response);
    let total_uids = uids.len() as u32;

    log::info!(
        "RAW IMAP sync_folder {folder}: {} UIDs found (search={search_query}), uidvalidity={uidvalidity}, batch_size={batch_size}",
        uids.len(),
    );

    if uids.is_empty() {
        let _ = reader.get_mut().write_all(format!("a{tag_num} LOGOUT\r\n").as_bytes()).await;
        return Ok(ImapFolderSyncSummary {
            uids,
            folder_status,
            messages_fetched: 0,
        });
    }

    let parser = MessageParser::default();
    let bs = batch_size as usize;
    let total_batches = uids.len().div_ceil(bs);
    let mut messages_fetched = 0u32;
    let mut cumulative_fetched = 0u32;

    for (batch_index, chunk) in uids.chunks(bs).enumerate() {
        let uid_set: String = chunk
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let fetch_cmd = format!(
            "a{tag_num} UID FETCH {uid_set} (UID FLAGS INTERNALDATE BODY.PEEK[])\r\n"
        );
        let tag = format!("a{tag_num}");
        reader
            .get_mut()
            .write_all(fetch_cmd.as_bytes())
            .await
            .map_err(|e| format!("FETCH write: {e}"))?;

        let raw_messages = raw_parse_fetch_responses(&mut reader, &tag).await?;
        tag_num += 1;

        let mut batch_messages = Vec::new();
        for raw_msg in &raw_messages {
            match parse_message(
                &parser,
                &raw_msg.body,
                raw_msg.uid,
                folder,
                raw_msg.body.len() as u32,
                raw_msg.is_read,
                raw_msg.is_starred,
                raw_msg.is_draft,
                raw_msg.internal_date,
            ) {
                Ok(msg) => batch_messages.push(msg),
                Err(e) => log::warn!("RAW sync_folder: failed to parse UID {}: {e}", raw_msg.uid),
            }
        }

        messages_fetched += batch_messages.len() as u32;
        cumulative_fetched += batch_messages.len() as u32;
        let is_last = batch_index + 1 >= total_batches;
        on_batch(
            batch_messages,
            batch_index as u32,
            cumulative_fetched,
            total_uids,
            is_last,
            &folder_status,
        )?;
    }

    let _ = reader
        .get_mut()
        .write_all(format!("a{tag_num} LOGOUT\r\n").as_bytes())
        .await;

    log::info!(
        "RAW IMAP sync_folder {folder}: fetched {messages_fetched} messages",
    );

    Ok(ImapFolderSyncSummary {
        uids,
        folder_status,
        messages_fetched,
    })
}

/// Test IMAP connectivity: connect, login, list, logout.
pub async fn test_connection(config: &ImapConfig) -> Result<String, String> {
    log::info!("IMAP test_connection: begin");
    log_imap_config("test_connection", config);

    let mut session = connect(config).await.map_err(|e| {
        log::error!("IMAP test_connection: connect failed — {e}");
        e
    })?;
    log::info!("IMAP test_connection: connected and authenticated, listing folders");

    // Try listing folders to verify access
    let count = tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let names = session
            .list(Some(""), Some("*"))
            .await
            .map_err(|e| format!("LIST failed: {e}"))?;
        Ok::<_, String>(names.collect::<Vec<_>>().await.len())
    })
    .await
    .map_err(|_| {
        let msg = format!("LIST timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs());
        log::error!("IMAP test_connection: {msg}");
        msg
    })?
    .map_err(|e| {
        log::error!("IMAP test_connection: LIST error — {e}");
        e
    })?;

    log::info!("IMAP test_connection: LIST ok, folder_count={count}");
    let _ = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.logout()).await;
    log::info!("IMAP test_connection: success");

    Ok(format!(
        "Connected successfully. Found {} folder(s).",
        count
    ))
}

/// Raw IMAP fetch: connect via raw TCP/TLS (bypassing async-imap),
/// authenticate, SELECT folder, UID FETCH with full body, parse responses.
///
/// This is a fallback for servers where async-imap fails to parse responses
/// (e.g. Mailo with non-standard flags like `Sent` without backslash).
pub async fn raw_fetch_messages(
    config: &ImapConfig,
    folder: &str,
    uid_range: &str,
) -> Result<ImapFetchResult, String> {
    log::info!("RAW IMAP FETCH: connecting to {}:{} for folder {folder}, UIDs {uid_range}", config.host, config.port);

    // Connect
    let stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut reader = BufReader::new(stream);

    // Read greeting (for non-STARTTLS)
    if config.security != "starttls" {
        let mut line = String::new();
        reader.read_line(&mut line).await.map_err(|e| format!("greeting: {e}"))?;
    }

    // LOGIN
    let login_cmd = if config.auth_method == "oauth2" {
        // XOAUTH2: AUTHENTICATE XOAUTH2 <base64>
        let xoauth2 = format!("user={}\x01auth=Bearer {}\x01\x01", config.username, config.password);
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, xoauth2.as_bytes());
        format!("a1 AUTHENTICATE XOAUTH2 {b64}\r\n")
    } else {
        format!("a1 LOGIN \"{}\" \"{}\"\r\n", config.username, config.password)
    };
    raw_send_and_wait(&mut reader, login_cmd.as_bytes(), "a1").await?;

    // SELECT
    let select_cmd = format!("a2 SELECT \"{folder}\"\r\n");
    let select_response = raw_send_and_wait(&mut reader, select_cmd.as_bytes(), "a2").await?;

    // Parse SELECT response for UIDVALIDITY, EXISTS, UNSEEN
    let mut exists = 0u32;
    let mut uidvalidity = 0u32;
    let mut unseen = 0u32;
    for line in select_response.lines() {
        if let Some(n) = parse_untagged_number(line, "EXISTS") {
            exists = n;
        }
        if line.contains("[UIDVALIDITY") {
            if let Some(v) = extract_bracket_number(line, "UIDVALIDITY") {
                uidvalidity = v;
            }
        }
        if line.contains("[UNSEEN") {
            if let Some(v) = extract_bracket_number(line, "UNSEEN") {
                unseen = v;
            }
        }
    }

    let folder_status = ImapFolderStatus {
        uidvalidity,
        uidnext: 0,
        exists,
        unseen,
        highest_modseq: None,
    };

    // UID FETCH with full body
    let fetch_cmd = format!("a3 UID FETCH {uid_range} (UID FLAGS INTERNALDATE BODY.PEEK[])\r\n");
    reader.get_mut().write_all(fetch_cmd.as_bytes()).await
        .map_err(|e| format!("FETCH write: {e}"))?;

    // Parse FETCH responses with literal handling
    let raw_messages = raw_parse_fetch_responses(&mut reader, "a3").await?;

    log::info!("RAW IMAP FETCH {folder}: parsed {} raw messages", raw_messages.len());

    // Parse each raw message
    let parser = MessageParser::default();
    let mut messages = Vec::new();

    for raw_msg in &raw_messages {
        match parse_message(
            &parser,
            &raw_msg.body,
            raw_msg.uid,
            folder,
            raw_msg.body.len() as u32,
            raw_msg.is_read,
            raw_msg.is_starred,
            raw_msg.is_draft,
            raw_msg.internal_date,
        ) {
            Ok(msg) => messages.push(msg),
            Err(e) => log::warn!("RAW FETCH: failed to parse UID {}: {e}", raw_msg.uid),
        }
    }

    // LOGOUT
    let _ = reader.get_mut().write_all(b"a4 LOGOUT\r\n").await;

    Ok(ImapFetchResult { messages, folder_status })
}

/// Raw IMAP fetch: one connection, multiple UID batches (full body or headers only).
pub async fn raw_fetch_messages_batched(
    config: &ImapConfig,
    folder: &str,
    uid_batches: &[Vec<u32>],
    headers_only: bool,
) -> Result<ImapFetchResult, String> {
    log::info!(
        "RAW IMAP FETCH batched: {}:{} folder={folder}, {} batches, headers_only={headers_only}",
        config.host,
        config.port,
        uid_batches.len(),
    );

    let stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut reader = BufReader::new(stream);

    if config.security != "starttls" {
        let mut line = String::new();
        reader.read_line(&mut line).await.map_err(|e| format!("greeting: {e}"))?;
    }

    let login_cmd = if config.auth_method == "oauth2" {
        let xoauth2 = format!("user={}\x01auth=Bearer {}\x01\x01", config.username, config.password);
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, xoauth2.as_bytes());
        format!("a1 AUTHENTICATE XOAUTH2 {b64}\r\n")
    } else {
        format!("a1 LOGIN \"{}\" \"{}\"\r\n", config.username, config.password)
    };
    raw_send_and_wait(&mut reader, login_cmd.as_bytes(), "a1").await?;

    let select_cmd = format!("a2 SELECT \"{folder}\"\r\n");
    let select_response = raw_send_and_wait(&mut reader, select_cmd.as_bytes(), "a2").await?;

    let mut exists = 0u32;
    let mut uidvalidity = 0u32;
    let mut unseen = 0u32;
    for line in select_response.lines() {
        if let Some(n) = parse_untagged_number(line, "EXISTS") {
            exists = n;
        }
        if line.contains("[UIDVALIDITY") {
            if let Some(v) = extract_bracket_number(line, "UIDVALIDITY") {
                uidvalidity = v;
            }
        }
        if line.contains("[UNSEEN") {
            if let Some(v) = extract_bracket_number(line, "UNSEEN") {
                unseen = v;
            }
        }
    }

    let folder_status = ImapFolderStatus {
        uidvalidity,
        uidnext: 0,
        exists,
        unseen,
        highest_modseq: None,
    };

    let fetch_item = if headers_only {
        "UID FLAGS INTERNALDATE BODY.PEEK[HEADER]"
    } else {
        "UID FLAGS INTERNALDATE BODY.PEEK[]"
    };

    let parser = MessageParser::default();
    let mut messages = Vec::new();
    let mut tag_num = 3u32;

    for batch in uid_batches {
        if batch.is_empty() {
            continue;
        }
        let uid_range: String = batch
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let tag = format!("a{tag_num}");
        tag_num += 1;
        let fetch_cmd = format!("{tag} UID FETCH {uid_range} ({fetch_item})\r\n");
        reader.get_mut().write_all(fetch_cmd.as_bytes()).await
            .map_err(|e| format!("FETCH write: {e}"))?;

        let raw_messages = raw_parse_fetch_responses(&mut reader, &tag).await?;
        for raw_msg in &raw_messages {
            match parse_message(
                &parser,
                &raw_msg.body,
                raw_msg.uid,
                folder,
                raw_msg.body.len() as u32,
                raw_msg.is_read,
                raw_msg.is_starred,
                raw_msg.is_draft,
                raw_msg.internal_date,
            ) {
                Ok(msg) => messages.push(msg),
                Err(e) => log::warn!("RAW FETCH batched: failed to parse UID {}: {e}", raw_msg.uid),
            }
        }
    }

    let logout_tag = format!("a{tag_num}");
    let _ = reader.get_mut().write_all(format!("{logout_tag} LOGOUT\r\n").as_bytes()).await;

    Ok(ImapFetchResult { messages, folder_status })
}

/// Raw IMAP diagnostic: connect via raw TCP/TLS (bypassing async-imap),
/// authenticate, SELECT folder, FETCH, and return raw server response.
/// This helps diagnose servers that async-imap can't parse.
pub async fn raw_fetch_diagnostic(
    config: &ImapConfig,
    folder: &str,
    uid_range: &str,
) -> Result<String, String> {
    // Connect and wrap in our ImapStream
    let mut stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut buf = vec![0u8; 16384];
    let mut output = String::new();

    // Read greeting (for non-STARTTLS)
    if config.security != "starttls" {
        let n = stream.read(&mut buf).await.map_err(|e| format!("greeting: {e}"))?;
        output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));
    }

    // LOGIN
    let login_cmd = format!("a1 LOGIN \"{}\" \"{}\"\r\n", config.username, config.password);
    stream.write_all(login_cmd.as_bytes()).await.map_err(|e| format!("LOGIN: {e}"))?;
    let n = stream.read(&mut buf).await.map_err(|e| format!("LOGIN read: {e}"))?;
    output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));

    // SELECT
    let select_cmd = format!("a2 SELECT \"{folder}\"\r\n");
    stream.write_all(select_cmd.as_bytes()).await.map_err(|e| format!("SELECT: {e}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let n = stream.read(&mut buf).await.map_err(|e| format!("SELECT read: {e}"))?;
    output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));

    // UID FETCH — just get UID and FLAGS first (small response)
    let fetch_cmd = format!("a3 UID FETCH {uid_range} (UID FLAGS)\r\n");
    stream.write_all(fetch_cmd.as_bytes()).await.map_err(|e| format!("FETCH: {e}"))?;

    let mut fetch_response = String::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        match tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                fetch_response.push_str(&String::from_utf8_lossy(&buf[..n]));
                if fetch_response.contains("a3 OK") || fetch_response.contains("a3 NO") || fetch_response.contains("a3 BAD") {
                    break;
                }
            }
            Ok(Err(e)) => { fetch_response.push_str(&format!("[read error: {e}]")); break; }
            Err(_) => { fetch_response.push_str("[timeout]"); break; }
        }
    }
    output.push_str(&format!("FETCH response:\n{fetch_response}"));

    let _ = stream.write_all(b"a4 LOGOUT\r\n").await;

    log::info!("RAW IMAP DIAGNOSTIC for {folder}:\n{output}");

    Ok(output)
}

// ---------- Raw TCP helpers ----------

/// Intermediate struct for a raw-parsed IMAP message before mail-parser processing.
struct RawFetchedMessage {
    uid: u32,
    is_read: bool,
    is_starred: bool,
    is_draft: bool,
    internal_date: Option<i64>,
    body: Vec<u8>,
}

/// Connect via STARTTLS for raw TCP operations.
async fn raw_connect_starttls(config: &ImapConfig) -> Result<ImapStream, String> {
    let addr = (&*config.host, config.port);
    let mut tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!(
            "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TCP: {e}"))?;
    configure_tcp_socket(&tcp);
    let mut tmp = vec![0u8; 4096];
    let _ = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut tmp)).await; // consume greeting
    tcp.write_all(b"a0 STARTTLS\r\n").await.map_err(|e| format!("STARTTLS: {e}"))?;
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut tmp))
        .await
        .map_err(|_| format!(
            "STARTTLS response timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("STARTTLS resp: {e}"))?;
    let resp = String::from_utf8_lossy(&tmp[..n]);
    if !resp.contains("OK") {
        return Err(format!("STARTTLS rejected: {resp}"));
    }
    let nc = build_tls_connector(config.accept_invalid_certs)?;
    let tc = tokio_native_tls::TlsConnector::from(nc);
    let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tc.connect(&config.host, tcp))
        .await
        .map_err(|_| format!(
            "TLS handshake timed out after {}s — check your server settings or network connection",
            TLS_HANDSHAKE_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TLS: {e}"))?;
    Ok(ImapStream::Tls(tls))
}

/// Send a command and read all response lines until the tagged response (e.g. "a1 OK ...").
async fn raw_send_and_wait(
    reader: &mut tokio::io::BufReader<ImapStream>,
    cmd: &[u8],
    tag: &str,
) -> Result<String, String> {
    reader.get_mut().write_all(cmd).await
        .map_err(|e| format!("{tag} write: {e}"))?;

    let mut response = String::new();
    let tag_ok = format!("{tag} OK");
    let tag_no = format!("{tag} NO");
    let tag_bad = format!("{tag} BAD");

    loop {
        let mut line = String::new();
        match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            reader.read_line(&mut line),
        ).await {
            Ok(Ok(0)) => return Err(format!("{tag}: connection closed")),
            Ok(Ok(_)) => {
                response.push_str(&line);
                if line.starts_with(&tag_ok) {
                    return Ok(response);
                }
                if line.starts_with(&tag_no) || line.starts_with(&tag_bad) {
                    return Err(format!("{tag} failed: {line}"));
                }
            }
            Ok(Err(e)) => return Err(format!("{tag} read: {e}")),
            Err(_) => return Err(format!("{tag}: timeout")),
        }
    }
}

/// Parse untagged responses like "* 3 EXISTS" → 3
fn parse_untagged_number(line: &str, keyword: &str) -> Option<u32> {
    // Format: "* <number> <KEYWORD>"
    let trimmed = line.trim();
    if !trimmed.starts_with("* ") || !trimmed.ends_with(keyword) {
        return None;
    }
    let middle = trimmed[2..trimmed.len() - keyword.len()].trim();
    middle.parse().ok()
}

/// Extract a number from bracket notation like "[UIDVALIDITY 12345]"
fn extract_bracket_number(line: &str, keyword: &str) -> Option<u32> {
    let pattern = format!("[{keyword} ");
    if let Some(start) = line.find(&pattern) {
        let after = &line[start + pattern.len()..];
        if let Some(end) = after.find(']') {
            return after[..end].trim().parse().ok();
        }
    }
    None
}

/// Parse IMAP FETCH responses with literal support ({size}\r\n...data...).
///
/// IMAP FETCH response format:
/// ```text
/// * 1 FETCH (UID 1 FLAGS (\Seen) INTERNALDATE "16-Feb-2026 12:00:00 +0000" BODY[] {1234}
/// <1234 bytes of raw email data>
/// )
/// a3 OK UID FETCH done
/// ```
async fn raw_parse_fetch_responses(
    reader: &mut tokio::io::BufReader<ImapStream>,
    tag: &str,
) -> Result<Vec<RawFetchedMessage>, String> {
    let mut messages: Vec<RawFetchedMessage> = Vec::new();
    let tag_ok = format!("{tag} OK");
    let tag_no = format!("{tag} NO");
    let tag_bad = format!("{tag} BAD");

    loop {
        let mut line = String::new();
        match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            reader.read_line(&mut line),
        ).await {
            Ok(Ok(0)) => return Err("Connection closed during FETCH".to_string()),
            Ok(Ok(_)) => {
                // Check for tagged response (end of FETCH)
                if line.starts_with(&tag_ok) {
                    break;
                }
                if line.starts_with(&tag_no) || line.starts_with(&tag_bad) {
                    return Err(format!("FETCH failed: {line}"));
                }

                // Check for untagged FETCH response: "* <seq> FETCH (...)"
                if !line.starts_with("* ") || !line.contains("FETCH") {
                    continue;
                }

                // Parse UID from the response line
                let uid = extract_fetch_uid(&line).unwrap_or(0);
                if uid == 0 {
                    log::warn!("RAW FETCH: could not parse UID from: {}", line.trim());
                    // Still need to consume any literal
                    if let Some(literal_size) = extract_literal_size(&line) {
                        let mut discard = vec![0u8; literal_size];
                        reader.read_exact(&mut discard).await
                            .map_err(|e| format!("discard literal: {e}"))?;
                    }
                    continue;
                }

                // Parse flags
                let flags_str = extract_flags_from_fetch(&line);
                let is_read = flags_str.contains("\\Seen");
                let is_starred = flags_str.contains("\\Flagged");
                let is_draft = flags_str.contains("\\Draft");

                // Parse INTERNALDATE
                let internal_date = extract_internal_date(&line);

                // Check for literal: {size}
                if let Some(literal_size) = extract_literal_size(&line) {
                    // Read exactly `literal_size` bytes
                    let mut body = vec![0u8; literal_size];
                    reader.read_exact(&mut body).await
                        .map_err(|e| format!("read literal for UID {uid}: {e}"))?;

                    // Read the closing ")\r\n" after the literal
                    let mut closing = String::new();
                    let _ = reader.read_line(&mut closing).await;

                    messages.push(RawFetchedMessage {
                        uid,
                        is_read,
                        is_starred,
                        is_draft,
                        internal_date,
                        body,
                    });
                }
            }
            Ok(Err(e)) => return Err(format!("FETCH read: {e}")),
            Err(_) => return Err("FETCH timeout".to_string()),
        }
    }

    Ok(messages)
}

/// Extract UID from a FETCH response line like "* 1 FETCH (UID 123 FLAGS ...)"
fn extract_fetch_uid(line: &str) -> Option<u32> {
    // Look for "UID " followed by a number
    let uid_idx = line.find("UID ")?;
    let after_uid = &line[uid_idx + 4..];
    let end = after_uid.find(|c: char| !c.is_ascii_digit()).unwrap_or(after_uid.len());
    after_uid[..end].parse().ok()
}

/// Extract flags string from FETCH response like "FLAGS (\Seen \Flagged)"
fn extract_flags_from_fetch(line: &str) -> String {
    if let Some(flags_start) = line.find("FLAGS (") {
        let after = &line[flags_start + 7..];
        if let Some(end) = after.find(')') {
            return after[..end].to_string();
        }
    }
    String::new()
}

/// Extract INTERNALDATE from FETCH response.
/// Format: INTERNALDATE "16-Feb-2026 12:00:00 +0000"
/// Returns None if not present — mail-parser will use the Date header instead.
fn extract_internal_date(line: &str) -> Option<i64> {
    let idx = line.find("INTERNALDATE \"")?;
    let after = &line[idx + 14..];
    let end = after.find('"')?;
    let date_str = &after[..end];
    // Parse "DD-Mon-YYYY HH:MM:SS +ZZZZ" manually
    parse_imap_date(date_str)
}

/// Parse IMAP date format "16-Feb-2026 12:00:00 +0000" to Unix timestamp.
fn parse_imap_date(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 { return None; }

    // "16-Feb-2026"
    let date_parts: Vec<&str> = parts[0].split('-').collect();
    if date_parts.len() != 3 { return None; }

    let day: u32 = date_parts[0].parse().ok()?;
    let month = match date_parts[1].to_lowercase().as_str() {
        "jan" => 1u32, "feb" => 2, "mar" => 3, "apr" => 4,
        "may" => 5, "jun" => 6, "jul" => 7, "aug" => 8,
        "sep" => 9, "oct" => 10, "nov" => 11, "dec" => 12,
        _ => return None,
    };
    let year: i64 = date_parts[2].parse().ok()?;

    // "12:00:00"
    let time_parts: Vec<&str> = parts.get(1)?.split(':').collect();
    if time_parts.len() != 3 { return None; }
    let hour: i64 = time_parts[0].parse().ok()?;
    let minute: i64 = time_parts[1].parse().ok()?;
    let second: i64 = time_parts[2].parse().ok()?;

    // Timezone offset "+0000" (optional)
    let tz_offset_secs: i64 = if let Some(tz) = parts.get(2) {
        let sign = if tz.starts_with('-') { -1i64 } else { 1i64 };
        let tz_num = tz.trim_start_matches(['+', '-']);
        if tz_num.len() == 4 {
            let tz_h: i64 = tz_num[..2].parse().unwrap_or(0);
            let tz_m: i64 = tz_num[2..].parse().unwrap_or(0);
            sign * (tz_h * 3600 + tz_m * 60)
        } else { 0 }
    } else { 0 };

    // Convert to Unix timestamp (days since epoch)
    // Simplified: use a basic calendar calculation
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += month_days[m as usize] as i64;
        if m == 2 && is_leap_year(year) { days += 1; }
    }
    days += day as i64 - 1;

    Some(days * 86400 + hour * 3600 + minute * 60 + second - tz_offset_secs)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

/// Extract literal size from a line ending with {1234}\r\n
fn extract_literal_size(line: &str) -> Option<usize> {
    let trimmed = line.trim_end();
    if !trimmed.ends_with('}') {
        return None;
    }
    let brace_start = trimmed.rfind('{')?;
    trimmed[brace_start + 1..trimmed.len() - 1].parse().ok()
}

// ---------- Internal helpers ----------

/// Establish TCP + TLS or plain stream for "tls" and "none" security modes.
async fn connect_stream(config: &ImapConfig) -> Result<ImapStream, String> {
    let addr = (&*config.host, config.port);
    log::info!("IMAP connect_stream: mode={} target={}:{}", config.security, config.host, config.port);

    match config.security.as_str() {
        "tls" => {
            log::info!("IMAP connect_stream: TCP connect (timeout {}s)", TCP_CONNECT_TIMEOUT.as_secs());
            let native_connector = build_tls_connector(config.accept_invalid_certs)?;
            let tls_connector = tokio_native_tls::TlsConnector::from(native_connector);
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
                .await
                .map_err(|_| format!(
                    "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
                    config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
            configure_tcp_socket(&tcp);
            log::info!("IMAP connect_stream: TCP ok, starting TLS handshake (timeout {}s)", TLS_HANDSHAKE_TIMEOUT.as_secs());
            let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tls_connector.connect(&config.host, tcp))
                .await
                .map_err(|_| format!(
                    "TLS handshake with {} timed out after {}s — check your server settings or network connection",
                    config.host, TLS_HANDSHAKE_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TLS handshake with {} failed: {e}", config.host))?;
            log::info!("IMAP connect_stream: TLS handshake ok");
            Ok(ImapStream::Tls(tls))
        }
        "none" => {
            log::info!("IMAP connect_stream: plain TCP (no TLS)");
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
                .await
                .map_err(|_| format!(
                    "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
                    config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
            configure_tcp_socket(&tcp);
            log::info!("IMAP connect_stream: plain TCP ok");
            Ok(ImapStream::Plain(tcp))
        }
        other => {
            log::error!("IMAP connect_stream: unknown security mode '{other}'");
            Err(format!(
            "Unknown security mode: {other}. Use \"tls\", \"starttls\", or \"none\"."
        ))
        },
    }
}

/// Handle STARTTLS connection: connect plain, upgrade to TLS, then authenticate.
///
/// STARTTLS is special because we must issue the STARTTLS command on the plain
/// connection, upgrade the underlying TCP stream to TLS, and then create a new
/// Client on the TLS stream for authentication.
async fn connect_starttls(config: &ImapConfig) -> Result<ImapSession, String> {
    let addr = (&*config.host, config.port);
    log::info!("IMAP connect_starttls: TCP connect to {}:{}", config.host, config.port);
    let mut tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!(
            "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
    configure_tcp_socket(&tcp);

    // Read the server greeting
    log::info!("IMAP connect_starttls: reading server greeting");
    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut buf))
        .await
        .map_err(|_| format!(
            "Reading server greeting timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("Failed to read server greeting: {e}"))?;
    let greeting = String::from_utf8_lossy(&buf[..n]);
    log::info!("IMAP connect_starttls: greeting={greeting:?}");
    if !greeting.contains("OK") {
        log::error!("IMAP connect_starttls: unexpected greeting");
        return Err(format!("Unexpected server greeting: {greeting}"));
    }

    // Send STARTTLS command
    log::info!("IMAP connect_starttls: sending STARTTLS");
    tcp.write_all(b"a001 STARTTLS\r\n")
        .await
        .map_err(|e| format!("Failed to send STARTTLS: {e}"))?;

    // Read STARTTLS response
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut buf))
        .await
        .map_err(|_| format!(
            "STARTTLS response timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("Failed to read STARTTLS response: {e}"))?;
    let response = String::from_utf8_lossy(&buf[..n]);
    log::info!("IMAP connect_starttls: STARTTLS response={response:?}");
    if !response.contains("OK") {
        log::error!("IMAP connect_starttls: STARTTLS rejected");
        return Err(format!("STARTTLS rejected: {response}"));
    }

    // Upgrade to TLS
    log::info!("IMAP connect_starttls: upgrading to TLS");
    let native_connector = build_tls_connector(config.accept_invalid_certs)?;
    let tls_connector = tokio_native_tls::TlsConnector::from(native_connector);
    let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tls_connector.connect(&config.host, tcp))
        .await
        .map_err(|_| format!(
            "TLS upgrade after STARTTLS timed out after {}s — check your server settings or network connection",
            TLS_HANDSHAKE_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TLS upgrade after STARTTLS failed: {e}"))?;
    log::info!("IMAP connect_starttls: TLS upgrade ok, authenticating");

    // Create a new IMAP client on the TLS stream and authenticate
    let client = Client::new(ImapStream::Tls(tls));
    tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))?
}

/// Authenticate with the IMAP server (LOGIN or XOAUTH2).
async fn authenticate(
    client: Client<ImapStream>,
    config: &ImapConfig,
) -> Result<ImapSession, String> {
    log::info!(
        "IMAP authenticate: method={} username={}",
        config.auth_method, config.username
    );
    let result = match config.auth_method.as_str() {
        "oauth2" => {
            log::info!("IMAP authenticate: using XOAUTH2");
            client
                .authenticate("XOAUTH2", XOAuth2::new(&config.username, &config.password))
                .await
                .map_err(|(e, _)| format!("XOAUTH2 authentication failed: {e}"))
        }
        _ => {
            log::info!("IMAP authenticate: using LOGIN");
            client
                .login(&config.username, &config.password)
                .await
                .map_err(|(e, _)| format!("Login failed: {e}"))
        }
    };
    match &result {
        Ok(_) => log::info!("IMAP authenticate: success"),
        Err(e) => log::error!("IMAP authenticate: failed — {e}"),
    }
    result
}

/// Detect special-use attribute from IMAP folder attributes and name heuristics.
fn detect_special_use(name: &async_imap::types::Name) -> Option<String> {
    use async_imap::types::NameAttribute;

    // Check RFC 6154 attributes first
    for attr in name.attributes() {
        let special = match attr {
            NameAttribute::Sent => Some("\\Sent"),
            NameAttribute::Trash => Some("\\Trash"),
            NameAttribute::Drafts => Some("\\Drafts"),
            NameAttribute::Junk => Some("\\Junk"),
            NameAttribute::Archive => Some("\\Archive"),
            NameAttribute::All => Some("\\All"),
            NameAttribute::Flagged => Some("\\Flagged"),
            _ => None,
        };
        if let Some(s) = special {
            return Some(s.to_string());
        }
    }

    // Heuristic fallback based on common folder names
    let lower = name.name().to_lowercase();
    match lower.as_str() {
        "inbox" => Some("\\Inbox".to_string()),
        "sent" | "sent messages" | "sent items" | "[gmail]/sent mail" => {
            Some("\\Sent".to_string())
        }
        "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" | "corbeille"
        | "unsolbox" | "[gmail]/trash" => {
            Some("\\Trash".to_string())
        }
        "drafts" | "draft" | "draftbox" | "brouillons" | "[gmail]/drafts" => Some("\\Drafts".to_string()),
        "junk" | "spam" | "junk e-mail" | "[gmail]/spam" => Some("\\Junk".to_string()),
        "archive" | "archives" | "[gmail]/all mail" => Some("\\Archive".to_string()),
        _ => None,
    }
}

/// Parse a raw email message into our ImapMessage struct.
///
/// `internal_date`: optional INTERNALDATE timestamp from the IMAP server,
/// used as fallback when the Date header cannot be parsed.
fn parse_message(
    parser: &MessageParser,
    raw: &[u8],
    uid: u32,
    folder: &str,
    raw_size: u32,
    is_read: bool,
    is_starred: bool,
    is_draft: bool,
    internal_date: Option<i64>,
) -> Result<ImapMessage, String> {
    let message = parser.parse(raw).ok_or("Failed to parse MIME message")?;

    let message_id = message.message_id().map(|s| s.to_string());
    let subject = message.subject().map(|s| s.to_string());
    let date = message
        .date()
        .map(|d| d.to_timestamp())
        .or(internal_date)
        .unwrap_or(0);

    // In-Reply-To
    let in_reply_to = match message.in_reply_to() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(list) => list.first().map(|s| s.to_string()),
        _ => None,
    };

    // References (space-separated message IDs)
    let references = match message.references() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(list) => {
            if list.is_empty() {
                None
            } else {
                Some(list.iter().map(|s| s.as_ref()).collect::<Vec<_>>().join(" "))
            }
        }
        _ => None,
    };

    // Addresses
    let (from_address, from_name) = extract_first_address(message.from());
    let to_addresses = format_address_list(message.to());
    let cc_addresses = format_address_list(message.cc());
    let bcc_addresses = format_address_list(message.bcc());
    let reply_to = format_address_list(message.reply_to());

    // Body
    let body_text = message.body_text(0).map(|s| s.to_string());
    let body_html = message.body_html(0).map(|s| s.to_string());

    // Generate snippet from text body (truncate at char boundary)
    let snippet = body_text.as_ref().map(|text| {
        let cleaned: String = text
            .chars()
            .map(|c| if c.is_whitespace() { ' ' } else { c })
            .collect();
        let trimmed = cleaned.trim();
        if trimmed.chars().count() > 200 {
            let end: String = trimmed.chars().take(200).collect();
            format!("{end}...")
        } else {
            trimmed.to_string()
        }
    });

    // List-Unsubscribe headers
    let list_unsubscribe = extract_header_text(message.header(mail_parser::HeaderName::ListUnsubscribe));
    let list_unsubscribe_post = extract_header_text(
        message.header(mail_parser::HeaderName::Other("List-Unsubscribe-Post".into())),
    );

    // Authentication-Results header
    let auth_results = extract_header_text(
        message.header(mail_parser::HeaderName::Other("Authentication-Results".into())),
    );

    // Build a map from mail-parser part index → IMAP MIME section path.
    // IMAP numbers children of multipart containers starting at 1 (e.g. "1", "2", "1.2.3").
    // mail-parser stores all parts flat in a Vec, with Multipart variants holding child indices.
    let section_map = build_imap_section_map(&message);

    log::debug!(
        "IMAP parse UID {uid}: {} parts, mail-parser attachment indices {:?}, section_map: {:?}",
        message.parts.len(),
        message.attachments,
        section_map,
    );

    let attachment_indices = collect_attachment_part_indices(&message);
    log::info!(
        "IMAP parse UID {uid}: collected {} attachment part(s) {:?}",
        attachment_indices.len(),
        attachment_indices,
    );

    let attachments: Vec<ImapAttachment> = attachment_indices
        .into_iter()
        .filter_map(|part_idx| part_to_imap_attachment(&message, part_idx, &section_map, uid))
        .collect();

    Ok(ImapMessage {
        uid,
        folder: folder.to_string(),
        message_id,
        in_reply_to,
        references,
        from_address,
        from_name,
        to_addresses,
        cc_addresses,
        bcc_addresses,
        reply_to,
        subject,
        date,
        is_read,
        is_starred,
        is_draft,
        body_html,
        body_text,
        snippet,
        raw_size,
        list_unsubscribe,
        list_unsubscribe_post,
        auth_results,
        attachments,
    })
}

/// Build a mapping from mail-parser part index → IMAP MIME section path string.
///
/// IMAP section numbering: children of a multipart container are numbered 1, 2, 3, ...
/// Nested multipart children get dot-separated paths (e.g., "1.2" for the 2nd child of the 1st child).
/// For non-multipart messages, the single body is section "1".
fn build_imap_section_map(message: &mail_parser::Message) -> std::collections::HashMap<usize, String> {
    use mail_parser::PartType;

    let mut map = std::collections::HashMap::new();

    fn walk(
        parts: &[mail_parser::MessagePart],
        part_idx: usize,
        prefix: &str,
        map: &mut std::collections::HashMap<usize, String>,
    ) {
        if let Some(part) = parts.get(part_idx) {
            if let PartType::Multipart(children) = &part.body {
                for (i, &child_idx) in children.iter().enumerate() {
                    let section = if prefix.is_empty() {
                        format!("{}", i + 1)
                    } else {
                        format!("{}.{}", prefix, i + 1)
                    };
                    walk(parts, child_idx, &section, map);
                }
            } else {
                // Leaf part — use the section path as-is
                let section = if prefix.is_empty() {
                    // Non-multipart message: the body is section "1"
                    "1".to_string()
                } else {
                    prefix.to_string()
                };
                map.insert(part_idx, section);
            }
        }
    }

    // Start from part 0 (root) with empty prefix
    if !message.parts.is_empty() {
        walk(&message.parts, 0, "", &mut map);
    }

    map
}

/// Collect MIME part indices that represent downloadable attachments.
/// mail-parser's built-in `message.attachments` misses filename-only parts (zip/docx).
fn collect_attachment_part_indices(message: &mail_parser::Message) -> Vec<usize> {
    use mail_parser::PartType;
    use std::collections::HashSet;

    let mut indices: Vec<usize> = message.attachments.clone();
    let mut seen: HashSet<usize> = indices.iter().copied().collect();

    for (idx, part) in message.parts.iter().enumerate() {
        if matches!(part.body, PartType::Multipart(_)) {
            continue;
        }

        let ctype = part
            .content_type()
            .map(|ct| ct.ctype())
            .unwrap_or("");
        let subtype = part
            .content_type()
            .and_then(|ct| ct.subtype())
            .unwrap_or("");

        let has_filename = part.attachment_name().is_some();
        let disposition = part.content_disposition();
        let is_attachment = disposition.map(|cd| cd.is_attachment()).unwrap_or(false);
        let is_inline = disposition.map(|cd| cd.is_inline()).unwrap_or(false);
        let has_cid = part.content_id().is_some();

        let is_text_body = ctype == "text" && (subtype == "plain" || subtype == "html");
        if is_text_body && !has_filename && !is_attachment {
            continue;
        }

        if is_inline && has_cid && !has_filename {
            continue;
        }

        if has_filename || is_attachment || (ctype != "text" && ctype != "multipart") {
            if seen.insert(idx) {
                indices.push(idx);
            }
        }
    }

    indices
}

fn part_to_imap_attachment(
    message: &mail_parser::Message,
    part_idx: usize,
    section_map: &std::collections::HashMap<usize, String>,
    uid: u32,
) -> Option<ImapAttachment> {
    let att = message.parts.get(part_idx)?;
    let section = match section_map.get(&part_idx) {
        Some(s) => s.clone(),
        None => {
            log::warn!(
                "IMAP UID {uid}: attachment at part index {part_idx} not found in section map (map has {} entries)",
                section_map.len(),
            );
            return None;
        }
    };

    let mime_type = att
        .content_type()
        .map(|ct| {
            let ctype = ct.ctype();
            let subtype = ct.subtype().unwrap_or("octet-stream");
            format!("{ctype}/{subtype}")
        })
        .unwrap_or_else(|| "application/octet-stream".to_string());

    if mime_type.starts_with("multipart/") {
        return None;
    }

    Some(ImapAttachment {
        part_id: section,
        filename: att
            .attachment_name()
            .unwrap_or("attachment")
            .to_string(),
        mime_type,
        size: att.len() as u32,
        content_id: att.content_id().map(|s| s.to_string()),
        is_inline: att.content_disposition().map_or(false, |cd| cd.is_inline()),
    })
}

/// Extract a text value from a HeaderValue, if present.
fn extract_header_text(hv: Option<&mail_parser::HeaderValue>) -> Option<String> {
    match hv {
        Some(mail_parser::HeaderValue::Text(t)) => Some(t.to_string()),
        Some(mail_parser::HeaderValue::TextList(list)) => {
            Some(list.iter().map(|s| s.as_ref()).collect::<Vec<_>>().join(", "))
        }
        _ => None,
    }
}

/// Extract the first address (email, display name) from an Address field.
fn extract_first_address(
    addr: Option<&mail_parser::Address>,
) -> (Option<String>, Option<String>) {
    let addr = match addr {
        Some(a) => a,
        None => return (None, None),
    };

    if let Some(first) = addr.first() {
        let email = first.address.as_ref().map(|s| s.to_string());
        let name = first.name.as_ref().map(|s| s.to_string());
        (email, name)
    } else {
        (None, None)
    }
}

/// Format an address list as a comma-separated string of "Name <email>" or "email".
fn format_address_list(addr: Option<&mail_parser::Address>) -> Option<String> {
    let addr = match addr {
        Some(a) => a,
        None => return None,
    };

    let parts: Vec<String> = addr
        .iter()
        .map(|a| {
            let email = a.address.as_deref().unwrap_or("");
            match a.name.as_deref() {
                Some(name) if !name.is_empty() => format!("{name} <{email}>"),
                _ => email.to_string(),
            }
        })
        .collect();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}
