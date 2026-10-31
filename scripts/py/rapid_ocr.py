#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""第二 OCR 引擎（RapidOCR / PaddleOCR 家族的 ONNX 版本）。

用法： python rapid_ocr.py <图片路径>
输出： 单行 JSON {"ok": true, "lines": [{"text": "...", "x": 12, "y": 34, "w": 100, "score": 0.95}, ...]}
失败： {"ok": false, "error": "..."}  （调用方据此静默回退，不影响主流程）

为什么用它：Windows 自带 OCR 对微信小号灰字/形近字容易误读；RapidOCR 是独立的
中文识别模型，和系统 OCR 形成“双引擎投票”，两类模型同时认错的概率远低于单引擎。
"""
import json
import sys


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing image path"}, ensure_ascii=False))
        return
    path = sys.argv[1]
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as exc:  # 未安装依赖时安静失败，调用方回退系统 OCR
        print(json.dumps({"ok": False, "error": "rapidocr unavailable: %s" % exc}, ensure_ascii=False))
        return
    try:
        engine = RapidOCR()
        result, _elapse = engine(path)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "ocr failed: %s" % exc}, ensure_ascii=False))
        return
    lines = []
    for item in result or []:
        try:
            box, text, score = item[0], item[1], item[2]
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            lines.append({
                "text": str(text),
                "x": int(min(xs)),
                "y": int(min(ys)),
                "w": int(max(xs) - min(xs)),
                "score": float(score),
            })
        except Exception:
            continue
    print(json.dumps({"ok": True, "lines": lines}, ensure_ascii=False))


if __name__ == "__main__":
    main()
