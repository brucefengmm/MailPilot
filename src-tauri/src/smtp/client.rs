use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use lettre::{
    transport::smtp::{
        authentication::{Credentials, Mechanism},
        client::{Tls, TlsParameters, TlsParametersBuilder},
        extension::ClientId,
    },
    AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
};
use std::time::Duration;

use super::types::{SmtpConfig, SmtpSendResult};

const SMTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Yandex SMTP often expects the local part (before @) while IMAP accepts the full address.
fn smtp_username_candidates(username: &str) -> Vec<String> {
    let trimmed = username.trim();
    let mut candidates = vec![trimmed.to_string()];
    if let Some(local) = trimmed.split('@').next() {
        if !local.is_empty() && local != trimmed {
            candidates.push(local.to_string());
        }
    }
    candidates
}

fn is_smtp_auth_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("authentication failed")
        || lower.contains("invalid user or password")
        || lower.contains("535")
        || lower.contains("authentication credentials invalid")
}

fn format_smtp_test_error(error: &str) -> String {
    let core = error.strip_prefix("SMTP test error: ").unwrap_or(error);
    format!("SMTP test error: {core}")
}

/// EHLO client name — use the mailbox domain when available (matches typical Python smtplib behavior).
fn smtp_hello_name(username: &str) -> ClientId {
    if let Some(domain) = username.split('@').nth(1).filter(|d| !d.is_empty()) {
        ClientId::Domain(domain.to_string())
    } else {
        ClientId::default()
    }
}

/// Auth mechanism sets to try on failure (PLAIN first, like Python smtplib / lettre defaults).
fn password_auth_mechanism_sets() -> Vec<Vec<Mechanism>> {
    vec![
        vec![Mechanism::Plain],
        vec![Mechanism::Login],
        vec![Mechanism::Plain, Mechanism::Login],
    ]
}

/// Log connection settings without exposing secrets.
fn log_smtp_config(stage: &str, config: &SmtpConfig) {
    log::info!(
        "SMTP [{stage}] host={} port={} security={} auth_method={} accept_invalid_certs={} username={} credential_len={}",
        config.host,
        config.port,
        config.security,
        config.auth_method,
        config.accept_invalid_certs,
        config.username,
        config.password.len()
    );
}

/// Decode a base64url-encoded string (Gmail format) to raw bytes.
fn decode_base64url(input: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|e| format!("Base64 decode error: {}", e))
}

/// Build TLS parameters, optionally accepting invalid certificates.
fn build_tls_params(config: &SmtpConfig) -> Result<TlsParameters, String> {
    let mut builder = TlsParametersBuilder::new(config.host.clone());
    if config.accept_invalid_certs {
        builder = builder
            .dangerous_accept_invalid_certs(true)
            .dangerous_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| format!("SMTP TLS params error: {}", e))
}

/// Build an async SMTP transport from the given config.
fn build_transport_with_mechanisms(
    config: &SmtpConfig,
    auth_mechanisms: &[Mechanism],
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    log_smtp_config("build_transport", config);
    let credentials = Credentials::new(config.username.clone(), config.password.clone());
    let hello_name = smtp_hello_name(&config.username);

    log::info!(
        "SMTP build_transport: auth mechanisms={:?} hello={hello_name}",
        auth_mechanisms
            .iter()
            .map(|m| m.to_string())
            .collect::<Vec<_>>()
    );

    let transport = match config.security.as_str() {
        "tls" => {
            log::info!("SMTP build_transport: mode=implicit TLS (port {})", config.port);
            let mut builder = AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
                .map_err(|e| {
                    log::error!("SMTP build_transport: relay() failed — {e}");
                    format!("SMTP relay error: {}", e)
                })?
                .port(config.port)
                .timeout(Some(SMTP_TIMEOUT))
                .hello_name(hello_name)
                .credentials(credentials)
                .authentication(auth_mechanisms.to_vec());

            if config.accept_invalid_certs {
                log::info!("SMTP build_transport: accept_invalid_certs=true (Wrapper TLS)");
                let tls_params = build_tls_params(config)?;
                builder = builder.tls(Tls::Wrapper(tls_params));
            }

            builder.build()
        }
        "starttls" => {
            log::info!("SMTP build_transport: mode=STARTTLS (port {})", config.port);
            let mut builder = AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
                .map_err(|e| {
                    log::error!("SMTP build_transport: starttls_relay() failed — {e}");
                    format!("SMTP STARTTLS error: {}", e)
                })?
                .port(config.port)
                .timeout(Some(SMTP_TIMEOUT))
                .hello_name(hello_name)
                .credentials(credentials)
                .authentication(auth_mechanisms.to_vec());

            if config.accept_invalid_certs {
                log::info!("SMTP build_transport: accept_invalid_certs=true (Required TLS)");
                let tls_params = build_tls_params(config)?;
                builder = builder.tls(Tls::Required(tls_params));
            }

            builder.build()
        }
        other => {
            log::warn!("SMTP build_transport: mode=plain/no encryption (security={other}, port {})", config.port);
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)
                .port(config.port)
                .timeout(Some(SMTP_TIMEOUT))
                .hello_name(hello_name)
                .credentials(credentials)
                .authentication(auth_mechanisms.to_vec())
                .build()
        }
    };

    log::info!("SMTP build_transport: transport created successfully");
    Ok(transport)
}

/// Extract an SMTP envelope (sender + recipients) from raw RFC 2822 bytes.
///
/// The envelope tells the SMTP server who the mail is from and who to deliver
/// it to, which is separate from the header fields visible to the recipient.
fn extract_envelope(raw: &[u8]) -> Result<lettre::address::Envelope, String> {
    let message = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or("Failed to parse email for envelope extraction")?;

    // Extract From address
    let from = message
        .from()
        .and_then(|list| list.first())
        .and_then(|addr| addr.address())
        .ok_or("No From address found in email")?;

    let from_addr: lettre::Address = from
        .parse()
        .map_err(|e| format!("Invalid From address '{}': {}", from, e))?;

    // Collect all recipient addresses (To, Cc, Bcc)
    let mut recipients: Vec<lettre::Address> = Vec::new();

    if let Some(to_list) = message.to() {
        for addr in to_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if let Some(cc_list) = message.cc() {
        for addr in cc_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if let Some(bcc_list) = message.bcc() {
        for addr in bcc_list.iter() {
            if let Some(email) = addr.address() {
                if let Ok(a) = email.parse::<lettre::Address>() {
                    recipients.push(a);
                }
            }
        }
    }

    if recipients.is_empty() {
        return Err("No recipients found in email".to_string());
    }

    lettre::address::Envelope::new(Some(from_addr), recipients)
        .map_err(|e| format!("Envelope error: {}", e))
}

/// Send a pre-built RFC 2822 email via SMTP.
///
/// The `raw_email_base64url` parameter is the full email message encoded as
/// base64url (the same encoding Gmail uses: `+` → `-`, `/` → `_`, no padding).
/// The function decodes it, extracts the envelope from headers, and sends it.
pub async fn send_raw_email(
    config: &SmtpConfig,
    raw_email_base64url: &str,
) -> Result<SmtpSendResult, String> {
    let raw_bytes = decode_base64url(raw_email_base64url)?;
    let envelope = extract_envelope(&raw_bytes)?;

    let candidates = if config.auth_method == "oauth2" {
        vec![config.username.clone()]
    } else {
        smtp_username_candidates(&config.username)
    };

    let mechanism_sets: Vec<Vec<Mechanism>> = if config.auth_method == "oauth2" {
        vec![vec![Mechanism::Xoauth2]]
    } else {
        password_auth_mechanism_sets()
    };

    let mut last_error = String::new();

    for (index, username) in candidates.iter().enumerate() {
        if index > 0 {
            log::info!("SMTP send_raw_email: retrying with username={username}");
        }

        let mut attempt = config.clone();
        attempt.username = username.clone();

        for mechanisms in &mechanism_sets {
            let transport = build_transport_with_mechanisms(&attempt, mechanisms)?;

            match transport.send_raw(&envelope, &raw_bytes).await {
                Ok(_response) => {
                    return Ok(SmtpSendResult {
                        success: true,
                        message: "Email sent successfully".to_string(),
                    });
                }
                Err(e) => {
                    last_error = format!("SMTP send error: {e}");
                    if !is_smtp_auth_error(&last_error) {
                        return Err(last_error);
                    }
                    log::info!(
                        "SMTP send_raw_email: auth failed with {:?}, trying next mechanism",
                        mechanisms
                            .iter()
                            .map(|m| m.to_string())
                            .collect::<Vec<_>>()
                    );
                }
            }
        }
    }

    Err(last_error)
}

/// Single SMTP test attempt (connect + authenticate + NOOP).
async fn test_connection_once(
    config: &SmtpConfig,
    auth_mechanisms: &[Mechanism],
) -> Result<SmtpSendResult, String> {
    let transport = build_transport_with_mechanisms(config, auth_mechanisms)?;

    log::info!("SMTP test_connection: calling transport.test_connection()");
    let test_result = transport.test_connection().await;
    match &test_result {
        Ok(true) => log::info!("SMTP test_connection: server accepted connection and auth"),
        Ok(false) => log::warn!("SMTP test_connection: test_connection returned false"),
        Err(e) => log::error!("SMTP test_connection: error — {e:?}"),
    }

    test_result
        .map(|success| SmtpSendResult {
            success,
            message: if success {
                format!("Connection successful (username: {})", config.username)
            } else {
                "Connection failed: server accepted TCP/TLS but NOOP command failed. \
                 Try port 465 with SSL/TLS instead of 587 with STARTTLS."
                    .to_string()
            },
        })
        .map_err(|e| format!("SMTP test error: {e}"))
}

/// Test SMTP connectivity by connecting, authenticating, and disconnecting.
pub async fn test_connection(config: &SmtpConfig) -> Result<SmtpSendResult, String> {
    log::info!("SMTP test_connection: begin");
    log_smtp_config("test_connection", config);

    let candidates = if config.auth_method == "oauth2" {
        vec![config.username.clone()]
    } else {
        smtp_username_candidates(&config.username)
    };

    let mechanism_sets: Vec<Vec<Mechanism>> = if config.auth_method == "oauth2" {
        vec![vec![Mechanism::Xoauth2]]
    } else {
        password_auth_mechanism_sets()
    };

    let mut last_error = String::new();

    for (index, username) in candidates.iter().enumerate() {
        if index > 0 {
            log::info!("SMTP test_connection: retrying with username={username}");
        }

        let mut attempt = config.clone();
        attempt.username = username.clone();

        for mechanisms in &mechanism_sets {
            match test_connection_once(&attempt, mechanisms).await {
                Ok(result) if result.success => return Ok(result),
                Ok(result) => {
                    last_error = result.message;
                }
                Err(e) => {
                    last_error = e;
                    if !is_smtp_auth_error(&last_error) {
                        let msg = format_smtp_test_error(&last_error);
                        log::error!("SMTP test_connection: {msg}");
                        return Err(msg);
                    }
                    log::info!(
                        "SMTP test_connection: auth failed with {:?}, trying next mechanism",
                        mechanisms
                            .iter()
                            .map(|m| m.to_string())
                            .collect::<Vec<_>>()
                    );
                }
            }
        }
    }

    let msg = format_smtp_test_error(&last_error);
    log::error!("SMTP test_connection: {msg}");
    Err(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_base64url_valid() {
        // "Hello" in base64url
        let encoded = "SGVsbG8";
        let decoded = decode_base64url(encoded).unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn test_decode_base64url_invalid() {
        let result = decode_base64url("!!!invalid!!!");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Base64 decode error"));
    }

    #[test]
    fn test_extract_envelope_valid() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nCc: carol@example.com\r\nSubject: Test\r\n\r\nBody";
        let envelope = extract_envelope(raw).unwrap();
        // Envelope should have from and 2 recipients (To + Cc)
        assert!(envelope.from().is_some());
        assert_eq!(envelope.to().len(), 2);
    }

    #[test]
    fn test_extract_envelope_no_from() {
        let raw = b"To: bob@example.com\r\nSubject: Test\r\n\r\nBody";
        let result = extract_envelope(raw);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No From address"));
    }

    #[test]
    fn test_extract_envelope_no_recipients() {
        let raw = b"From: alice@example.com\r\nSubject: Test\r\n\r\nBody";
        let result = extract_envelope(raw);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No recipients found"));
    }

    #[test]
    fn test_extract_envelope_with_bcc() {
        let raw = b"From: alice@example.com\r\nTo: bob@example.com\r\nBcc: secret@example.com\r\nSubject: Test\r\n\r\nBody";
        let envelope = extract_envelope(raw).unwrap();
        assert_eq!(envelope.to().len(), 2);
    }

    #[test]
    fn test_smtp_username_candidates_full_email() {
        let candidates = smtp_username_candidates("meimiao@yandex-team.ru");
        assert_eq!(candidates, vec!["meimiao@yandex-team.ru", "meimiao"]);
    }

    #[test]
    fn test_smtp_username_candidates_local_part_only() {
        let candidates = smtp_username_candidates("meimiao");
        assert_eq!(candidates, vec!["meimiao"]);
    }

    #[test]
    fn test_is_smtp_auth_error() {
        assert!(is_smtp_auth_error(
            "permanent error (535): 5.7.8 Error: authentication failed: Invalid user or password!"
        ));
        assert!(!is_smtp_auth_error("connection timed out"));
    }
}
