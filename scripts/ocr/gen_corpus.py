#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""合成「类微信聊天窗口」截图语料（v3.0.0 OCR Benchmark Phase A / C）。

为什么用合成图：真实微信截图涉及好友隐私、不可复现、场景不可控。合成图固定种子、
全部内容虚构，能稳定复现 CER 等指标，用来做 OCR 引擎/后处理的 A/B 对比。

内容安全：好友名固定为 A/B/C；正文全部是测试文案（「大肥鱼」「表情包」等取自本仓库
输入法/OCR 测试词）；手机号一律用 13800000000 这类全零占位号（虚构）；不含真实姓名、
wxid、邮箱、真实号码。生成器只画像素，不截图、不启动微信。

输出（相对仓库根）：
    test/fixtures/ocr-corpus/images/<captureId>.png
    test/fixtures/ocr-corpus/manifest.json

manifest 里所有 bbox 都是「最终图片像素坐标」[x, y, w, h]：经过缩放/拉伸/模糊的图
已经按实际渲染尺寸换算好，bench 不需要再猜缩放比例。

用法：
    python scripts/ocr/gen_corpus.py
    python scripts/ocr/gen_corpus.py --per-scenario 3 --out <目录>
    python scripts/ocr/gen_corpus.py --only clear,scale_175,dark_mode
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "test" / "fixtures" / "ocr-corpus"

# ── 布局常量（logical 基准 480x640，先按此绘制，最后整体缩放）──────────────
BASE_W = 480
BASE_H = 640
TITLE_H = 36
INPUT_H = 56
MARGIN = 12
AVATAR = 34
AVATAR_GAP = 8
BUBBLE_RADIUS = 8
PAD_X = 12
PAD_Y = 9
MAX_TEXT_W = 296
MSG_GAP = 14
LINE_GAP = 3
FONT_SIZE = 15

SEED = 20261031

# 本机系统字体；只用于渲染，不写入 manifest/文档里的用户路径。
FONT_FILES = [
    Path(r"C:\Windows\Fonts\msyh.ttc"),  # 微软雅黑
    Path(r"C:\Windows\Fonts\msyhbd.ttc"),
]
EMOJI_FONT_FILES = [
    Path(r"C:\Windows\Fonts\seguiemj.ttf"),  # Segoe UI Emoji（彩色，OCR 读不出，属预期噪声）
]

# 彩色 emoji / 杂项符号：OCR 引擎一般读不出来，作为「不可识别符号」场景的一部分。
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]"
)


def is_emoji(ch: str) -> bool:
    return bool(EMOJI_RE.match(ch))


# ── 主题（浅色 / 深色，对齐微信桌面版观感）──────────────────────────────
THEMES = {
    "light": {
        "app_bg": (242, 242, 242),
        "title_bg": (231, 231, 231),
        "title_fg": (30, 30, 30),
        "chat_bg": (237, 237, 237),
        "bubble_left": (255, 255, 255),
        "bubble_right": (149, 236, 105),
        "text_left": (22, 22, 22),
        "text_right": (22, 22, 22),
        "ts_fg": (155, 155, 155),
        "input_bg": (247, 247, 247),
        "input_border": (216, 216, 216),
        "input_fg": (178, 178, 178),
        "avatar_left": (255, 171, 74),
        "avatar_right": (74, 144, 217),
        "faded_bubble_left": (250, 250, 250),
        "faded_bubble_right": (203, 240, 186),
        "faded_text_left": (176, 176, 176),
        "faded_text_right": (168, 186, 160),
    },
    "dark": {
        "app_bg": (30, 30, 30),
        "title_bg": (43, 43, 43),
        "title_fg": (225, 225, 225),
        "chat_bg": (17, 17, 17),
        "bubble_left": (44, 44, 44),
        "bubble_right": (62, 181, 117),
        "text_left": (226, 226, 226),
        "text_right": (18, 18, 18),
        "ts_fg": (120, 120, 120),
        "input_bg": (38, 38, 38),
        "input_border": (62, 62, 62),
        "input_fg": (128, 128, 128),
        "avatar_left": (176, 118, 61),
        "avatar_right": (58, 110, 165),
        "faded_bubble_left": (40, 40, 40),
        "faded_bubble_right": (58, 128, 92),
        "faded_text_left": (128, 128, 128),
        "faded_text_right": (96, 128, 108),
    },
}

_FONT_CACHE: dict = {}
_EMOJI_FONT_CACHE: dict = {}


def get_font(size: int):
    if size not in _FONT_CACHE:
        for path in FONT_FILES:
            if path.exists():
                _FONT_CACHE[size] = ImageFont.truetype(str(path), size, index=0)
                break
        else:  # pragma: no cover - 本机环境已确认存在
            raise SystemExit(
                "找不到中文字体（C:\\Windows\\Fonts\\msyh.ttc）。"
                "本脚本依赖微软雅黑渲染中文。"
            )
    return _FONT_CACHE[size]


def get_emoji_font(size: int):
    if size not in _EMOJI_FONT_CACHE:
        font = None
        for path in EMOJI_FONT_FILES:
            if path.exists():
                try:
                    font = ImageFont.truetype(str(path), size, index=0)
                except OSError:
                    font = None
                break
        _EMOJI_FONT_CACHE[size] = font
    return _EMOJI_FONT_CACHE[size]


# ── 文本测量 / 换行 / 绘制（emoji 用彩色字体单独绘制）────────────────────
TOKEN_RE = re.compile(r"([ \t]+|[A-Za-z0-9][A-Za-z0-9._:/\-+@#]*|[^\s])")


def measure_text(font, emoji_font, text: str) -> float:
    total = 0.0
    i, n = 0, len(text)
    while i < n:
        if is_emoji(text[i]):
            f = emoji_font or font
            total += f.getlength(text[i])
            i += 1
        else:
            j = i
            while j < n and not is_emoji(text[j]):
                j += 1
            total += font.getlength(text[i:j])
            i = j
    return total


def wrap_text(font, emoji_font, text: str, max_w: float) -> list[str]:
    """按像素宽度换行：ASCII 单词整体换行、CJK 逐字换行，保留原文空格。"""
    lines: list[str] = []
    for para in str(text).split("\n"):
        cur = ""
        cur_w = 0.0
        pending_space = False
        for tok in TOKEN_RE.findall(para):
            if not tok.strip():
                pending_space = bool(cur)
                continue
            piece = (" " if pending_space else "") + tok
            piece_w = measure_text(font, emoji_font, piece)
            if cur and cur_w + piece_w > max_w:
                lines.append(cur.rstrip())
                cur = tok
                cur_w = measure_text(font, emoji_font, tok)
            else:
                cur += piece
                cur_w += piece_w
            pending_space = False
        lines.append(cur.rstrip())
    return lines or [""]


def draw_text_run(draw, x: float, y: float, text: str, font, emoji_font, fill):
    """逐 run 绘制：普通字符整段画（保持字形），emoji 用彩色字体单独画。"""
    i, n = 0, len(text)
    while i < n:
        if is_emoji(text[i]):
            f = emoji_font or font
            kw = {"embedded_color": True} if emoji_font else {}
            draw.text((x, y), text[i], font=f, fill=fill, anchor="la", **kw)
            x += f.getlength(text[i])
            i += 1
        else:
            j = i
            while j < n and not is_emoji(text[j]):
                j += 1
            run = text[i:j]
            draw.text((x, y), run, font=font, fill=fill, anchor="la")
            x += font.getlength(run)
            i = j


# ── 渲染一个「类微信聊天窗口」────────────────────────────────────────────
def render_chat(opts: dict, rng: random.Random):
    """返回 (base_image, expected_messages, expected_context)；bbox 为 base 坐标。"""
    theme = THEMES[opts["theme"]]
    low = bool(opts.get("low_contrast"))
    font_size = int(opts.get("font_size", FONT_SIZE))
    font = get_font(font_size)
    emoji_font = get_emoji_font(font_size)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent + LINE_GAP

    img = Image.new("RGB", (BASE_W, BASE_H), theme["app_bg"])
    draw = ImageDraw.Draw(img)
    max_text_w = int(opts.get("max_text_w", MAX_TEXT_W))
    allow_overflow = bool(opts.get("allow_overflow"))

    # 空/错误截图（12.1）：没有聊天内容，只有一条系统提示；用来测「不该产出任何消息」
    if opts.get("blank"):
        blank_text = opts.get("blank_text", "截图失败：未获取到聊天窗口")
        bf = get_font(15)
        bw = bf.getlength(blank_text)
        draw.text(((BASE_W - bw) / 2, (BASE_H - bf.getmetrics()[0]) / 2), blank_text, font=bf, fill=theme["ts_fg"], anchor="la")
        return img, [], [
            {"kind": "screen_text", "text": blank_text, "region": [0, int(BASE_H / 2) - 6, BASE_W, 44]},
        ]

    # 标题栏
    draw.rectangle((0, 0, BASE_W, TITLE_H), fill=theme["title_bg"])
    draw.line((0, TITLE_H, BASE_W, TITLE_H), fill=theme["chat_bg"], width=1)
    title_font = get_font(14)
    title = opts.get("title", "A")
    tw = title_font.getlength(title)
    draw.text(((BASE_W - tw) / 2, 12), title, font=title_font, fill=theme["title_fg"], anchor="la")
    # 右侧窗口控制标记（纯线条，不含文字，避免给 OCR 添假文本）
    for k in range(3):
        cx = BASE_W - 68 + k * 20
        draw.line((cx, 17, cx + 11, 17), fill=theme["ts_fg"], width=1)
        draw.line((cx, 20, cx + 11, 20), fill=theme["ts_fg"], width=1)
    # 左侧返回箭头
    draw.line((18, 18, 24, 12), fill=theme["ts_fg"], width=1)
    draw.line((18, 18, 24, 24), fill=theme["ts_fg"], width=1)

    # 聊天区背景
    draw.rectangle((0, TITLE_H + 1, BASE_W, BASE_H - INPUT_H), fill=theme["chat_bg"])
    # 底部输入栏
    draw.rectangle((0, BASE_H - INPUT_H, BASE_W, BASE_H), fill=theme["input_bg"])
    draw.line((0, BASE_H - INPUT_H, BASE_W, BASE_H - INPUT_H), fill=theme["input_border"], width=1)
    input_box = (MARGIN, BASE_H - INPUT_H + 10, BASE_W - MARGIN, BASE_H - 10)
    draw.rounded_rectangle(input_box, radius=6, fill=theme["app_bg"], outline=theme["input_border"], width=1)
    placeholder = "输入消息"
    ph_font = get_font(14)
    draw.text((MARGIN + 12, BASE_H - INPUT_H + 20), placeholder, font=ph_font, fill=theme["input_fg"], anchor="la")

    context: list[dict] = [
        {"kind": "title", "text": title, "region": [0, 0, BASE_W, TITLE_H]},
        {
            "kind": "input",
            "text": placeholder,
            "region": [input_box[0], BASE_H - INPUT_H, input_box[2] - input_box[0], INPUT_H],
        },
    ]

    # 颜色取主题或低对比覆盖
    bubble_l = theme["faded_bubble_left"] if low else theme["bubble_left"]
    bubble_r = theme["faded_bubble_right"] if low else theme["bubble_right"]
    text_l = theme["faded_text_left"] if low else theme["text_left"]
    text_r = theme["faded_text_right"] if low else theme["text_right"]

    ts_font = get_font(12)
    ts_ascent, ts_descent = ts_font.getmetrics()
    ts_line_h = ts_ascent + ts_descent + 2

    # 第一遍：换行 + 算高。真实微信会话是「从底部往上堆」的，最后一条消息贴着输入栏，
    # 这样 2 条消息的截图不会出现一大片空白（更接近真实截图，也对 OCR 行序更自然）。
    layout: list[dict] = []
    for sender, text in opts["messages"]:
        if sender == "ts":
            layout.append({"kind": "ts", "text": text, "h": ts_line_h})
            continue
        if sender == "system":
            # 居中系统提示（如「你已添加了A…」），属于窗口 chrome，不进 expectedMessages
            sys_lines = wrap_text(font, emoji_font, text, max_text_w)
            layout.append({"kind": "system", "text": text, "lines": sys_lines, "h": line_h * len(sys_lines) + 4})
            continue
        lines = wrap_text(font, emoji_font, text, max_text_w)
        text_w = max(measure_text(font, emoji_font, ln) for ln in lines) if lines else 0.0
        text_w = min(text_w, max_text_w)
        layout.append(
            {
                "kind": "msg",
                "sender": sender,
                "text": text,
                "lines": lines,
                "bw": int(text_w) + PAD_X * 2,
                "bh": line_h * len(lines) + PAD_Y * 2,
            }
        )

    block_h = ts_line_h + MSG_GAP + sum(
        (item["h"] if item["kind"] in ("ts", "system") else item["bh"]) + MSG_GAP for item in layout
    )
    if allow_overflow:
        # 窗口滚动中：内容比可见区高，顶部消息会滚到标题栏后面（chrome 最后重绘盖住）
        y = BASE_H - INPUT_H - 10 - (block_h - MSG_GAP)
    else:
        y = max(TITLE_H + 8, BASE_H - INPUT_H - 10 - (block_h - MSG_GAP))

    # 顶部默认时间戳
    default_ts = opts.get("timestamp", "10月31日 22:31")
    ts_w = ts_font.getlength(default_ts)
    draw.text(((BASE_W - ts_w) / 2, y), default_ts, font=ts_font, fill=theme["ts_fg"], anchor="la")
    context.append({"kind": "timestamp", "text": default_ts, "region": [0, y, BASE_W, ts_line_h + 4]})
    y += ts_line_h + MSG_GAP

    messages: list[dict] = []
    for item in layout:
        if item["kind"] == "ts":
            # 会话中间的第二个时间戳（真实微信按时间分组）
            w = ts_font.getlength(item["text"])
            draw.text(((BASE_W - w) / 2, y), item["text"], font=ts_font, fill=theme["ts_fg"], anchor="la")
            context.append({"kind": "timestamp", "text": item["text"], "region": [0, y, BASE_W, ts_line_h + 4]})
            y += item["h"] + MSG_GAP
            continue

        if item["kind"] == "system":
            for idx, ln in enumerate(item["lines"]):
                w = measure_text(font, emoji_font, ln)
                draw.text(((BASE_W - w) / 2, y + idx * line_h), ln, font=font, fill=theme["ts_fg"], anchor="la")
            context.append({"kind": "system", "text": item["text"], "region": [0, y, BASE_W, item["h"] + 2]})
            y += item["h"] + MSG_GAP
            continue

        sender = item["sender"]
        bw, bh = item["bw"], item["bh"]
        if sender == "right":
            bx = BASE_W - MARGIN - AVATAR - AVATAR_GAP - bw
            ax = BASE_W - MARGIN - AVATAR
        else:
            bx = MARGIN + AVATAR + AVATAR_GAP
            ax = MARGIN
        by = y
        bubble_fill = bubble_r if sender == "right" else bubble_l
        draw.rounded_rectangle((bx, by, bx + bw, by + bh), radius=BUBBLE_RADIUS, fill=bubble_fill)
        avatar_fill = theme["avatar_right"] if sender == "right" else theme["avatar_left"]
        avatar_box = (ax, by, ax + AVATAR, by + AVATAR)
        draw.rounded_rectangle(avatar_box, radius=5, fill=avatar_fill)
        # 真实头像是照片而不是纯色块：铺低对比度的马赛克纹理 + 细噪点。
        # 纯色/干净几何形状会被 WinRT 读成字符 "0"（真实微信头像是照片，不会出这种假文本）。
        ax0, ay0, ax1, ay1 = avatar_box
        for gy in range(int(ay0), int(ay1), 4):
            for gx in range(int(ax0), int(ax1), 4):
                c = tuple(max(0, min(255, v + rng.randint(-38, 38))) for v in avatar_fill)
                draw.rectangle(
                    (gx, gy, min(gx + 3, int(ax1) - 1), min(gy + 3, int(ay1) - 1)), fill=c
                )
        for _ in range(90):
            px = rng.randint(int(ax0) + 2, int(ax1) - 5)
            py = rng.randint(int(ay0) + 2, int(ay1) - 5)
            c = tuple(max(0, min(255, v + rng.randint(-60, 60))) for v in avatar_fill)
            draw.rectangle((px, py, px + rng.randint(1, 2), py + rng.randint(1, 2)), fill=c)

        line_boxes = []
        tx = bx + PAD_X
        ty = by + PAD_Y
        for idx, ln in enumerate(item["lines"]):
            draw_text_run(draw, tx, ty + idx * line_h, ln, font, emoji_font, text_r if sender == "right" else text_l)
            line_boxes.append(
                {
                    "text": ln,
                    "bbox": [int(tx), int(ty + idx * line_h), int(measure_text(font, emoji_font, ln)), int(line_h)],
                }
            )
        messages.append(
            {
                "sender": sender,
                "text": item["text"],
                "bbox": [int(bx), int(by), int(bw), int(bh)],
                "lineBoxes": line_boxes,
            }
        )
        y = by + bh + MSG_GAP

    if block_h > BASE_H - INPUT_H - TITLE_H - 20 and not allow_overflow:
        raise SystemExit(f"消息太多超出窗口高度：{opts.get('captureId')} block_h={block_h}")

    if allow_overflow:
        # 标题栏与输入栏固定不动，消息从下方滚动到它们后面：最后再画一遍 chrome
        draw.rectangle((0, 0, BASE_W, TITLE_H), fill=theme["title_bg"])
        draw.line((0, TITLE_H, BASE_W, TITLE_H), fill=theme["chat_bg"], width=1)
        tw = title_font.getlength(title)
        draw.text(((BASE_W - tw) / 2, 12), title, font=title_font, fill=theme["title_fg"], anchor="la")
        for k in range(3):
            cx = BASE_W - 68 + k * 20
            draw.line((cx, 17, cx + 11, 17), fill=theme["ts_fg"], width=1)
            draw.line((cx, 20, cx + 11, 20), fill=theme["ts_fg"], width=1)
        draw.line((18, 18, 24, 12), fill=theme["ts_fg"], width=1)
        draw.line((18, 18, 24, 24), fill=theme["ts_fg"], width=1)
        draw.rectangle((0, BASE_H - INPUT_H, BASE_W, BASE_H), fill=theme["input_bg"])
        draw.line((0, BASE_H - INPUT_H, BASE_W, BASE_H - INPUT_H), fill=theme["input_border"], width=1)
        draw.rounded_rectangle(input_box, radius=6, fill=theme["app_bg"], outline=theme["input_border"], width=1)
        draw.text((MARGIN + 12, BASE_H - INPUT_H + 20), placeholder, font=ph_font, fill=theme["input_fg"], anchor="la")

    return img, messages, context


# ── 场景定义：20 类 × 2 个变体（固定种子）────────────────────────────────
def messages(pairs):
    return list(pairs)


SCENARIOS: list[dict] = [
    {
        "id": "clear",
        "label": "清晰基准（15px、浅色、100%）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages([("left", "今天大肥鱼很好吃"), ("right", "真的吗？我明天也去试试")]),
            messages([("left", "周末有空吗"), ("right", "有空的，下午三点见")]),
        ],
    },
    {
        "id": "small_font",
        "label": "小字号（10px，模拟微信小号字）",
        "opts": {"theme": "light", "font_size": 10},
        "variants": [
            messages([("left", "这个字号有点小，能看清吗"), ("right", "能看清，就是有点糊")]),
            messages([("left", "小字号的截图识别"), ("right", "看看效果如何")]),
        ],
    },
    {
        "id": "low_contrast",
        "label": "低对比（灰字浅底）",
        "opts": {"theme": "light", "font_size": 15, "low_contrast": True},
        "variants": [
            messages([("left", "灰字浅底看着有点费劲"), ("right", "截图压缩之后就这样")]),
            messages([("left", "低对比度的聊天截图"), ("right", "识别难度会明显上升")]),
        ],
    },
    {
        "id": "gaussian_blur",
        "label": "高斯模糊（radius 1.2）",
        "opts": {"theme": "light", "font_size": 15, "blur_radius": 1.2},
        "variants": [
            messages([("left", "截图被人手抖了一下"), ("right", "整个窗口都糊掉了")]),
            messages([("left", "模糊的截图还能读出来吗"), ("right", "应该会漏掉几个字")]),
        ],
    },
    {
        "id": "scale_100",
        "label": "缩放 100%（基准）",
        "opts": {"theme": "light", "font_size": 15, "scale": (1.0, 1.0)},
        "variants": [
            messages([("left", "缩放百分之一百的截图"), ("right", "这是基准尺寸")]),
            messages([("left", "原始尺寸的界面"), ("right", "文字边缘最清楚")]),
        ],
    },
    {
        "id": "scale_125",
        "label": "缩放 125%",
        "opts": {"theme": "light", "font_size": 15, "scale": (1.25, 1.25)},
        "variants": [
            messages([("left", "缩放百分之一百二十五"), ("right", "看起来清楚了一点")]),
            messages([("left", "系统缩放调大一档"), ("right", "字也变大了")]),
        ],
    },
    {
        "id": "scale_150",
        "label": "缩放 150%",
        "opts": {"theme": "light", "font_size": 15, "scale": (1.5, 1.5)},
        "variants": [
            messages([("left", "缩放百分之一百五十"), ("right", "截图尺寸变大了")]),
            messages([("left", "高分屏的常见比例"), ("right", "识别应该更稳")]),
        ],
    },
    {
        "id": "scale_175",
        "label": "缩放 175%",
        "opts": {"theme": "light", "font_size": 15, "scale": (1.75, 1.75)},
        "variants": [
            messages([("left", "缩放百分之一百七十五"), ("right", "这已经是很大的图了")]),
            messages([("left", "大尺寸截图"), ("right", "计算量也更大")]),
        ],
    },
    {
        "id": "long_bubble",
        "label": "超长气泡（多行换行）",
        "opts": {"theme": "light", "font_size": 14},
        "variants": [
            messages(
                [
                    (
                        "left",
                        "今天下午三点开会，会议纪要我已经整理好发到群里了，大家有空看一下，"
                        "有问题随时在群里回复，我这边会统一汇总处理。",
                    ),
                    ("right", "收到，我晚点看"),
                ]
            ),
            messages(
                [
                    ("left", "你上次说的那个表情包工程还在吗"),
                    (
                        "right",
                        "在的，我把仓库地址和说明都放在群公告里了，你按里面的步骤装一下依赖，"
                        "然后运行测试命令应该就能跑起来，有问题再找我。",
                    ),
                ]
            ),
        ],
    },
    {
        "id": "repeat_two",
        "label": "连发两条相同文本",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages([("left", "好的收到"), ("left", "好的收到")]),
            messages([("right", "明天见"), ("right", "明天见")]),
        ],
    },
    {
        "id": "bilingual",
        "label": "中英混排",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages(
                [
                    ("left", "OK，明天 10:30 我们开个 Zoom 会议聊一下 OCR 的事情"),
                    ("right", "收到，会议链接发我一下"),
                ]
            ),
            messages(
                [
                    ("left", "这个 pipeline 的 CER 大概是多少"),
                    ("right", "我跑一下 benchmark 再告诉你"),
                ]
            ),
        ],
    },
    {
        "id": "numbers",
        "label": "数字 / 金额 / 电话 / 日期（均为虚构占位）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages(
                [
                    ("left", "订单号 SF0000000000，金额 128.50 元，日期 2026-10-31"),
                    ("right", "客服电话 13800000000，工作时间 9:00-18:00"),
                ]
            ),
            messages(
                [
                    ("left", "转账 66.66 元已到账，余额 1024.00 元"),
                    ("right", "2 号线转 10 号线，22:15 最后一班"),
                ]
            ),
        ],
    },
    {
        "id": "emoji",
        "label": "emoji / 颜文字（OCR 通常读不出，属预期）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages(
                [
                    ("left", "今天好累啊 😂 但是活还得干"),
                    ("right", "抱抱你 (￣▽￣) 早点睡"),
                ]
            ),
            messages(
                [
                    ("left", "下班啦 🎉🎉"),
                    ("right", "收到红包啦 🧧 谢谢"),
                ]
            ),
        ],
    },
    {
        "id": "dark_mode",
        "label": "深色模式",
        "opts": {"theme": "dark", "font_size": 15},
        "variants": [
            messages([("left", "深色模式下看得更舒服"), ("right", "夜里刷手机就靠它了")]),
            messages([("left", "黑色背景的截图"), ("right", "对比度其实不低")]),
        ],
    },
    {
        "id": "occluded",
        "label": "半遮挡（通知条盖住部分气泡）",
        "opts": {"theme": "light", "font_size": 15, "occlude": True},
        "variants": [
            messages([("left", "这条消息被通知条挡住了一半"), ("right", "遮挡的部分还能认出来吗")]),
            messages([("left", "被遮挡的聊天内容"), ("right", "只能靠上下文猜了")]),
        ],
    },
    {
        "id": "multi_message",
        "label": "多行多消息（6 条 + 中间时间戳）",
        "opts": {"theme": "light", "font_size": 14},
        "variants": [
            messages(
                [
                    ("left", "在吗"),
                    ("right", "在的"),
                    ("ts", "22:35"),
                    ("left", "晚上一起吃饭吗"),
                    ("right", "可以啊，吃什么"),
                    ("left", "大肥鱼怎么样"),
                    ("right", "行，六点半见"),
                ]
            ),
            messages(
                [
                    ("left", "下午的会议改到三点了"),
                    ("right", "收到"),
                    ("ts", "22:40"),
                    ("left", "会议纪要记得发我"),
                    ("right", "好的，整理完发你"),
                ]
            ),
        ],
    },
    {
        "id": "short_msgs",
        "label": "极短消息（1-2 字气泡）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages([("left", "嗯"), ("right", "好的"), ("left", "OK")]),
            messages([("left", "收到"), ("right", "行"), ("left", "明天见")]),
        ],
    },
    {
        "id": "stretched",
        "label": "截图横向拉伸（x1.35 / y1.0）",
        "opts": {"theme": "light", "font_size": 15, "scale": (1.35, 1.0)},
        "variants": [
            messages([("left", "这是一张被横向拉伸的截图"), ("right", "比例不对，文字会变形")]),
            messages([("left", "拉伸后的文字宽度变了"), ("right", "识别率可能会下降")]),
        ],
    },
    {
        "id": "noisy",
        "label": "压缩噪声（sigma 8）",
        "opts": {"theme": "light", "font_size": 15, "noise_sigma": 8.0, "noise_alpha": 0.12},
        "variants": [
            messages([("left", "压缩噪声让文字边缘变脏"), ("right", "截图质量差的典型情况")]),
            messages([("left", "有噪点的聊天截图"), ("right", "还能认得出来")]),
        ],
    },
    {
        "id": "ai_disclaimer",
        "label": "AI 免责声明长消息",
        "opts": {"theme": "light", "font_size": 14},
        "variants": [
            messages(
                [
                    ("left", "本消息由 AI 分身自动生成，若不需要请回复「停」，人工会尽快接手处理。"),
                    ("right", "好的，知道了，谢谢提醒"),
                ]
            ),
            messages(
                [
                    ("left", "提示：本消息由 AI 分身自动回复，内容仅供参考。"),
                    ("right", "明白，那我先不打扰了"),
                ]
            ),
        ],
    },
    # ── 12.1 覆盖补齐（追加在末尾，保持旧场景序号与随机种子不变）──
    {
        "id": "rare_chars",
        "label": "生僻字/多音字（魑魅魍魉/饕餮耄耋）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages([("left", "银行行长说重要的事要重复三遍"), ("right", "魑魅魍魉饕餮耄耋这些字真难写")]),
            messages([("left", "觊觎已久的东西终于到手了"), ("right", "氤氲的空气里满是蹉跎")]),
        ],
    },
    {
        "id": "homophone",
        "label": "形近字（己已巳/未末/戌戍/辨辩辫）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages([("left", "己所不欲，勿施于人"), ("right", "已经、自己、巳时要分清")]),
            messages([("left", "未来和末日只差一横"), ("right", "辨认辩论辫子三个字难倒我了")]),
        ],
    },
    {
        "id": "network_slang",
        "label": "网络口语（yyds/绝绝子/破防/栓Q）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages([("left", "yyds，这波操作绝绝子"), ("right", "破防了，栓Q")]),
            messages([("left", "今天有点 emo，想躺平"), ("right", "666，干饭去")]),
        ],
    },
    {
        "id": "similar_nickname",
        "label": "相似昵称（小A / 小A2）",
        "opts": {"theme": "light", "font_size": 15},
        "titles": ["小A", "小A2"],
        "variants": [
            messages([("left", "在吗"), ("right", "在的")]),
            messages([("left", "晚上有空吗"), ("right", "八点之后")]),
        ],
    },
    {
        "id": "long_nickname",
        "label": "长昵称（8-9 字）",
        "opts": {"theme": "light", "font_size": 15},
        "titles": ["大肥鱼助手一号", "表情包工程组组长"],
        "variants": [
            messages([("left", "这个昵称有点长"), ("right", "长昵称容易被截断")]),
            messages([("left", "昵称太长会占满标题栏"), ("right", "是的，可能还会被省略")]),
        ],
    },
    {
        "id": "truncated_bubble",
        "label": "气泡截断（超长文本超出窗口右缘）",
        "opts": {"theme": "light", "font_size": 15, "max_text_w": 2000},
        "variants": [
            messages([("left", "这是一条被窗口右边缘截断的超长消息，后半部分内容根本看不全"), ("right", "收到")]),
            messages([("left", "超长气泡在截图里只显示左边一段，右边直接被裁掉了"), ("right", "明白了")]),
        ],
    },
    {
        "id": "empty_error",
        "label": "错误或空截图（无聊天内容，只有提示）",
        "opts": {"theme": "light", "blank": True},
        "variant_opts": [
            {"blank_text": "截图失败：未获取到聊天窗口"},
            {"blank_text": "窗口不在前台，已跳过本次识别"},
        ],
        "variants": [messages([]), messages([])],
    },
    {
        "id": "engine_conflict",
        "label": "双引擎易冲突（小字号+低对比+形近字）",
        "opts": {"theme": "light", "font_size": 11, "low_contrast": True, "blur_radius": 0.5},
        "variants": [
            messages([("left", "己已巳戌戍这几个字容易认错"), ("right", "银行行长重要的事说三遍")]),
            messages([("left", "未末曰日看起来很接近"), ("right", "辩辨辫在低清截图里会混")]),
        ],
    },
    {
        "id": "scrolled",
        "label": "窗口滚动中（顶部消息被标题栏盖住）",
        "opts": {"theme": "light", "font_size": 13, "allow_overflow": True},
        "variants": [
            messages([
                ("right", "再往上还有一条完全看不见"),
                ("left", "这条被标题栏挡住一半"),
                ("left", "上面这条消息只露出一半"),
                ("right", "聊天记录正在往上滚动"),
                ("left", "滚动中截图很容易切掉内容"),
                ("right", "所以要记录滚动位置"),
                ("left", "收到，继续往下看"),
                ("right", "今天聊得有点久"),
                ("left", "先去忙一会儿"),
                ("right", "晚点继续聊"),
                ("left", "好的一会见"),
                ("right", "这条在最下面最完整"),
            ]),
            messages([
                ("right", "最上面这条只剩一点点"),
                ("left", "滚动截图顶部会被标题栏盖住"),
                ("right", "这条只能看到下半截"),
                ("left", "这是中间的聊天内容"),
                ("right", "中间第二条消息"),
                ("left", "中间第三条消息"),
                ("right", "中间第四条消息"),
                ("left", "中间第五条消息"),
                ("right", "中间第六条消息"),
                ("left", "倒数第二条"),
                ("right", "倒数第一条"),
                ("left", "最后一条消息完整显示"),
            ]),
        ],
    },
    {
        "id": "contact_switch",
        "label": "切换联系人（系统提示+新会话消息）",
        "opts": {"theme": "light", "font_size": 15},
        "variants": [
            messages([
                ("system", "你已添加了A，现在可以开始聊天了"),
                ("left", "刚换了个聊天窗口"),
                ("right", "截图里混了上一个会话的内容"),
            ]),
            messages([
                ("system", "以下是新消息"),
                ("left", "切换联系人之后的截图"),
                ("right", "注意别把上一条对话当成新消息"),
            ]),
        ],
    },
]

SCENARIO_INDEX: dict[str, int] = {s["id"]: i for i, s in enumerate(SCENARIOS)}

# 12.1 场景覆盖清单：任务书要求的 21 类场景 → 生成器场景映射，写入 manifest 供审计
COVERAGE_ITEMS: list[dict] = [
    {"id": "near-chars", "label": "形近字", "scenarios": ["homophone", "engine_conflict"]},
    {"id": "polyphone-rare", "label": "多音字及生僻字", "scenarios": ["rare_chars"]},
    {"id": "bilingual", "label": "中英文混合", "scenarios": ["bilingual"]},
    {"id": "numbers-punct", "label": "数字和标点", "scenarios": ["numbers"]},
    {"id": "slang", "label": "网络口语", "scenarios": ["network_slang"]},
    {"id": "emoji", "label": "Emoji", "scenarios": ["emoji"]},
    {"id": "multi-line", "label": "多行消息", "scenarios": ["long_bubble", "multi_message"]},
    {"id": "long-msg", "label": "长消息", "scenarios": ["long_bubble", "ai_disclaimer"]},
    {"id": "dup-in-thread", "label": "同一消息重复出现", "scenarios": ["repeat_two", "multi_message"]},
    {"id": "consecutive-dup", "label": "连续两条相同消息", "scenarios": ["repeat_two"]},
    {"id": "similar-nickname", "label": "相似昵称", "scenarios": ["similar_nickname"]},
    {"id": "long-nickname", "label": "长昵称", "scenarios": ["long_nickname"]},
    {"id": "dark-theme", "label": "深色主题", "scenarios": ["dark_mode"]},
    {"id": "light-theme", "label": "浅色主题", "scenarios": ["clear", "scale_100"]},
    {"id": "dpi", "label": "不同 DPI/缩放", "scenarios": ["scale_100", "scale_125", "scale_150", "scale_175", "stretched"]},
    {"id": "truncated-bubble", "label": "消息气泡截断", "scenarios": ["truncated_bubble"]},
    {"id": "occluded", "label": "窗口遮挡", "scenarios": ["occluded"]},
    {"id": "empty-error", "label": "错误或空截图", "scenarios": ["empty_error"]},
    {"id": "engine-conflict", "label": "两个引擎识别冲突", "scenarios": ["engine_conflict"]},
    {"id": "scrolled", "label": "窗口滚动", "scenarios": ["scrolled"]},
    {"id": "contact-switch", "label": "用户主动切换联系人", "scenarios": ["contact_switch"]},
]


def _scenario_coverage() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for item in COVERAGE_ITEMS:
        for sid in item["scenarios"]:
            out.setdefault(sid, []).append(item["id"])
    return out


def _scale_boxes(messages: list[dict], context: list[dict], sx: float, sy: float):
    """把 base 坐标的 bbox 换算成最终图片坐标。"""
    def conv(box):
        x, y, w, h = box
        return [
            int(round(x * sx)),
            int(round(y * sy)),
            int(round(w * sx)),
            int(round(h * sy)),
        ]

    for msg in messages:
        msg["bbox"] = conv(msg["bbox"])
        for line in msg["lineBoxes"]:
            line["bbox"] = conv(line["bbox"])
    for ctx in context:
        ctx["region"] = conv(ctx["region"])


def build_capture(scenario: dict, variant_index: int, variant: list, out_dir: Path) -> dict:
    sid = scenario["id"]
    capture_id = f"{sid}-{variant_index:02d}"
    rng = random.Random(f"{SEED}:{capture_id}")
    opts = dict(scenario["opts"])
    if scenario.get("variant_opts"):
        opts.update(scenario["variant_opts"][variant_index % len(scenario["variant_opts"])])
    opts["messages"] = variant
    opts["captureId"] = capture_id
    if scenario.get("titles"):
        opts["title"] = scenario["titles"][variant_index % len(scenario["titles"])]
    else:
        opts["title"] = ["A", "B", "C"][(variant_index + sum(map(ord, sid))) % 3]
    opts["timestamp"] = rng.choice(["10月31日 22:31", "10月31日 22:28", "今天 21:57"])

    base, messages, context = render_chat(opts, rng)

    sx, sy = opts.get("scale", (1.0, 1.0))
    # 半遮挡：用一条灰色通知条盖住第一条消息气泡的中上部（base 坐标）
    if opts.get("occlude"):
        target = messages[0]["bbox"]
        bar = (
            max(0, target[0] + int(target[2] * 0.10)),
            max(0, target[1] - 4),
            min(BASE_W, target[0] + int(target[2] * 0.92)),
            min(BASE_H, target[1] + max(18, int(target[3] * 0.55))),
        )
        overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.rounded_rectangle(bar, radius=6, fill=(196, 196, 196, 238))
        base = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")

    if opts.get("blur_radius"):
        base = base.filter(ImageFilter.GaussianBlur(radius=float(opts["blur_radius"])))

    final_w = max(1, int(round(BASE_W * sx)))
    final_h = max(1, int(round(BASE_H * sy)))
    if (final_w, final_h) != (BASE_W, BASE_H):
        base = base.resize((final_w, final_h), resample=Image.LANCZOS)

    if opts.get("noise_sigma"):
        noise = Image.effect_noise(base.size, float(opts["noise_sigma"])).convert("RGB")
        base = Image.blend(base, noise, float(opts.get("noise_alpha", 0.1)))

    _scale_boxes(messages, context, final_w / BASE_W, final_h / BASE_H)

    image_path = out_dir / "images" / f"{capture_id}.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    base.save(image_path, format="PNG", optimize=True)

    return {
        "captureId": capture_id,
        "scenario": sid,
        "scenarioLabel": scenario["label"],
        "scenarioIndex": SCENARIO_INDEX.get(sid, -1),
        "variant": variant_index,
        "scalePct": int(round(sx * 100)),
        "scaleX": round(final_w / BASE_W, 4),
        "scaleY": round(final_h / BASE_H, 4),
        "width": final_w,
        "height": final_h,
        "theme": opts["theme"],
        "fontSize": int(opts.get("font_size", FONT_SIZE)),
        "blurRadius": float(opts.get("blur_radius", 0)),
        "noiseSigma": float(opts.get("noise_sigma", 0)),
        "image": f"images/{capture_id}.png",
        "friendName": opts["title"],
        "expectedMessages": messages,
        "expectedContext": context,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="生成类微信聊天截图 OCR 语料")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录（默认 test/fixtures/ocr-corpus）")
    parser.add_argument("--per-scenario", type=int, default=2, help="每个场景生成几张（默认 2）")
    parser.add_argument("--only", default="", help="只生成指定场景，逗号分隔，如 clear,dark_mode")
    args = parser.parse_args(argv)

    out_dir = Path(args.out).resolve()
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    scenarios = [s for s in SCENARIOS if not only or s["id"] in only]
    if not scenarios:
        print(f"没有匹配的场景：{args.only}", file=sys.stderr)
        return 2

    entries: list[dict] = []
    for scenario in scenarios:
        variants = scenario["variants"][: max(1, args.per_scenario)]
        for idx, variant in enumerate(variants):
            entry = build_capture(scenario, idx, variant, out_dir)
            entries.append(entry)
            print(f"生成 {entry['captureId']}.png  {entry['width']}x{entry['height']}  "
                  f"{entry['scenarioLabel']}")

    scenario_coverage = _scenario_coverage()
    scenario_ids = {s["id"] for s in scenarios}
    coverage_out = []
    for item in COVERAGE_ITEMS:
        present = [sid for sid in item["scenarios"] if sid in scenario_ids]
        if present:
            coverage_out.append({"id": item["id"], "label": item["label"], "scenarios": present})
    if not only:
        uncovered = [item["id"] for item in COVERAGE_ITEMS if not any(sid in scenario_ids for sid in item["scenarios"])]
        if uncovered:
            raise SystemExit(f"12.1 场景覆盖不完整：{uncovered}")

    manifest = {
        "version": 2,
        "seed": SEED,
        "generator": "scripts/ocr/gen_corpus.py",
        "font": "msyh.ttc（微软雅黑）",
        "baseSize": [BASE_W, BASE_H],
        "scenarioCount": len({e["scenario"] for e in entries}),
        "imageCount": len(entries),
        "coverageCount": len(coverage_out),
        "privacy": "全部内容虚构：好友名仅 A/B/C，正文为测试文案；手机号/单号/金额均为占位假数据",
        "scenarios": [
            {
                "id": s["id"],
                "index": SCENARIO_INDEX[s["id"]],
                "label": s["label"],
                "coverage": scenario_coverage.get(s["id"], []),
            }
            for s in scenarios
        ],
        "coverage": coverage_out,
        "images": entries,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"\n完成：{len(entries)} 张图 → {out_dir / 'images'}")
    print(f"manifest → {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
