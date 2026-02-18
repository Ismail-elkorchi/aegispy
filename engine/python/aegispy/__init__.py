"""AegisPy guest capability bindings backed by native host ABI dispatch."""

import os
import sys
import time

_REQ_PREFIX = "\x1eaegispy-cap-req:"
_RES_PREFIX = "\x1eaegispy-cap-res:"
_BRIDGE_INFO = {
    "bridge_kind": "builtin-capability-bridge",
    "capability_channel": "component-wit",
    "dispatch_mode": "host-native-abi-direct-dispatch",
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


def _runtime_call(capability, field_a, field_b):
    import json as _json

    request_id = _next_request_id()
    request_payload = _json.dumps(
        {
            "id": request_id,
            "capability": capability,
            "field_a": field_a,
            "field_b": field_b,
        },
        separators=(",", ":"),
    )
    request_frame = f"{_REQ_PREFIX}{request_payload}\n".encode("utf-8")

    offset = 0
    while offset < len(request_frame):
        offset += os.write(2, request_frame[offset:])

    channel_deadline = time.monotonic() + 2.0
    response_line = b""
    while response_line == b"":
        response_line = sys.stdin.buffer.readline()
        if response_line != b"":
            break
        if time.monotonic() >= channel_deadline:
            raise RuntimeError(f"capability_runtime_channel_closed:{capability}")
        time.sleep(0.001)

    decoded = response_line.decode("utf-8", "replace").rstrip("\r\n")
    if not decoded.startswith(_RES_PREFIX):
        raise RuntimeError(f"capability_runtime_response_invalid:{capability}")

    response = _json.loads(decoded[len(_RES_PREFIX) :])
    if _coerce_str(response.get("id", "")) != request_id:
        raise RuntimeError(f"capability_runtime_response_mismatch:{capability}")

    if bool(response.get("ok", False)):
        return str(response.get("payload_utf8", ""))

    error_code = _coerce_str(response.get("error_code", "runtime_error"))
    raise RuntimeError(f"capability_runtime_denied:{error_code}")


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
    return dict(_BRIDGE_INFO)


__all__ = ["_bridge_info", "_install_plan", "env_get", "fs_read", "fs_write", "http_get"]
