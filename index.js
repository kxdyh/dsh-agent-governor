/**
 * Host half of the Agent Governor bundle.
 *
 * Two independently switchable interception layers, both built on documented
 * Harness extension points only:
 *
 *  - **DOL layer — communication semantics.** A deontic policy (Right /
 *    Prohibition / Obligation / Dispensation, resolved by a meta-policy of
 *    `Prohibition > Obligation > Permission`) is injected as a system-prompt
 *    section, and every assistant stream is audited against it on the way out
 *    (`agent/assistant-stream`). A violation is turned into a one-shot
 *    corrective system-prompt context, so the next step of the same turn has to
 *    face it — the Harness equivalent of "retry feedback" at the communication
 *    edge.
 *
 *  - **Sentinel layer — tool execution.** A framework-free evidence cache is
 *    filled from `tools/post-execute` (the only "verified reality": user input
 *    plus real tool returns), and `tools/pre-execute` gates the next call
 *    against it. Deterministic rules only, zero model cost: irreversible shell
 *    commands, and an obligation that a specific numeric argument must have
 *    appeared in the evidence first. `tools/pre-execute` denial is a structured
 *    `{kind:'deny', reason}` — the model receives the reason as the tool result
 *    and corrects itself.
 *
 * Both layers share one evidence cache and one state object, which is what
 * binds "what the agent says" to "what the agent does".
 *
 * The live switch state lives in `<dsh-home>/storages/agent-governor.json` and
 * is served to the Client half over a loopback-only HTTP route, so the header
 * panel and the Host always read the same numbers.
 *
 * All rules are fail-open: a rule that throws is logged and the call proceeds.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** No hard Host dependency: every service is read optionally with `ctx.get`. */
export const inject = [];

const NAME = 'agent-governor';
const ENDPOINT = '/dsh-agent-governor';
const STORE_FILE = 'agent-governor.json';
const LOG_FILE = 'agent-governor-log.json';
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 65536;
const MAX_EVIDENCE = 240;
const MAX_SESSIONS = 32;
const MAX_SESSION_NUMBERS = 6000;
const MAX_STREAM_CHARS = 40000;
const CORRECTION_TTL_MS = 10 * 60 * 1000;
const CORRECTION_MAX = 3;
/** How many of the user's own rules one profile may carry. */
const CUSTOM_RULE_LIMIT = 30;

/** Deontic ranks: the meta-policy resolves conflicts by this order. */
const PROHIBITION = 3;
const OBLIGATION = 2;
const PERMISSION = 1;
const DEONTIC_LABEL = { 3: 'prohibition', 2: 'obligation', 1: 'permission' };

/** Seed configuration. Live switches override `dol` / `sentinel`. */
const DEFAULTS = {
  dol: true,
  sentinel: true,
  dolShadow: false,
  sentinelShadow: false,
  /** Obligation rule: a specific number in a call must exist in the evidence. */
  evidenceGap: true,
  /** Not enabled by default: the same tool+arguments may legitimately repeat. */
  repeatLimit: 0,
  /** Both off by default: heuristic text rules belong in shadow mode first. */
  absoluteClaim: false,
  numberGrounding: false,
  /** Rule ids exempted by the user (the Dispensation concept). */
  dispensations: [],
  /** Tool names whose arguments are treated as shell text. */
  shellTools: ['bash', 'pwsh', 'sh', 'shell', 'run_command', 'terminal_open', 'terminal_write', 'terminal_signal'],
  /**
   * Read-only calls are exempt from the numeric evidence obligation: fetching a
   * value to *look at* is how evidence is produced in the first place, and a
   * line offset is not a claim about the world.
   */
  readOnlyTools: '^(read|read_image|glob|grep|ls|list_.*|get_.*|show_.*|view_.*|inspect_.*|stat|search.*|session_search|session_event_(read|search|trace)|job_output|job_list|cordis_inspect_.*|team_task_(get|list)|list_subagent_models)$',
  /** Result snippet kept per evidence entry. */
  evidenceChars: 800,
  /** Per-string argument cap; longer strings are treated as bulk content. */
  bulkStringChars: 200,
};

/* -------------------------------------------------------------------------- */
/* The rule book                                                              */
/* -------------------------------------------------------------------------- */

/** Argument keys whose string values are shell text. */
const SHELL_KEY_RE = /^(command|cmd|script|input|data|text|code|line)$/i;

/**
 * Recursive *forced* deletion. The catastrophic variant (drive root, home, `/`)
 * is a prohibition; this shape is the one an agent reaches for when it decides a
 * directory "should go" — and the target is exactly what has to be the user's
 * idea, not the model's.
 */
const FORCED_DELETE_RE = /\brm\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|\bRemove-Item\b[^\n]*?-Recurse[^\n]*?-Force|\bdel\s+\/[a-z]*(?:s|q)|\brmdir\s+\/[a-z]*s/i;
/**
 * Any deletion verb at all — the `strict` strength of the delete guard.
 *
 * This is opt-in on purpose: applied by default it would stop an agent from
 * cleaning up files it produced itself, which is normal work. The user picks
 * the strength in the panel; `block` (forced recursive only) stays the default.
 */
const ANY_DELETE_RE = /\b(?:rm|ri|del|erase|rmdir|rd|Remove-Item)\b/i;
/** Path-shaped tokens inside a shell command. */
const PATH_TOKEN_RE = /(?:[A-Za-z]:\\[^\s"'|;&<>]*|~\/[^\s"'|;&<>]*|\/[^\s"'|;&<>]+|\.{1,2}\/[^\s"'|;&<>]+)/g;
/** Scratch space agents are allowed to clean up themselves. */
const SCRATCH_TARGET_RE = /(^|[/\\])(tmp|temp|\.tmp|cache|\.cache|node_modules|dist|build|out|__pycache__|\.venv|venv|target)([/\\]|$)/i;

/** The deletion targets a command names, minus scratch space. */
function deleteTargets(text, options = {}) {
  const source = String(text ?? '');
  const verb = options.anyVerb === true ? ANY_DELETE_RE : FORCED_DELETE_RE;
  if (!verb.test(source)) return [];
  const out = [];
  // `rm -rf *` / `rm -rf .` delete whatever happens to be there: always unrequested.
  if (/\brm\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:\*|\.)(?:\s|$)/i.test(source)) out.push('*');
  for (const match of source.matchAll(PATH_TOKEN_RE)) {
    const raw = match[0].replace(/["']+$/, '');
    if (raw.length < 3) continue;
    if (SCRATCH_TARGET_RE.test(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** Canonical form for comparing paths: one separator style, no trailing slash. */
function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/["']+$/g, '')
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** True when the user's own words named this target (or at least its leaf). */
function isUserNamed(target, userText) {
  const text = String(userText ?? '').toLowerCase();
  if (text === '') return false;
  if (target === '*') return false;
  const normalized = normalizePath(target);
  if (normalized !== '' && text.includes(normalized)) return true;
  const slashed = normalized.replace(/\\/g, '/');
  if (slashed !== normalized && text.includes(slashed)) return true;
  const parts = normalized.split('\\').filter(Boolean);
  const leaf = parts[parts.length - 1] ?? '';
  return leaf.length >= 3 && text.includes(leaf);
}

/** Every path-shaped token in a piece of text. */
function pathTokens(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(PATH_TOKEN_RE)) {
    const raw = match[0].replace(/["']+$/, '').replace(/[\\/]+$/, '');
    if (raw.length >= 3 && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * True when the session itself brought this path into existence.
 *
 * A name-based scratch list can never cover the names an agent invents
 * (`dsh-skill-probe`, `_sx`, …), and that gap blocked a real cleanup. Owning is
 * therefore decided from what actually happened in the session: files written
 * through the file tools, paths named by a creation command, paths inside a
 * script the agent authored, and the output of a successful creation command.
 *
 * Ancestors are deliberately NOT owned: writing one file into a directory the
 * user owns must never license deleting that directory.
 */
function isAgentOwned(target, owned) {
  if (owned === undefined || owned === null || owned.size === 0) return false;
  const normalized = normalizePath(target);
  if (normalized === '') return false;
  if (owned.has(normalized)) return true;
  for (const [path, kind] of owned) {
    if (kind !== 'dir') continue;
    if (normalized.startsWith(`${path}\\`)) return true;
  }
  return false;
}

/** Commands that create a directory (or unpack into one). */
const CREATE_DIR_RE = /\b(?:New-Item\b[^\n]*?-ItemType\s+Directory|\bmkdir\b|\bmd\s+-|\bExpand-Archive\b|\btar\b[^\n]*-x|\bunzip\b|\b7z\s+x\b|\basar\s+extract\b|\bCopy-Item\b|\bcp\s|\bMove-Item\b|\bmv\s)/i;
/** Commands that create or overwrite a file. */
const CREATE_FILE_RE = /\b(?:Out-File|Set-Content|Add-Content|New-Item|\bni\s|\btouch\b|writeFileSync|writeFile|>>?)/i;

/**
 * Rules for the Sentinel layer. `test` receives one pending call plus the
 * session's evidence and returns `null` when the call is clean, or a detail
 * string when the rule is violated.
 */
const SENTINEL_RULES = [
  {
    id: 'sentinel.destructive-delete',
    deontic: PROHIBITION,
    defaultEnabled: true,
    title: { zh: '破坏性删除', en: 'Destructive delete' },
    summary: {
      zh: '拒绝删除根目录／家目录、递归强删系统盘、格式化与覆写磁盘的命令',
      en: 'Deny deleting a filesystem root or home, recursive forced removal of a system drive, formatting, or raw disk writes',
    },
    patterns: [
      { re: /\brm\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:\/|~\/?|\$HOME|\*)(?:\s|$|[;&|])/i, note: 'rm -rf on / or ~' },
      { re: /\brm\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*\s+(?:\/|~\/?|\$HOME|\*)(?:\s|$|[;&|])/i, note: 'rm -fr on / or ~' },
      // The drive root must be the operand of the forced recursion, not any
      // later drive letter in the same command line: `Remove-Item -Recurse
      // -Force C:\` is catastrophic, `Remove-Item "E:\proj\scratch" -Recurse
      // -Force` is ordinary cleanup (measured as a live false positive before).
      { re: /\bRemove-Item\b[^\n]*?-Recurse\b[^\n]*?-Force\b\s*["']?[A-Za-z]:\\?["']?(?:\s|$|;)/i, note: 'recursive forced removal at a drive root' },
      { re: /\bRemove-Item\b[^\n]*?-Recurse\b[^\n]*?-Force\b\s*["']?\\\\["']?(?:\s|$|;)/i, note: 'recursive forced removal at a UNC root' },
      { re: /\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart)\b/i, note: 'mkfs / diskpart' },
      { re: /\bformat\s+[a-z]:/i, note: 'format <drive>:' },
      { re: /\bdd\b[^\n]*\bof=\/dev\//i, note: 'dd onto a device node' },
    ],
  },
  {
    id: 'sentinel.system-control',
    deontic: PROHIBITION,
    defaultEnabled: true,
    title: { zh: '系统级开关机／关机', en: 'Host power control' },
    summary: {
      zh: '拒绝关机、重启、注销本机的命令',
      en: 'Deny shutting down, rebooting, or logging off the host',
    },
    patterns: [
      { re: /\b(?:shutdown|reboot|halt|poweroff|logoff)\b/i, note: 'shutdown family' },
      { re: /\b(?:Restart-Computer|Stop-Computer)\b/i, note: 'PowerShell power verbs' },
    ],
  },
  {
    id: 'sentinel.history-rewrite',
    deontic: PROHIBITION,
    defaultEnabled: true,
    title: { zh: '不可逆的版本库操作', en: 'Irreversible VCS operation' },
    summary: {
      zh: '拒绝强推、硬重置、强制清理、丢弃改动、删分支与清 stash（未提交的工作会被丢弃）',
      en: 'Deny force-push, hard reset, forced clean, discarded work, dropped branches and cleared stashes (uncommitted work is lost)',
    },
    patterns: [
      { re: /\bgit\s+push\b[^\n]*\s--force(?!-with-lease)\b/i, note: 'git push --force' },
      { re: /\bgit\s+push\b[^\n]*\s-f\b/i, note: 'git push -f' },
      { re: /\bgit\s+reset\s+--hard\b/i, note: 'git reset --hard' },
      { re: /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*\b/i, note: 'git clean -fd' },
      // `git restore` and `git checkout -- <path>` throw away working-tree
      // changes exactly like a hard reset; measured as a live gap before this.
      { re: /\bgit\s+restore\b(?![^\n]*--staged)/i, note: 'git restore (discards working-tree changes)' },
      { re: /\bgit\s+checkout\s+--\s/i, note: 'git checkout -- <path>' },
      { re: /\bgit\s+checkout\s+(?:-f|--force)\b/i, note: 'git checkout --force' },
      { re: /\bgit\s+checkout\s+\.(?:\s|$)/i, note: 'git checkout .' },
      { re: /\bgit\s+stash\s+(?:drop|clear)\b/i, note: 'git stash drop/clear' },
      { re: /\bgit\s+branch\s+-D\b/, note: 'git branch -D' },
    ],
  },
  {
    id: 'sentinel.data-destroy',
    deontic: PROHIBITION,
    defaultEnabled: true,
    title: { zh: '破坏性数据定义语句', en: 'Destructive DDL' },
    summary: {
      zh: '拒绝 DROP／TRUNCATE 之类的破坏性数据库语句',
      en: 'Deny destructive DROP / TRUNCATE statements',
    },
    patterns: [
      { re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX)\b/i, note: 'DROP TABLE/DATABASE/...' },
      { re: /\bTRUNCATE\s+TABLE\b/i, note: 'TRUNCATE TABLE' },
    ],
  },
  {
    id: 'sentinel.pipe-to-shell',
    deontic: PROHIBITION,
    defaultEnabled: true,
    title: { zh: '下载内容直接管道执行', en: 'Pipe download into a shell' },
    summary: {
      zh: '拒绝把网络下载的内容直接交给 shell／解释器执行',
      en: 'Deny piping freshly downloaded content straight into a shell or interpreter',
    },
    patterns: [
      { re: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/i, note: 'curl | sh' },
      { re: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n|]*\|\s*(?:iex|Invoke-Expression|python[0-9.]*|node|perl)\b/i, note: 'curl | iex/python/node' },
      { re: /\biex\s*\(\s*(?:New-Object\s+Net\.WebClient|iwr|Invoke-WebRequest)\b/i, note: 'iex(New-Object Net.WebClient)' },
    ],
  },
  {
    id: 'sentinel.unrequested-delete',
    deontic: OBLIGATION,
    defaultEnabled: true,
    title: { zh: '未经点名的删除', en: 'Delete the user never asked for' },
    summary: {
      zh: '递归强制删除（rm -rf / Remove-Item -Recurse -Force 等）的目标必须出现在用户的要求里；单文件删除不受此限，agent 可以清理自己产生的东西',
      en: 'A forced recursive delete may only target something the user named; single-file deletes are not restricted, so an agent can still clean up its own output',
    },
    configKey: 'unrequestedDelete',
    test(context) {
      if (context.shellCall !== true) return null;
      // `strict` widens the trigger to every delete verb; `block` (default) only
      // the forced recursive forms.
      const targets = deleteTargets(context.shell, { anyVerb: context.config.deleteGuardStrict === true });
      if (targets.length === 0) return null;
      for (const target of targets) {
        if (isUserNamed(target, context.session.userText)) continue;
        // The session's own artifacts are not the user's data: this is the part a
        // name-based scratch list could never cover.
        if (isAgentOwned(target, context.session.ownedPaths)) continue;
        return `删除目标「${target}」既没有出现在用户的要求里，也不是本会话中由你自己创建的产物（本会话用户只说过：${truncateMiddle(String(context.session.userText ?? '').replace(/\s+/g, ' ').trim(), 120) || '（空）'}）`;
      }
      return null;
    },
  },
  {
    id: 'sentinel.evidence-gap',
    deontic: OBLIGATION,
    defaultEnabled: true,
    title: { zh: '数值证据缺失', en: 'Ungrounded numeric argument' },
    summary: {
      zh: '调用参数里的具体数值必须已经出现在本会话的已验证证据（用户输入或工具返回）中',
      en: 'A specific number in a call must already appear in this session evidence (user input or a tool return)',
    },
    configKey: 'evidenceGap',
    test(context) {
      if (context.readOnly) return null;
      // Shell text is governed by the prohibition patterns above; a command line
      // is full of incidental numbers (ports, IPs, sizes) that mean nothing.
      if (context.shellCall) return null;
      if (hasBulkString(context.args, context.config.bulkStringChars)) return null;
      // Only numbers that ARE numbers: a digits-in-a-string scan would flag the
      // `127.0` of a URL or the `4213` of a filename, which is noise, not a claim.
      const numbers = collectSpecificNumbers(context.args, { fromStrings: false });
      if (numbers.length === 0) return null;
      for (const value of numbers) {
        if (context.session.numbers.has(value.raw) || context.session.numbers.has(value.normalized)) continue;
        return `参数中的数值 ${value.raw} 未出现在本会话的已验证证据中（用户的输入或任何工具的真实返回）`;
      }
      return null;
    },
  },
  {
    id: 'sentinel.repeat-loop',
    deontic: OBLIGATION,
    defaultEnabled: false,
    title: { zh: '重复调用循环', en: 'Repeated identical call' },
    summary: {
      zh: '同名同参数的成功调用超过阈值后拒绝，逼出换策略',
      en: 'Deny the same successful call+arguments beyond a threshold, forcing a different strategy',
    },
    test(context) {
      const limit = context.config.repeatLimit;
      if (!(limit > 0)) return null;
      const fingerprint = fingerprintOf(context.exec.name, context.args);
      const count = context.session.calls.get(fingerprint) ?? 0;
      if (count < limit) return null;
      return `同一个工具 + 同一组参数已经成功执行 ${count} 次（阈值 ${limit}），继续重复不会带来新信息`;
    },
  },
];

/**
 * Secret-shaped strings. A *documented placeholder* is not a leak: writing
 * `sk-EXAMPLE…` in an example, a doc row, or a test fixture is exactly how a
 * rule like this one gets explained, and flagging it costs a whole extra turn of
 * self-correction for nothing. Real keys are random; these markers are not.
 */
const SECRET_PATTERNS = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, note: 'private key block' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, note: 'sk- API key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, note: 'AWS access key id' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, note: 'GitHub token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, note: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/, note: 'Google API key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, note: 'JWT' },
];
const PLACEHOLDER_RE = /(EXAMPLE|PLACEHOLDER|REDACTED|DUMMY|FAKE|DEMO|SAMPLE|YOUR_|XXXX|\*\*\*\*|……)/i;

/** The first secret-shaped match that is not an obvious placeholder. */
function firstRealSecret(text) {
  for (const pattern of SECRET_PATTERNS) {
    for (const match of String(text ?? '').matchAll(new RegExp(pattern.re.source, `${pattern.re.flags}g`))) {
      if (PLACEHOLDER_RE.test(match[0])) continue;
      return pattern.note;
    }
  }
  return null;
}

/**
 * Rules for the DOL layer. `test` receives the outgoing assistant text for one
 * committed attempt; the same evidence cache decides whether a claim is backed.
 */
const DOL_RULES = [
  {
    id: 'dol.credential-leak',
    deontic: PROHIBITION,
    defaultEnabled: true,
    title: { zh: '凭据外泄', en: 'Credential leak' },
    summary: {
      zh: '禁止把密钥、令牌、私钥写进面向用户的输出',
      en: 'Never put a key, token, or private key into user-facing output',
    },
    patterns: SECRET_PATTERNS,
    // The pattern gate admits any secret shape; this decision admits only a
    // shape that is not a documented placeholder.
    test(context) {
      return firstRealSecret(context.text);
    },
  },
  {
    id: 'dol.completion-claim',
    deontic: OBLIGATION,
    defaultEnabled: true,
    title: { zh: '无证据的完成性断言', en: 'Unbacked completion claim' },
    summary: {
      zh: '本回合没有任何成功工具证据时，不得声称"已完成／已修复／已通过"',
      en: 'A turn with no successful tool evidence may not claim "done / fixed / tests pass"',
    },
    patterns: [
      { re: /(已完成|已修复|已解决|已经完成|已经修复|已通过|全部通过|测试通过|修复完成|已实现|已经改好|搞定)/, note: 'completion claim (zh)' },
      { re: /\b(?:all tests pass(?:ed)?|tests pass(?:ed)?|successfully (?:completed|fixed|implemented)|is now fixed|is now complete|fully tested)\b/i, note: 'completion claim (en)' },
    ],
    test(context) {
      // The obligation only bites when the turn produced no successful evidence.
      if (context.session.turnSuccesses > 0) return null;
      return '本回合至今没有任何成功的工具调用结果，却给出了完成性断言';
    },
  },
  {
    id: 'dol.absolute-claim',
    deontic: PROHIBITION,
    defaultEnabled: false,
    configKey: 'absoluteClaim',
    title: { zh: '绝对化承诺', en: 'Absolute promise' },
    summary: {
      zh: '禁止"100%／绝对／保证"这类无法兑现的绝对化表述',
      en: 'Forbid unkeepable absolutes such as "100% / guaranteed / never fails"',
    },
    patterns: [
      { re: /(100%|绝对不|绝对不会|保证不|保证能|万无一失|零风险)/, note: 'absolute claim (zh)' },
      { re: /\b(?:guaranteed|100% (?:safe|secure|correct|reliable)|never fails)\b/i, note: 'absolute claim (en)' },
    ],
  },
  {
    id: 'dol.number-grounding',
    deontic: OBLIGATION,
    defaultEnabled: false,
    configKey: 'numberGrounding',
    title: { zh: '输出数值无依据', en: 'Ungrounded number in output' },
    summary: {
      zh: '输出里的具体数值也必须有证据来源，不能凭印象给出',
      en: 'A specific number in the answer needs an evidence source too',
    },
    test(context) {
      const numbers = collectSpecificNumbers(context.text);
      for (const value of numbers) {
        if (context.session.numbers.has(value.raw) || context.session.numbers.has(value.normalized)) continue;
        return `输出中的数值 ${value.raw} 未出现在本会话的已验证证据中`;
      }
      return null;
    },
  },
];

const ALL_RULES = [...SENTINEL_RULES, ...DOL_RULES];
const RULE_BY_ID = new Map(ALL_RULES.map((rule) => [rule.id, rule]));

/* -------------------------------------------------------------------------- */
/* Text helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Head+tail truncation: keeps column headers and sample rows (never just the head). */
function truncateMiddle(text, max) {
  if (typeof text !== 'string') return '';
  if (max <= 0 || text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [truncated ${text.length - max} chars] …\n${text.slice(text.length - tail)}`;
}

/** Flatten a tool result into audit text. */
function resultText(result) {
  if (result === undefined || result === null) return '';
  const parts = [];
  if (result.isError === true) parts.push(`[error] ${result.error?.message ?? ''}`);
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if (typeof block.text === 'string') parts.push(block.text);
      else if (block.type !== undefined) parts.push(`[${String(block.type)}]`);
    }
  }
  if (result.value !== undefined) {
    try {
      parts.push(typeof result.value === 'string' ? result.value : JSON.stringify(result.value));
    } catch {
      /* a non-serializable value still leaves the content text above */
    }
  }
  return parts.join('\n');
}

/** Compact, bounded argument snapshot for the evidence cache. */
function summarizeArgs(args) {
  const seen = new Set();
  const walk = (value, depth) => {
    if (depth > 4) return '…';
    if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => walk(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) out[key] = walk(item, depth + 1);
    return out;
  };
  try {
    return truncateMiddle(JSON.stringify(walk(args, 0)) ?? '', 600);
  } catch {
    return '';
  }
}

/** Every shell-looking string inside a call's arguments. */
function shellText(args) {
  const parts = [];
  const walk = (value, key, depth) => {
    if (depth > 4 || parts.length > 20) return;
    if (typeof value === 'string') {
      if (key === undefined || SHELL_KEY_RE.test(key)) parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [childKey, item] of Object.entries(value)) walk(item, childKey, depth + 1);
    }
  };
  walk(args, undefined, 0);
  return parts.join('\n');
}

/** True when the call carries bulk content, so numeric grounding is not applied. */
function hasBulkString(args, cap) {
  let bulk = false;
  const seen = new Set();
  const walk = (value, depth) => {
    if (bulk || depth > 5) return;
    if (typeof value === 'string') {
      if (value.length > cap) bulk = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(args, 0);
  return bulk;
}

/**
 * "Specific" numbers: magnitude ≥ 100 and not a round multiple of ten, so
 * ordinary constants (60000, 2000, 1500, small counts) are never policed while
 * invented quantities (299.99, 4213) are.
 *
 * `fromStrings` decides whether digits *inside* a string count. The evidence
 * obligation answers "is this a real quantity or an invention", so it reads
 * numbers only; a prose scan (the opt-in DOL number rule) reads both.
 */
function collectSpecificNumbers(value, { fromStrings = true } = {}) {
  const out = [];
  const seen = new Set();
  const consider = (raw) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const magnitude = Math.abs(parsed);
    if (magnitude < 100) return;
    if (Number.isInteger(parsed) && parsed % 10 === 0) return;
    out.push({ raw: String(raw), normalized: String(parsed) });
  };
  const fromText = (text) => {
    if (fromStrings !== true) return;
    for (const match of text.matchAll(/-?\d+(?:\.\d+)?/g)) consider(match[0]);
  };
  const walk = (item, depth) => {
    if (out.length > 24 || depth > 6) return;
    if (typeof item === 'number') {
      consider(item);
      return;
    }
    if (typeof item === 'string') {
      fromText(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) walk(entry, depth + 1);
      return;
    }
    if (item !== null && typeof item === 'object') {
      if (seen.has(item)) return;
      seen.add(item);
      for (const entry of Object.values(item)) walk(entry, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/** Stable identity for a call: tool name + arguments. */
function fingerprintOf(name, args) {
  let body;
  try {
    body = JSON.stringify(args) ?? '';
  } catch {
    body = String(args);
  }
  return `${name}::${body.length > 400 ? `${body.slice(0, 400)}|${body.length}` : body}`;
}

/* -------------------------------------------------------------------------- */
/* Evidence + per-session state                                               */
/* -------------------------------------------------------------------------- */

function createSession(id) {
  return {
    id,
    /** Every number the session has actually seen (user input + tool returns). */
    numbers: new Set(),
    /**
     * The user's own words, so an obligation can ask "did the user name this?".
     * Tool output must never land here: "the model read it" is not "the user
     * asked for it", which is the whole point of the delete rule.
     */
    userText: '',
    /** Newest-last ring of verified tool outcomes. */
    evidence: [],
    /** Successful-call fingerprints → count (repeat-loop rule). */
    calls: new Map(),
    /** One-shot DOL corrections waiting to be shown to the model. */
    pending: [],
    /**
     * Paths this session created (`Map<lowercased path, 'file'|'dir'>`). Used to
     * tell "the agent's own artifact" from "the user's data" without guessing
     * from names.
     */
    ownedPaths: new Map(),
    /** Per-session counters for the panel. */
    stats: { dolAudited: 0, dolFlagged: 0, sentinelInspected: 0, sentinelBlocked: 0, evidence: 0 },
    /** Turn bookkeeping for the completion-claim obligation. */
    turn: undefined,
    /** Latest step seen for this agent, so a denial can be attributed to a step. */
    step: null,
    /**
     * The turn that step belonged to. Kept apart from `turn` (which the stream
     * handler owns, because that is what resets the per-turn success counter).
     */
    stepTurn: null,
    turnStartedAt: 0,
    turnSuccesses: 0,
    touched: Date.now(),
  };
}

function absorbNumbers(session, text) {
  if (typeof text !== 'string' || text.length === 0) return;
  if (session.numbers.size > MAX_SESSION_NUMBERS) return;
  for (const match of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    session.numbers.add(match[0]);
    const parsed = Number(match[0]);
    if (Number.isFinite(parsed)) session.numbers.add(String(parsed));
  }
}

/** Text of the messages entering one step (user input is ground truth). */
function messagesText(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Record the paths a successful call shows the session creating. */
function recordOwnedPaths(session, exec, result) {
  const remember = (raw, kind) => {
    const path = normalizePath(raw);
    if (path.length < 3) return;
    if (session.ownedPaths.get(path) === 'dir') return;
    session.ownedPaths.set(path, kind === 'dir' ? 'dir' : 'file');
    if (session.ownedPaths.size > 400) {
      const oldest = session.ownedPaths.keys().next();
      if (oldest.done !== true) session.ownedPaths.delete(oldest.value);
    }
  };

  const name = String(exec?.name ?? '');
  const args = exec?.arguments;
  if (name === 'write' || name === 'edit') {
    remember(args?.file_path, 'file');
    // A script the session authored names the artifacts it is about to produce.
    if (name === 'write' && typeof args?.content === 'string') {
      for (const token of pathTokens(args.content.slice(0, 8000))) remember(token, 'file');
    }
    return;
  }

  const command = typeof args?.command === 'string' ? args.command : '';
  if (command === '') return;
  if (CREATE_DIR_RE.test(command)) for (const token of pathTokens(command)) remember(token, 'dir');
  if (CREATE_FILE_RE.test(command)) {
    for (const token of pathTokens(command)) remember(token, 'file');
    // A creation command's own output lists what it produced.
    for (const token of pathTokens(resultText(result).slice(0, 4000))) remember(token, 'file');
  }
}

/* -------------------------------------------------------------------------- */
/* Rule evaluation                                                            */
/* -------------------------------------------------------------------------- */

function configuredRules(config, rules = ALL_RULES) {
  const enabled = new Map();
  for (const rule of rules) {
    let on = rule.defaultEnabled === true;
    const override = config.ruleOverrides?.[rule.id];
    if (typeof override === 'boolean') on = override;
    if (rule.configKey !== undefined && typeof config[rule.configKey] === 'boolean') on = config[rule.configKey];
    if (config.dispensations.includes(rule.id)) on = false;
    enabled.set(rule.id, on);
  }
  return enabled;
}

/**
 * Meta-policy: dispensations remove a rule, then the highest deontic rank wins,
 * ties broken by the rule book's order (an explicit prohibition always beats an
 * obligation).
 */
function resolveMatches(matches, config) {
  const live = matches.filter((match) => !config.dispensations.includes(match.id));
  live.sort((a, b) => b.deontic - a.deontic || a.order - b.order);
  return live[0] ?? null;
}

function matchPattern(rule, text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const pattern of rule.patterns ?? []) {
    if (pattern.re.test(text)) return pattern.note;
  }
  return null;
}

/**
 * Run a rule book.
 *
 * A rule fires only when every condition it declares holds: a declared pattern
 * must match the surface the rule targets, and a declared `test` must return a
 * detail. `textFor` returns null when a surface does not apply to that rule
 * (a shell prohibition on a non-shell call, for instance).
 */
function matchRules(rules, options) {
  const { textFor, contextOf, config } = options;
  // The enabled map must cover exactly the book being evaluated, or a
  // user-authored rule reads as undefined and silently never fires.
  const enabled = configuredRules(config, rules);
  const matches = [];
  rules.forEach((rule, order) => {
    if (enabled.get(rule.id) !== true) return;
    const hasPatterns = Array.isArray(rule.patterns) && rule.patterns.length > 0;
    let patternNote = null;
    if (hasPatterns) {
      const text = textFor(rule);
      if (text === null || text === undefined) return;
      patternNote = matchPattern(rule, text);
      if (patternNote === null) return;
    }
    let note = null;
    if (rule.test !== undefined) {
      note = rule.test(contextOf(rule));
      if (note === null || note === undefined || note === false) return;
    }
    matches.push({ id: rule.id, deontic: rule.deontic, order, note: String(note ?? `匹配到 ${patternNote}`) });
  });
  return resolveMatches(matches, config);
}

/** One-line call signature a custom rule can match against. */
function callText(exec) {
  let args = '';
  try {
    args = JSON.stringify(exec?.arguments ?? null) ?? '';
  } catch {
    args = String(exec?.arguments);
  }
  return truncateMiddle(`${exec?.name ?? ''} ${args}`, 2000);
}

/**
 * Evaluate the Sentinel layer for one pending call.
 * `extraRules` are the user's own rules (layer `sentinel`); they see the whole
 * call signature, while the built-in shell prohibitions keep their narrower
 * shell-only surface.
 */
export function evaluateSentinel(exec, session, config, extraRules = []) {
  const args = exec.arguments;
  const context = {
    exec,
    args,
    shell: shellText(args),
    call: callText(exec),
    session,
    config,
    readOnly: isReadOnlyCall(config, exec.name),
    shellCall: isShellCall(config, exec.name),
  };
  return matchRules([...SENTINEL_RULES, ...extraRules.filter((rule) => rule.layer === 'sentinel')], {
    textFor: (rule) => (rule.surface === 'call' ? context.call : context.shellCall ? context.shell : null),
    contextOf: () => context,
    config,
  });
}

/** True when the tool name is on the read-only exemption list. */
export function isReadOnlyCall(config, name) {
  if (typeof name !== 'string') return false;
  try {
    return new RegExp(config.readOnlyTools, 'i').test(name);
  } catch {
    return false;
  }
}

/** True when the tool's arguments are treated as shell text. */
export function isShellCall(config, name) {
  if (typeof name !== 'string') return false;
  return config.shellTools.includes(name) || name.startsWith('terminal_');
}

/** Evaluate the DOL layer for one committed assistant output. */
export function evaluateDol(text, session, config, extraRules = []) {
  return matchRules([...DOL_RULES, ...extraRules.filter((rule) => rule.layer === 'dol')], {
    textFor: () => text,
    contextOf: () => ({ text, session, config }),
    config,
  });
}

/** Build a live rule object out of one user-authored entry. */
function customRuleObject(entry, index) {
  const pattern = typeof entry?.pattern === 'string' ? entry.pattern.trim() : '';
  if (pattern === '') return null;
  let re;
  try {
    re = new RegExp(pattern, typeof entry.flags === 'string' && entry.flags !== '' ? entry.flags : 'i');
  } catch {
    return null;
  }
  const layer = entry.layer === 'dol' ? 'dol' : 'sentinel';
  return {
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `custom.${index + 1}`,
    custom: true,
    layer,
    surface: layer === 'dol' ? 'output' : 'call',
    defaultEnabled: entry.enabled !== false,
    deontic: entry.deontic === 'obligation' ? OBLIGATION : PROHIBITION,
    title: entry.title ?? { zh: '自定义规则', en: 'Custom rule' },
    summary: {
      zh: `自定义正则：${pattern}`,
      en: `Custom regex: ${pattern}`,
    },
    pattern,
    message: typeof entry.message === 'string' && entry.message.trim() !== '' ? entry.message.trim() : pattern,
    patterns: [{ re, note: typeof entry.message === 'string' && entry.message.trim() !== '' ? entry.message.trim() : pattern }],
  };
}

function ruleView(rule, enabled) {
  return {
    id: rule.id,
    layer: rule.layer ?? (SENTINEL_RULES.includes(rule) ? 'sentinel' : 'dol'),
    deontic: DEONTIC_LABEL[rule.deontic],
    enabled: enabled === true,
    custom: rule.custom === true,
    title: rule.title,
    summary: rule.summary,
    ...(rule.custom === true ? { pattern: rule.pattern, message: rule.message } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Live state + persistence                                                   */
/* -------------------------------------------------------------------------- */

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS, ...source };
  config.dispensations = Array.isArray(source.dispensations)
    ? source.dispensations.filter((id) => typeof id === 'string')
    : [];
  config.shellTools = Array.isArray(source.shellTools)
    ? source.shellTools.filter((name) => typeof name === 'string')
    : [...DEFAULTS.shellTools];
  config.ruleOverrides = source.ruleOverrides !== null && typeof source.ruleOverrides === 'object' ? source.ruleOverrides : {};
  config.repeatLimit = Number.isFinite(Number(config.repeatLimit)) ? Math.max(0, Number(config.repeatLimit)) : 0;
  config.evidenceChars = Number.isFinite(Number(config.evidenceChars)) ? Math.min(4000, Math.max(120, Number(config.evidenceChars))) : DEFAULTS.evidenceChars;
  config.readOnlyTools = typeof source.readOnlyTools === 'string' && source.readOnlyTools.trim() !== '' ? source.readOnlyTools : DEFAULTS.readOnlyTools;
  try {
    new RegExp(config.readOnlyTools);
  } catch {
    config.readOnlyTools = DEFAULTS.readOnlyTools;
  }
  return config;
}

/**
 * The host half of the plugin: shared state, evidence, rules and the loopback
 * bridge the Client panel reads.
 */
export function createGovernor(rawConfig, logger) {
  const config = normalizeConfig(rawConfig);
  const sessions = new Map();
  const attempts = new Map();
  const startedAt = Date.now();

  const view = {
    dol: { enabled: config.dol !== false, shadow: config.dolShadow === true },
    sentinel: { enabled: config.sentinel !== false, shadow: config.sentinelShadow === true },
  };

  /**
   * Sub-control of the Sentinel layer: how hard the delete guard pushes.
   *
   * `off` is deliberately *not* a strength — it is the switch. The three
   * strengths are:
   *   watch  — record the would-be block, never refuse (适合先观察)
   *   block  — refuse a forced recursive delete of something neither the user
   *            named nor this session created (默认)
   *   strict — refuse any delete verb, single files included, under the same test
   */
  const DELETE_LEVELS = ['watch', 'block', 'strict'];
  const deleteGuard = { enabled: config.deleteGuardEnabled !== false, level: 'block' };
  if (typeof config.deleteGuardLevel === 'string' && DELETE_LEVELS.includes(config.deleteGuardLevel)) {
    deleteGuard.level = config.deleteGuardLevel;
  }
  const guardActive = () => deleteGuard.enabled === true;
  const guardLevel = () => (guardActive() ? deleteGuard.level : 'off');
  /** Mirror the guard into the rule book: off disables the rule, strict widens it. */
  const syncGuard = () => {
    if (guardActive()) delete config.ruleOverrides['sentinel.unrequested-delete'];
    else config.ruleOverrides['sentinel.unrequested-delete'] = false;
    config.deleteGuardStrict = guardActive() && deleteGuard.level === 'strict';
  };
  syncGuard();

  /**
   * The user's own rules, editable from the header panel. They live beside the
   * switches in the storage file so a self-authored rule survives restarts, and
   * they are ordinary rule objects: same engine, same meta-policy.
   */
  const custom = { list: [] };
  const customRules = () => custom.list.map(customRuleObject).filter((rule) => rule !== null);
  const ruleOf = (id) => {
    const built = RULE_BY_ID.get(id);
    if (built !== undefined) return built;
    return customRules().find((rule) => rule.id === id);
  };

  /**
   * Add one rule authored from the header panel. Validation is the whole point:
   * a bad regex must be refused here, with a reason, rather than thrown on the
   * next tool call.
   */
  const addCustomRule = (input) => {
    const layer = input?.layer === 'dol' ? 'dol' : 'sentinel';
    const pattern = typeof input?.pattern === 'string' ? input.pattern.trim() : '';
    if (pattern === '' || pattern.length > 200) return { ok: false, error: 'pattern must be 1-200 characters' };
    const flags = typeof input?.flags === 'string' && input.flags !== '' ? input.flags : '';
    try {
      new RegExp(pattern, flags === '' ? 'i' : flags);
    } catch (error) {
      return { ok: false, error: `invalid regex: ${error?.message ?? error}` };
    }
    if (custom.list.length >= CUSTOM_RULE_LIMIT) return { ok: false, error: `at most ${CUSTOM_RULE_LIMIT} custom rules` };
    const id = `custom.${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
    custom.list.push({
      id,
      layer,
      pattern,
      flags,
      message: typeof input?.message === 'string' ? input.message.trim().slice(0, 160) : '',
      deontic: input?.deontic === 'obligation' ? 'obligation' : 'prohibition',
      enabled: true,
      title: layer === 'dol' ? { zh: '自定义输出规则', en: 'Custom output rule' } : { zh: '自定义工具规则', en: 'Custom tool rule' },
    });
    persist();
    log(`custom rule added (${layer}): ${pattern}`);
    return { ok: true, id };
  };

  const removeCustomRule = (id) => {
    const index = custom.list.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    custom.list.splice(index, 1);
    persist();
    return true;
  };

  const stats = {
    dol: { audited: 0, flagged: 0, corrected: 0, shadowed: 0, lastFlag: null },
    sentinel: { inspected: 0, blocked: 0, shadowed: 0, evidence: 0, lastBlock: null, lastShadow: null },
  };

  /**
   * Shared interception log: one ring buffer across every session, so the
   * header button can answer "which step was stopped, and why" without caring
   * which conversation it came from.
   */
  const logEntries = [];
  let logSeq = 0;
  const recordInterception = (entry) => {
    logSeq += 1;
    logEntries.push({ id: logSeq, at: new Date().toISOString(), ...entry });
    if (logEntries.length > 80) logEntries.splice(0, logEntries.length - 80);
    persistLog();
  };

  /**
   * Placement/error reports pushed by the Client half. The header control is a
   * slot occupant, and "the registration exists" does not prove "the control is
   * on screen" — this is the channel that turns that question into data.
   */
  const diagnostics = [];
  const recordDiagnostic = (report) => {
    if (report === null || typeof report !== 'object') return;
    diagnostics.push({ at: new Date().toISOString(), ...report });
    if (diagnostics.length > 20) diagnostics.splice(0, diagnostics.length - 20);
  };

  const log = (message, error) => {
    try {
      if (error === undefined) logger?.info?.(`[${NAME}] ${message}`);
      else logger?.warn?.(`[${NAME}] ${message}: ${error?.message ?? error}`);
    } catch {
      /* logging must never break a governed call */
    }
  };

  /* -- persistence --------------------------------------------------------- */

  const storePath = () => join(dshHome(), 'storages', STORE_FILE);
  const logPath = () => join(dshHome(), 'storages', LOG_FILE);

  /** The record outlives the process: a log that resets on restart is not a log. */
  let logSaveTimer;
  const persistLog = () => {
    if (logSaveTimer !== undefined) clearTimeout(logSaveTimer);
    logSaveTimer = setTimeout(() => {
      logSaveTimer = undefined;
      try {
        const target = logPath();
        mkdirSync(join(target, '..'), { recursive: true });
        const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: logEntries }, null, 2);
        const temporary = `${target}.tmp`;
        writeFileSync(temporary, payload, 'utf8');
        renameSync(temporary, target);
      } catch (error) {
        log('could not persist the interception record', error);
      }
    }, 200);
    if (typeof logSaveTimer?.unref === 'function') logSaveTimer.unref();
  };

  let saveTimer;
  const persist = () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      try {
        const target = storePath();
        mkdirSync(join(target, '..'), { recursive: true });
        const payload = JSON.stringify(
          {
            version: 2,
            dol: view.dol.enabled,
            sentinel: view.sentinel.enabled,
            dolShadow: view.dol.shadow,
            sentinelShadow: view.sentinel.shadow,
            deleteGuardEnabled: deleteGuard.enabled,
            deleteGuardLevel: deleteGuard.level,
            customRules: custom.list,
            savedAt: new Date().toISOString(),
          },
          null,
          2,
        );
        const temporary = `${target}.tmp`;
        writeFileSync(temporary, payload, 'utf8');
        renameSync(temporary, target);
      } catch (error) {
        log('could not persist switches', error);
      }
    }, 120);
    if (typeof saveTimer?.unref === 'function') saveTimer.unref();
  };

  const load = () => {
    try {
      const parsed = JSON.parse(readFileSync(storePath(), 'utf8'));
      if (typeof parsed?.dol === 'boolean') view.dol.enabled = parsed.dol;
      if (typeof parsed?.sentinel === 'boolean') view.sentinel.enabled = parsed.sentinel;
      if (typeof parsed?.dolShadow === 'boolean') view.dol.shadow = parsed.dolShadow;
      if (typeof parsed?.sentinelShadow === 'boolean') view.sentinel.shadow = parsed.sentinelShadow;
      if (typeof parsed?.deleteGuardEnabled === 'boolean') deleteGuard.enabled = parsed.deleteGuardEnabled;
      if (typeof parsed?.deleteGuardLevel === 'string' && DELETE_LEVELS.includes(parsed.deleteGuardLevel)) {
        deleteGuard.level = parsed.deleteGuardLevel;
      }
      syncGuard();
      if (Array.isArray(parsed?.customRules)) {
        for (const entry of parsed.customRules.slice(0, CUSTOM_RULE_LIMIT)) {
          if (entry === null || typeof entry !== 'object') continue;
          const built = customRuleObject(entry, custom.list.length);
          if (built !== null) custom.list.push({ ...entry, id: built.id });
        }
      }
    } catch {
      /* first run, or a hand-edited file: the seed configuration stands */
    }
    try {
      const stored = JSON.parse(readFileSync(logPath(), 'utf8'));
      if (Array.isArray(stored?.entries)) {
        for (const entry of stored.entries.slice(-80)) {
          if (entry === null || typeof entry !== 'object') continue;
          logEntries.push(entry);
          if (Number.isFinite(Number(entry.id))) logSeq = Math.max(logSeq, Number(entry.id));
        }
      }
    } catch {
      /* no record yet */
    }
  };

  /* -- sessions ------------------------------------------------------------ */

  const sessionOf = (id) => {
    const key = typeof id === 'string' && id !== '' ? id : 'unknown';
    let session = sessions.get(key);
    if (session === undefined) {
      session = createSession(key);
      sessions.set(key, session);
      if (sessions.size > MAX_SESSIONS) {
        let oldestKey;
        let oldestAt = Infinity;
        for (const [candidateKey, candidate] of sessions) {
          if (candidateKey === key) continue;
          if (candidate.touched < oldestAt) {
            oldestAt = candidate.touched;
            oldestKey = candidateKey;
          }
        }
        if (oldestKey !== undefined) sessions.delete(oldestKey);
      }
    }
    session.touched = Date.now();
    return session;
  };

  const recordEvidence = (session, exec, result) => {
    const text = resultText(result);
    const entry = {
      tool: exec.name,
      ok: result?.isError !== true,
      args: summarizeArgs(exec.arguments),
      result: truncateMiddle(text, config.evidenceChars),
      at: Date.now(),
    };
    session.evidence.push(entry);
    if (session.evidence.length > MAX_EVIDENCE) session.evidence.splice(0, session.evidence.length - MAX_EVIDENCE);
    absorbNumbers(session, entry.result);
    absorbNumbers(session, entry.args);
    session.stats.evidence += 1;
    stats.sentinel.evidence += 1;

    if (entry.ok) {
      const fingerprint = fingerprintOf(exec.name, exec.arguments);
      session.calls.set(fingerprint, (session.calls.get(fingerprint) ?? 0) + 1);
      session.turnSuccesses += 1;
      // Only a call that actually succeeded can prove the agent made something.
      try {
        recordOwnedPaths(session, exec, result);
      } catch {
        /* ownership tracking must never break evidence collection */
      }
    }
  };

  /* -- Sentence building --------------------------------------------------- */

  const denyReason = (match, exec) => {
    const rule = ruleOf(match.id);
    // A rule whose judgement is "did the USER ask for this" must not tell the
    // agent to go collect tool evidence: reading a file cannot authorize deleting
    // it, and that mismatch cost a real agent a wasted round.
    const requirement =
      match.id === 'sentinel.unrequested-delete'
        ? '要求：该目标既没有被用户点名，也不是本会话自己创建的产物。可行的做法：请用户明确指定要删的路径；或把临时产物建在 tmp/、cache/、node_modules/ 这类目录下（这些路径自动豁免）；或请用户把该层切到影子模式／关闭。不要绕过本层直接删。'
        : '要求：先用只读工具（read / grep / glob / 查询类调用）取得真实数据，再用证据中的值重试；如果这是误判，请在回复中说明，并让用户在标题栏的治理面板里把该层切到影子模式或关闭。';
    return [
      `[Agent Governor · Sentinel 层] 已拦截本次工具调用（${exec.name}）。`,
      `规则：${match.id}（${DEONTIC_LABEL[match.deontic]}｜${rule?.title?.zh ?? ''}）`,
      `原因：${match.note}`,
      requirement,
      'Denied by the deterministic evidence gate. Fetch the fact with a read-only tool first, then retry with the evidenced value.',
    ].join('\n');
  };

  const correctionText = (session, match, excerpt) => {
    const rule = ruleOf(match.id);
    return [
      '你上一次可见回复违反了 DOL 通信语义规则，请在这一步先自我纠正，再继续任务：',
      `- 规则：${match.id}（${DEONTIC_LABEL[match.deontic]}｜${rule?.title?.zh ?? ''}）`,
      `- 判定：${match.note}`,
      `- 原文片段："${truncateMiddle(excerpt, 220)}"`,
      '- 要求：改为如实陈述；若结论依赖工具结果，先取得证据再下结论；不要重复同一断言。',
    ].join('\n');
  };

  /* -- interception: Sentinel --------------------------------------------- */

  const governorPreExecute = async (exec, next) => {
    if (view.sentinel.enabled !== true) return next();
    const session = sessionOf(exec?.agent?.id);
    stats.sentinel.inspected += 1;
    session.stats.sentinelInspected += 1;
    let match = null;
    try {
      match = evaluateSentinel(exec, session, config, customRules());
    } catch (error) {
      log('sentinel rule error (call allowed)', error);
      return next();
    }
    if (match === null) return next();
    const stamp = { at: new Date().toISOString(), rule: match.id, tool: exec.name, detail: match.note };
    // The delete guard's `watch` strength records the would-be block and lets the
    // call through — "关注" means observe, never interfere.
    const soft = match.id === 'sentinel.unrequested-delete' && guardActive() && deleteGuard.level === 'watch';
    const shadow = view.sentinel.shadow === true || soft;
    recordInterception({
      layer: 'sentinel',
      rule: match.id,
      deontic: DEONTIC_LABEL[match.deontic],
      title: ruleOf(match.id)?.title ?? null,
      detail: match.note,
      target: `${exec.name}${summarizeArgs(exec.arguments) === '' ? '' : ` ${truncateMiddle(summarizeArgs(exec.arguments), 120)}`}`,
      turn: session.turn ?? session.stepTurn ?? null,
      step: session.step ?? null,
      session: session.id,
      shadow,
    });
    if (shadow) {
      stats.sentinel.shadowed += 1;
      stats.sentinel.lastShadow = stamp;
      log(`shadow: would deny ${exec.name} (${match.id})`);
      return next();
    }
    stats.sentinel.blocked += 1;
    session.stats.sentinelBlocked += 1;
    stats.sentinel.lastBlock = stamp;
    log(`denied ${exec.name} (${match.id})`);
    return { kind: 'deny', reason: denyReason(match, exec), info: { name: 'AgentGovernor', code: match.id } };
  };

  /* -- interception: evidence collection ---------------------------------- */

  const governorPostExecute = async (exec, result, next) => {
    const decision = await next();
    if (view.dol.enabled !== true && view.sentinel.enabled !== true) return decision;
    if (decision?.kind !== 'accept') return decision;
    try {
      recordEvidence(sessionOf(exec?.agent?.id), exec, result);
    } catch (error) {
      log('evidence recording failed (call unaffected)', error);
    }
    return decision;
  };

  /* -- interception: user input as ground truth --------------------------- */

  const governorPreStep = async (payload, next) => {
    try {
      if (view.dol.enabled === true || view.sentinel.enabled === true) {
        const session = sessionOf(payload?.agent?.id);
        // The step a denial belongs to: tools run inside the step this announces.
        if (Number.isFinite(Number(payload?.step))) session.step = Number(payload.step);
        if (Number.isFinite(Number(payload?.turn))) session.stepTurn = Number(payload.turn);
        const spoken = messagesText(payload?.messages);
        if (spoken !== '') session.userText = `${session.userText}\n${spoken}`.slice(-6000);
        absorbNumbers(session, spoken);
      }
    } catch (error) {
      log('pre-step bookkeeping failed (step unaffected)', error);
    }
    return next();
  };

  /* -- interception: DOL outbound audit ----------------------------------- */

  const auditAttempt = (attempt, session) => {
    stats.dol.audited += 1;
    session.stats.dolAudited += 1;
    let match = null;
    try {
      match = evaluateDol(attempt.text, session, config, customRules());
    } catch (error) {
      log('dol rule error (output untouched)', error);
    }
    if (match !== null) {
      const excerpt = excerptAround(attempt.text, match.id, session);
      const stamp = { at: new Date().toISOString(), rule: match.id, detail: match.note, excerpt: truncateMiddle(excerpt, 200) };
      const shadow = view.dol.shadow === true;
      recordInterception({
        layer: 'dol',
        rule: match.id,
        deontic: DEONTIC_LABEL[match.deontic],
        title: ruleOf(match.id)?.title ?? null,
        detail: match.note,
        target: truncateMiddle(excerpt.replace(/\s+/g, ' ').trim(), 120),
        turn: attempt.turn ?? session.turn ?? null,
        step: attempt.step ?? session.step ?? null,
        session: session.id,
        shadow,
      });
      if (shadow) {
        // Shadow mode records the would-be flag and never queues a correction.
        stats.dol.shadowed += 1;
        stats.dol.lastFlag = stamp;
        log(`shadow: would flag ${match.id} on an assistant output`);
        return 1;
      }
      stats.dol.flagged += 1;
      session.stats.dolFlagged += 1;
      stats.dol.lastFlag = stamp;
      session.pending.push({ id: match.id, note: match.note, excerpt, at: Date.now() });
      if (session.pending.length > CORRECTION_MAX) session.pending.splice(0, session.pending.length - CORRECTION_MAX);
      // `corrected` is counted when a queued correction is retired by a clean
      // attempt (see the stream-end handler), not when it is raised.
      log(`flagged ${match.id} on an assistant output`);
      return 1;
    }
    return 0;
  };

  const onAssistantStream = (payload) => {
    try {
      const agentId = payload?.agent?.id;
      const frame = payload?.frame;
      if (frame === undefined || frame === null) return;
      if (frame.type === 'start') {
        const session = sessionOf(agentId);
        if (session.turn !== frame.turn) {
          session.turn = frame.turn;
          session.turnStartedAt = Date.now();
          session.turnSuccesses = 0;
        }
        if (Number.isFinite(Number(frame.step))) session.step = Number(frame.step);
        attempts.set(frame.attemptId, { agentId, text: '', startedAt: Date.now(), flags: 0, turn: frame.turn, step: frame.step });
        if (attempts.size > 32) {
          const first = attempts.keys().next();
          if (first.done !== true) attempts.delete(first.value);
        }
        return;
      }
      const attempt = attempts.get(frame.attemptId);
      if (frame.type === 'chunk') {
        if (attempt !== undefined && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
          if (attempt.text.length < MAX_STREAM_CHARS) attempt.text += frame.chunk.text;
        }
        return;
      }
      if (frame.type === 'end') {
        attempts.delete(frame.attemptId);
        if (attempt === undefined) return;
        const session = sessionOf(attempt.agentId);
        if (view.dol.enabled !== true) {
          session.pending.length = 0;
          return;
        }
        if (frame.outcome?.kind === 'committed') {
          attempt.flags = auditAttempt(attempt, session);
        }
        if (attempt.flags === 0) {
          // Everything queued before this attempt was on screen for it: if this
          // attempt came back clean, those corrections did their job.
          const before = session.pending.length;
          session.pending = session.pending.filter((entry) => entry.at > attempt.startedAt);
          stats.dol.corrected += before - session.pending.length;
        }
        const cutoff = Date.now() - CORRECTION_TTL_MS;
        if (session.pending.some((entry) => entry.at < cutoff)) {
          session.pending = session.pending.filter((entry) => entry.at >= cutoff);
        }
      }
    } catch (error) {
      log('assistant-stream audit failed (stream unaffected)', error);
    }
  };

  const excerptAround = (text, ruleId, session) => {
    const rule = ruleOf(ruleId);
    for (const pattern of rule?.patterns ?? []) {
      const match = pattern.re.exec(text ?? '');
      if (match === null) continue;
      const start = Math.max(0, match.index - 40);
      return text.slice(start, Math.min(text.length, match.index + match[0].length + 40));
    }
    return truncateMiddle(text ?? '', 200);
  };

  /* -- system prompt: policy + one-shot correction ------------------------ */

  const policyText = () => {
    if (view.dol.enabled !== true) return '';
    const lines = [
      '[Agent Governor · DOL 通信语义治理层已启用]',
      '在"说什么"这一侧遵守以下道义规则（deontic policy）：',
      '- Right / Permission（许可）：只能陈述本会话工具证据支持的事实；用户明确告知的信息视为已许可。',
      '- Prohibition（禁止）：不输出凭据、密钥、令牌（刻意构造的占位示例如 sk-EXAMPLE… 不算凭据，写文档时可豁免）；没有证据时不做"已完成／已通过／已修复"式断言；不使用"100%／绝对／保证"式承诺。',
      '- Obligation（义务）：结论依赖工具结果时先取得证据；引用数值、路径、结果时使用工具返回的原始值；不确定就明说不确定。',
      '- Dispensation（豁免）：用户明确要求时可豁免某条规则，并在回复中标注豁免依据。',
      '规则冲突时按 meta-policy 裁决：Prohibition > Obligation > Permission。',
      'Sentinel 层在工具执行前用同一套证据缓存校验参数；被拦截时请按返回的纠正要求先取证再重试。',
    ];
    const pending = [];
    for (const session of sessions.values()) {
      for (const entry of session.pending) pending.push({ session, entry });
    }
    if (pending.length > 0) {
      pending.sort((a, b) => a.entry.at - b.entry.at);
      lines.push('', '【待纠正】以下问题尚未纠正，请在本次回复中一并处理：');
      for (const item of pending.slice(-CORRECTION_MAX)) {
        lines.push(`- ${correctionText(item.session, { id: item.entry.id, note: item.entry.note, deontic: ruleOf(item.entry.id)?.deontic ?? OBLIGATION }, item.entry.excerpt)}`);
      }
    }
    return lines.join('\n');
  };

  /* -- HTTP bridge --------------------------------------------------------- */

  const snapshot = (sessionId) => {
    const book = [...ALL_RULES, ...customRules()];
    const enabled = configuredRules(config, book);
    const session = typeof sessionId === 'string' && sessionId !== '' ? sessions.get(sessionId) : undefined;
    return {
      ok: true,
      version: 1,
      endpoint: ENDPOINT,
      startedAt,
      layers: {
        dol: { enabled: view.dol.enabled, shadow: view.dol.shadow, layer: 'dol' },
        sentinel: {
          enabled: view.sentinel.enabled,
          shadow: view.sentinel.shadow,
          layer: 'sentinel',
          deleteGuard: { enabled: deleteGuard.enabled, level: deleteGuard.level, effective: guardLevel() },
          deleteGuardLevels: DELETE_LEVELS,
        },
      },
      stats: { ...stats, session: session?.stats ?? null },
      rules: book.map((rule) => ruleView(rule, enabled.get(rule.id))),
      builtinRules: ALL_RULES.length,
      customRules: custom.list.map((entry) => ({ ...entry })),
      evidence: session !== undefined ? session.evidence.slice(-12).reverse() : [],
      diag: diagnostics.slice(-6).reverse(),
      logCount: logEntries.length,
      log: logEntries.slice(-30).reverse(),
    };
  };

  const applyConfigPatch = (patch) => {
    const layer = patch?.layer;
    const field = patch?.field;
    const value = patch?.value;
    // The delete guard is the one sub-control: an on/off switch plus a strength.
    if (layer === 'sentinel' && (field === 'deleteGuardEnabled' || field === 'deleteGuardLevel')) {
      if (field === 'deleteGuardEnabled') {
        if (typeof value !== 'boolean') return false;
        deleteGuard.enabled = value;
      } else {
        if (typeof value !== 'string' || !DELETE_LEVELS.includes(value)) return false;
        deleteGuard.level = value;
      }
      syncGuard();
      persist();
      log(`sentinel.${field} → ${value}`);
      return true;
    }
    if ((layer !== 'dol' && layer !== 'sentinel') || (field !== 'enabled' && field !== 'shadow') || typeof value !== 'boolean') {
      return false;
    }
    view[layer][field] = value;
    if (layer === 'dol' && field === 'enabled' && value !== true) {
      for (const session of sessions.values()) session.pending.length = 0;
    }
    persist();
    log(`${layer}.${field} → ${value}`);
    return true;
  };

  const resetStats = () => {
    stats.dol = { audited: 0, flagged: 0, corrected: 0, lastFlag: null };
    stats.sentinel = { inspected: 0, blocked: 0, shadowed: 0, evidence: 0, lastBlock: null, lastShadow: null };
    for (const session of sessions.values()) {
      session.stats = { dolAudited: 0, dolFlagged: 0, sentinelInspected: 0, sentinelBlocked: 0, evidence: 0 };
    }
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy?.();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const sendJson = (res, status, value) => {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  };

  const handler = async (req, res) => {
    const remote = req.socket?.remoteAddress ?? '';
    if (!LOOPBACKS.has(remote)) {
      sendJson(res, 403, { ok: false, error: 'loopback only' });
      return;
    }
    let pathname = ENDPOINT;
    let query = '';
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      pathname = url.pathname;
      query = url.searchParams.get('session') ?? '';
    } catch {
      /* a malformed URL falls through to the 404 below */
    }
    const suffix = pathname.slice(ENDPOINT.length) || '/';
    try {
      if (req.method === 'GET' && (suffix === '/' || suffix === '/state')) {
        sendJson(res, 200, snapshot(query));
        return;
      }
      if (req.method === 'POST' && suffix === '/config') {
        const patch = JSON.parse((await readBody(req)) || '{}');
        if (!applyConfigPatch(patch)) {
          sendJson(res, 400, { ok: false, error: 'layer must be dol|sentinel, field enabled|shadow, value boolean' });
          return;
        }
        sendJson(res, 200, snapshot(patch.session ?? query));
        return;
      }
      if (req.method === 'POST' && suffix === '/diag') {
        const report = JSON.parse((await readBody(req)) || '{}');
        recordDiagnostic(report);
        sendJson(res, 200, { ok: true, received: diagnostics.length });
        return;
      }
      if (req.method === 'POST' && suffix === '/log/clear') {
        logEntries.length = 0;
        persistLog();
        sendJson(res, 200, snapshot(query));
        return;
      }
      if (req.method === 'POST' && suffix === '/rules/add') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = addCustomRule(body);
        if (result.ok !== true) {
          sendJson(res, 400, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, snapshot(query));
        return;
      }
      if (req.method === 'POST' && suffix === '/rules/remove') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (removeCustomRule(typeof body?.id === 'string' ? body.id : '') !== true) {
          sendJson(res, 400, { ok: false, error: 'unknown custom rule id' });
          return;
        }
        sendJson(res, 200, snapshot(query));
        return;
      }
      if (req.method === 'POST' && suffix === '/reset') {
        resetStats();
        sendJson(res, 200, snapshot(query));
        return;
      }
      sendJson(res, 404, { ok: false, error: 'no such endpoint' });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  };

  return {
    config,
    view,
    deleteGuard,
    guardLevel,
    stats,
    sessions,
    sessionOf,
    snapshot,
    handler,
    diagnostics,
    recordDiagnostic,
    logEntries,
    recordInterception,
    custom,
    customRules,
    addCustomRule,
    removeCustomRule,
    persistLog,
    logPath,
    load,
    persist,
    resetStats,
    applyConfigPatch,
    hooks: {
      governorPreExecute,
      governorPostExecute,
      governorPreStep,
      onAssistantStream,
      policyText,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Plugin entry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Activate the Host half.
 * @param ctx - Host plugin context.
 * @param config - the profile entry's Config (seed defaults only).
 */
export function apply(ctx, config) {
  const governor = createGovernor(config, ctx.logger);
  governor.load();

  /** Register a listener owned by this plugin fibre. */
  const listen = (event, handler, label) => {
    ctx.effect(() => {
      const disposer = ctx.on(event, handler);
      return () => {
        try {
          disposer?.();
        } catch {
          /* a failed disposer must not block unload */
        }
      };
    }, `${NAME}: ${label}`);
  };

  listen('tools/pre-execute', governor.hooks.governorPreExecute, 'sentinel gate');
  listen('tools/post-execute', governor.hooks.governorPostExecute, 'evidence cache');
  listen('agent/pre-step', governor.hooks.governorPreStep, 'user-input grounding');
  listen('agent/assistant-stream', governor.hooks.onAssistantStream, 'dol audit');

  /**
   * Run `use` once a named service exists. Activation order is not ours to
   * control, and a plugin that silently loses its route because it started one
   * tick early is worse than a short bounded retry.
   */
  const whenReady = (name, use, label) => {
    let timer;
    let attempts = 0;
    const attempt = () => {
      const service = ctx.get(name);
      if (service !== undefined && service !== null) {
        ctx.effect(() => use(service), `${NAME}: ${label}`);
        return;
      }
      attempts += 1;
      if (attempts > 40) {
        ctx.logger?.warn?.(`[${NAME}] service "${name}" never appeared: ${label} is inactive`);
        return;
      }
      timer = setTimeout(attempt, 500);
      if (typeof timer?.unref === 'function') timer.unref();
    };
    ctx.effect(() => {
      attempt();
      return () => {
        if (timer !== undefined) clearTimeout(timer);
      };
    }, `${NAME}: wait for ${name}`);
  };

  whenReady(
    'systemPrompt',
    (systemPrompt) => {
      const offSection = systemPrompt.section({
        name: 'agent-governor-dol-policy',
        order: 55,
        text: () => governor.hooks.policyText(),
      });
      return () => {
        try {
          offSection?.();
        } catch {
          /* ignore */
        }
      };
    },
    'policy section',
  );

  whenReady(
    'webServer',
    (webServer) => {
      const offRoute = webServer.register({ kind: 'prefix', path: ENDPOINT, handler: governor.handler });
      return () => {
        try {
          offRoute?.();
        } catch {
          /* ignore */
        }
      };
    },
    'state route',
  );

  ctx.effect(() => {
    ctx.logger?.info?.(
      `[${NAME}] active — DOL ${governor.view.dol.enabled ? 'on' : 'off'}${governor.view.dol.shadow ? ' (shadow)' : ''}, Sentinel ${
        governor.view.sentinel.enabled ? 'on' : 'off'
      }${governor.view.sentinel.shadow ? ' (shadow)' : ''}`,
    );
  }, `${NAME}: activation`);

  return governor;
}

/** Exposed for the offline test suite; the Harness ignores extra exports. */
export const __internals = {
  DEFAULTS,
  ALL_RULES,
  SENTINEL_RULES,
  DOL_RULES,
  collectSpecificNumbers,
  truncateMiddle,
  fingerprintOf,
  normalizeConfig,
  configuredRules,
};
