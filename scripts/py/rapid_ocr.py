#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""第二 OCR 引擎（RapidOCR 家族）适配层。

用法： python rapid_ocr.py <图片路径>
      RAPIDOCR_IMPL=auto|unified|legacy python rapid_ocr.py <图片路径>

输出（stdout 单行 JSON，UTF-8）：
    成功： {"ok": true, "lines": [{"text": "...", "x": 12, "y": 34, "w": 100, "h": 20, "score": 0.95}, ...],
            "engine": "rapidocr" | "rapidocr_onnxruntime", "version": "2.1.0" | null}
    不可用：{"ok": false, "available": false, "engine": ..., "version": null, "error": "..."}
    识别失败：{"ok": false, "available": true, "engine": ..., "version": ..., "error": "..."}
    调用方（scripts/pwsh/wechat-uia.ps1、scripts/ocr/engines.mjs）据此静默回退，不影响主流程。
    注意：本脚本「不可用/失败」也以 exit 0 退出，靠 JSON 的 ok/available 区分；不打印 traceback。

双路径（v3.0.0 §5.2）：
    - 新统一包 `rapidocr`（官方推荐，结果对象带 boxes/txts/scores）；
    - 旧包 `rapidocr_onnxruntime`（本机当前只装了旧包，旧路径已实测回归）。
    auto 模式先试新包，导入失败再退回旧包；`RAPIDOCR_IMPL` 可强制指定，便于测试。
    本脚本不自动安装任何包、不自动下载模型；缺依赖时返回 available=false。

为什么用它：Windows 自带 OCR 对微信小号灰字/形近字容易误读；RapidOCR 是独立的
中文识别模型，和系统 OCR 形成“双引擎投票”，两类模型同时认错的概率远低于单引擎。
"""
import importlib
import importlib.metadata
import json
import os
import sys

# 允许环境变量强制实现，便于「新包未安装」时验证降级路径（不写死在业务逻辑里）
IMPL_ENV = "RAPIDOCR_IMPL"
VALID_IMPLS = ("auto", "unified", "legacy")


def _pkg_version(pkg_name):
    """取已安装包版本；包存在但没有 metadata（旧包常见）时返回 None。"""
    try:
        return importlib.metadata.version(pkg_name)
    except Exception:
        return None


def _load_engine(impl):
    """返回 (engine, engine_name, version, load_error)。

    新包与旧包的构造/调用方式一致（RapidOCR() / engine(path)），但返回结构不同，
    调用处用 _extract_lines 统一。导入/构造失败不抛异常，交给上层决定降级。
    """
    if impl == "unified":
        try:
            module = importlib.import_module("rapidocr")
            engine = module.RapidOCR()
            return engine, "rapidocr", _pkg_version("rapidocr"), None
        except Exception as exc:  # 未安装/模型缺失都走这里
            return None, "rapidocr", _pkg_version("rapidocr"), str(exc)
    if impl == "legacy":
        try:
            module = importlib.import_module("rapidocr_onnxruntime")
            engine = module.RapidOCR()
            return engine, "rapidocr_onnxruntime", _pkg_version("rapidocr_onnxruntime"), None
        except Exception as exc:
            return None, "rapidocr_onnxruntime", _pkg_version("rapidocr_onnxruntime"), str(exc)
    raise ValueError("invalid impl: %s" % impl)


def _get_attr(obj, *names):
    """从 dict 或对象里按顺序取第一个非 None 字段（兼容新旧包的不同返回结构）。"""
    for name in names:
        if isinstance(obj, dict):
            value = obj.get(name)
        else:
            value = getattr(obj, name, None)
        if value is not None:
            return value
    return None


def _box_from_quad(points):
    """四点多边形 → (x, y, w, h)。支持 [[x,y],...] 与 numpy 数组。"""
    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    return int(round(min(xs))), int(round(min(ys))), int(round(max(xs) - min(xs))), int(round(max(ys) - min(ys)))


def _lines_from_pairs(result):
    """旧包结构：[[box, text, score], ...]。"""
    lines = []
    for item in result or []:
        try:
            box, text, score = item[0], item[1], item[2]
            x, y, w, h = _box_from_quad(box)
            lines.append({"text": str(text), "x": x, "y": y, "w": w, "h": h, "score": float(score)})
        except Exception:
            continue
    return lines


def _lines_from_columns(result):
    """新包结构：对象/字典带并列数组 boxes、txts、scores（长度一致）。"""
    boxes = _get_attr(result, "boxes", "box")
    txts = _get_attr(result, "txts", "txt", "texts")
    scores = _get_attr(result, "scores", "score")
    if boxes is None or txts is None:
        return None
    if scores is None:
        scores = [None] * len(txts)
    lines = []
    for i, text in enumerate(txts):
        try:
            box = boxes[i]
            score = scores[i]
            x, y, w, h = _box_from_quad(box)
            line = {"text": str(text), "x": x, "y": y, "w": w, "h": h}
            if score is not None:
                line["score"] = float(score)
            lines.append(line)
        except Exception:
            continue
    return lines


def _extract_lines(result):
    """把新旧两种返回结构统一成 lines；未知结构返回 None 让调用方报错而不是猜。"""
    if result is None:
        return []
    lines = _lines_from_columns(result)
    if lines is not None:
        return lines
    if isinstance(result, (list, tuple)):
        return _lines_from_pairs(result)
    return None


def _emit(payload):
    """单行 JSON 输出（调用方按最后一行 JSON 解析）；显式 UTF-8，避免 Windows GBK 乱码。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv):
    impl = (os.environ.get(IMPL_ENV) or "auto").strip().lower()
    if impl not in VALID_IMPLS:
        _emit({"ok": False, "available": False, "engine": None, "version": None,
               "error": "invalid %s=%s（可选 auto/unified/legacy）" % (IMPL_ENV, impl)})
        return 0
    if len(argv) < 2:
        _emit({"ok": False, "available": False, "engine": None, "version": None,
               "error": "missing image path"})
        return 0
    path = argv[1]

    order = ["unified", "legacy"] if impl == "auto" else [impl]
    engine = name = version = None
    load_errors = []
    for candidate in order:
        engine, name, version, err = _load_engine(candidate)
        if engine is not None:
            break
        load_errors.append("%s: %s" % (candidate, err))

    if engine is None:
        _emit({"ok": False, "available": False, "engine": None, "version": None,
               "error": "rapidocr 引擎不可用（未安装？）：" + "；".join(load_errors)})
        return 0

    try:
        out = engine(path)
    except Exception as exc:
        _emit({"ok": False, "available": True, "engine": name, "version": version,
               "error": "ocr failed: %s" % exc})
        return 0

    # 旧包在部分版本返回 (result, elapse)；新包直接返回结果对象
    result = out[0] if isinstance(out, tuple) and len(out) == 2 else out

    lines = _extract_lines(result)
    if lines is None:
        _emit({"ok": False, "available": True, "engine": name, "version": version,
               "error": "无法识别的 RapidOCR 返回结构：%s" % type(result).__name__})
        return 0
    _emit({"ok": True, "available": True, "engine": name, "version": version, "lines": lines})
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
