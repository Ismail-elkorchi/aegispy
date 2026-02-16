"""AegisPy capability shims for test harness flows."""


def fs_read(path: str) -> str:
    return f"read:{path}"


def fs_write(path: str, data_utf8: str) -> str:
    return f"write:{path}:{len(data_utf8)}"


def http_get(url: str) -> str:
    return f"http:{url}"
