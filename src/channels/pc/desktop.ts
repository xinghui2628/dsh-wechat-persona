/**
 * desktop 通道（PC 微信）：视觉驱动（截图 + Windows OCR + 点击/键入）。
 *
 * 设计要点：
 * - 读取优先走「会话列表扫描」：一次 list 拿到未读行 + 预览文字，直接作为入站消息，
 *   避免逐个打开聊天；列表没命中或预览为空时回退到 read 脚本。
 * - 发送优先走「行坐标快路径」：把 list 拿到的 top/left/height 传给脚本，直接点会话行；
 *   v3.0.0 起没有行坐标一律拒绝发送（不再信任 lastActiveContact，避免用户切聊天后发错人）。
 * - 用户键鼠活跃 / 空闲门槛：发送前检查 user-activity.ps1 的 idle 毫秒，过短则让路。
 * - 所有自动化都在独立 powershell 子进程里执行，契约：stdout 单行 JSON。
 *
 * 注意：本文件由源文件事故后重写，保持精简；如需扩展请优先保证脚本契约兼容。
 *
 * v3.0.0 重构：原先内联的 OCR 纯函数（噪声评估/词典纠错/双引擎投票）已迁移到
 * src/core/ocr/{normalize,correction,vote}.ts，并保留同名 re-export 不破坏外部导入。
 * 本文件负责「IO 编排 + 通道状态机」，不再承担 OCR 算法。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import type { ChannelDeps } from '../channel.ts';
import type { WechatPersonaConfig } from '../../config.ts';
import {
  DEFAULT_CORRECTION_WORDS,
  correctOcrText,
  looksGarbled,
  pickBetterText,
} from '../../core/ocr/correction.ts';
import { textOverlapRatio } from '../../core/ocr/normalize.ts';
import { mergeEngineVote } from '../../core/ocr/vote.ts';
import { planInboundDispatch } from '../../core/ocr/pipeline.ts';
import type { OcrDispatchPlan, OcrMessageInput } from '../../core/ocr/pipeline.ts';
import type { BubblePane, BubbleSide, OcrBox } from '../../core/ocr/types.ts';
import type {
  ChannelCapabilities,
  ChannelId,
  ChannelState,
  ChannelStatus,
  FileStoreLike,
  InboundHandler,
  InboundMessage,
  Logger,
  OutboundPart,
  SendDelivery,
  SendResult,
} from '../../types.ts';

// 兼容 v0.2.8 对外导出：纯函数实现已迁到 src/core/ocr/*，这里继续 re-export。
export { correctOcrText, looksGarbled, pickBetterText, textOverlapRatio, mergeEngineVote };
/** 兼容 v0.2.8 导出名：桌面通道的常用词纠错词典（实现见 core/ocr/correction.ts）。 */
export const DEFAULT_OCR_DICT: readonly string[] = DEFAULT_CORRECTION_WORDS;

const POLL_INTERVAL_MS = 2000;
const SCRIPT_TIMEOUT_MS = 90000;
const MAX_CONSECUTIVE_FAILURES = 6;
// 每个联系人保留最近几条已发送文本：用于识别「把自己的消息回读成新消息」的自回声。
const MAX_SENT_HISTORY = 5;
const SENT_STATE_PATH = join(tmpdir(), 'dsh-wechat-persona-sent.json');
// v3.0.0：ack 水位线落在 dataDir 里（跨进程重启仍能读回，避免重启后重放已处理帧）。
const ACK_STATE_FILE = 'desktop-ack.json';

export type DesktopScriptName = 'wechat-uia' | 'user-activity';

export interface DesktopScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type DesktopScriptRunner = (
  name: DesktopScriptName,
  args: string[],
) => DesktopScriptResult | Promise<DesktopScriptResult>;

/** 构造参数（测试可注入假脚本运行器与轮询间隔）。 */
export interface DesktopChannelOptions {
  config?: WechatPersonaConfig;
  deps?: ChannelDeps;
  runScript?: DesktopScriptRunner;
  pollIntervalMs?: number;
}

/** 会话列表里一行聊天的定位信息（来自 wechat-uia list）。 */
interface ChatRowBounds {
  top: number;
  left: number;
  height: number;
}

/** wechat-uia list 返回的 rows[] 条目。 */
interface DesktopListRow {
  found?: boolean;
  name?: string;
  top?: number;
  left?: number;
  height?: number;
  unread?: boolean;
  preview?: string;
  selected?: boolean;
}

/** wechat-uia read/send 返回的 messages[] 条目（v3.0.0 起带 captureId/side/box，供气泡归属与 ack 使用）。 */
interface DesktopScriptMessage extends OcrMessageInput {}

/** wechat-uia read 返回的候选行（诊断用：side 由脚本几何判定给出）。 */
interface DesktopScriptLine {
  text?: string;
  side?: BubbleSide;
  captureId?: string;
  box?: OcrBox;
}

/** wechat-uia 脚本的单行 JSON 输出（字段按需可选）。 */
interface DesktopScriptPayload {
  ok?: boolean;
  error?: string;
  rows?: DesktopListRow[];
  messages?: DesktopScriptMessage[];
  /** v3.0.0：本次读取的帧号（同一帧所有行共享；未确认的行下次重放时 id 不变）。 */
  captureId?: string;
  /** v3.0.0：脚本回显的 ack 水位线（调用方上次确认的 captureId）。 */
  ack?: string;
  /** v3.0.0：聊天面板几何边界（用于气泡归属判定）。 */
  pane?: BubblePane;
  /** v3.0.0：本次读取的候选行（含 side；诊断用）。 */
  lines?: DesktopScriptLine[];
  /** v3.0.0：本次读取实际使用的 OCR 引擎（如 ['winrt'] / ['winrt','rapidocr']）。 */
  engines?: string[];
  /** v3.0.0：发送结果三态（脚本回车后无法确认气泡时给 unknown，引擎据此不自动重发）。 */
  delivery?: SendDelivery;
}

/** v3.0.0 Phase F：最近一次 OCR 读取诊断（供只读诊断接口；不含聊天内容）。 */
export interface DesktopOcrDiagnostics {
  /** 最近一次 read 脚本返回的 captureId。 */
  captureId?: string;
  /** 实际使用的引擎，如 ['winrt'] / ['winrt','rapidocr']。 */
  engines?: string[];
  /** 最近一次识别行数。 */
  lines?: number;
  /** 因归属不确定被拒投的候选数（最近一次读取）。 */
  uncertainCount?: number;
  /** 最近一次读取耗时（ms）。 */
  durationMs?: number;
  /** 最后读取时间戳（ms）。 */
  lastReadAt?: number;
  /** 最后一次 OCR/读取错误（脱敏，不含正文）。 */
  lastError?: string;
}

/** 解析 user-activity.ps1 的 stdout（纯数字 / {"idleMs":N} / idle=N）；解析不出返回 null。 */
export function parseIdleMs(stdout: string): number | null {
  const text = String(stdout || '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text) as { idleMs?: unknown; idle?: unknown; idle_ms?: unknown };
      const value = Number(json?.idleMs ?? json?.idle ?? json?.idle_ms);
      if (Number.isFinite(value)) return value;
    } catch { /* 继续按文本解析 */ }
  }
  const match = text.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** 校验脚本返回的 delivery 字段；非法/缺失返回 undefined（喂给引擎走「按错误文案保守推断」分支）。 */
function normalizeSendDelivery(value: unknown): SendDelivery | undefined {
  return value === 'sent' || value === 'not-sent' || value === 'unknown' ? value : undefined;
}

export class DesktopChannel {
  readonly id: ChannelId = 'desktop';
  // 桌面视觉驱动目前只能发文本：表情/图片/语音没有 UIA 实现。
  // 声明后引擎会自动把表情概率降为 0，避免「选了表情→发送被拒→错误计数」。
  readonly capabilities: ChannelCapabilities = { stickers: false, images: false, voice: false };

  config!: WechatPersonaConfig;
  deps!: ChannelDeps;
  logger!: Logger;
  store!: FileStoreLike;
  handler?: InboundHandler;
  injectedRunner: DesktopScriptRunner | null = null;
  pollIntervalMs = POLL_INTERVAL_MS;
  state: ChannelState = 'stopped';
  detail = 'not started';
  lastError?: string;
  since = 0;
  lastInboundAt?: number;
  lastSendAt?: number;
  stopped = true;
  timer: ReturnType<typeof setInterval> | null = null;
  busy = false;
  failures = 0;
  pauseUntil = 0;
  lastRows = new Map<string, ChatRowBounds>();
  lastActiveContact = '';
  lastActiveContactAt = 0;
  // 当前打开的会话收到新消息时不会出现未读红点（聊天窗口已打开=已读），
  // 列表里的绿底选中行文字 OCR 也常常认不出来，所以对最近交互的会话做低频轮询读取，避免漏回。
  lastOpenReadAt = new Map<string, number>();
  inFlight = new Set<string>();
  // 自己刚发出的文本（按联系人）：防止把「自己的回复」误判成对方的新消息。
  lastSentText = new Map<string, string[]>();
  // v3.0.0：每个联系人最近一次成功投递的帧号（下次 read 传 -Ack 作为水位线，未确认行重放）。
  ackByContact = new Map<string, string>();
  // v3.0.0：因气泡归属不确定而被拒绝投递的累计条数（ChannelStatus 契约不含该字段，诊断用）。
  uncertainCount = 0;
  // v3.0.0：ack 水位线是否已从 dataDir 读回（懒加载，避免构造函数做异步 IO）。
  private ackLoaded = false;
  // v3.0.0：ack 落盘串行链（多次 commit 不并发写同一个文件；失败不影响主流程）。
  private ackSaveChain: Promise<void> = Promise.resolve();
  // v3.0.0 Phase F：最近一次 OCR 读取诊断（status() 透出给只读诊断接口；不含聊天内容）。
  ocrDiagnostics: DesktopOcrDiagnostics = {};
  // 本次 readInboundOnce 的开始时间，用于诊断耗时。
  private ocrStartedAt = 0;

  constructor(options: DesktopChannelOptions = {}) {
    const { config, deps, runScript, pollIntervalMs } = options;
    this.config = config as WechatPersonaConfig;
    this.deps = deps as ChannelDeps;
    this.logger = (deps as ChannelDeps).logger;
    this.store = (deps as ChannelDeps).store;
    this.injectedRunner = typeof runScript === 'function' ? runScript : null;
    this.pollIntervalMs = Number(pollIntervalMs) > 0 ? Number(pollIntervalMs) : POLL_INTERVAL_MS;
    this.state = 'stopped';
    this.detail = 'not started';
    this.lastError = undefined;
    this.since = Date.now();
    this.lastInboundAt = undefined;
    this.lastSendAt = undefined;
    this.stopped = true;
    this.timer = null;
    this.busy = false;
    this.failures = 0;
    this.pauseUntil = 0;
    this.lastRows = new Map();
    this.lastActiveContact = '';
    this.lastActiveContactAt = 0;
    // 当前打开的会话收到新消息时不会出现未读红点（聊天窗口已打开=已读），
    // 列表里的绿底选中行文字 OCR 也常常认不出来，所以对最近交互的会话做低频轮询读取，避免漏回。
    this.lastOpenReadAt = new Map();
    this.inFlight = new Set();
    // 自己刚发出的文本（按联系人）：防止把「自己的回复」误判成对方的新消息。
    this.lastSentText = new Map();
    this.ackByContact = new Map();
    this.uncertainCount = 0;
    this.ocrDiagnostics = {};
    this.ocrStartedAt = 0;
    this.loadSentState();
  }

  loadSentState(): void {
    try {
      const raw = readFileSync(SENT_STATE_PATH, 'utf8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [name, value] of Object.entries(obj || {})) {
        const list: unknown[] = Array.isArray(value) ? value : [value];
        const texts = list.filter((x): x is string => typeof x === 'string' && x.length > 0);
        if (texts.length > 0) this.lastSentText.set(name, texts.slice(-MAX_SENT_HISTORY));
      }
    } catch { /* 首次运行或文件损坏，忽略 */ }
  }

  saveSentState(): void {
    try {
      const obj: Record<string, string[]> = {};
      for (const [name, texts] of this.lastSentText) obj[name] = texts;
      writeFileSync(SENT_STATE_PATH, JSON.stringify(obj), 'utf8');
    } catch { /* 写临时文件失败不影响主流程 */ }
  }

  /**
   * v3.0.0：懒加载上次的 ack 水位线。
   * 插件重启后 inFlight 是空的、脚本里 pending 仍会在下一帧重放；带上持久化水位线
   * 才能让脚本只重放「未确认」的行，避免重启后把已处理过的消息再投一遍。
   */
  private async loadAckState(): Promise<void> {
    if (this.ackLoaded) return;
    this.ackLoaded = true;
    try {
      const data = await this.store.readJson<Record<string, unknown>>(ACK_STATE_FILE);
      if (!data || typeof data !== 'object') return;
      for (const [name, value] of Object.entries(data)) {
        if (typeof value === 'string' && value.length > 0 && !this.ackByContact.has(name)) {
          this.ackByContact.set(name, value);
        }
      }
    } catch { /* 首次运行或文件损坏：当作没有水位线（脚本会重放 pending，inFlight 兜底去重） */ }
  }

  /** v3.0.0：串行落盘 ack 水位线；写失败只记 debug，不影响读取主流程。 */
  private persistAckState(): void {
    const snapshot: Record<string, string> = {};
    for (const [name, ack] of this.ackByContact) snapshot[name] = ack;
    this.ackSaveChain = this.ackSaveChain
      .then(() => this.store.writeJson(ACK_STATE_FILE, snapshot))
      .catch(() => { this.logger.debug?.('[desktop] ack 水位线落盘失败（不影响本轮读取）'); });
  }

  normalizeText(text: string): string {
    return String(text || '').replace(/[\s，。！？、,.!?；;：:""''（）()【】\[\]…~～-]/g, '');
  }

  /** 记录一条刚发送的文本（保留最近 MAX_SENT_HISTORY 条，供自回声识别用）。 */
  rememberSentText(label: string, text: string): string[] {
    const trimmed = String(text || '').slice(0, 200);
    const history = this.lastSentText.get(label) || [];
    const next = [...history.filter((item) => item !== trimmed), trimmed].slice(-MAX_SENT_HISTORY);
    this.lastSentText.set(label, next);
    return next;
  }

  /** 预览文字是否是我们自己刚发出去的消息（避免自问自答/自言自语）。 */
  isOwnPreview(name: string, preview: string): boolean {
    return this.isOwnText(name, preview);
  }

  /** 一段文字是否是我们自己刚发过的内容（带 OCR 容错）。 */
  isOwnText(name: string, text: string): boolean {
    const own = this.lastSentText.get(name);
    if (!own || own.length === 0) return false;
    const p = this.normalizeText(text);
    if (p.length < 2) return false;
    return own.some((item) => this.looksLikeOwnText(p, this.normalizeText(item)));
  }

  /**
   * 判断一段（已归一化的）文字是不是自己刚发过的内容。
   * 列表预览/窗口 OCR 会截断、漏字、把形近字认错（如「完整」→「完整」、
   * 「你」→「亻克」、「复读」→「亻读」），所以整串相等之外还要比较前缀和字符重合率。
   * 宁可把好友的短回复漏掉一次，也不要把自己的话当成对方消息来自言自语。
   */
  looksLikeOwnText(p: string, s: string): boolean {
    if (p.length < 2 || s.length < 2) return false;
    if (p === s) return true;
    if (s.length >= 4 && (s.includes(p) || p.includes(s))) return true;
    // 列表预览只显示前 ~20 个字：检查是否互为前缀/后缀。
    const head = Math.min(p.length, s.length, 12);
    if (head >= 4 && (s.startsWith(p.slice(0, head)) || p.startsWith(s.slice(0, head)))) return true;
    if (p.length >= 6 && s.length >= 6) {
      const chars = [...new Set(p)];
      const common = chars.filter((ch) => s.includes(ch)).length;
      if (common / chars.length >= 0.6) return true;
    }
    return false;
  }

  scriptPath(name: DesktopScriptName): string {
    return fileURLToPath(new URL(`../../../scripts/pwsh/${name}.ps1`, import.meta.url));
  }

  runScript(name: DesktopScriptName, args: string[], signal?: AbortSignal): Promise<DesktopScriptResult> {
    if (this.injectedRunner) {
      return Promise.resolve(this.injectedRunner(name, args));
    }
    return new Promise((resolve) => {
      const ps1 = this.scriptPath(name);
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args],
        { windowsHide: true },
      );
      let out = '';
      let err = '';
      let settled = false;
      const finish = (result: DesktopScriptResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish({ code: -1, stdout: out, stderr: err || 'timeout' });
      }, SCRIPT_TIMEOUT_MS);
      const onAbort = (): void => {
        clearTimeout(timer);
        try { child.kill(); } catch { /* ignore */ }
        finish({ code: -1, stdout: out, stderr: err || 'aborted' });
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        finish({ code: -1, stdout: out, stderr: String(error) });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        finish({ code: code ?? -1, stdout: out, stderr: err });
      });
    });
  }

  parseJson(result: DesktopScriptResult): DesktopScriptPayload | null {
    const line = String(result.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('{') && s.endsWith('}'))
      .pop();
    if (!line) return null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as DesktopScriptPayload;
    } catch {
      return null;
    }
  }

  /**
   * OCR 二次识别投票：读取到的文本可疑时，用 -Upscale 4 再读一遍，取噪声更低/更完整的一份。
   * 第一遍不确定就不硬猜，多读一帧再投票，比拿错字去回复便宜得多。
   */
  async recheckGarbledText(name: string, args: string[], text: string): Promise<string> {
    if (!looksGarbled(text)) return correctOcrText(text, this.contactNames());
    let best = text;
    // 多帧投票：可疑时换不同放大倍数各读一帧，取噪声最低/最完整的一份。
    // 4 倍对形近字更准，2 倍对整体偏糊的窗口更稳；两帧都差就保留原文本，绝不空手丢消息。
    for (const scale of ['4', '2']) {
      if (!looksGarbled(best)) break;
      try {
        const retry = await this.runScript('wechat-uia', [...args, '-Upscale', scale]);
        const data = this.parseJson(retry);
        if (!data || data.ok !== true || !Array.isArray(data.messages)) continue;
        let candidate = '';
        for (const message of data.messages) {
          const item = String(message?.text || '').trim();
          if (!item || this.isOwnText(name, item)) continue;
          candidate = pickBetterText(candidate, item);
        }
        if (!candidate) continue;
        const chosen = pickBetterText(best, candidate);
        if (!looksGarbled(chosen)) {
          this.logger.debug?.(`[desktop] OCR 二次识别选优（${scale}x）：${name} 「${text.slice(0, 24)}」→「${chosen.slice(0, 24)}」`);
        }
        best = chosen;
      } catch { /* 单帧失败不影响其他帧 */ }
    }
    // 双引擎投票：多帧系统 OCR 仍可疑时，让脚本调用第二引擎（RapidOCR）独立识别同一截图，
    // 两路结果重合度高时取更完整的一份；python/依赖缺失时脚本静默回退，不影响主流程。
    if (looksGarbled(best)) {
      try {
        const retry = await this.runScript('wechat-uia', [...args, '-SecondOcr']);
        const data = this.parseJson(retry);
        if (data && data.ok === true && Array.isArray(data.messages)) {
          for (const message of data.messages) {
            const item = String(message?.text || '').trim();
            if (!item || this.isOwnText(name, item)) continue;
            best = pickBetterText(best, mergeEngineVote(best, item));
          }
          if (!looksGarbled(best)) {
            this.logger.debug?.(`[desktop] OCR 双引擎投票选优：${name} 「${text.slice(0, 24)}」→「${best.slice(0, 24)}」`);
          }
        }
      } catch { /* 第二引擎不可用时保留原结果 */ }
    }
    return correctOcrText(best, this.contactNames());
  }

  contactNames(): string[] {
    return (this.config.whitelist || []).map((w) => w.name || w.id).filter(Boolean);
  }

  async start(handler: InboundHandler): Promise<void> {
    const cfg = this.config.channels.desktop;
    if (!this.config.enabled) {
      this.lastError = '桌面通道已禁用';
      this.setState('error', this.lastError);
      this.logger.warn?.('[desktop] 插件未启用，跳过启动');
      return;
    }
    if (!cfg.enabled) {
      this.lastError = '桌面通道已禁用';
      this.setState('error', this.lastError);
      this.logger.warn?.('[desktop] 桌面通道未启用（channels.desktop.enabled=false），不启动自动化');
      return;
    }
    if (cfg.driverEnabled === false) {
      this.setState('running', 'desktop channel running（driverEnabled=false，仅监听不执行自动化）');
      this.logger.info?.('[desktop] driverEnabled=false：仅监听，不执行 UI 自动化');
      return;
    }
    if (process.platform !== 'win32') {
      this.lastError = `desktop 通道仅支持 Windows，当前平台=${process.platform}`;
      this.setState('error', this.lastError);
      this.logger.warn?.(`[desktop] 当前平台 ${process.platform} 不支持桌面自动化`);
      return;
    }
    this.handler = handler;
    this.stopped = false;
    this.setState('starting', 'engine starting');
    this.logger.info?.(`[desktop] 启动：windowTitle=${cfg.windowTitle} idle=${cfg.userActivityIdleMs}ms poll=${this.pollIntervalMs}ms`);
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    await this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.setState('stopped', 'stopped');
    this.logger.info?.('[desktop] 已停止');
  }

  status(): ChannelStatus & { ocr?: DesktopOcrDiagnostics } {
    return {
      id: this.id,
      state: this.state,
      detail: this.detail,
      lastError: this.lastError,
      since: this.since,
      lastInboundAt: this.lastInboundAt,
      lastSendAt: this.lastSendAt,
      // 只读诊断：最近一次 OCR 读取的帧号/引擎/行数/耗时，不含聊天正文。
      ocr: { ...this.ocrDiagnostics },
    };
  }

  setState(state: ChannelState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.since = Date.now();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      await this.readInboundOnce();
      this.failures = 0;
      if (this.state !== 'running') this.setState('running', 'desktop channel running');
    } catch (error) {
      this.failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.setState(this.failures >= MAX_CONSECUTIVE_FAILURES ? 'degraded' : 'running', message);
      this.logger.warn?.(`[desktop] 读取循环异常（${this.failures}）：${message}`);
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.detail = `连续失败 ${this.failures} 次，已停摆；请重载插件恢复`;
        this.logger.warn?.('[desktop] 连续失败过多，停止本轮循环等待重载');
      }
    } finally {
      this.busy = false;
    }
  }

  /** 读取某联系人时应带上的 ack 水位线参数（v3.0.0：脚本只丢弃已确认的行，未确认行重放）。 */
  private ackArgs(name: string): string[] {
    const ack = this.ackByContact.get(name);
    return ack ? ['-Ack', ack] : [];
  }

  /**
   * 把一次 read 的脚本输出转成投递计划（v3.0.0 Phase C）：
   * - 透传 captureId / pane / side / box，交给 core/ocr/pipeline.ts 做气泡归属过滤；
   * - uncertain（几何无法判断）与 outbound（自己）一律拒投并计数，绝不猜；
   * - 旧脚本输出（无 pane/box/side）按 legacy 兼容接受，升级过程不丢消息。
   */
  private planRead(name: string, data: DesktopScriptPayload): OcrDispatchPlan {
    const plan = planInboundDispatch({
      captureId: data.captureId,
      ack: this.ackByContact.get(name) || '',
      pane: data.pane,
      messages: Array.isArray(data.messages) ? data.messages : [],
    });
    this.uncertainCount += plan.uncertainCount;
    const lineCount = Array.isArray(data.lines)
      ? data.lines.length
      : Array.isArray(data.messages) ? data.messages.length : undefined;
    this.ocrDiagnostics = {
      ...this.ocrDiagnostics,
      captureId: plan.captureId || this.ocrDiagnostics.captureId,
      engines: Array.isArray(data.engines) && data.engines.length > 0
        ? data.engines.map((engine) => String(engine))
        : this.ocrDiagnostics.engines,
      lines: typeof lineCount === 'number' ? lineCount : this.ocrDiagnostics.lines,
      uncertainCount: plan.uncertainCount,
      lastReadAt: Date.now(),
      durationMs: this.ocrStartedAt > 0 ? Date.now() - this.ocrStartedAt : this.ocrDiagnostics.durationMs,
    };
    if (plan.rejected.length > 0) {
      for (const rejected of plan.rejected) {
        this.logger.debug?.(`[desktop] 拒绝投递(${rejected.reason}) ${name}: ${rejected.text.slice(0, 30)}`);
      }
    }
    return plan;
  }

  /** 记录本次读取的帧号，作为下次读取的 ack 水位线（只传已成功处理的帧），并持久化。 */
  private commitAck(name: string, plan: OcrDispatchPlan | null): void {
    if (!plan?.nextAck) return;
    if (this.ackByContact.get(name) === plan.nextAck) return;
    this.ackByContact.set(name, plan.nextAck);
    this.persistAckState();
  }

  async readInboundOnce(): Promise<void> {
    await this.loadAckState();
    this.ocrStartedAt = Date.now();
    const contacts = this.contactNames();
    if (!contacts.length) return;
    const cfg = this.config.channels.desktop;
    // 始终带上最近一次会话：脚本用标题 OCR 交叉验证（list 里绿底选中行名字 OCR 不出来时靠它认领），
    // 即使这个值过期，脚本也只是认不出该行、不会错认别人，因此不必加时间窗限制。
    const current = this.lastActiveContact;

    const list = await this.runScript('wechat-uia', [
      '-Action', 'list',
      '-WindowTitle', cfg.windowTitle || '微信',
      '-Contacts', contacts.join(','),
      '-CurrentContact', current,
    ]);
    const parsed = this.parseJson(list);
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.rows)) {
      throw new Error(`list 失败 code=${list.code} ${String(list.stderr || '').slice(0, 200)}`);
    }

    const needRead: string[] = [];
    // 未读预览先不直接投递：列表预览是 OCR 结果，消息稍长就会被截断
    // （实测「我想拉高你的幽默度」只读到「我想拉高你的幽」丢了「默度」），
    // 只拿预览去回复会让模型对着半句话回「啥意思」。先读一次全文，读不到再退回预览。
    const previewRows: Array<{ name: string; preview: string; selected: boolean }> = [];
    for (const row of parsed.rows) {
      if (!row || !row.found) {
        // 列表里没认出来的联系人不要触发 read：read 会走 Enter-Chat（Ctrl+F 搜索 + 抢前台），
        // 每一轮都触发时用户会看到微信搜索框被反复输入。等下一轮 OCR 恢复即可。
        this.logger.debug?.(`[desktop] list 未识别联系人，跳过 read：${row?.name ?? '?'}`);
        continue;
      }
      const rowName = String(row.name || '');
      if (!rowName) continue;
      this.lastRows.set(rowName, { top: row.top || 0, left: row.left || 0, height: row.height || 0 });
      if (row.unread && typeof row.preview === 'string' && row.preview.trim().length > 0) {
        if (this.isOwnPreview(rowName, row.preview)) {
          this.logger.debug?.(`[desktop] 跳过自己的消息预览：${rowName} ${row.preview.slice(0, 30)}`);
          continue;
        }
        previewRows.push({ name: rowName, preview: row.preview, selected: !!row.selected });
      } else if (row.unread) {
        needRead.push(rowName);
      }
    }

    // 当前打开的会话收到新消息时列表不会有未读红点（聊天窗口已打开=已读），
    // 列表 OCR 里的绿底选中行文字也常常识别不出来，所以对「当前正在看的会话」做低频轮询读取，
    // 否则「回完一条后对方继续发」会一直漏回。脚本用 -NoSearch 只读已打开的聊天，绝不会 Ctrl+F 搜索。
    const selectedRow = parsed.rows.find((row) => !!row && !!row.found && !!row.selected);
    const openName = selectedRow ? String(selectedRow.name || '') : '';
    const noSearchNames = new Set<string>();
    if (
      selectedRow &&
      openName &&
      !selectedRow.unread &&
      Date.now() - (this.lastOpenReadAt.get(openName) || 0) > 8000 &&
      !needRead.includes(openName)
    ) {
      needRead.push(openName);
      noSearchNames.add(openName);
      this.lastOpenReadAt.set(openName, Date.now());
      this.logger.debug?.(`[desktop] 当前打开的会话低频轮询读取：${openName}`);
    }

    // 预览校验：最多取 2 条未读预览去读窗口全文（避免一次轮询读太多），
    // 读到的全文若比预览更完整就用全文；读不到就退回预览投递，保证不漏消息。
    const previewFallbacks: Array<{ name: string; preview: string; selected: boolean }> = [];
    for (let index = 0; index < previewRows.length; index += 1) {
      const item = previewRows[index];
      if (index >= 2) {
        previewFallbacks.push(item);
        continue;
      }
      const args: string[] = [
        '-Action', 'read',
        '-WindowTitle', cfg.windowTitle || '微信',
        '-Contact', item.name,
      ];
      // v3.0.0：不再传 -MaxMessages（脚本已不截断），改为回传上次确认的 captureId 水位线。
      args.push(...this.ackArgs(item.name));
      if (item.selected || item.name === current) {
        // 会话已经打开时只读窗口，不触发 Ctrl+F 搜索。
        args.push('-NoSearch', '-CurrentContact', item.name);
      }
      const read = await this.runScript('wechat-uia', args);
      const data = this.parseJson(read);
      const plan = data && data.ok === true ? this.planRead(item.name, data) : null;
      let verified: { text: string; id?: string } | null = null;
      for (const message of plan?.accepted ?? []) {
        const text = message.text.trim();
        if (!text) continue;
        if (this.isOwnText(item.name, text)) continue;
        verified = { text, id: message.id };
      }
      if (!verified) {
        if (plan && plan.uncertainCount > 0) {
          // 读到的新行几何归属不确定（长气泡越线等）：按约定拒投并计数，也不用列表预览补投，
          // 避免「无法判断归属却仍然回复」。ack 掉本轮帧，避免同一帧被反复重放。
          this.commitAck(item.name, plan);
          this.logger.debug?.(`[desktop] 气泡归属不确定，放弃预览补全：${item.name}`);
          continue;
        }
        if (data && data.ok === false && data.error) {
          this.logger.debug?.(`[desktop] 预览校验读取失败，退回预览：${item.name} ${String(data.error).slice(0, 60)}`);
          this.ocrDiagnostics = { ...this.ocrDiagnostics, lastError: String(data.error).slice(0, 120) };
        }
        this.commitAck(item.name, plan);
        previewFallbacks.push(item);
        continue;
      }
      const preview = item.preview.trim();
      const fullText = await this.recheckGarbledText(item.name, args, verified.text);
      const useFull = fullText.length >= preview.length || fullText.includes(preview) || preview.includes(fullText);
      this.emitMessage(item.name, useFull ? fullText : preview, verified.id);
      this.commitAck(item.name, plan);
    }
    for (const item of previewFallbacks) this.emitPreview(item.name, correctOcrText(item.preview, this.contactNames()));

    for (const name of needRead.filter(Boolean)) {
      if (this.stopped) return;
      const args: string[] = [
        '-Action', 'read',
        '-WindowTitle', cfg.windowTitle || '微信',
        '-Contact', name,
      ];
      // v3.0.0：回传上次确认的 captureId 水位线，让脚本重放未确认的行（id 稳定，靠 inFlight 去重）。
      args.push(...this.ackArgs(name));
      if (noSearchNames.has(name)) {
        // 只读当前已经打开的会话：脚本在标题与 CurrentContact 都对不上时直接返回 ok:false，不做 Ctrl+F。
        args.push('-NoSearch', '-CurrentContact', name);
      }
      const read = await this.runScript('wechat-uia', args);
      const data = this.parseJson(read);
      if (!data || data.ok !== true || !Array.isArray(data.messages)) {
        this.logger.warn?.(`[desktop] read ${name} 失败 code=${read.code} ${String(read.stderr || '').slice(0, 160)}`);
        this.ocrDiagnostics = {
          ...this.ocrDiagnostics,
          lastError: `read 失败 code=${read.code}`,
          lastReadAt: Date.now(),
        };
        continue;
      }
      const plan = this.planRead(name, data);
      for (const message of plan.accepted) {
        const text = message.text.trim();
        if (!text) continue;
        // 双保险：窗口读取偶尔会把机器人自己的绿气泡 OCR 成「对方消息」
        // （右侧过滤失败/窗口布局异常时），命中最近发送过的文本就直接丢弃，绝不回给自己。
        if (this.isOwnText(name, text)) {
          this.logger.debug?.(`[desktop] 跳过自回声消息：${name} ${text.slice(0, 30)}`);
          continue;
        }
        const finalText = await this.recheckGarbledText(name, args, text);
        this.emitMessage(name, finalText, message.id);
      }
      this.commitAck(name, plan);
    }
  }

  emitPreview(name: string, preview: string): void {
    const text = preview.trim();
    const id = 'preview-' + createHash('sha1').update(`${name}|${text}|${Math.floor(Date.now() / 60000)}`).digest('hex').slice(0, 16);
    this.emitMessage(name, text, id);
  }

  emitMessage(name: string, text: string, rawId?: string): void {
    const id = rawId || 'msg-' + createHash('sha1').update(`${name}|${text}`).digest('hex').slice(0, 16);
    const key = `${name}|${id}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    if (this.inFlight.size > 200) this.inFlight.clear();
    this.lastInboundAt = Date.now();
    const message: InboundMessage = {
      id,
      contactId: name,
      contactName: name,
      chatType: 'single',
      kind: 'text',
      text,
      receivedAt: Date.now(),
    };
    this.logger.debug?.(`[desktop] 入站 ${name}: ${text.slice(0, 40)}`);
    try {
      this.handler?.(message);
    } catch (error) {
      this.logger.warn?.(`[desktop] handler 异常：${String(error)}`);
    }
  }

  async send(contactId: string, part: OutboundPart, signal?: AbortSignal): Promise<SendResult> {
    if (part?.kind !== 'text') {
      return { ok: false, error: '桌面通道暂不支持发送表情（UIA 表情面板未实现）' };
    }
    const text = String(part.text || '');
    if (!text.trim()) return { ok: false, error: '空消息不发送' };

    const cfg = this.config.channels.desktop;
    if (this.state === 'stopped') return { ok: false, error: '通道未启动' };
    if (!this.config.enabled || !cfg.enabled) return { ok: false, error: '桌面通道已禁用' };
    if (cfg.driverEnabled === false) return { ok: false, error: 'driver disabled' };

    const whitelistEntry = (this.config.whitelist || []).find((w) => w.id === contactId);
    const label = whitelistEntry?.name ? whitelistEntry.name : contactId;
    const row = this.lastRows.get(label) || this.lastRows.get(contactId);
    // v3.0.0 安全修复（REL-P0-3）：不再把「最近 180s 内活跃过的会话」当作可发送目标。
    // 用户可能在生成/拟人延迟期间切走聊天，只凭 lastActiveContact 会把消息发进别人的会话；
    // 这里要求必须拿到 list 的行坐标，脚本再用标题 OCR + 绿底选中双重校验。
    // 定位不到就拒绝：宁可少发一次，也绝不发错人。
    if (!row) {
      return {
        ok: false,
        error: `缺少聊天定位信息（会话列表里没有 ${contactId} 的行坐标），已拒绝发送以避免发错人`,
      };
    }

    if (this.pauseUntil > Date.now()) {
      const remain = Math.max(1, Math.ceil((this.pauseUntil - Date.now()) / 1000));
      return { ok: false, error: `用户正在使用电脑，暂停发送中（剩余 ${remain} 秒）` };
    }

    const idle = await this.userIdleMs();
    if (idle < 0) {
      this.lastError = '无法确认用户键鼠空闲状态，已拒绝发送（user-activity 读取失败）';
      this.setState('degraded', this.lastError);
      return { ok: false, error: this.lastError };
    }
    const replying = this.lastInboundAt && Date.now() - this.lastInboundAt < 120000;
    if (!replying && idle < cfg.userActivityIdleMs) {
      const pauseSeconds = Number(cfg.pauseSeconds) > 0 ? Number(cfg.pauseSeconds) : 30;
      this.pauseUntil = Date.now() + pauseSeconds * 1000;
      const error = `用户正在使用电脑（idle=${idle}ms < ${cfg.userActivityIdleMs}ms），暂停发送 ${pauseSeconds} 秒`;
      this.lastError = error;
      return { ok: false, error };
    }

    const args: string[] = [
      '-Action', 'send',
      '-WindowTitle', cfg.windowTitle || '微信',
      '-Contact', label,
      '-TextBase64', Buffer.from(text, 'utf8').toString('base64'),
    ];
    // 不传 -CurrentContact：脚本侧 trustedOpen 分支会跳过标题 OCR，属于 v0.2.8 的跨联系人误发根因之一，
    // v3.0.0 起发送必须走「行坐标 + 标题校验」路径（定位失败由脚本返回 not-sent）。
    if (row) {
      args.push('-RowTop', String(row.top), '-RowLeft', String(row.left), '-RowHeight', String(row.height));
    }

    const result = await this.runScript('wechat-uia', args, signal);
    const data = this.parseJson(result);
    const delivery = normalizeSendDelivery(data?.delivery);
    if (!data || data.ok !== true) {
      const error = data?.error || `发送脚本失败 code=${result.code} ${String(result.stderr || '').slice(0, 200)}`;
      this.lastError = error;
      this.setState('degraded', error);
      this.logger.warn?.(`[desktop] 发送 ${contactId} 失败（delivery=${delivery ?? 'unknown'}）：${error}`);
      const failure: SendResult = { ok: false, error };
      if (delivery) failure.delivery = delivery;
      return failure;
    }
    this.lastSendAt = Date.now();
    this.lastActiveContact = label;
    this.lastActiveContactAt = Date.now();
    this.rememberSentText(label, text);
    this.saveSentState();
    this.logger.debug?.(`[desktop] 已发送给 ${contactId}（${text.length} 字）`);
    return { ok: true, delivery: 'sent' };
  }

  async userIdleMs(): Promise<number> {
    try {
      const result = await this.runScript('user-activity', []);
      if (!result || result.code !== 0) return -1;
      const idle = parseIdleMs(result.stdout);
      return idle === null ? -1 : idle;
    } catch {
      return -1;
    }
  }
}

export default DesktopChannel;
