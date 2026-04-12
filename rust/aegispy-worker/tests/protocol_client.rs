use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const PROTOCOL_VERSION: &str = "1";

fn unique_temp_dir() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("aegispy-protocol-client-{nanos}"));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn write_frame(writer: &mut dyn Write, value: &Value) {
    let payload = serde_json::to_vec(value).expect("serialize frame");
    let len = (payload.len() as u32).to_be_bytes();
    writer.write_all(&len).expect("write frame length");
    writer.write_all(&payload).expect("write frame payload");
    writer.flush().expect("flush frame");
}

fn read_frame(reader: &mut dyn Read) -> Value {
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header).expect("read frame length");
    let len = u32::from_be_bytes(header) as usize;
    let mut payload = vec![0_u8; len];
    reader.read_exact(&mut payload).expect("read frame payload");
    serde_json::from_slice(&payload).expect("parse frame")
}

fn run_request(request_id: &str, code: &str) -> Value {
    json!({
      "protocolVersion": PROTOCOL_VERSION,
      "type": "run",
      "requestId": request_id,
      "run": {
        "code": code,
        "argv": ["python"],
        "stdinUtf8": "",
        "permissions": {
          "fs": null,
          "http": null,
          "env": null
        },
        "limits": {
          "time": {
            "wallMs": 5000,
            "cpuMs": 5000
          },
          "bytes": {
            "memoryBytes": 536870912,
            "stdoutBytes": 4096,
            "stderrBytes": 4096
          }
        },
        "determinism": {
          "enabled": true,
          "epochMs": 0,
          "rngSeedHex": "00"
        }
      }
    })
}

#[test]
fn rust_reference_client_exercises_server_engine_protocol_v1() {
    let worker = env!("CARGO_BIN_EXE_aegispy_worker");
    let temp_dir = unique_temp_dir();
    let mut child = Command::new(worker)
        .current_dir(&temp_dir)
        .env("AEGISPY_WORKER_EXECUTOR", "simulation")
        .env(
            "AEGISPY_WORKER_BUNDLE_METADATA_JSON",
            serde_json::to_string(&json!({
              "runtimeFamily": "server-wasi-component",
              "bundleId": "server-wasi-component-test",
              "os": std::env::consts::OS,
              "arch": std::env::consts::ARCH,
              "pythonAbi": "cpython-3.14",
              "packageSetVersion": "base"
            }))
            .expect("serialize bundle metadata"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn worker");

    let mut stdin = child.stdin.take().expect("worker stdin");
    let mut stdout = child.stdout.take().expect("worker stdout");

    write_frame(
        &mut stdin,
        &json!({
          "protocolVersion": PROTOCOL_VERSION,
          "type": "hello",
          "requestId": "rust-hello",
          "client": {
            "name": "rust-reference-client",
            "host": "node"
          },
          "maxFrameBytes": 1048576
        }),
    );
    let hello = read_frame(&mut stdout);
    assert_eq!(hello["type"], "hello_result");
    assert_eq!(hello["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(hello["requestId"], "rust-hello");
    assert_eq!(hello["engine"]["name"], "aegispy-worker");

    write_frame(&mut stdin, &run_request("rust-run", "print(\"hello\")"));
    let run = read_frame(&mut stdout);
    assert_eq!(run["type"], "run_result");
    assert_eq!(run["requestId"], "rust-run");
    assert_eq!(run["result"]["status"], "ok");

    write_frame(
        &mut stdin,
        &run_request("rust-denial", "aegispy.http_get(\"https://example.com\")"),
    );
    let denial = read_frame(&mut stdout);
    assert_eq!(denial["type"], "run_result");
    assert_eq!(denial["requestId"], "rust-denial");
    assert_eq!(denial["result"]["status"], "error");
    assert_eq!(denial["result"]["error"]["code"], "AEG-POLICY-DENIED");

    write_frame(
        &mut stdin,
        &json!({
          "protocolVersion": PROTOCOL_VERSION,
          "type": "cancel",
          "requestId": "rust-cancel",
          "targetRequestId": "rust-run"
        }),
    );
    let cancel = read_frame(&mut stdout);
    assert_eq!(cancel["type"], "cancel_result");
    assert_eq!(cancel["requestId"], "rust-cancel");
    assert_eq!(cancel["accepted"], false);

    write_frame(
        &mut stdin,
        &json!({
          "protocolVersion": PROTOCOL_VERSION,
          "type": "shutdown",
          "requestId": "rust-shutdown"
        }),
    );
    let shutdown = read_frame(&mut stdout);
    assert_eq!(shutdown["type"], "shutdown_result");
    assert_eq!(shutdown["requestId"], "rust-shutdown");
    assert_eq!(shutdown["accepted"], true);

    drop(stdin);
    let status = child.wait().expect("wait worker");
    assert!(status.success());
}
