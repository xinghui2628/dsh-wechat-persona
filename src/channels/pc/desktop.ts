// @ts-nocheck
/**
 * desktop 通道（PC 微信）：视觉驱动（截图 + Windows OCR + 点击/键入）。
 *
 * 设计要点：
 * - 读取优先走「会话列表扫描」：一次 list 拿到未读行 + 预览文字，直接作为入站消息，
 *   避免逐个打开聊天；列表没命中或预览为空时回退到 read 脚本。
 * - 发送优先走「行坐标快路径」：把 list 拿到的 top/left/height 传给脚本，直接点会话行；
 *   没有行坐标时只允许在「当前已打开聊天」的情况下发送，否则拒绝以避免发错人。
 * - 用户键鼠活跃 / 空闲门槛：发送前检查 user-activity.ps1 的 idle 毫秒，过短则让路。
 * - 所有自动化都在独立 powershell 子进程里执行，契约：stdout 单行 JSON。
 *
 * 注意：本文件由源文件事故后重写，保持精简；如需扩展请优先保证脚本契约兼容。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const POLL_INTERVAL_MS = 2000;
const SCRIPT_TIMEOUT_MS = 90000;
const MAX_CONSECUTIVE_FAILURES = 6;
// 每个联系人保留最近几条已发送文本：用于识别「把自己的消息回读成新消息」的自回声。
const MAX_SENT_HISTORY = 5;
const SENT_STATE_PATH = join(tmpdir(), 'dsh-wechat-persona-sent.json');

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

/** 解析 user-activity.ps1 的 stdout（纯数字 / {"idleMs":N} / idle=N）；解析不出返回 null。 */
export function parseIdleMs(stdout: string): number | null {
  const text = String(stdout || '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const value = Number(json?.idleMs ?? json?.idle ?? json?.idle_ms);
      if (Number.isFinite(value)) return value;
    } catch { /* 继续按文本解析 */ }
  }
  const match = text.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

export class DesktopChannel {
  id: any = 'desktop';
  // 桌面视觉驱动目前只能发文本：表情/图片/语音没有 UIA 实现。
  // 声明后引擎会自动把表情概率降为 0，避免「选了表情→发送被拒→错误计数」。
  capabilities: any = { stickers: false, images: false, voice: false };

  constructor({ config, deps, runScript, pollIntervalMs }: any = {}) {
    this.config = config;
    this.deps = deps;
    this.logger = deps.logger;
    this.store = deps.store;
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
    this.loadSentState();
  }

  loadSentState() {
    try {
      const raw = readFileSync(SENT_STATE_PATH, 'utf8');
      const obj = JSON.parse(raw);
      for (const [name, value] of Object.entries(obj || {})) {
        const list = Array.isArray(value) ? value : [value];
        const texts = list.filter((x) => typeof x === 'string' && x);
        if (texts.length > 0) this.lastSentText.set(name, texts.slice(-MAX_SENT_HISTORY));
      }
    } catch { /* 首次运行或文件损坏，忽略 */ }
  }

  saveSentState() {
    try {
      const obj = {};
      for (const [name, texts] of this.lastSentText) obj[name] = texts;
      writeFileSync(SENT_STATE_PATH, JSON.stringify(obj), 'utf8');
    } catch { /* 写临时文件失败不影响主流程 */ }
  }

  normalizeText(text) {
    return String(text || '').replace(/[\s，。！？、,.!?；;：:""''（）()【】\[\]…~～-]/g, '');
  }

  /** 记录一条刚发送的文本（保留最近 MAX_SENT_HISTORY 条，供自回声识别用）。 */
  rememberSentText(label, text) {
    const trimmed = String(text || '').slice(0, 200);
    const history = this.lastSentText.get(label) || [];
    const next = [...history.filter((item) => item !== trimmed), trimmed].slice(-MAX_SENT_HISTORY);
    this.lastSentText.set(label, next);
    return next;
  }

  /** 预览文字是否是我们自己刚发出去的消息（避免自问自答/自言自语）。 */
  isOwnPreview(name, preview) {
    return this.isOwnText(name, preview);
  }

  /** 一段文字是否是我们自己刚发过的内容（带 OCR 容错）。 */
  isOwnText(name, text) {
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
  looksLikeOwnText(p, s) {
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

  scriptPath(name) {
    return fileURLToPath(new URL(`../../../scripts/pwsh/${name}.ps1`, import.meta.url));
  }

  runScript(name, args) {
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
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ code: -1, stdout: out, stderr: err || 'timeout' });
      }, SCRIPT_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
    });
  }

  parseJson(result) {
    const line = String(result.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('{') && s.endsWith('}'))
      .pop();
    if (!line) return null;
    try { return JSON.parse(line); } catch { return null; }
  }

  contactNames() {
    return (this.config.whitelist || []).map((w) => w.name || w.id).filter(Boolean);
  }

  async start(handler) {
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

  async stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.setState('stopped', 'stopped');
    this.logger.info?.('[desktop] 已停止');
  }

  status(): any {
    return {
      id: 'desktop',
      state: this.state,
      detail: this.detail,
      lastError: this.lastError,
      since: this.since,
      lastInboundAt: this.lastInboundAt,
      lastSendAt: this.lastSendAt,
    };
  }

  setState(state, detail) {
    this.state = state;
    this.detail = detail;
    this.since = Date.now();
  }

  async tick() {
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

  async readInboundOnce() {
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

    const needRead = [];
    // 未读预览先不直接投递：列表预览是 OCR 结果，消息稍长就会被截断
    // （实测「我想拉高你的幽默度」只读到「我想拉高你的幽」丢了「默度」），
    // 只拿预览去回复会让模型对着半句话回「啥意思」。先读一次全文，读不到再退回预览。
    const previewRows = [];
    for (const row of parsed.rows) {
      if (!row || !row.found) {
        // 列表里没认出来的联系人不要触发 read：read 会走 Enter-Chat（Ctrl+F 搜索 + 抢前台），
        // 每一轮都触发时用户会看到微信搜索框被反复输入。等下一轮 OCR 恢复即可。
        this.logger.debug?.(`[desktop] list 未识别联系人，跳过 read：${row?.name ?? '?'}`);
        continue;
      }
      this.lastRows.set(row.name, { top: row.top || 0, left: row.left || 0, height: row.height || 0 });
      if (row.unread && typeof row.preview === 'string' && row.preview.trim().length > 0) {
        if (this.isOwnPreview(row.name, row.preview)) {
          this.logger.debug?.(`[desktop] 跳过自己的消息预览：${row.name} ${row.preview.slice(0, 30)}`);
          continue;
        }
        previewRows.push({ name: row.name, preview: row.preview, selected: !!row.selected });
      } else if (row.unread) {
        needRead.push(row.name);
      }
    }

    // 当前打开的会话收到新消息时列表不会有未读红点（聊天窗口已打开=已读），
    // 列表 OCR 里的绿底选中行文字也常常识别不出来，所以对「当前正在看的会话」做低频轮询读取，
    // 否则「回完一条后对方继续发」会一直漏回。脚本用 -NoSearch 只读已打开的聊天，绝不会 Ctrl+F 搜索。
    const selectedRow = parsed.rows.find((row) => row && row.found && row.selected);
    const openName = selectedRow ? String(selectedRow.name) : '';
    const noSearchNames = new Set();
    if (
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
    const previewFallbacks = [];
    for (let index = 0; index < previewRows.length; index += 1) {
      const item = previewRows[index];
      if (index >= 2) {
        previewFallbacks.push(item);
        continue;
      }
      const args = [
        '-Action', 'read',
        '-WindowTitle', cfg.windowTitle || '微信',
        '-Contact', item.name,
        '-MaxMessages', '10',
      ];
      if (item.selected || item.name === current) {
        // 会话已经打开时只读窗口，不触发 Ctrl+F 搜索。
        args.push('-NoSearch', '-CurrentContact', item.name);
      }
      const read = await this.runScript('wechat-uia', args);
      const data = this.parseJson(read);
      const messages = data && data.ok === true && Array.isArray(data.messages) ? data.messages : [];
      let verified = null;
      for (const message of messages) {
        const text = String(message?.text || '').trim();
        if (!text) continue;
        if (this.isOwnText(item.name, text)) continue;
        verified = { text, id: message?.id };
      }
      if (!verified) {
        if (data && data.ok === false && data.error) {
          this.logger.debug?.(`[desktop] 预览校验读取失败，退回预览：${item.name} ${String(data.error).slice(0, 60)}`);
        }
        previewFallbacks.push(item);
        continue;
      }
      const preview = item.preview.trim();
      const useFull = verified.text.length >= preview.length || verified.text.includes(preview) || preview.includes(verified.text);
      this.emitMessage(item.name, useFull ? verified.text : preview, verified.id);
    }
    for (const item of previewFallbacks) this.emitPreview(item.name, item.preview);

    for (const name of needRead.filter(Boolean)) {
      if (this.stopped) return;
      const args = [
        '-Action', 'read',
        '-WindowTitle', cfg.windowTitle || '微信',
        '-Contact', name,
        '-MaxMessages', '10',
      ];
      if (noSearchNames.has(name)) {
        // 只读当前已经打开的会话：脚本在标题与 CurrentContact 都对不上时直接返回 ok:false，不做 Ctrl+F。
        args.push('-NoSearch', '-CurrentContact', name);
      }
      const read = await this.runScript('wechat-uia', args);
      const data = this.parseJson(read);
      if (!data || data.ok !== true || !Array.isArray(data.messages)) {
        this.logger.warn?.(`[desktop] read ${name} 失败 code=${read.code} ${String(read.stderr || '').slice(0, 160)}`);
        continue;
      }
      for (const message of data.messages) {
        const text = String(message?.text || '').trim();
        if (!text) continue;
        // 双保险：窗口读取偶尔会把机器人自己的绿气泡 OCR 成「对方消息」
        // （右侧过滤失败/窗口布局异常时），命中最近发送过的文本就直接丢弃，绝不回给自己。
        if (this.isOwnText(name, text)) {
          this.logger.debug?.(`[desktop] 跳过自回声消息：${name} ${text.slice(0, 30)}`);
          continue;
        }
        this.emitMessage(name, text, message?.id);
      }
    }
  }

  emitPreview(name, preview) {
    const text = preview.trim();
    const id = 'preview-' + createHash('sha1').update(`${name}|${text}|${Math.floor(Date.now() / 60000)}`).digest('hex').slice(0, 16);
    this.emitMessage(name, text, id);
  }

  emitMessage(name, text, rawId) {
    const id = rawId || 'msg-' + createHash('sha1').update(`${name}|${text}`).digest('hex').slice(0, 16);
    const key = `${name}|${id}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    if (this.inFlight.size > 200) this.inFlight.clear();
    this.lastInboundAt = Date.now();
    const message = {
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

  async send(contactId, part) {
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
    const trustedCurrent =
      Date.now() - this.lastActiveContactAt < 180000 ? this.lastActiveContact : '';

    if (!row && trustedCurrent !== label) {
      return { ok: false, error: `缺少聊天定位信息（既不是当前会话也没有行坐标），已拒绝发送以避免发错人：${contactId}` };
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

    const args = [
      '-Action', 'send',
      '-WindowTitle', cfg.windowTitle || '微信',
      '-Contact', label,
      '-TextBase64', Buffer.from(text, 'utf8').toString('base64'),
      '-CurrentContact', trustedCurrent,
    ];
    if (row) {
      args.push('-RowTop', String(row.top), '-RowLeft', String(row.left), '-RowHeight', String(row.height));
    }

    const result = await this.runScript('wechat-uia', args);
    const data = this.parseJson(result);
    if (!data || data.ok !== true) {
      const error = data?.error || `发送脚本失败 code=${result.code} ${String(result.stderr || '').slice(0, 200)}`;
      this.lastError = error;
      this.setState('degraded', error);
      this.logger.warn?.(`[desktop] 发送 ${contactId} 失败：${error}`);
      return { ok: false, error };
    }
    this.lastSendAt = Date.now();
    this.lastActiveContact = label;
    this.lastActiveContactAt = Date.now();
    this.rememberSentText(label, text);
    this.saveSentState();
    this.logger.debug?.(`[desktop] 已发送给 ${contactId}（${text.length} 字）`);
    return { ok: true };
  }

  async userIdleMs() {
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
