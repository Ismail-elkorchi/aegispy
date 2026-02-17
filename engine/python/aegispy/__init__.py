"""AegisPy guest capability bindings backed by host plan dispatch."""

_PLAN = []
_BRIDGE_INFO = {
    "bridge_kind": "builtin-capability-bridge",
    "capability_channel": "component-wit",
    "dispatch_mode": "host-plan-dispatch",
    "dlopen_dependency": False,
}


def _install_plan(plan):
    global _PLAN
    if isinstance(plan, list):
        _PLAN = list(plan)


def _coerce_str(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _consume(capability, field_a, field_b):
    for index, entry in enumerate(_PLAN):
        if not isinstance(entry, dict):
            continue
        if str(entry.get("capability", "")) != capability:
            continue
        if str(entry.get("field_a", "")) != field_a:
            continue
        if str(entry.get("field_b", "")) != field_b:
            continue

        _PLAN.pop(index)
        if bool(entry.get("ok", False)):
            return str(entry.get("payload_utf8", ""))
        return ""

    raise RuntimeError(f"capability_runtime_binding_missing:{capability}")


def fs_read(path):
    return _consume("fs_read", _coerce_str(path), "")


def fs_write(path, data_utf8):
    _consume("fs_write", _coerce_str(path), _coerce_str(data_utf8))
    return None


def http_get(url):
    return _consume("http_get", _coerce_str(url), "")


def env_get(key):
    return _consume("env_get", _coerce_str(key), "")


def _bridge_info():
    return dict(_BRIDGE_INFO)


__all__ = [
    "_bridge_info",
    "_install_plan",
    "env_get",
    "fs_read",
    "fs_write",
    "http_get",
]
