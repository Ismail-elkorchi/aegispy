"""AegisPy guest capability bindings backed by runtime host-call dispatch."""

import os
import time

_BRIDGE_DIR = os.getenv("AEGISPY_CAP_BRIDGE_GUEST_DIR", "/aegispy-bridge")
_BRIDGE_TIMEOUT_MS_DEFAULT = 2000


def _read_timeout_ms():
    raw = os.getenv("AEGISPY_CAP_BRIDGE_TIMEOUT_MS", str(_BRIDGE_TIMEOUT_MS_DEFAULT))
    normalized = str(raw).strip()
    if normalized.startswith("+"):
        normalized = normalized[1:]
    if normalized.isdecimal():
        value = int(normalized)
        if value > 0:
            return value
    return _BRIDGE_TIMEOUT_MS_DEFAULT


_BRIDGE_TIMEOUT_MS = _read_timeout_ms()
_BRIDGE_INFO = {
    "bridge_kind": "builtin-capability-bridge",
    "capability_channel": "component-wit",
    "dispatch_mode": "host-runtime-call-dispatch",
    "dlopen_dependency": False,
}
_REQUEST_SEQ = 0


def _coerce_str(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _next_request_id():
    global _REQUEST_SEQ
    _REQUEST_SEQ += 1
    epoch_ms = int(time.time() * 1000)
    return f"{os.getpid()}-{epoch_ms}-{_REQUEST_SEQ}"


def _write_text_atomic(path, payload):
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        handle.write(payload)
    os.replace(tmp_path, path)


def _runtime_call(capability, field_a, field_b):
    import json as _json

    request_id = _next_request_id()
    request_path = f"{_BRIDGE_DIR}/req-{request_id}.json"
    response_path = f"{_BRIDGE_DIR}/res-{request_id}.json"
    if os.path.exists(response_path):
        os.remove(response_path)

    payload = _json.dumps(
        {
            "id": request_id,
            "capability": capability,
            "field_a": field_a,
            "field_b": field_b,
        }
    )
    _write_text_atomic(request_path, payload)

    deadline_ms = int(time.monotonic() * 1000) + _BRIDGE_TIMEOUT_MS
    while True:
        if os.path.exists(response_path):
            with open(response_path, "r", encoding="utf-8") as handle:
                response_payload = handle.read()
            os.remove(response_path)
            response = _json.loads(response_payload)

            if bool(response.get("ok", False)):
                return str(response.get("payload_utf8", ""))

            error_code = _coerce_str(response.get("error_code", "runtime_error"))
            raise RuntimeError(f"capability_runtime_denied:{error_code}")

        if int(time.monotonic() * 1000) >= deadline_ms:
            if os.path.exists(request_path):
                os.remove(request_path)
            raise RuntimeError(f"capability_runtime_timeout:{capability}")
        time.sleep(0.001)


def _install_plan(_plan):
    # Backward-compatible no-op: runtime dispatch does not use precomputed plans.
    return None


def fs_read(path):
    return _runtime_call("fs_read", _coerce_str(path), "")


def fs_write(path, data_utf8):
    _runtime_call("fs_write", _coerce_str(path), _coerce_str(data_utf8))
    return None


def http_get(url):
    return _runtime_call("http_get", _coerce_str(url), "")


def env_get(key):
    return _runtime_call("env_get", _coerce_str(key), "")


def _bridge_info():
    info = dict(_BRIDGE_INFO)
    info["bridge_dir"] = _BRIDGE_DIR
    info["bridge_timeout_ms"] = _BRIDGE_TIMEOUT_MS
    return info


__all__ = ["_bridge_info", "_install_plan", "env_get", "fs_read", "fs_write", "http_get"]
