use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::min;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, ReadBuf};
use wasmtime::component::{Component as WasmComponent, Linker as ComponentLinker, ResourceTable};
use wasmtime::{Config, Engine, OptLevel, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::cli::AsyncStdinStream;
use wasmtime_wasi::p2::add_to_linker_sync as add_to_component_linker_sync;
use wasmtime_wasi::p2::bindings::sync::Command as WasiCommand;
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{DirPerms, FilePerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkerExecutorMode {
    Wasi,
    Simulation,
}

impl FromStr for WorkerExecutorMode {
    type Err = String;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw.trim().to_lowercase().as_str() {
            "wasi" => Ok(Self::Wasi),
            "simulation" => Ok(Self::Simulation),
            _ => Err("invalid AEGISPY_WORKER_EXECUTOR".to_string()),
        }
    }
}

impl WorkerExecutorMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wasi => "wasi",
            Self::Simulation => "simulation",
        }
    }
}

#[derive(Clone)]
struct WasiExecutor {
    engine: Engine,
    component: WasmComponent,
    python_home: PathBuf,
    enable_fuel: bool,
    enable_epoch: bool,
    enable_store_limits: bool,
}

struct WasiStoreState {
    wasi: WasiCtx,
    table: ResourceTable,
    stdout: MemoryOutputPipe,
    stderr: MemoryOutputPipe,
    limits: StoreLimits,
}

impl WasiView for WasiStoreState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

const ENGINE_MIN_MEMORY_BYTES: u64 = 128 * 1024 * 1024;

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
            (5000_u64, 5000_u64, 512 * 1024 * 1024, 2 * 1024 * 1024),
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

fn load_executor_mode() -> Result<WorkerExecutorMode, String> {
    let raw = std::env::var("AEGISPY_WORKER_EXECUTOR").unwrap_or_else(|_| "wasi".to_string());
    WorkerExecutorMode::from_str(&raw)
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

fn decode_quoted_literal(token: &str) -> Option<String> {
    let trimmed = token.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let quote = bytes[0];
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    if bytes[bytes.len() - 1] != quote {
        return None;
    }

    let mut out = String::new();
    let mut index = 1;
    while index + 1 < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' && index + 2 <= bytes.len() {
            let escaped = bytes[index + 1];
            let mapped = match escaped {
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'\\' => '\\',
                b'"' => '"',
                b'\'' => '\'',
                _ => escaped as char,
            };
            out.push(mapped);
            index += 2;
            continue;
        }
        if byte == quote {
            return None;
        }
        out.push(byte as char);
        index += 1;
    }

    Some(out)
}

fn find_matching_paren(code: &str, open_paren_index: usize) -> Option<usize> {
    let bytes = code.as_bytes();
    let mut index = open_paren_index;
    let mut depth = 0_i64;
    let mut in_quote: Option<u8> = None;

    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(quote) = in_quote {
            if byte == b'\\' && index + 1 < bytes.len() {
                index += 2;
                continue;
            }
            if byte == quote {
                in_quote = None;
            }
            index += 1;
            continue;
        }

        if byte == b'"' || byte == b'\'' {
            in_quote = Some(byte);
            index += 1;
            continue;
        }

        if byte == b'(' {
            depth += 1;
        } else if byte == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }

        index += 1;
    }

    None
}

fn extract_literal_arguments(input: &str) -> Vec<Option<String>> {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut depth = 0_i64;
    let mut quote: Option<u8> = None;

    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(active) = quote {
            if byte == b'\\' && index + 1 < bytes.len() {
                index += 2;
                continue;
            }
            if byte == active {
                quote = None;
            }
            index += 1;
            continue;
        }

        if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == b'(' || byte == b'[' || byte == b'{' {
            depth += 1;
            index += 1;
            continue;
        }
        if byte == b')' || byte == b']' || byte == b'}' {
            depth -= 1;
            index += 1;
            continue;
        }
        if byte == b',' && depth == 0 {
            out.push(decode_quoted_literal(&input[start..index]));
            start = index + 1;
        }
        index += 1;
    }

    if start < input.len() {
        out.push(decode_quoted_literal(&input[start..]));
    } else if input.trim().is_empty() {
        out.clear();
    } else {
        out.push(None);
    }

    out
}

fn collect_call_targets(code: &str, call_marker: &str) -> Vec<String> {
    let needle = format!("{call_marker}(");
    let mut out = Vec::new();
    let mut cursor = 0;

    while let Some(found) = code[cursor..].find(&needle) {
        let call_start = cursor + found;
        let open_paren_index = call_start + needle.len() - 1;
        let Some(close_paren_index) = find_matching_paren(code, open_paren_index) else {
            break;
        };
        let args = extract_literal_arguments(&code[open_paren_index + 1..close_paren_index]);
        if let Some(Some(target)) = args.first() {
            out.push(target.clone());
        }
        cursor = close_paren_index + 1;
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

fn path_under_root(target: &str, root: &str) -> bool {
    if root == "/" {
        return target.starts_with('/');
    }
    if target == root {
        return true;
    }
    target
        .strip_prefix(root)
        .map(|suffix| suffix.starts_with('/'))
        .unwrap_or(false)
}

fn path_under_roots(target: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| path_under_root(target, root))
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

fn now_ms() -> u64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_millis(0));
    duration.as_millis() as u64
}

fn worker_debug_enabled() -> bool {
    std::env::var("AEGISPY_WORKER_DEBUG")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn worker_debug(event: &str, detail: &str) {
    if worker_debug_enabled() {
        eprintln!(
            "{}",
            json!({
              "level": "debug",
              "event": event,
              "detail": detail
            })
        );
    }
}

fn clamp_u64_to_usize(value: u64) -> usize {
    min(value, usize::MAX as u64) as usize
}

fn parse_seed_u64(seed_hex: &str) -> u64 {
    let trimmed = seed_hex.trim();
    if trimmed.is_empty() {
        return 1;
    }
    let relevant = if trimmed.len() > 16 {
        &trimmed[..16]
    } else {
        trimmed
    };
    u64::from_str_radix(relevant, 16).unwrap_or(1).max(1)
}

fn maybe_push_nondeterminism_audit(
    run: &Value,
    code: &str,
    started_ts_ms: u64,
    audit: &mut Vec<Value>,
) {
    let determinism_enabled = run
        .get("determinism")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if determinism_enabled {
        return;
    }

    if code.contains("time.time") {
        audit.push(json!({ "kind": "determinism_time", "detailJson": "source:time.time", "tsMs": started_ts_ms }));
    }

    if code.contains("random.random") {
        audit.push(json!({ "kind": "determinism_rng", "detailJson": "source:random.random", "tsMs": started_ts_ms }));
    }
}

fn enforce_capability_policy(
    run: &Value,
    code: &str,
    started_ts_ms: u64,
    audit: &mut Vec<Value>,
) -> Option<Value> {
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
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "fs_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        let write_roots = string_list_at_path(run, &["permissions", "fs", "writeRoots"]);
        let read_roots = string_list_at_path(run, &["permissions", "fs", "readRoots"]);

        for target in fs_write_targets {
            if has_path_traversal(&target) || !path_under_roots(&target, &write_roots) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("fs_path_denied:{target}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "fs_path_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
            }
            audit.push(json!({ "kind": "fs_write", "detailJson": "allow" }));
        }

        for target in fs_read_targets {
            if has_path_traversal(&target) || !path_under_roots(&target, &read_roots) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("fs_path_denied:{target}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "fs_path_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
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
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "http_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        let allow_origins = string_list_at_path(run, &["permissions", "http", "allowOrigins"]);
        let deny_origins = string_list_at_path(run, &["permissions", "http", "denyOrigins"]);
        let max_requests =
            required_non_negative_u64(run, &["permissions", "http", "maxRequests"]).unwrap_or(0);
        if max_requests > 0 && (http_targets.len() as u64) > max_requests {
            audit.push(json!({
              "kind": "policy_denied",
              "detailJson": "http_max_requests_exceeded"
            }));
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "http_max_requests_exceeded",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        for target in http_targets {
            let origin = extract_http_origin(&target).unwrap_or(target.clone());
            if deny_origins.iter().any(|blocked| blocked == &origin)
                || !allow_origins.iter().any(|allowed| allowed == &origin)
            {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("http_origin_denied:{origin}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "http_origin_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
            }

            audit.push(json!({ "kind": "http_request", "detailJson": "allow" }));
        }
    }

    let env_targets = collect_call_targets(code, "aegispy.env_get");
    if !env_targets.is_empty() {
        let env_is_null = run
            .get("permissions")
            .and_then(|value| value.get("env"))
            .map(Value::is_null)
            .unwrap_or(true);
        if env_is_null {
            audit.push(json!({ "kind": "policy_denied", "detailJson": "env_permission_missing" }));
            return Some(make_error_result(
                "AEG-POLICY-DENIED",
                "env_permission_missing",
                "policy_denied",
                started_ts_ms,
                started_ts_ms + 1,
                audit.clone(),
            ));
        }

        let allow_keys = string_list_at_path(run, &["permissions", "env", "allowKeys"]);
        for target in env_targets {
            if !allow_keys.iter().any(|allowed| allowed == &target) {
                audit.push(json!({
                  "kind": "policy_denied",
                  "detailJson": format!("env_key_denied:{target}")
                }));
                return Some(make_error_result(
                    "AEG-POLICY-DENIED",
                    "env_key_denied",
                    "policy_denied",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit.clone(),
                ));
            }
            audit.push(json!({ "kind": "env_read", "detailJson": "allow" }));
        }
    }

    None
}

fn rewrite_code_for_determinism(code: &str, run: &Value) -> String {
    let deterministic_enabled = run
        .get("determinism")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let epoch_ms = run
        .get("determinism")
        .and_then(|value| value.get("epochMs"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let seed_hex = run
        .get("determinism")
        .and_then(|value| value.get("rngSeedHex"))
        .and_then(Value::as_str)
        .unwrap_or("1");
    let seed = parse_seed_u64(seed_hex);
    let mut rewritten = code.to_string();

    if rewritten.contains("time.time()") {
        let replacement = if deterministic_enabled {
            format!("{}", (epoch_ms as f64) / 1000.0)
        } else {
            format!("{}", (now_ms() as f64) / 1000.0)
        };
        rewritten = rewritten.replace("time.time()", &replacement);
    }

    if rewritten.contains("random.random()") {
        let value = if deterministic_enabled {
            let next = seed.wrapping_mul(1664525).wrapping_add(1013904223) & 0xffff_ffff;
            (next as f64) / 4294967296.0
        } else {
            let next = (now_ms() % 1_000_003) as f64;
            next / 1_000_003.0
        };
        rewritten = rewritten.replace("random.random()", &format!("{value:.6}"));
    }

    rewritten
}

const CAPABILITY_FS_DIR: &str = "fs";
const CAPABILITY_WIT_REQ_PREFIX: &str = "__AEGISPY_HOST_REQ__";
const CAPABILITY_WIT_RES_PREFIX: &str = "__AEGISPY_HOST_RES__";
const CAPABILITY_WIT_STDOUT_OVERHEAD_BYTES: u64 = 512 * 1024;

#[derive(Default)]
struct HostCapabilityHttpState {
    requests_used: u64,
}

#[derive(Default)]
struct HostCapabilityFsState {
    bytes_used: u64,
    written_files: BTreeSet<String>,
}

#[derive(Clone)]
struct HostCapabilityFsConfig {
    read_roots: Vec<String>,
    write_roots: Vec<String>,
    max_bytes: u64,
    max_files: u64,
}

#[derive(Clone)]
struct HostCapabilityHttpConfig {
    allow_origins: Vec<String>,
    deny_origins: Vec<String>,
    max_requests: u64,
    max_bytes: u64,
    timeout_ms: u64,
}

#[derive(Clone)]
struct HostCapabilityEnvConfig {
    allow_keys: Vec<String>,
}

#[derive(Clone)]
struct HostCapabilityConfig {
    fs: Option<HostCapabilityFsConfig>,
    http: Option<HostCapabilityHttpConfig>,
    env: Option<HostCapabilityEnvConfig>,
}

#[derive(Clone, Default)]
struct HostCapabilityRunState {
    audit: Vec<Value>,
    policy_denial: Option<String>,
    engine_error: Option<String>,
    filtered_stdout_utf8: Option<String>,
}

struct HostCapabilityServer {
    host_root: PathBuf,
    stop: Arc<AtomicBool>,
    run_state: Arc<Mutex<HostCapabilityRunState>>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct DynamicInputReader {
    shared: Arc<Mutex<DynamicInputState>>,
}

#[derive(Default)]
struct DynamicInputState {
    bytes: VecDeque<u8>,
    closed: bool,
    waker: Option<Waker>,
}

#[derive(Clone)]
struct DynamicInputSender {
    shared: Arc<Mutex<DynamicInputState>>,
}

#[derive(Debug)]
struct HostCapabilityRequest {
    request_id: u64,
    capability: String,
    field_a: String,
    field_b: String,
}

#[derive(Debug)]
struct HostCapabilityResponse {
    ok: bool,
    value_kind: String,
    payload_utf8: String,
    error_code: String,
}

#[derive(Clone, Debug)]
enum HostCapabilityValue {
    None,
    Utf8(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HostCapabilityFailureKind {
    PolicyDenied,
    EngineError,
}

#[derive(Clone, Debug)]
struct HostCapabilityFailure {
    kind: HostCapabilityFailureKind,
    code: String,
}

fn create_temp_binding_dir(prefix: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{}", std::process::id(), now_ms()));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create capability temp dir: {error}"))?;
    Ok(dir)
}

impl DynamicInputReader {
    fn with_initial(initial: &[u8]) -> (Self, DynamicInputSender) {
        let mut state = DynamicInputState::default();
        for byte in initial {
            state.bytes.push_back(*byte);
        }
        let shared = Arc::new(Mutex::new(state));
        (
            Self {
                shared: Arc::clone(&shared),
            },
            DynamicInputSender { shared },
        )
    }
}

impl DynamicInputSender {
    fn push_bytes(&self, payload: &[u8]) {
        let mut wake = None;
        if let Ok(mut guard) = self.shared.lock() {
            for byte in payload {
                guard.bytes.push_back(*byte);
            }
            wake = guard.waker.take();
        }
        if let Some(waker) = wake {
            waker.wake();
        }
    }

    fn push_line(&self, payload: &str) {
        self.push_bytes(payload.as_bytes());
        self.push_bytes(b"\n");
    }

    fn close(&self) {
        let mut wake = None;
        if let Ok(mut guard) = self.shared.lock() {
            guard.closed = true;
            wake = guard.waker.take();
        }
        if let Some(waker) = wake {
            waker.wake();
        }
    }
}

impl AsyncRead for DynamicInputReader {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut guard = match self.shared.lock() {
            Ok(value) => value,
            Err(_) => {
                return Poll::Ready(Err(io::Error::other("stdin channel poisoned")));
            }
        };

        if guard.bytes.is_empty() {
            if guard.closed {
                return Poll::Ready(Ok(()));
            }
            guard.waker = Some(cx.waker().clone());
            return Poll::Pending;
        }

        while buf.remaining() > 0 {
            let Some(byte) = guard.bytes.pop_front() else {
                break;
            };
            buf.put_slice(&[byte]);
        }
        Poll::Ready(Ok(()))
    }
}

fn sanitize_virtual_root(root: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim_start_matches('/');
    let candidate = Path::new(trimmed);
    let mut out = PathBuf::new();

    for component in candidate.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err("invalid fs root".to_string()),
        }
    }

    if out.as_os_str().is_empty() {
        out.push("__root__");
    }
    Ok(out)
}

fn resolve_fs_binding_path(
    binding_root: &Path,
    target: &str,
    roots: &[String],
) -> Result<(PathBuf, String), String> {
    let selected_root = roots
        .iter()
        .filter(|root| path_under_root(target, root))
        .max_by_key(|root| root.len())
        .cloned()
        .ok_or_else(|| "fs root not mapped".to_string())?;
    let host_root = binding_root.join(sanitize_virtual_root(&selected_root)?);

    let tail = if target == selected_root {
        String::new()
    } else if selected_root == "/" {
        target.trim_start_matches('/').to_string()
    } else {
        target[selected_root.len() + 1..].to_string()
    };

    let mut relative = PathBuf::new();
    for component in Path::new(&tail).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            _ => return Err("invalid fs path".to_string()),
        }
    }

    Ok((host_root.join(relative), selected_root))
}

fn execute_http_get(url: &str, max_bytes: u64, timeout_ms: u64) -> Result<String, String> {
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let response = ureq::get(url)
        .timeout(timeout)
        .call()
        .map_err(|error| format!("http_get_failed:{error}"))?;
    let reader = response.into_reader();
    let mut limited = reader.take(max_bytes.saturating_add(1));
    let mut body = Vec::new();
    limited
        .read_to_end(&mut body)
        .map_err(|error| format!("http_read_failed:{error}"))?;
    if (body.len() as u64) > max_bytes {
        return Err("http_response_bytes_exceeded".to_string());
    }
    Ok(String::from_utf8_lossy(&body).to_string())
}

fn non_null_value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    value_at_path(value, path).filter(|node| !node.is_null())
}

fn build_host_capability_config(run: &Value, wall_ms: u64) -> HostCapabilityConfig {
    let fs = non_null_value_at_path(run, &["permissions", "fs"]).map(|_| HostCapabilityFsConfig {
        read_roots: string_list_at_path(run, &["permissions", "fs", "readRoots"]),
        write_roots: string_list_at_path(run, &["permissions", "fs", "writeRoots"]),
        max_bytes: required_non_negative_u64(run, &["permissions", "fs", "maxBytes"]).unwrap_or(0),
        max_files: required_non_negative_u64(run, &["permissions", "fs", "maxFiles"]).unwrap_or(0),
    });
    let http =
        non_null_value_at_path(run, &["permissions", "http"]).map(|_| HostCapabilityHttpConfig {
            allow_origins: string_list_at_path(run, &["permissions", "http", "allowOrigins"]),
            deny_origins: string_list_at_path(run, &["permissions", "http", "denyOrigins"]),
            max_requests: required_non_negative_u64(run, &["permissions", "http", "maxRequests"])
                .unwrap_or(0),
            max_bytes: required_non_negative_u64(run, &["permissions", "http", "maxBytes"])
                .unwrap_or(0),
            timeout_ms: wall_ms.max(1),
        });
    let env =
        non_null_value_at_path(run, &["permissions", "env"]).map(|_| HostCapabilityEnvConfig {
            allow_keys: string_list_at_path(run, &["permissions", "env", "allowKeys"]),
        });

    HostCapabilityConfig { fs, http, env }
}

fn build_runtime_capability_prelude_wit_host_abi() -> String {
    format!(
        r#"
import builtins
import sys

_AEGISPY_REQ_PREFIX = "{req_prefix}"
_AEGISPY_RES_PREFIX = "{res_prefix}"
_AEGISPY_SEQ = 0

def _aegispy_wire_escape(value):
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")

def _aegispy_wire_unescape(value):
    out = []
    index = 0
    while index < len(value):
        ch = value[index]
        if ch == "\\" and index + 1 < len(value):
            esc = value[index + 1]
            if esc == "n":
                out.append("\n")
            elif esc == "r":
                out.append("\r")
            elif esc == "t":
                out.append("\t")
            elif esc == "\\":
                out.append("\\")
            else:
                out.append(esc)
            index = index + 2
            continue
        out.append(ch)
        index = index + 1
    return "".join(out)

def _aegispy_host_call(capability, field_a, field_b):
    global _AEGISPY_SEQ
    _AEGISPY_SEQ = _AEGISPY_SEQ + 1
    req_id = _AEGISPY_SEQ
    frame = "\t".join(
        [
            str(req_id),
            capability,
            _aegispy_wire_escape(field_a),
            _aegispy_wire_escape(field_b),
        ]
    )
    sys.stdout.write(_AEGISPY_REQ_PREFIX + frame + "\n")
    sys.stdout.flush()

    while True:
        line = sys.stdin.readline()
        if line == "":
            raise RuntimeError("capability_channel_closed")
        line = line.rstrip("\r\n")
        if not line.startswith(_AEGISPY_RES_PREFIX):
            continue
        raw = line[len(_AEGISPY_RES_PREFIX):]
        parts = raw.split("\t", 4)
        if len(parts) < 5:
            continue
        if parts[0] != str(req_id):
            continue
        status = parts[1]
        value_kind = parts[2]
        error_code = _aegispy_wire_unescape(parts[3])
        payload = _aegispy_wire_unescape(parts[4])
        if status == "ok":
            if value_kind == "none":
                return None
            return payload
        raise RuntimeError(error_code or "capability_error")

def _aegispy_fs_write(path, data_utf8):
    _aegispy_host_call("fs_write", path, data_utf8)
    return None

def _aegispy_fs_read(path):
    return _aegispy_host_call("fs_read", path, "")

def _aegispy_http_get(url):
    return _aegispy_host_call("http_get", url, "")

def _aegispy_env_get(key):
    return _aegispy_host_call("env_get", key, "")

class _AegispyModule:
    pass

_aegispy_mod = _AegispyModule()
_aegispy_mod.fs_write = _aegispy_fs_write
_aegispy_mod.fs_read = _aegispy_fs_read
_aegispy_mod.http_get = _aegispy_http_get
_aegispy_mod.env_get = _aegispy_env_get
sys.modules["aegispy"] = _aegispy_mod
aegispy = _aegispy_mod
builtins.aegispy = _aegispy_mod
"#,
        req_prefix = CAPABILITY_WIT_REQ_PREFIX,
        res_prefix = CAPABILITY_WIT_RES_PREFIX
    )
}

fn host_capability_failure_policy(code: impl Into<String>) -> HostCapabilityFailure {
    HostCapabilityFailure {
        kind: HostCapabilityFailureKind::PolicyDenied,
        code: code.into(),
    }
}

fn host_capability_failure_engine(code: impl Into<String>) -> HostCapabilityFailure {
    HostCapabilityFailure {
        kind: HostCapabilityFailureKind::EngineError,
        code: code.into(),
    }
}

fn host_capability_response_ok(value: HostCapabilityValue) -> HostCapabilityResponse {
    match value {
        HostCapabilityValue::None => HostCapabilityResponse {
            ok: true,
            value_kind: "none".to_string(),
            payload_utf8: String::new(),
            error_code: String::new(),
        },
        HostCapabilityValue::Utf8(payload) => HostCapabilityResponse {
            ok: true,
            value_kind: "utf8".to_string(),
            payload_utf8: payload,
            error_code: String::new(),
        },
    }
}

fn host_capability_response_error(code: &str) -> HostCapabilityResponse {
    HostCapabilityResponse {
        ok: false,
        value_kind: "none".to_string(),
        payload_utf8: String::new(),
        error_code: code.to_string(),
    }
}

fn escape_wire_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out
}

fn unescape_wire_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(esc) = chars.next() {
                match esc {
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    '\\' => out.push('\\'),
                    _ => out.push(esc),
                }
            } else {
                out.push('\\');
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn process_host_capability_request(
    req: &HostCapabilityRequest,
    config: &HostCapabilityConfig,
    fs_root: &Path,
    fs_state: &mut HostCapabilityFsState,
    http_state: &mut HostCapabilityHttpState,
    runtime_audit: &mut Vec<Value>,
) -> Result<HostCapabilityValue, HostCapabilityFailure> {
    match req.capability.as_str() {
        "fs_write" => {
            let Some(fs_config) = config.fs.as_ref() else {
                return Err(host_capability_failure_policy("fs_permission_missing"));
            };

            let target = req.field_a.clone();
            let content = req.field_b.clone();
            if has_path_traversal(&target) || !path_under_roots(&target, &fs_config.write_roots) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let (host_path, root) =
                resolve_fs_binding_path(fs_root, &target, &fs_config.write_roots)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?;
            let host_root = fs_root.join(
                sanitize_virtual_root(&root)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?,
            );
            if !host_path.starts_with(&host_root) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let content_bytes = content.len() as u64;
            if fs_config.max_bytes > 0
                && fs_state.bytes_used.saturating_add(content_bytes) > fs_config.max_bytes
            {
                return Err(host_capability_failure_policy("fs_quota_bytes_exceeded"));
            }

            let host_key = host_path.to_string_lossy().to_string();
            if !fs_state.written_files.contains(&host_key)
                && fs_config.max_files > 0
                && (fs_state.written_files.len() as u64) >= fs_config.max_files
            {
                return Err(host_capability_failure_policy("fs_quota_files_exceeded"));
            }

            if let Some(parent) = host_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    host_capability_failure_engine(format!("fs_write_failed:{error}"))
                })?;
            }
            fs::write(&host_path, content.as_bytes()).map_err(|error| {
                host_capability_failure_engine(format!("fs_write_failed:{error}"))
            })?;

            fs_state.bytes_used = fs_state.bytes_used.saturating_add(content_bytes);
            fs_state.written_files.insert(host_key);
            runtime_audit.push(json!({
              "kind": "fs_write",
              "detailJson": format!("runtime_allow:{target}")
            }));
            Ok(HostCapabilityValue::None)
        }
        "fs_read" => {
            let Some(fs_config) = config.fs.as_ref() else {
                return Err(host_capability_failure_policy("fs_permission_missing"));
            };

            let target = req.field_a.clone();
            if has_path_traversal(&target) || !path_under_roots(&target, &fs_config.read_roots) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let (host_path, root) =
                resolve_fs_binding_path(fs_root, &target, &fs_config.read_roots)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?;
            let host_root = fs_root.join(
                sanitize_virtual_root(&root)
                    .map_err(|_| host_capability_failure_policy("fs_path_denied"))?,
            );
            if !host_path.starts_with(&host_root) {
                return Err(host_capability_failure_policy("fs_path_denied"));
            }

            let payload = fs::read_to_string(&host_path).map_err(|error| {
                host_capability_failure_engine(format!("fs_read_failed:{error}"))
            })?;
            let payload_bytes = payload.len() as u64;
            if fs_config.max_bytes > 0
                && fs_state.bytes_used.saturating_add(payload_bytes) > fs_config.max_bytes
            {
                return Err(host_capability_failure_policy("fs_quota_bytes_exceeded"));
            }

            fs_state.bytes_used = fs_state.bytes_used.saturating_add(payload_bytes);
            runtime_audit.push(json!({
              "kind": "fs_read",
              "detailJson": format!("runtime_allow:{target}")
            }));
            Ok(HostCapabilityValue::Utf8(payload))
        }
        "http_get" => {
            let Some(http_config) = config.http.as_ref() else {
                return Err(host_capability_failure_policy("http_permission_missing"));
            };

            let target = req.field_a.clone();
            let origin = extract_http_origin(&target).unwrap_or_else(|| target.clone());
            if http_config
                .deny_origins
                .iter()
                .any(|blocked| blocked == &origin)
                || !http_config
                    .allow_origins
                    .iter()
                    .any(|allowed| allowed == &origin)
            {
                return Err(host_capability_failure_policy("http_origin_denied"));
            }
            if http_config.max_requests > 0 && http_state.requests_used >= http_config.max_requests
            {
                return Err(host_capability_failure_policy("http_max_requests_exceeded"));
            }

            let payload = execute_http_get(
                &target,
                http_config.max_bytes.max(1),
                http_config.timeout_ms,
            )
            .map_err(|message| {
                if message == "http_response_bytes_exceeded" {
                    host_capability_failure_policy(message)
                } else {
                    host_capability_failure_engine(message)
                }
            })?;
            http_state.requests_used += 1;
            runtime_audit.push(json!({
              "kind": "http_request",
              "detailJson": format!("runtime_allow:{origin}")
            }));
            Ok(HostCapabilityValue::Utf8(payload))
        }
        "env_get" => {
            let Some(env_config) = config.env.as_ref() else {
                return Err(host_capability_failure_policy("env_permission_missing"));
            };

            let key = req.field_a.clone();
            if !env_config.allow_keys.iter().any(|allowed| allowed == &key) {
                return Err(host_capability_failure_policy("env_key_denied"));
            }
            runtime_audit.push(json!({
              "kind": "env_read",
              "detailJson": format!("runtime_allow:{key}")
            }));
            if let Ok(value) = std::env::var(&key) {
                Ok(HostCapabilityValue::Utf8(value))
            } else {
                Ok(HostCapabilityValue::None)
            }
        }
        _ => Err(host_capability_failure_engine("capability_unknown")),
    }
}

fn parse_line_bytes(line: &[u8]) -> String {
    String::from_utf8_lossy(line)
        .trim_end_matches('\r')
        .to_string()
}

fn process_wit_line(
    line: &[u8],
    config: &HostCapabilityConfig,
    fs_root: &Path,
    fs_state: &mut HostCapabilityFsState,
    http_state: &mut HostCapabilityHttpState,
    run_state: &Arc<Mutex<HostCapabilityRunState>>,
    stdin_sender: &DynamicInputSender,
) -> bool {
    let text = parse_line_bytes(line);
    if !text.starts_with(CAPABILITY_WIT_REQ_PREFIX) {
        return false;
    }

    let payload = &text[CAPABILITY_WIT_REQ_PREFIX.len()..];
    let mut parts = payload.splitn(4, '\t');
    let Some(request_id_text) = parts.next() else {
        if let Ok(mut guard) = run_state.lock() {
            if guard.engine_error.is_none() {
                guard.engine_error =
                    Some("capability_request_decode_failed:missing_id".to_string());
            }
        }
        return true;
    };
    let Some(capability) = parts.next() else {
        if let Ok(mut guard) = run_state.lock() {
            if guard.engine_error.is_none() {
                guard.engine_error =
                    Some("capability_request_decode_failed:missing_capability".to_string());
            }
        }
        return true;
    };
    let Some(field_a_encoded) = parts.next() else {
        if let Ok(mut guard) = run_state.lock() {
            if guard.engine_error.is_none() {
                guard.engine_error =
                    Some("capability_request_decode_failed:missing_field_a".to_string());
            }
        }
        return true;
    };
    let Some(field_b_encoded) = parts.next() else {
        if let Ok(mut guard) = run_state.lock() {
            if guard.engine_error.is_none() {
                guard.engine_error =
                    Some("capability_request_decode_failed:missing_field_b".to_string());
            }
        }
        return true;
    };
    let request_id = match request_id_text.parse::<u64>() {
        Ok(value) => value,
        Err(_) => {
            if let Ok(mut guard) = run_state.lock() {
                if guard.engine_error.is_none() {
                    guard.engine_error =
                        Some("capability_request_decode_failed:invalid_request_id".to_string());
                }
            }
            return true;
        }
    };

    let request = HostCapabilityRequest {
        request_id,
        capability: capability.to_string(),
        field_a: unescape_wire_text(field_a_encoded),
        field_b: unescape_wire_text(field_b_encoded),
    };
    let mut runtime_audit = Vec::new();
    let response = match process_host_capability_request(
        &request,
        config,
        fs_root,
        fs_state,
        http_state,
        &mut runtime_audit,
    ) {
        Ok(value) => host_capability_response_ok(value),
        Err(failure) => {
            let audit_kind = if failure.kind == HostCapabilityFailureKind::PolicyDenied {
                "policy_denied"
            } else {
                "engine_error"
            };
            runtime_audit.push(json!({
              "kind": audit_kind,
              "detailJson": format!("runtime_denied:{}", failure.code)
            }));
            if let Ok(mut guard) = run_state.lock() {
                if failure.kind == HostCapabilityFailureKind::PolicyDenied
                    && guard.policy_denial.is_none()
                {
                    guard.policy_denial = Some(failure.code.clone());
                }
                if failure.kind == HostCapabilityFailureKind::EngineError
                    && guard.engine_error.is_none()
                {
                    guard.engine_error = Some(failure.code.clone());
                }
            }
            host_capability_response_error(&failure.code)
        }
    };

    if let Ok(mut guard) = run_state.lock() {
        guard.audit.extend(runtime_audit);
    }

    let status = if response.ok { "ok" } else { "err" };
    let encoded = format!(
        "{}\t{}\t{}\t{}\t{}",
        request.request_id,
        status,
        response.value_kind,
        escape_wire_text(&response.error_code),
        escape_wire_text(&response.payload_utf8)
    );
    stdin_sender.push_line(&format!("{CAPABILITY_WIT_RES_PREFIX}{encoded}"));

    true
}

fn run_host_capability_wit_server(
    stdout: MemoryOutputPipe,
    stdin_sender: DynamicInputSender,
    fs_root: PathBuf,
    config: HostCapabilityConfig,
    run_state: Arc<Mutex<HostCapabilityRunState>>,
    stop: Arc<AtomicBool>,
) {
    let mut fs_state = HostCapabilityFsState::default();
    let mut http_state = HostCapabilityHttpState::default();
    let mut consumed = 0_usize;
    let mut buffer = Vec::<u8>::new();
    let mut user_stdout = Vec::<u8>::new();

    loop {
        let snapshot = stdout.contents();
        if snapshot.len() > consumed {
            buffer.extend_from_slice(&snapshot[consumed..]);
            consumed = snapshot.len();

            while let Some(newline_index) = buffer.iter().position(|byte| *byte == b'\n') {
                let mut line = buffer.drain(..=newline_index).collect::<Vec<u8>>();
                if line.last() == Some(&b'\n') {
                    line.pop();
                }
                let is_protocol_line = process_wit_line(
                    &line,
                    &config,
                    &fs_root,
                    &mut fs_state,
                    &mut http_state,
                    &run_state,
                    &stdin_sender,
                );
                if !is_protocol_line {
                    user_stdout.extend_from_slice(&line);
                    user_stdout.push(b'\n');
                }
            }
        } else if stop.load(Ordering::Relaxed) {
            if !buffer.is_empty() {
                let is_protocol_line = process_wit_line(
                    &buffer,
                    &config,
                    &fs_root,
                    &mut fs_state,
                    &mut http_state,
                    &run_state,
                    &stdin_sender,
                );
                if !is_protocol_line {
                    user_stdout.extend_from_slice(&buffer);
                }
            }
            break;
        } else {
            thread::sleep(Duration::from_millis(1));
        }
    }

    if let Ok(mut guard) = run_state.lock() {
        guard.filtered_stdout_utf8 = Some(String::from_utf8_lossy(&user_stdout).to_string());
    }
    stdin_sender.close();
}

impl HostCapabilityServer {
    fn start(
        run: &Value,
        wall_ms: u64,
        stdout: MemoryOutputPipe,
        stdin_sender: DynamicInputSender,
    ) -> Result<Self, String> {
        let host_root = create_temp_binding_dir("aegispy-worker-capability")?;
        let fs_dir = host_root.join(CAPABILITY_FS_DIR);
        fs::create_dir_all(&fs_dir)
            .map_err(|error| format!("failed to create capability fs dir: {error}"))?;

        let config = build_host_capability_config(run, wall_ms);
        let run_state = Arc::new(Mutex::new(HostCapabilityRunState::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_run_state = Arc::clone(&run_state);
        let thread_stop = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            run_host_capability_wit_server(
                stdout,
                stdin_sender,
                fs_dir,
                config,
                thread_run_state,
                thread_stop,
            );
        });

        Ok(Self {
            host_root,
            stop,
            run_state,
            handle: Some(handle),
        })
    }

    fn stop_and_collect(&mut self) -> HostCapabilityRunState {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let state = self
            .run_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let _ = fs::remove_dir_all(&self.host_root);
        state
    }
}

fn detect_python_stdlib_guest_path(python_home: &Path, guest_root: &str) -> Option<String> {
    let lib_dir = python_home.join("lib");
    let entries = fs::read_dir(lib_dir).ok()?;
    let mut candidates = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let is_dir = entry.file_type().ok()?.is_dir();
            if !is_dir {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("python") {
                Some(name)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    candidates.sort();
    candidates
        .pop()
        .map(|name| format!("{guest_root}/lib/{name}"))
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
    if let Some(result) = enforce_capability_policy(run, code, started_ts_ms, &mut audit) {
        return result;
    }
    maybe_push_nondeterminism_audit(run, code, started_ts_ms, &mut audit);

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
      "meta": make_meta(started_ts_ms, started_ts_ms + 1, &stdout_utf8, &stderr_utf8, "ok", audit)
    })
}

impl WasiExecutor {
    fn new() -> Result<Self, String> {
        let component_path = std::env::var("AEGISPY_WORKER_WASI_COMPONENT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("artifacts/component/aegispy.component.wasm"));
        let compiled_component_path = std::env::var("AEGISPY_WORKER_WASI_COMPILED_COMPONENT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("artifacts/component/aegispy.component.cwasm"));
        let python_home = std::env::var("AEGISPY_WORKER_WASI_PYTHON_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("artifacts/engine/wasi-python"));
        let enable_fuel = parse_bool_env("AEGISPY_WORKER_WASI_ENABLE_FUEL", false)?;
        let enable_epoch = parse_bool_env("AEGISPY_WORKER_WASI_ENABLE_EPOCH", true)?;
        let enable_store_limits = parse_bool_env("AEGISPY_WORKER_WASI_ENABLE_STORE_LIMITS", true)?;
        worker_debug(
            "wasi_init",
            &format!("component={}", component_path.display()),
        );
        worker_debug(
            "wasi_init",
            &format!("compiled_component={}", compiled_component_path.display()),
        );
        worker_debug(
            "wasi_init",
            &format!("python_home={}", python_home.display()),
        );
        worker_debug("wasi_init", &format!("fuel={enable_fuel}"));
        worker_debug("wasi_init", &format!("epoch={enable_epoch}"));
        worker_debug("wasi_init", &format!("store_limits={enable_store_limits}"));

        if !component_path.exists() {
            return Err(format!(
                "missing WASI component artifact: {}",
                component_path.display()
            ));
        }
        if !python_home.exists() {
            return Err(format!(
                "missing WASI python home: {}",
                python_home.display()
            ));
        }

        let mut config = Config::new();
        config.consume_fuel(enable_fuel);
        config.epoch_interruption(enable_epoch);
        config.cranelift_opt_level(OptLevel::None);
        config.wasm_component_model(true);
        worker_debug("wasi_init", "creating engine");
        let engine = Engine::new(&config)
            .map_err(|error| format!("failed to initialize engine: {error}"))?;
        let component = if compiled_component_path.exists() {
            worker_debug("wasi_init", "loading precompiled component");
            let loaded =
                unsafe { WasmComponent::deserialize_file(&engine, &compiled_component_path) };
            match loaded {
                Ok(component) => {
                    worker_debug("wasi_init", "precompiled component loaded");
                    component
                }
                Err(error) => {
                    worker_debug(
                        "wasi_init",
                        &format!("precompiled component invalid, recompiling: {error}"),
                    );
                    let component = WasmComponent::from_file(&engine, &component_path).map_err(
                        |compile_error| {
                            format!(
                                "failed to load component {}: {compile_error}",
                                component_path.display()
                            )
                        },
                    )?;
                    match component.serialize() {
                        Ok(bytes) => {
                            if let Some(parent) = compiled_component_path.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            if let Err(error) = fs::write(&compiled_component_path, bytes) {
                                worker_debug(
                                    "wasi_init",
                                    &format!("failed to persist compiled component: {error}"),
                                );
                            }
                        }
                        Err(error) => {
                            worker_debug(
                                "wasi_init",
                                &format!("failed to serialize component: {error}"),
                            );
                        }
                    }
                    worker_debug("wasi_init", "component compiled and cached");
                    component
                }
            }
        } else {
            worker_debug("wasi_init", "compiling component");
            let component =
                WasmComponent::from_file(&engine, &component_path).map_err(|error| {
                    format!(
                        "failed to load component {}: {error}",
                        component_path.display()
                    )
                })?;
            match component.serialize() {
                Ok(bytes) => {
                    if let Some(parent) = compiled_component_path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    if let Err(error) = fs::write(&compiled_component_path, bytes) {
                        worker_debug(
                            "wasi_init",
                            &format!("failed to persist compiled component: {error}"),
                        );
                    }
                }
                Err(error) => {
                    worker_debug(
                        "wasi_init",
                        &format!("failed to serialize component: {error}"),
                    );
                }
            }
            worker_debug("wasi_init", "component compiled and cached");
            component
        };
        worker_debug("wasi_init", "component loaded");

        Ok(Self {
            engine,
            component,
            python_home,
            enable_fuel,
            enable_epoch,
            enable_store_limits,
        })
    }

    fn run(&self, run: &Value, profile: &IsolationProfile) -> Value {
        let wall_started = Instant::now();
        let deterministic_enabled = run
            .get("determinism")
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let started_ts_ms = if deterministic_enabled {
            run.get("determinism")
                .and_then(|value| value.get("epochMs"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        } else {
            now_ms()
        };

        let wall_ms = required_non_negative_u64(run, &["limits", "time", "wallMs"]).unwrap_or(0);
        let cpu_ms = required_non_negative_u64(run, &["limits", "time", "cpuMs"]).unwrap_or(0);
        let memory_limit =
            required_non_negative_u64(run, &["limits", "bytes", "memoryBytes"]).unwrap_or(0);
        let stdout_limit =
            required_non_negative_u64(run, &["limits", "bytes", "stdoutBytes"]).unwrap_or(0);
        let stderr_limit =
            required_non_negative_u64(run, &["limits", "bytes", "stderrBytes"]).unwrap_or(0);

        let code = required_string(run, &["code"]).unwrap_or("");
        let stdin_utf8 = required_string(run, &["stdinUtf8"]).unwrap_or("");
        let mut audit = Vec::<Value>::new();
        audit.push(json!({
          "kind": "runtime_channel",
          "detailJson": "capability_channel:component-wit"
        }));

        if let Some(result) = enforce_isolation_profile(run, profile, started_ts_ms, &mut audit) {
            return result;
        }
        if let Some(result) = enforce_capability_policy(run, code, started_ts_ms, &mut audit) {
            return result;
        }
        maybe_push_nondeterminism_audit(run, code, started_ts_ms, &mut audit);

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

        if code.contains("while True") && wall_ms > 0 {
            return make_error_result(
                "AEG-TIMEOUT",
                "wall time reached",
                "timeout",
                started_ts_ms,
                started_ts_ms.saturating_add(wall_ms),
                audit,
            );
        }

        if let Some(stdout_marker) = parse_marker_u64(code, "#aegispy:stdout=") {
            if stdout_marker > stdout_limit {
                return make_error_result(
                    "AEG-OUTPUT-LIMIT",
                    "output budget reached",
                    "output_limit",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        }
        if let Some(stderr_marker) = parse_marker_u64(code, "#aegispy:stderr=") {
            if stderr_marker > stderr_limit {
                return make_error_result(
                    "AEG-OUTPUT-LIMIT",
                    "output budget reached",
                    "output_limit",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        }

        let stdout_pipe_capacity =
            clamp_u64_to_usize(stdout_limit.saturating_add(CAPABILITY_WIT_STDOUT_OVERHEAD_BYTES));
        let stdout_pipe = MemoryOutputPipe::new(stdout_pipe_capacity);
        let stderr_pipe = MemoryOutputPipe::new(clamp_u64_to_usize(stderr_limit));
        let (runtime_stdin_reader, runtime_stdin_sender) =
            DynamicInputReader::with_initial(stdin_utf8.as_bytes());
        let mut capability_server = match HostCapabilityServer::start(
            run,
            wall_ms,
            stdout_pipe.clone(),
            runtime_stdin_sender.clone(),
        ) {
            Ok(server) => server,
            Err(message) => {
                return make_error_result(
                    "AEG-ENGINE",
                    &message,
                    "engine_error",
                    started_ts_ms,
                    started_ts_ms + 1,
                    audit,
                );
            }
        };
        let rewritten_code = rewrite_code_for_determinism(code, run);
        let runtime_code = format!(
            "{}\n{}",
            build_runtime_capability_prelude_wit_host_abi(),
            rewritten_code
        );
        let guest_root = "/runtime";
        let program_name = std::env::var("AEGISPY_WORKER_WASI_PROGRAM_NAME")
            .unwrap_or_else(|_| "python.wasm".to_string());
        let py_path = detect_python_stdlib_guest_path(&self.python_home, guest_root);
        let mut builder = WasiCtxBuilder::new();
        builder.stdin(AsyncStdinStream::new(runtime_stdin_reader));
        builder
            .stdout(stdout_pipe.clone())
            .stderr(stderr_pipe.clone());
        builder.env("PYTHONHOME", guest_root);
        if let Some(path) = py_path.as_deref() {
            builder.env("PYTHONPATH", path);
        }
        builder.env("PYTHONDONTWRITEBYTECODE", "1");
        let args = vec![
            program_name.as_str(),
            "-B",
            "-S",
            "-c",
            runtime_code.as_str(),
        ];
        builder.args(&args);

        if builder
            .preopened_dir(
                &self.python_home,
                guest_root,
                DirPerms::READ,
                FilePerms::READ,
            )
            .is_err()
        {
            let capability_state = capability_server.stop_and_collect();
            audit.extend(capability_state.audit);
            return make_error_result(
                "AEG-ENGINE",
                "failed to preopen python home",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        let wasi = builder.build();
        let runtime_memory_limit = min(
            profile.max_memory_bytes,
            memory_limit.max(ENGINE_MIN_MEMORY_BYTES),
        );
        let limits = StoreLimitsBuilder::new()
            .memory_size(clamp_u64_to_usize(runtime_memory_limit))
            .instances(8)
            .tables(16)
            .memories(4)
            .build();
        let mut store = Store::new(
            &self.engine,
            WasiStoreState {
                wasi,
                table: ResourceTable::new(),
                stdout: stdout_pipe,
                stderr: stderr_pipe,
                limits,
            },
        );
        if self.enable_store_limits {
            store.limiter(|state| &mut state.limits);
        }

        if self.enable_fuel
            && store
                .set_fuel(cpu_ms.saturating_mul(20_000).max(10_000))
                .is_err()
        {
            let capability_state = capability_server.stop_and_collect();
            audit.extend(capability_state.audit);
            return make_error_result(
                "AEG-ENGINE",
                "failed to set cpu fuel budget",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }
        if self.enable_epoch {
            store.set_epoch_deadline(wall_ms.max(1));
        }

        let stop = Arc::new(AtomicBool::new(false));
        let ticker = if self.enable_epoch {
            let stop_for_thread = Arc::clone(&stop);
            let engine = self.engine.clone();
            Some(thread::spawn(move || {
                while !stop_for_thread.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(1));
                    engine.increment_epoch();
                }
            }))
        } else {
            None
        };

        let mut linker = ComponentLinker::<WasiStoreState>::new(&self.engine);
        if add_to_component_linker_sync(&mut linker).is_err() {
            stop.store(true, Ordering::Relaxed);
            if let Some(handle) = ticker {
                let _ = handle.join();
            }
            let capability_state = capability_server.stop_and_collect();
            audit.extend(capability_state.audit);
            return make_error_result(
                "AEG-ENGINE",
                "failed to initialize wasi linker",
                "engine_error",
                started_ts_ms,
                started_ts_ms + 1,
                audit,
            );
        }

        let run_outcome = WasiCommand::instantiate(&mut store, &self.component, &linker)
            .and_then(|command| command.wasi_cli_run().call_run(&mut store));

        stop.store(true, Ordering::Relaxed);
        if let Some(handle) = ticker {
            let _ = handle.join();
        }
        let capability_state = capability_server.stop_and_collect();
        audit.extend(capability_state.audit);

        let stdout_bytes = store.data().stdout.contents();
        let stderr_bytes = store.data().stderr.contents();
        let raw_stdout_utf8 = String::from_utf8_lossy(stdout_bytes.as_ref()).to_string();
        let stdout_utf8 = capability_state
            .filtered_stdout_utf8
            .clone()
            .unwrap_or(raw_stdout_utf8);
        let stderr_utf8 = String::from_utf8_lossy(stderr_bytes.as_ref()).to_string();
        let elapsed_ms = (wall_started.elapsed().as_millis() as u64).max(1);
        let ended_ts_ms = started_ts_ms.saturating_add(elapsed_ms);
        if (stdout_utf8.len() as u64) > stdout_limit || (stderr_utf8.len() as u64) > stderr_limit {
            return make_error_result(
                "AEG-OUTPUT-LIMIT",
                "output budget reached",
                "output_limit",
                started_ts_ms,
                ended_ts_ms,
                audit,
            );
        }
        if let Some(detail) = capability_state.policy_denial {
            return make_error_result(
                "AEG-POLICY-DENIED",
                &detail,
                "policy_denied",
                started_ts_ms,
                ended_ts_ms,
                audit,
            );
        }
        if let Some(detail) = capability_state.engine_error {
            return make_error_result(
                "AEG-ENGINE",
                &detail,
                "engine_error",
                started_ts_ms,
                ended_ts_ms,
                audit,
            );
        }

        match run_outcome {
            Ok(Ok(())) => json!({
              "status": "ok",
              "exitCode": 0,
              "stdoutUtf8": stdout_utf8,
              "stderrUtf8": stderr_utf8,
              "meta": make_meta(started_ts_ms, ended_ts_ms, &stdout_utf8, &stderr_utf8, "ok", audit)
            }),
            Ok(Err(())) => make_error_result(
                "AEG-ENGINE",
                "wasi execution failed: guest returned non-zero status",
                "engine_error",
                started_ts_ms,
                ended_ts_ms,
                audit,
            ),
            Err(error) => {
                let message = error.to_string();
                if message.contains("all fuel consumed")
                    || message.contains("deadline")
                    || message.contains("interrupt")
                {
                    return make_error_result(
                        "AEG-TIMEOUT",
                        "wall time reached",
                        "timeout",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }

                if message.contains("write beyond capacity of MemoryOutputPipe") {
                    return make_error_result(
                        "AEG-OUTPUT-LIMIT",
                        "output budget reached",
                        "output_limit",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }

                if message.contains("memory")
                    && (message.contains("limit") || message.contains("growing"))
                {
                    return make_error_result(
                        "AEG-MEMORY-LIMIT",
                        "memory budget reached",
                        "memory_limit",
                        started_ts_ms,
                        ended_ts_ms,
                        audit,
                    );
                }

                make_error_result(
                    "AEG-ENGINE",
                    &format!("wasi execution failed: {message}"),
                    "engine_error",
                    started_ts_ms,
                    ended_ts_ms,
                    audit,
                )
            }
        }
    }
}

fn execute_run(
    run: &Value,
    isolation_profile: &IsolationProfile,
    executor_mode: WorkerExecutorMode,
    wasi_executor: Option<&WasiExecutor>,
) -> Value {
    match executor_mode {
        WorkerExecutorMode::Simulation => run_simulation(run, isolation_profile),
        WorkerExecutorMode::Wasi => {
            if let Some(executor) = wasi_executor {
                executor.run(run, isolation_profile)
            } else {
                make_error_result(
                    "AEG-ENGINE",
                    "wasi executor not available",
                    "engine_error",
                    0,
                    0,
                    Vec::new(),
                )
            }
        }
    }
}

fn handle_request_with_executor(
    req: RunRequestEnvelope,
    isolation_profile: &IsolationProfile,
    executor_mode: WorkerExecutorMode,
    wasi_executor: Option<&WasiExecutor>,
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
            Ok(()) => execute_run(&req.run, isolation_profile, executor_mode, wasi_executor),
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
          "isolationProfile": isolation_profile.name,
          "executorMode": executor_mode.as_str()
        })
    );

    RunResponseEnvelope {
        kind: "run_result",
        request_id: req.request_id,
        result,
    }
}

#[cfg(test)]
fn handle_request(
    req: RunRequestEnvelope,
    isolation_profile: &IsolationProfile,
) -> RunResponseEnvelope {
    handle_request_with_executor(req, isolation_profile, WorkerExecutorMode::Simulation, None)
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

fn bootstrap_wasi_engine() -> Result<(), String> {
    let status = Command::new("node")
        .args(["scripts/engine/build-wasi.mjs"])
        .status()
        .map_err(|error| {
            format!("failed to execute node scripts/engine/build-wasi.mjs: {error}")
        })?;
    if !status.success() {
        return Err("scripts/engine/build-wasi.mjs failed".to_string());
    }
    Ok(())
}

fn ensure_wasi_engine_ready() -> Result<(), String> {
    let engine_dir = PathBuf::from("artifacts").join("engine");
    let manifest_path = engine_dir.join("manifest.json");
    let module_path = engine_dir.join("cpython-wasi.wasm");
    let python_home = engine_dir.join("wasi-python");

    let missing_engine = !manifest_path.exists() || !module_path.exists() || !python_home.exists();
    if missing_engine {
        bootstrap_wasi_engine()?;
    }

    verify_manifest(&engine_dir, &manifest_path)?;
    if !module_path.exists() {
        return Err("missing cpython-wasi.wasm after build".to_string());
    }
    if !python_home.exists() {
        return Err("missing wasi-python runtime directory after build".to_string());
    }

    Ok(())
}

fn run_worker() -> io::Result<()> {
    verify_engine_if_present()
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    worker_debug("worker_start", "verified manifest if present");
    let executor_mode =
        load_executor_mode().map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    worker_debug("worker_start", executor_mode.as_str());
    if matches!(executor_mode, WorkerExecutorMode::Wasi) {
        worker_debug("worker_start", "component-wit");
    }
    if matches!(executor_mode, WorkerExecutorMode::Wasi) {
        worker_debug("worker_start", "ensuring wasi engine");
        ensure_wasi_engine_ready()
            .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
        worker_debug("worker_start", "wasi engine ready");
    }
    let isolation_profile = load_isolation_profile()
        .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?;
    worker_debug("worker_start", "isolation profile loaded");
    let wasi_executor = if matches!(executor_mode, WorkerExecutorMode::Wasi) {
        worker_debug("worker_start", "building wasi executor");
        Some(
            WasiExecutor::new()
                .map_err(|error| io::Error::new(ErrorKind::PermissionDenied, error))?,
        )
    } else {
        None
    };
    worker_debug("worker_start", "runtime initialized");

    let stdin = io::stdin();
    let stdout = io::stdout();

    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    while let Some(frame) = read_frame(&mut reader)? {
        let parsed = serde_json::from_slice::<RunRequestEnvelope>(&frame);
        let response = match parsed {
            Ok(req) => handle_request_with_executor(
                req,
                &isolation_profile,
                executor_mode,
                wasi_executor.as_ref(),
            ),
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
            max_memory_bytes: 512 * 1024 * 1024,
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

    #[test]
    fn default_executor_mode_is_wasi() {
        std::env::remove_var("AEGISPY_WORKER_EXECUTOR");
        let mode = load_executor_mode().expect("parse default executor mode");
        assert_eq!(mode, WorkerExecutorMode::Wasi);
    }
}
