# -*- coding: utf-8 -*-
"""发送判定补丁的三路径实机验证（文件传输助手，不涉及真实好友）。

1) 短文本单字（气泡 OCR 天然看不到，len<2）→ 应由“输入框已清空”兜底判 ok:true
2) WXUIA_FORCE_BUBBLE_FAIL=1 → 强制走兜底，应 ok:true
3) WXUIA_FORCE_BUBBLE_FAIL=1 + WXUIA_SKIP_ENTER=1 → 输入框未清空，必须 ok:false 且不重发
4) 收尾：正常发送一条，顺带清掉第 3 步残留在输入框里的文字

用法：python scripts/dev/test-send-fallback.py [--shots]
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wx_probe  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SHOT_DIR = str(ROOT / '.dsh-tmp' / 'shots' / 'send-fallback')
CONTACT = '文件传输助手'


ROW = {}


def run_case(name, text, extra_env=None, shots=False):
    res = wx_probe.send_text(CONTACT, text, row=ROW,
                             shot_dir=SHOT_DIR if shots else None,
                             extra_env=extra_env, timeout=180)
    js = res['json'] or {}
    print('[%s] elapsedMs=%s exit=%s ok=%s %s' % (
        name, res['elapsedMs'], res['exitCode'], js.get('ok'),
        (js.get('error') or '')[:120]))
    return res, js


def main():
    shots = '--shots' in sys.argv
    t0 = time.time()
    results = {}
    # 每次发送前重新取行坐标，避免窗口位置变化导致点到别的会话
    lst = wx_probe.list_contacts([CONTACT])
    rows = (lst['json'] or {}).get('rows') or []
    global ROW
    ROW = rows[0]
    if not rows:
        print('FAIL: list 未返回 %s 行：%s' % (CONTACT, json.dumps(lst['json'], ensure_ascii=False)))
        return 2
    print('list %sms rows=%s' % (lst['elapsedMs'], json.dumps(rows, ensure_ascii=False)))

    r1, j1 = run_case('1-short-single-char', '好', shots=shots)
    results['short'] = j1.get('ok')
    r2, j2 = run_case('2-force-bubble-fail', '兜底校验2',
                      extra_env={'WXUIA_FORCE_BUBBLE_FAIL': '1'}, shots=shots)
    results['force_fallback'] = j2.get('ok')
    r3, j3 = run_case('3-skip-enter', '不该出现的残留',
                      extra_env={'WXUIA_FORCE_BUBBLE_FAIL': '1', 'WXUIA_SKIP_ENTER': '1'}, shots=shots)
    results['skip_enter'] = j3.get('ok')
    print('   case3 error: %s' % (j3.get('error') or ''))
    # 收尾清理：正常发送一条，CtrlA/Backspace 会清掉残留
    r4, j4 = run_case('4-cleanup', '收尾清理', shots=shots)
    results['cleanup'] = j4.get('ok')
    print('total %dms' % int((time.time() - t0) * 1000))
    expected = {'short': True, 'force_fallback': True, 'skip_enter': False, 'cleanup': True}
    bad = {k: (results.get(k), expected[k]) for k in expected if results.get(k) != expected[k]}
    print('RESULT: %s' % ('PASS' if not bad else 'FAIL %s' % json.dumps(bad, ensure_ascii=False)))
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
