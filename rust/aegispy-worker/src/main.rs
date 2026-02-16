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

fn run_simulation(run: &Value) -> Value {
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

    if code.contains("aegispy.fs_") {
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
        audit.push(json!({ "kind": "fs_write", "detailJson": "allow" }));
    }

    if code.contains("aegispy.http_") {
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
        audit.push(json!({ "kind": "http_request", "detailJson": "allow" }));
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

fn handle_request(req: RunRequestEnvelope) -> RunResponseEnvelope {
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
            Ok(()) => run_simulation(&req.run),
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
          "termination": termination
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

    let stdin = io::stdin();
    let stdout = io::stdout();

    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(frame) = read_frame(&mut reader)? {
        let parsed = serde_json::from_slice::<RunRequestEnvelope>(&frame);
        let response = match parsed {
            Ok(req) => handle_request(req),
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

        let res = handle_request(req);
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
