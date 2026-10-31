"""Script-layer stress test: N rounds of list + send against 文件传输助手.

Measures P50/P95 latency and success rate, writes a JSON report under .dsh-tmp/.
"""
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wx_probe  # noqa: E402

CONTACT = "文件传输助手"
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 10


def pct(values, p):
    if not values:
        return None
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, int(round((p / 100.0) * (len(ordered) - 1)))))
    return ordered[k]


def main():
    rounds = []
    for i in range(1, ROUNDS + 1):
        list_started = time.perf_counter()
        # 模拟插件行为：始终带 lastActiveContact，使绿底选中行可用标题 OCR 认领。
        lst = wx_probe.run("list", contacts=CONTACT, current_contact=CONTACT, timeout=180)
        list_ms = int((time.perf_counter() - list_started) * 1000)
        rows = lst["json"].get("rows") if isinstance(lst.get("json"), dict) else None
        row = None
        for candidate in rows or []:
            if candidate.get("name") == CONTACT and candidate.get("found"):
                row = candidate
                break
        row_rec = {"round": i, "listMs": list_ms, "listOk": bool(row)}
        if not row:
            rounds.append({**row_rec, "sendOk": False, "error": "list 未返回可点击行"})
            print(f"[{i}/{ROUNDS}] list {list_ms}ms 未找到行，跳过")
            continue
        text = f"压测#{i} {time.strftime('%H:%M:%S')}"
        snd = wx_probe.send_text(CONTACT, text, current_contact=CONTACT, row=row, timeout=180)
        data = snd.get("json") or {}
        rec = {**row_rec, "sendMs": snd["elapsedMs"], "sendOk": data.get("ok") is True,
               "error": data.get("error"), "text": text}
        rounds.append(rec)
        print(f"[{i}/{ROUNDS}] list={list_ms}ms send={snd['elapsedMs']}ms ok={rec['sendOk']} err={rec['error']}")

    list_ms_all = [r["listMs"] for r in rounds if r.get("listMs")]
    send_ms_all = [r["sendMs"] for r in rounds if r.get("sendMs")]
    sends = [r for r in rounds if r.get("sendOk")]
    report = {
        "contact": CONTACT,
        "rounds": ROUNDS,
        "listSuccess": sum(1 for r in rounds if r.get("listOk")),
        "sendSuccess": len(sends),
        "successRate": round(len(sends) / max(1, len(rounds)), 4),
        "listP50": pct(list_ms_all, 50),
        "listP95": pct(list_ms_all, 95),
        "sendP50": pct(send_ms_all, 50),
        "sendP95": pct(send_ms_all, 95),
        "avgTotalMs": round(statistics.mean([r["listMs"] + (r.get("sendMs") or 0) for r in rounds]), 1),
        "details": rounds,
        "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    out = Path(__file__).resolve().parents[2] / ".dsh-tmp" / f"stress-script-{time.strftime('%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "details"}, ensure_ascii=False, indent=1))
    print("saved:", out)


if __name__ == "__main__":
    main()
