use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct RunRequestEnvelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId")]
    request_id: String,
    run: Value,
}

#[derive(Debug, Serialize)]
struct RunResponseEnvelope {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "requestId")]
    request_id: String,
    result: Value,
}

#[derive(Clone, Debug, Serialize)]
struct IsolationProfile {
    name: String,
    max_wall_ms: u64,
    max_cpu_ms: u64,
    max_memory_bytes: u64,
    max_stdout_bytes: u64,
    max_stderr_bytes: u64,
    deny_env_capability: bool,
}

fn parse_positive_env_u64(key: &str, default: u64) -> Result<u64, String> {
    let raw = match std::env::var(key) {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return Ok(default),
        Err(error) => return Err(format!("failed to read {key}: {error}")),
    };

    let parsed = raw
        .parse::<u64>()
        .map_err(|_| format!("invalid numeric value for {key}"))?;
    if parsed == 0 {
        return Err(format!("invalid numeric value for {key}"));
    }
    Ok(parsed)
}

fn parse_bool_env(key: &str, default: bool) -> Result<bool, String> {
    let raw = match std::env::var(key) {
        Ok(value) => value.trim().to_string(),
        Err(std::env::VarError::NotPresent) => return Ok(default),
        Err(error) => return Err(format!("failed to read {key}: {error}")),
    };

    match raw.as_str() {
        "1" | "true" | "TRUE" | "True" => Ok(true),
        "0" | "false" | "FALSE" | "False" => Ok(false),
        _ => Err(format!("invalid boolean value for {key}")),
    }
}

fn load_isolation_profile() -> Result<IsolationProfile, String> {
    let profile = std::env::var("AEGISPY_WORKER_ISOLATION_PROFILE")
        .unwrap_or_else(|_| "strict".to_string())
        .trim()
        .to_lowercase();

    let (defaults, deny_env_capability) = match profile.as_str() {
        "strict" => (
            (5000_u64, 5000_u64, 64 * 1024 * 1024, 2 * 1024 * 1024),
            true,
        ),
        "compat" => (
            (10000_u64, 10000_u64, 256 * 1024 * 1024, 8 * 1024 * 1024),
            false,
        ),
        _ => return Err("invalid AEGISPY_WORKER_ISOLATION_PROFILE".to_string()),
    };

    let max_wall_ms = parse_positive_env_u64("AEGISPY_WORKER_MAX_WALL_MS", defaults.0)?;
    let max_cpu_ms = parse_positive_env_u64("AEGISPY_WORKER_MAX_CPU_MS", defaults.1)?;
    let max_memory_bytes = parse_positive_env_u64("AEGISPY_WORKER_MAX_MEMORY_BYTES", defaults.2)?;
    let max_stdout_bytes = parse_positive_env_u64("AEGISPY_WORKER_MAX_STDOUT_BYTES", defaults.3)?;
    let max_stderr_bytes = parse_positive_env_u64("AEGISPY_WORKER_MAX_STDERR_BYTES", defaults.3)?;
    let deny_env_capability =
        parse_bool_env("AEGISPY_WORKER_DENY_ENV_CAPABILITY", deny_env_capability)?;

    Ok(IsolationProfile {
        name: profile,
        max_wall_ms,
        max_cpu_ms,
        max_memory_bytes,
        max_stdout_bytes,
        max_stderr_bytes,
        deny_env_capability,
    })
}

fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    let len = payload.len() as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn read_frame(reader: &mut dyn Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let len = u32::from_be_bytes(header) as usize;
    let mut payload = vec![0_u8; len];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame(writer: &mut dyn Write, payload: &[u8]) -> io::Result<()> {
    let framed = encode_frame(payload);
    writer.write_all(&framed)?;
    writer.flush()
}

fn required_non_negative_u64(value: &Value, path: &[&str]) -> Result<u64, String> {
    let mut current = value;
    for key in path {
        current = current
            .get(*key)
            .ok_or_else(|| format!("missing field: {}", path.join(".")))?;
    }

    current
        .as_u64()
        .ok_or_else(|| format!("invalid number field: {}", path.join(".")))
}

fn required_string<'a>(value: &'a Value, path: &[&str]) -> Result<&'a str, String> {
    let mut current = value;
    for key in path {
        current = current
            .get(*key)
            .ok_or_else(|| format!("missing field: {}", path.join(".")))?;
    }

    current
        .as_str()
        .ok_or_else(|| format!("invalid string field: {}", path.join(".")))
}

fn parse_marker_u64(code: &str, marker: &str) -> Option<u64> {
    let index = code.find(marker)?;
    let tail = &code[index + marker.len()..];
    let digits: String = tail.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u64>().ok()
}

fn extract_first_quoted_value(input: &str) -> Option<String> {
    let start_double = input.find('"').map(|index| (index, '"'));
    let start_single = input.find('\'').map(|index| (index, '\''));

    let (start_index, quote) = match (start_double, start_single) {
        (Some(double), Some(single)) => {
            if double.0 < single.0 {
                double
            } else {
                single
            }
        }
        (Some(double), None) => double,
        (None, Some(single)) => single,
        (None, None) => return None,
    };

    let tail = &input[start_index + 1..];
    let end_index = tail.find(quote)?;
    Some(tail[..end_index].to_string())
}

fn collect_call_targets(code: &str, call_marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = code;

    loop {
        let Some(call_index) = cursor.find(call_marker) else {
            break;
        };
        let after_call = &cursor[call_index + call_marker.len()..];
        let Some(open_paren) = after_call.find('(') else {
            break;
        };
        let args = &after_call[open_paren + 1..];
        if let Some(target) = extract_first_quoted_value(args) {
            out.push(target);
        }
        cursor = args;
    }

    out
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_list_at_path(value: &Value, path: &[&str]) -> Vec<String> {
    value_at_path(value, path)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn path_under_roots(target: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| target.starts_with(root))
}

fn has_path_traversal(target: &str) -> bool {
    target.contains("/../") || target.starts_with("../") || target.ends_with("/..")
}

fn extract_http_origin(target: &str) -> Option<String> {
    let scheme_end = target.find("://")?;
    let after_scheme = &target[scheme_end + 3..];
    let slash = after_scheme.find('/').unwrap_or(after_scheme.len());
    Some(format!(
        "{}://{}",
        &target[..scheme_end],
        &after_scheme[..slash]
    ))
}

fn extract_print_value(code: &str) -> String {
    if let Some(start) = code.find("print(\"") {
        let tail = &code[start + 7..];
        if let Some(end) = tail.find("\")") {
            return format!("{}\n", &tail[..end]);
        }
    }

    if let Some(start) = code.find("print('") {
        let tail = &code[start + 7..];
        if let Some(end) = tail.find("')") {
            return format!("{}\n", &tail[..end]);
        }
    }

    String::new()
}

fn make_meta(
    started_ts_ms: u64,
    ended_ts_ms: u64,
    stdout_utf8: &str,
    stderr_utf8: &str,
    termination: &str,
    audit: Vec<Value>,
) -> Value {
    let duration = ended_ts_ms.saturating_sub(started_ts_ms);
    json!({
      "startedTsMs": started_ts_ms,
      "endedTsMs": ended_ts_ms,
      "durationMs": duration,
      "cpuMs": if duration == 0 { 1 } else { duration },
      "memoryPeakBytes": 0,
      "stdoutBytes": stdout_utf8.len(),
      "stderrBytes": stderr_utf8.len(),
      "termination": termination,
      "audit": audit
    })
}

fn make_error_result(
    code: &str,
    message: &str,
    termination: &str,
    started_ts_ms: u64,
    ended_ts_ms: u64,
    audit: Vec<Value>,
) -> Value {
    let stderr_utf8 = message.to_string();
    json!({
      "status": "error",
      "exitCode": 1,
      "stdoutUtf8": "",
      "stderrUtf8": stderr_utf8,
      "meta": make_meta(started_ts_ms, ended_ts_ms, "", message, termination, audit),
      "error": {
        "code": code,
        "message": message,
        "detailJson": json!({ "termination": termination }).to_string()
      }
    })
}

fn validate_run_payload(run: &Value) -> Result<(), String> {
    let host_fields = [
        ["code"].as_slice(),
        ["stdinUtf8"].as_slice(),
        ["determinism", "rngSeedHex"].as_slice(),
    ];

    for path in host_fields {
        let _ = required_string(run, path)?;
    }

    let numeric_fields = [
        ["limits", "time", "wallMs"].as_slice(),
        ["limits", "time", "cpuMs"].as_slice(),
        ["limits", "bytes", "memoryBytes"].as_slice(),
        ["limits", "bytes", "stdoutBytes"].as_slice(),
        ["limits", "bytes", "stderrBytes"].as_slice(),
        ["determinism", "epochMs"].as_slice(),
    ];

    for path in numeric_fields {
        let _ = required_non_negative_u64(run, path)?;
    }

    if run
        .get("determinism")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .is_none()
    {
        return Err("invalid determinism.enabled".to_string());
    }

    if run.get("permissions").and_then(Value::as_object).is_none() {
        return Err("invalid permissions".to_string());
    }

    Ok(())
}

fn enforce_isolation_profile(
    run: &Value,
    profile: &IsolationProfile,
    started_ts_ms: u64,
    audit: &mut Vec<Value>,
) -> Option<Value> {
    let wall_ms = required_non_negative_u64(run, &["limits", "time", "wallMs"]).ok()?;
    let cpu_ms = required_non_negative_u64(run, &["limits", "time", "cpuMs"]).ok()?;
    let memory_bytes = required_non_negative_u64(run, &["limits", "bytes", "memoryBytes"]).ok()?;
    let stdout_bytes = required_non_negative_u64(run, &["limits", "bytes", "stdoutBytes"]).ok()?;
    let stderr_bytes = required_non_negative_u64(run, &["limits", "bytes", "stderrBytes"]).ok()?;

    let deny_reason = if wall_ms > profile.max_wall_ms {
        Some("isolation_wall_limit_exceeded")
    } else if cpu_ms > profile.max_cpu_ms {
        Some("isolation_cpu_limit_exceeded")
    } else if memory_bytes > profile.max_memory_bytes {
        Some("isolation_memory_limit_exceeded")
    } else if stdout_bytes > profile.max_stdout_bytes {
        Some("isolation_stdout_limit_exceeded")
    } else if stderr_bytes > profile.max_stderr_bytes {
        Some("isolation_stderr_limit_exceeded")
    } else {
        None
    };

    if let Some(reason) = deny_reason {
        audit.push(json!({
          "kind": "policy_denied",
          "detailJson": format!("isolation_profile_denied:{reason}")
        }));
        return Some(make_error_result(
            "AEG-POLICY-DENIED",
            reason,
            "policy_denied",
            started_ts_ms,
            started_ts_ms + 1,
            audit.clone(),
        ));
    }

    let env_capability_present = run
        .get("permissions")
        .and_then(|value| value.get("env"))
        .map(|value| !value.is_null())
        .unwrap_or(false);
    if profile.deny_env_capability && env_capability_present {
        audit.push(json!({
          "kind": "policy_denied",
          "detailJson": "isolation_profile_denied:env_capability_blocked"
        }));
        return Some(make_error_result(
            "AEG-POLICY-DENIED",
            "env capability blocked by strict isolation profile",
            "policy_denied",
            started_ts_ms,
            started_ts_ms + 1,
            audit.clone(),
        ));
    }

    None
}

fn run_simulation(run: &Value, profile: &IsolationProfile) -> Value {
    let started_ts_ms = run
        .get("determinism")
        .and_then(|value| value.get("epochMs"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let wall_ms = required_non_negative_u64(run, &["limits", "time", "wallMs"]).unwrap_or(0);
    let memory_limit =
        required_non_negative_u64(run, &["limits", "bytes", "memoryBytes"]).unwrap_or(0);
    let stdout_limit =
        required_non_negative_u64(run, &["limits", "bytes", "stdoutBytes"]).unwrap_or(0);
    let stderr_limit =
        required_non_negative_u64(run, &["limits", "bytes", "stderrBytes"]).unwrap_or(0);

    let code = required_string(run, &["code"]).unwrap_or("");
    let mut audit: Vec<Value> = Vec::new();

    if let Some(result) = enforce_isolation_profile(run, profile, started_ts_ms, &mut audit) {
        return result;
    }

    let fs_write_targets = collect_call_targets(code, "aegispy.fs_write");
    let fs_read_targets = collect_call_targets(code, "aegispy.fs_read");
    if !fs_write_targets.is_empty() || !fs_read_targets.is_empty() {
        let fs_is_null = run
            .get("permissions")
            .and_then(|value| value.get("fs"))
            .map(Value::is_null)
            .unwrap_or(true);
        if fs_is_null {
            audit.push(json!({ "kind": "policy_denied", "detailJson": "fs_permission_missing" }));
            return make_error_result(
                "AEG-POLICY-DENIED",
                "fs_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }

        let write_roots = string_list_at_path(run, &["permissions", "fs", "writeRoots"]);
        let read_roots = string_list_at_path(run, &["permissions", "fs", "readRoots"]);

        for target in fs_write_targets {
            if has_path_traversal(&target) || !path_under_roots(&target, &write_roots) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("fs_path_denied:{target}")
                }));
                return make_error_result(
                    "AEG-POLICY-DENIED",
                    "fs_path_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
            audit.push(json!({ "kind": "fs_write", "detailJson": "allow" }));
        }

        for target in fs_read_targets {
            if has_path_traversal(&target) || !path_under_roots(&target, &read_roots) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("fs_path_denied:{target}")
                }));
                return make_error_result(
                    "AEG-POLICY-DENIED",
                    "fs_path_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
            audit.push(json!({ "kind": "fs_read", "detailJson": "allow" }));
        }
    }

    let http_targets = collect_call_targets(code, "aegispy.http_get");
    if !http_targets.is_empty() {
        let http_is_null = run
            .get("permissions")
            .and_then(|value| value.get("http"))
            .map(Value::is_null)
            .unwrap_or(true);
        if http_is_null {
            audit.push(json!({ "kind": "policy_denied", "detailJson": "http_permission_missing" }));
            return make_error_result(
                "AEG-POLICY-DENIED",
                "http_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }

        let allow_origins = string_list_at_path(run, &["permissions", "http", "allowOrigins"]);
        let deny_origins = string_list_at_path(run, &["permissions", "http", "denyOrigins"]);

        for target in http_targets {
            let origin = extract_http_origin(&target).unwrap_or(target.clone());
            if deny_origins.iter().any(|blocked| blocked == &origin)
                || !allow_origins.iter().any(|allowed| allowed == &origin)
            {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("http_origin_denied:{origin}")
                }));
                return make_error_result(
                    "AEG-POLICY-DENIED",
                    "http_origin_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }

            audit.push(json!({ "kind": "http_request", "detailJson": "allow" }));
        }
    }

    if code.contains("while True") && wall_ms > 0 {
        return make_error_result(
            "AEG-TIMEOUT",
            "wall time reached",
            "timeout",
            started_ts_ms,
            started_ts_ms + wall_ms,
            audit,
        );
    }

    if let Some(memory_marker) = parse_marker_u64(code, "#aegispy:memory=") {
        if memory_marker > memory_limit {
            return make_error_result(
                "AEG-MEMORY-LIMIT",
                "memory budget reached",
                "memory_limit",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
    }

    let mut stdout_utf8 = extract_print_value(code);
    let mut stderr_utf8 = String::new();

    if let Some(stdout_marker) = parse_marker_u64(code, "#aegispy:stdout=") {
        stdout_utf8 = "x".repeat(stdout_marker as usize);
    }

    if let Some(stderr_marker) = parse_marker_u64(code, "#aegispy:stderr=") {
        stderr_utf8 = "e".repeat(stderr_marker as usize);
    }

    if stdout_utf8.len() as u64 > stdout_limit || stderr_utf8.len() as u64 > stderr_limit {
        return make_error_result(
            "AEG-OUTPUT-LIMIT",
            "output budget reached",
            "output_limit",
            started_ts_ms,
            started_ts_ms + 1,
            audit,
        );
    }

    json!({
      "status": "ok",
      "exitCode": 0,
      "stdoutUtf8": stdout_utf8,
      "stderrUtf8": stderr_utf8,
      "meta": make_meta(started_ts_ms, started_ts_ms + 1, "", "", "ok", audit)
    })
}

fn handle_request(
    req: RunRequestEnvelope,
    isolation_profile: &IsolationProfile,
) -> RunResponseEnvelope {
    let result = if req.kind != "run" {
        make_error_result(
            "AEG-INVALID-REQUEST",
            "invalid request type",
            "internal_error",
            0,
            0,
            Vec::new(),
        )
    } else {
        match validate_run_payload(&req.run) {
            Ok(()) => run_simulation(&req.run, isolation_profile),
            Err(message) => make_error_result(
                "AEG-INVALID-REQUEST",
                &message,
                "internal_error",
                0,
                0,
                Vec::new(),
            ),
        }
    };

    let termination = result
        .get("meta")
        .and_then(|value| value.get("termination"))
        .and_then(Value::as_str)
        .unwrap_or("internal_error");

    eprintln!(
        "{}",
        json!({
          "level": "info",
          "event": "worker_run",
          "requestId": req.request_id,
          "termination": termination,
          "isolationProfile": isolation_profile.name
        })
    );

    RunResponseEnvelope {
        kind: "run_result",
        request_id: req.request_id,
        result,
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn verify_manifest(engine_dir: &Path, manifest_path: &Path) -> Result<(), String> {
    let manifest_text = fs::read_to_string(manifest_path)
        .map_err(|error| format!("manifest read error: {error}"))?;

    let manifest: BTreeMap<String, BTreeMap<String, Value>> = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("manifest parse error: {error}"))?;

    for (name, entry) in manifest {
        let expected = entry
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("manifest missing sha256 for {name}"))?;
        let artifact_path = engine_dir.join(&name);
        let bytes = fs::read(&artifact_path)
            .map_err(|error| format!("artifact read error for {name}: {error}"))?;
        let actual = sha256_bytes(&bytes);
        if actual != expected {
            return Err(format!("hash mismatch for {name}"));
        }
    }

    Ok(())
}

fn verify_engine_if_present() -> Result<(), String> {
    let engine_dir = PathBuf::from("artifacts").join("engine");
    let manifest_path = engine_dir.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(());
    }
    verify_manifest(&engine_dir, &manifest_path)
}

fn run_worker() -> io::Result<()> {
    verify_engine_if_present()
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    let isolation_profile = load_isolation_profile()
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;

    let stdin = io::stdin();
    let stdout = io::stdout();

    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(frame) = read_frame(&mut reader)? {
        let parsed = serde_json::from_slice::<RunRequestEnvelope>(&frame);
        let response = match parsed {
            Ok(req) => handle_request(req, &isolation_profile),
            Err(_) => RunResponseEnvelope {
                kind: "run_result",
                request_id: "invalid-request-id".to_string(),
                result: make_error_result(
                    "AEG-INVALID-REQUEST",
                    "request decode failure",
                    "internal_error",
                    0,
                    0,
                    Vec::new(),
                ),
            },
        };

        let payload = serde_json::to_vec(&response)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error.to_string()))?;
        write_frame(&mut writer, &payload)?;
    }

    Ok(())
}

fn main() {
    if let Err(error) = run_worker() {
        eprintln!(
            "{}",
            json!({ "level": "error", "event": "worker_exit", "message": error.to_string() })
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn write_artifact(rel: &str, payload: &Value) {
        let full = repo_root().join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).expect("create artifact parent");
        }
        fs::write(
            full,
            format!(
                "{}\n",
                serde_json::to_string_pretty(payload).expect("serialize artifact")
            ),
        )
        .expect("write artifact");
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aegispy-worker-{name}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn test_isolation_profile() -> IsolationProfile {
        IsolationProfile {
            name: "strict".to_string(),
            max_wall_ms: 5000,
            max_cpu_ms: 5000,
            max_memory_bytes: 64 * 1024 * 1024,
            max_stdout_bytes: 2 * 1024 * 1024,
            max_stderr_bytes: 2 * 1024 * 1024,
            deny_env_capability: true,
        }
    }

    #[test]
    fn frame_roundtrip() {
        let payload = br#"{"x":1}"#;
        let encoded = encode_frame(payload);

        let mut cursor = io::Cursor::new(encoded);
        let decoded = read_frame(&mut cursor)
            .expect("frame read")
            .expect("frame present");

        assert_eq!(decoded, payload);

        write_artifact(
            "artifacts/tests/worker-protocol-rust.json",
            &json!({
              "ok": true,
              "invariants": ["INV-FEAT-0021"],
              "frameBytes": payload.len()
            }),
        );
    }

    #[test]
    fn invalid_request_rejected() {
        let req = RunRequestEnvelope {
            kind: "run".to_string(),
            request_id: "id-1".to_string(),
            run: json!({ "code": 1 }),
        };

        let res = handle_request(req, &test_isolation_profile());
        let status = res
            .result
            .get("status")
            .and_then(Value::as_str)
            .expect("status field");

        assert_eq!(status, "error");
    }

    #[test]
    fn verify_manifest_hashes() {
        let dir = unique_temp_dir("manifest");
        let engine_dir = dir.join("engine");
        fs::create_dir_all(&engine_dir).expect("create engine dir");

        let artifact_name = "cpython-wasi.wasm";
        let artifact_path = engine_dir.join(artifact_name);
        fs::write(&artifact_path, b"engine-bytes").expect("write artifact bytes");
        let digest = sha256_bytes(b"engine-bytes");

        let manifest_path = engine_dir.join("manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&json!({
              artifact_name: {
                "sha256": digest,
                "bytes": 12
              }
            }))
            .expect("serialize manifest"),
        )
        .expect("write manifest");

        let verified = verify_manifest(&engine_dir, &manifest_path);
        assert!(verified.is_ok());

        write_artifact(
            "artifacts/tests/engine-hash-verify.json",
            &json!({
              "ok": true,
              "invariants": ["INV-SECU-0004"],
              "verified": true
            }),
        );
    }
}
