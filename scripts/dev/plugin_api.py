"""Thin client for the dsh-wechat-persona plugin HTTP API (dev tool).

Base URL: http://127.0.0.1:<dsh-web-port>/dsh-wechat-persona/api
All requests must send header  x-dsh-wechat-persona: 1
Body is UTF-8 JSON (never use PowerShell 5.1 default encodings for this).
"""
import json
import sys
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:53905/dsh-wechat-persona/api"


def request(method, path, payload=None, base=DEFAULT_BASE, timeout=30):
    url = base.rstrip("/") + path
    data = None
    headers = {"x-dsh-wechat-persona": "1", "Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(body) if body.strip() else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except Exception:
            return exc.code, {"raw": body}


def get_config(base=DEFAULT_BASE):
    status, data = request("GET", "/config", base=base)
    if status != 200:
        raise SystemExit(f"GET /config failed: {status} {data}")
    return data


def post_config(config, base=DEFAULT_BASE):
    status, data = request("POST", "/config", {"config": config}, base=base)
    return status, data


def set_flags(enabled=None, desktop_enabled=None, base=DEFAULT_BASE):
    doc = get_config(base=base)
    cfg = doc["config"]
    if enabled is not None:
        cfg["enabled"] = enabled
    if desktop_enabled is not None:
        cfg["channels"]["desktop"]["enabled"] = desktop_enabled
    return post_config(cfg, base=base)


def status(base=DEFAULT_BASE):
    return request("GET", "/status", base=base)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    base = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_BASE
    if action == "status":
        print(json.dumps(status(base=base), ensure_ascii=False, indent=1))
    elif action == "config":
        print(json.dumps(get_config(base=base), ensure_ascii=False, indent=1))
    elif action == "enable":
        print(json.dumps(set_flags(enabled=True, desktop_enabled=True, base=base), ensure_ascii=False, indent=1))
    elif action == "disable-desktop":
        print(json.dumps(set_flags(desktop_enabled=False, base=base), ensure_ascii=False, indent=1))
    else:
        raise SystemExit("unknown action: " + action)
