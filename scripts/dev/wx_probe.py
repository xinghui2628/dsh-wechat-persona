"""Script-layer probe/driver for wechat-uia.ps1 (dev tool, no plugin dependency).

Calls the PowerShell script directly and returns its JSON contract + elapsed ms.
Used to calibrate the sender and to run the script-layer stress test.
"""
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "pwsh" / "wechat-uia.ps1"
PS = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def run(action, *, contact="", contacts="", text=None, current_contact="",
        row_top=None, row_left=None, row_height=None, max_messages=None,
        shot_dir=None, timeout=120, extra_env=None):
    args = [PS, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
            "-Action", action]
    if contact:
        args += ["-Contact", contact]
    if contacts:
        args += ["-Contacts", contacts]
    if text is not None:
        args += ["-TextBase64", base64.b64encode(text.encode("utf-8")).decode("ascii")]
    if current_contact:
        args += ["-CurrentContact", current_contact]
    if row_top is not None:
        args += ["-RowTop", str(row_top)]
    if row_left is not None:
        args += ["-RowLeft", str(row_left)]
    if row_height is not None:
        args += ["-RowHeight", str(row_height)]
    if max_messages is not None:
        args += ["-MaxMessages", str(max_messages)]

    env = os.environ.copy()
    if shot_dir:
        Path(shot_dir).mkdir(parents=True, exist_ok=True)
        env["WXUIA_SHOT_DIR"] = str(shot_dir)
    if extra_env:
        env.update({k: str(v) for k, v in extra_env.items()})

    t0 = time.perf_counter()
    proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", env=env, timeout=timeout)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    data = None
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                pass
    return {"action": action, "contact": contact, "elapsedMs": elapsed_ms,
            "exitCode": proc.returncode, "json": data,
            "stdout": (proc.stdout or "")[-2000:], "stderr": (proc.stderr or "")[-2000:]}


def list_contacts(contacts, shot_dir=None, timeout=120):
    if isinstance(contacts, (list, tuple)):
        contacts = ",".join(contacts)
    return run("list", contacts=contacts, shot_dir=shot_dir, timeout=timeout)


def send_text(contact, text, *, current_contact="", row=None, shot_dir=None,
              timeout=180, extra_env=None):
    kw = {}
    if row:
        kw = {"row_top": int(row.get("top", 0)), "row_left": int(row.get("left", 0)),
              "row_height": int(row.get("height", 0))}
    return run("send", contact=contact, text=text, current_contact=current_contact,
               shot_dir=shot_dir, timeout=timeout, extra_env=extra_env, **kw)


def read_chat(contact, max_messages=10, timeout=120):
    return run("read", contact=contact, max_messages=max_messages, timeout=timeout)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        res = list_contacts(sys.argv[2] if len(sys.argv) > 2 else "文件传输助手")
    elif cmd == "read":
        res = read_chat(sys.argv[2] if len(sys.argv) > 2 else "文件传输助手")
    else:
        raise SystemExit("unknown cmd: " + cmd)
    print(json.dumps(res, ensure_ascii=False, indent=1))
