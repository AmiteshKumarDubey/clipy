//! Recording-funnel events for the desktop apps.
//!
//! The web recorder has emitted `recording_failed` / `recording_cancelled` /
//! `recording_abandoned` for a long time; the Mac and Windows apps emitted
//! nothing at all, so a started upload that never reached `ready` could not
//! be told apart from a user who changed their mind.
//!
//! This posts the same event names, `stage` values and `reason_code` slugs the
//! web recorder uses to the same `/api/analytics/posthog-event` route. It is
//! fire-and-forget by construction: every failure is swallowed, because an
//! analytics call must never be able to cost somebody their recording.
//!
//! Property keys are constrained by the server's allowlist of recording
//! journey and environment properties; anything outside it is dropped
//! silently, so keep this in step with it.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

pub const RECORDING_BLOCKED: &str = "recording_blocked";
pub const RECORDING_FAILED: &str = "recording_failed";
pub const RECORDING_CANCELLED: &str = "recording_cancelled";
pub const RECORDING_ABANDONED: &str = "recording_abandoned";
pub const RECORDING_RECOVERED: &str = "recording_recovered";
pub const RECORDING_RECOVERY_FAILED: &str = "recording_recovery_failed";
/// Periodic resource sample during a take (`recording_health.rs`).
pub const RECORDING_HEALTH: &str = "recording_health";

// Auto-update lifecycle. Without these, an install that had an update
// waiting for a restart looked the same as one whose check or download was
// failing. Staged vs install-started is the restart gap.
pub const UPDATE_STAGED: &str = "desktop_update_staged";
pub const UPDATE_INSTALL_STARTED: &str = "desktop_update_install_started";
pub const UPDATE_FAILED: &str = "desktop_update_failed";


/// One funnel event. Built at the call site, serialized here.
#[derive(Debug, Clone)]
pub struct Event {
    name: &'static str,
    recording_id: Option<String>,
    stage: Option<&'static str>,
    reason_code: Option<String>,
    error_name: Option<String>,
    elapsed_ms: Option<u64>,
    to_version: Option<String>,
    /// Set only for an event recorded earlier and sent later (an update's
    /// install, sent by the next launch), so it keeps the id and the time
    /// it was recorded with.
    event_id: Option<String>,
    timestamp: Option<String>,
    /// Numeric or boolean measurements beside the funnel fields. The caller
    /// names the key, so it must be one the server allowlists.
    extra: serde_json::Map<String, Value>,
}

impl Event {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            recording_id: None,
            stage: None,
            reason_code: None,
            error_name: None,
            elapsed_ms: None,
            to_version: None,
            event_id: None,
            timestamp: None,
            extra: serde_json::Map::new(),
        }
    }

    /// The version an update event is about (the running one is
    /// `client_version`).
    pub fn to_version(mut self, version: &str) -> Self {
        self.to_version = Some(slug(version));
        self
    }

    /// An event recorded earlier and sent now: keep the id and time it was
    /// recorded with.
    pub fn recorded(mut self, event_id: &str, timestamp: &str) -> Self {
        self.event_id = Some(event_id.to_string());
        self.timestamp = Some(timestamp.to_string());
        self
    }

    pub fn recording(mut self, recording_id: &str) -> Self {
        self.recording_id = Some(recording_id.to_string());
        self
    }

    pub fn maybe_recording(mut self, recording_id: Option<&str>) -> Self {
        self.recording_id = recording_id.map(str::to_string);
        self
    }

    pub fn stage(mut self, stage: &'static str) -> Self {
        self.stage = Some(stage);
        self
    }

    pub fn reason(mut self, reason_code: impl AsRef<str>) -> Self {
        self.reason_code = Some(slug(reason_code.as_ref()));
        self
    }

    /// Detail beside `reason_code` (an API variant name, an HRESULT). Only
    /// ever a slug the caller built; never an error message.
    pub fn maybe_error_name(mut self, error_name: Option<&str>) -> Self {
        self.error_name = error_name.map(slug);
        self
    }

    pub fn elapsed_ms(mut self, elapsed_ms: u64) -> Self {
        self.elapsed_ms = Some(elapsed_ms);
        self
    }

    /// A measurement. `None` leaves the key out rather than sending a null.
    pub fn measure(mut self, key: &'static str, value: Option<impl Into<Value>>) -> Self {
        if let Some(value) = value {
            self.extra.insert(key.to_string(), value.into());
        }
        self
    }

    pub(crate) fn properties(&self) -> Value {
        let mut properties = json!({
            // Resolved through the same function that stamps `sourcePlatform`
            // on `/complete`, so a funnel event and the `videos` row it
            // belongs to can never disagree about which client recorded it.
            "source": crate::capture_health::upload_source_platform(),
            "client_version": env!("CARGO_PKG_VERSION"),
            "os": reported_os(),
        });
        let map = properties.as_object_mut().expect("json object");
        if let Some(version) = crate::capture_health::reported_os_version() {
            map.insert("os_version".into(), Value::String(version));
        }
        if let Some(installer) = installer_kind() {
            map.insert("installer".into(), Value::String(installer.to_string()));
        }
        if let Some(id) = &self.recording_id {
            map.insert("recordingId".into(), Value::String(id.clone()));
        }
        if let Some(stage) = self.stage {
            map.insert("stage".into(), Value::String(stage.to_string()));
        }
        if let Some(reason) = &self.reason_code {
            map.insert("reason_code".into(), Value::String(reason.clone()));
        }
        if let Some(name) = &self.error_name {
            map.insert("error_name".into(), Value::String(name.clone()));
        }
        if let Some(elapsed) = self.elapsed_ms {
            map.insert("elapsed_ms".into(), json!(elapsed));
        }
        if let Some(version) = &self.to_version {
            map.insert("to_version".into(), Value::String(version.clone()));
        }
        for (key, value) in &self.extra {
            map.entry(key.clone()).or_insert_with(|| value.clone());
        }
        properties
    }
}

/// Send without waiting. The normal path: a recording has just failed and the
/// caller has a user to answer to.
pub fn send<R: Runtime>(app: &AppHandle<R>, event: Event) {
    // The local edition reports nothing anywhere.
    let _ = (app, event);
}

/// Send and wait, up to `budget`. Only for the quit path, where the process is
/// about to disappear and there is no later chance to report.
pub async fn send_bounded<R: Runtime>(app: &AppHandle<R>, event: Event, budget: Duration) {
    let _ = (app, event, budget);
}

/// Whether a failed API call was the product refusing on purpose — the free
/// allowance, an expired session, a build the server no longer accepts — or a
/// genuine failure. Reporting a working gate as `recording_failed` would make
/// the desktop failure rate read as whatever share of users hit their quota.
///
/// Classification walks the error chain (`api_error::refusal_of`); it never
/// reads the formatted message.
pub fn classify(err: &anyhow::Error, default_reason: &str) -> (&'static str, String) {
    match crate::api_error::refusal_of(err) {
        Some(refusal) => {
            let reason = refusal
                .code
                .clone()
                .unwrap_or_else(|| format!("http_{}", refusal.status));
            let name = if matches!(refusal.status, 401 | 402 | 403 | 426) {
                RECORDING_BLOCKED
            } else {
                RECORDING_FAILED
            };
            (name, slug(&reason))
        }
        // A local failure that knows why it happened says so; the default is
        // only for errors nobody has given a reason yet.
        None => match crate::capture::failure::of(err) {
            Some(failure) => (RECORDING_FAILED, slug(failure.reason)),
            None => (RECORDING_FAILED, slug(default_reason)),
        },
    }
}

fn reported_os() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macOS"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "Other"
    }
}

/// Which Windows package this copy came from: `nsis` (the setup .exe, the
/// only one the updater moves forward), `msi` or `portable` (the zip). Old
/// builds that cannot update are still reaching new accounts, and this says
/// which download they started from. `None` off Windows.
///
/// Read from what each package leaves beside the app, never from the folder
/// name, since the MSI can install anywhere and the zip can be unpacked
/// anywhere: the NSIS installer writes `uninstall.exe`, the portable zip
/// ships a `README.txt` that opens with `PORTABLE_README_TITLE` (see
/// `desktop-release-windows.yml`), and the MSI leaves neither.
pub(crate) fn installer_kind() -> Option<&'static str> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    static CACHED: OnceLock<Option<&'static str>> = OnceLock::new();
    *CACHED.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let readme = std::fs::read(dir.join("README.txt")).ok();
        Some(installer_kind_for(
            dir.join("uninstall.exe").is_file(),
            readme.as_deref(),
        ))
    })
}

/// The first line of the README the release workflow puts in the portable zip.
const PORTABLE_README_TITLE: &str = "Clipy Portable for Windows";

fn installer_kind_for(has_nsis_uninstaller: bool, readme: Option<&[u8]>) -> &'static str {
    if has_nsis_uninstaller {
        return "nsis";
    }
    let is_portable = readme.is_some_and(|bytes| {
        // PowerShell's `-Encoding utf8` writes a byte-order mark first.
        let text = String::from_utf8_lossy(bytes);
        text.trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with(PORTABLE_README_TITLE)
    });
    if is_portable {
        "portable"
    } else {
        "msi"
    }
}

/// The server drops any `reason_code` outside `[\w .-]{1,80}`, so a code we
/// pass through from a future server release must be coerced rather than
/// silently lost.
fn slug(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' ') {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_kind_reads_what_each_package_leaves_beside_the_app() {
        let portable =
            "\u{feff}Clipy Portable for Windows 1.1.75\r\n\r\n1. Double-click".as_bytes();
        assert_eq!(installer_kind_for(true, None), "nsis");
        assert_eq!(installer_kind_for(true, Some(portable)), "nsis");
        assert_eq!(installer_kind_for(false, Some(portable)), "portable");
        assert_eq!(installer_kind_for(false, Some(b"Some other readme")), "msi");
        assert_eq!(installer_kind_for(false, None), "msi");
    }

    const QUOTA_BODY: &str = r#"{"error":"You've used your free allowance.","code":"pro_required","level":"quota"}"#;

    #[test]
    fn a_gate_refusal_is_blocked_not_failed() {
        let err = anyhow::Error::new(crate::api_error::ApiRefusal::parse(
            403,
            QUOTA_BODY,
            "initiate",
        ))
        .context("start streaming upload");
        let (name, reason) = classify(&err, "upload_init_failed");
        assert_eq!(name, RECORDING_BLOCKED);
        assert_eq!(reason, "pro_required");
    }

    #[test]
    fn an_expired_session_and_a_stale_build_are_blocked_too() {
        for status in [401u16, 426] {
            let err = anyhow::Error::new(crate::api_error::ApiRefusal::parse(status, "", "initiate"));
            assert_eq!(classify(&err, "upload_init_failed").0, RECORDING_BLOCKED);
        }
    }

    #[test]
    fn a_server_error_is_a_real_failure() {
        let err = anyhow::Error::new(crate::api_error::ApiRefusal::parse(500, "", "finalize"));
        let (name, reason) = classify(&err, "finalize_failed");
        assert_eq!(name, RECORDING_FAILED);
        assert_eq!(reason, "http_500");
    }

    #[test]
    fn a_local_failure_keeps_the_callers_reason() {
        let err = anyhow::anyhow!("open ffmpeg MP4 encoder").context("start capture");
        let (name, reason) = classify(&err, "capture_unavailable");
        assert_eq!(name, RECORDING_FAILED);
        assert_eq!(reason, "capture_unavailable");
    }

    #[test]
    fn a_local_failure_with_a_known_cause_reports_it() {
        let err = anyhow::Error::new(crate::capture::failure::wgc_start_failure(
            "GraphicsCaptureApiError(BorderConfigUnsupported)",
        ))
        .context("start Windows screen capture");
        let (name, reason) = classify(&err, "capture_unavailable");
        assert_eq!(name, RECORDING_FAILED);
        assert_eq!(reason, "wgc_option_unsupported");
    }

    #[test]
    fn a_refusal_still_wins_over_a_stage_tag() {
        let err = crate::capture::failure::CaptureFailure::tag(
            "upload_initiate_failed",
            anyhow::Error::new(crate::api_error::ApiRefusal::parse(401, "", "initiate"))
                .context("start streaming upload"),
        );
        assert_eq!(classify(&err, "capture_unavailable").0, RECORDING_BLOCKED);
    }

    #[test]
    fn error_name_is_sent_as_a_slug() {
        let properties = Event::new(RECORDING_FAILED)
            .maybe_error_name(Some("DirectXError_887a0004"))
            .properties();
        assert_eq!(properties["error_name"], serde_json::json!("DirectXError_887a0004"));
        assert!(Event::new(RECORDING_FAILED).properties().get("error_name").is_none());
    }

    #[test]
    fn reason_codes_are_coerced_into_what_the_server_accepts() {
        assert_eq!(slug("pro_required"), "pro_required");
        assert_eq!(slug("weird:code/here"), "weird_code_here");
        assert_eq!(slug(""), "unknown");
        assert_eq!(slug(&"x".repeat(200)).len(), 80);
    }

    #[test]
    fn properties_carry_the_same_source_the_upload_stamps() {
        let event = Event::new(RECORDING_FAILED)
            .recording("11112222-3333-4444-5555-666677778888")
            .stage("setup")
            .reason("capture_unavailable");
        let properties = event.properties();
        assert_eq!(
            properties["source"],
            serde_json::json!(crate::capture_health::upload_source_platform())
        );
        assert_eq!(properties["stage"], serde_json::json!("setup"));
        assert_eq!(
            properties["recordingId"],
            serde_json::json!("11112222-3333-4444-5555-666677778888")
        );
    }
}
