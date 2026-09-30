/**
 * Offline tests for the Agent Governor host half.
 *
 * They drive the real `apply()` wiring through a mock Cordis context: the same
 * waterfall dispatch order, the same effect disposal, a fake HTTP request and a
 * fake response. No Harness process is needed.
 *
 *   node test/host.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apply,
  evaluateDol,
  evaluateSentinel,
  isReadOnlyCall,
  createGovernor,
  __internals,
} from '../index.js';

const { collectSpecificNumbers, truncateMiddle, DEFAULTS } = __internals;

/**
 * `apply()` loads the persisted switches, exactly as the running plugin does.
 * Point DSH_HOME at a throwaway directory so the suite never reads (or writes)
 * the developer's real `<dsh-home>/storages/agent-governor.json`.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'agov-suite-'));
process.env.DSH_HOME = TEST_HOME;

/* -------------------------------------------------------------------------- */
/* Tiny test harness                                                          */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n       ${error?.message ?? error}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Mock Cordis context                                                        */
/* -------------------------------------------------------------------------- */

function createMockCtx(services = {}) {
  const listeners = new Map();
  const routes = [];
  const registrations = { sections: [], effects: 0 };

  const provider = {
    systemPrompt: {
      section(section) {
        registrations.sections.push(section);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    ...services,
  };

  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => provider[name],
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    effect(callback) {
      registrations.effects += 1;
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };

  /** Waterfall dispatch with the Harness's terminal defaults. */
  const dispatch = async (event, terminal, ...args) => {
    const list = [...(listeners.get(event) ?? [])];
    let index = -1;
    const next = async () => {
      index += 1;
      if (index >= list.length) return typeof terminal === 'function' ? terminal() : terminal;
      return list[index](...args, next);
    };
    return next();
  };

  const emit = (event, payload) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  };

  return { ctx, dispatch, emit, routes, registrations, listeners, provider };
}

function fakeRequest({ method = 'GET', url = '/dsh-agent-governor/state', body, remote = '127.0.0.1' } = {}) {
  const handlers = new Map();
  return {
    method,
    url,
    socket: { remoteAddress: remote },
    on(event, handler) {
      handlers.set(event, handler);
      if (event === 'end') {
        if (body !== undefined) handlers.get('data')?.(Buffer.from(body, 'utf8'));
        queueMicrotask(() => handlers.get('end')?.());
      }
      return this;
    },
    destroy() {},
  };
}

function fakeResponse() {
  const captured = { status: undefined, headers: undefined, body: '' };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body) {
      captured.body = body === undefined ? '' : String(body);
    },
  };
}

const signal = () => new AbortController().signal;
const agent = (id) => ({ id });

function exec(name, args, id = 's1') {
  return { callId: 'c1', name, arguments: args, agent: agent(id), signal: signal() };
}

const success = (text, value) => ({ isError: false, value, content: [{ type: 'text', text }] });

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

await test('truncateMiddle keeps head and tail, drops the middle', () => {
  const text = `${'H'.repeat(500)}${'M'.repeat(500)}${'T'.repeat(500)}`;
  const cut = truncateMiddle(text, 120);
  assert.ok(cut.length < text.length);
  assert.ok(cut.startsWith('H'));
  assert.ok(cut.endsWith('T'));
  assert.ok(cut.includes('truncated'));
});

await test('collectSpecificNumbers ignores round constants and small counts', () => {
  const found = collectSpecificNumbers({ amount: 4213, timeoutMs: 60000, limit: 2000, retries: 3, price: 299.99 });
  const raw = found.map((entry) => entry.raw);
  assert.deepEqual(raw.sort(), ['299.99', '4213']);
});

await test('isReadOnlyCall exempts read-only tools only', () => {
  assert.equal(isReadOnlyCall(DEFAULTS, 'read'), true);
  assert.equal(isReadOnlyCall(DEFAULTS, 'grep'), true);
  assert.equal(isReadOnlyCall(DEFAULTS, 'job_output'), true);
  assert.equal(isReadOnlyCall(DEFAULTS, 'pwsh'), false);
  assert.equal(isReadOnlyCall(DEFAULTS, 'write'), false);
});

/* -------------------------------------------------------------------------- */
/* Sentinel rules                                                             */
/* -------------------------------------------------------------------------- */

function governorSession() {
  const governor = createGovernor({}, { info() {}, warn() {} });
  return { governor, session: governor.sessionOf('s1') };
}

await test('sentinel denies a destructive delete with structured feedback', () => {
  const { governor, session } = governorSession();
  const match = evaluateSentinel(exec('pwsh', { command: 'sudo rm -rf / --no-preserve-root' }), session, governor.config);
  assert.equal(match?.id, 'sentinel.destructive-delete');
  assert.equal(match?.deontic, 3);
});

await test('sentinel allows ordinary shell work', () => {
  const { governor, session } = governorSession();
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'Get-ChildItem -Force | Select-Object Name' }), session, governor.config), null);
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'node --test test/host.test.mjs' }), session, governor.config), null);
});

await test('a drive-root force delete is denied, a named path cleanup is not', () => {
  const { governor, session } = governorSession();
  // The catastrophic shape: the drive root is the operand of the forced recursion.
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'Remove-Item -Recurse -Force C:\\' }), session, governor.config)?.id, 'sentinel.destructive-delete');
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'Remove-Item -Recurse -Force "C:\\"' }), session, governor.config)?.id, 'sentinel.destructive-delete');

  const command = 'Remove-Item "E:\\deepseek\\scratch" -Recurse -Force -ErrorAction SilentlyContinue; Test-Path "E:\\deepseek\\scratch"';
  // Measured false positive: a later `E:\…` in the same line must not turn a
  // path cleanup into a drive-root wipe. With the user having asked for that
  // path, nothing fires at all.
  session.userText = '把 E:\\deepseek\\scratch 清掉';
  assert.equal(evaluateSentinel(exec('pwsh', { command }), session, governor.config), null);
  // Without the user naming it, the obligation still asks first — and it must be
  // the obligation's message, never the drive-root prohibition's.
  const unnamed = evaluateSentinel(exec('pwsh', { command }, 's-unnamed'), governor.sessionOf('s-unnamed'), governor.config);
  assert.equal(unnamed?.id, 'sentinel.unrequested-delete');
  assert.match(unnamed?.note, /scratch/);
});

await test('sentinel denies force-push and DROP TABLE', () => {
  const { governor, session } = governorSession();
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'git push origin main --force' }), session, governor.config)?.id, 'sentinel.history-rewrite');
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'psql -c "DROP TABLE users"' }), session, governor.config)?.id, 'sentinel.data-destroy');
});

await test('the whole discard-your-work git family is denied', () => {
  const { governor, session } = governorSession();
  const denied = [
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git restore .',
    'git restore src/app.ts',
    'git checkout -- .',
    'git checkout -f main',
    'git checkout .',
    'git stash drop',
    'git stash clear',
    'git branch -D feature',
  ];
  for (const command of denied) {
    assert.equal(evaluateSentinel(exec('pwsh', { command }), session, governor.config)?.id, 'sentinel.history-rewrite', command);
  }
});

await test('ordinary git work is not touched by that family', () => {
  const { governor, session } = governorSession();
  const allowed = [
    'git status',
    'git diff --stat',
    'git checkout main',
    'git switch -c feature/x',
    'git restore --staged src/app.ts',
    'git stash list',
    'git commit -m "wip"',
    'git push origin main',
  ];
  for (const command of allowed) {
    assert.equal(evaluateSentinel(exec('pwsh', { command }), session, governor.config), null, command);
  }
});

await test('sentinel evidence gate blocks an ungrounded number and accepts a grounded one', () => {
  const { governor, session } = governorSession();
  const ungrounded = evaluateSentinel(exec('process_refund', { orderId: 'A1', amount: 4213 }), session, governor.config);
  assert.equal(ungrounded?.id, 'sentinel.evidence-gap');
  session.numbers.add('4213');
  assert.equal(evaluateSentinel(exec('process_refund', { orderId: 'A1', amount: 4213 }), session, governor.config), null);
});

await test('sentinel evidence gate skips read-only calls and bulk content', () => {
  const { governor, session } = governorSession();
  assert.equal(evaluateSentinel(exec('read', { offset: 4213, limit: 200 }), session, governor.config), null);
  assert.equal(evaluateSentinel(exec('write', { path: 'a.txt', content: 'x'.repeat(400) + ' 4213' }), session, governor.config), null);
});

await test('a recursive forced delete needs the user to have named the target', () => {
  const { governor, session } = governorSession();
  // The realistic case: the agent decides a project directory "should go".
  const unrequested = evaluateSentinel(exec('pwsh', { command: 'rm -rf E:\\deepseek\\manim_mv' }), session, governor.config);
  assert.equal(unrequested?.id, 'sentinel.unrequested-delete');
  assert.equal(unrequested?.deontic, 2);
  assert.match(unrequested?.note, /manim_mv/);

  // Same command, but the user asked for that directory: allowed.
  session.userText = '把 manim_mv 那个旧目录清理掉';
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'rm -rf E:\\deepseek\\manim_mv' }), session, governor.config), null);

  // A directory the user never mentioned is still refused.
  assert.equal(
    evaluateSentinel(exec('pwsh', { command: 'rm -rf E:\\deepseek\\locales' }), session, governor.config)?.id,
    'sentinel.unrequested-delete',
  );
});

await test('the delete rule covers PowerShell recursion, wildcards and scratch exemptions', () => {
  const { governor, session } = governorSession();
  session.userText = '帮我整理一下 deepseek 工作区';
  assert.equal(
    evaluateSentinel(exec('pwsh', { command: 'Remove-Item -Recurse -Force C:\\Users\\22977\\Documents\\proj' }), session, governor.config)?.id,
    'sentinel.unrequested-delete',
  );
  // `rm -rf *` is caught by the stronger prohibition (meta-policy: prohibition
  // beats obligation), which is the right message for a "delete everything here".
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'rm -rf *' }), session, governor.config)?.id, 'sentinel.destructive-delete');
  // The agent's own scratch space is not the user's data.
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'rm -rf ./tmp/agov-build' }), session, governor.config), null);
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'rm -rf node_modules/.cache' }), session, governor.config), null);
  // A plain (non-recursive) rm is not this rule's business.
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'rm E:\\deepseek\\notes.txt' }), session, governor.config), null);
});

await test('user text reaches the delete rule end-to-end through pre-step', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  await mock.dispatch(
    'agent/pre-step',
    { kind: 'enter', messages: [] },
    {
      agent: agent('s-del'),
      messages: [{ role: 'user', content: [{ type: 'text', text: '把 manim_mv 目录清掉' }] }],
      turn: 1,
      step: 1,
      signal: signal(),
    },
  );
  const asked = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'rm -rf E:\\deepseek\\manim_mv' }, 's-del'));
  assert.equal(asked.kind, 'allow');
  const invented = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'rm -rf E:\\deepseek\\dsh-usage-meter' }, 's-del'));
  assert.equal(invented.kind, 'deny');
  assert.equal(invented.info.code, 'sentinel.unrequested-delete');
});

await test('regression: digits inside strings and shell text are not "claims"', () => {
  const { governor, session } = governorSession();
  // The live false positive: a URL's 127.0 was treated as an invented quantity.
  assert.equal(
    evaluateSentinel(exec('pwsh', { command: 'Invoke-RestMethod -Uri "http://127.0.0.1:19387/dsh-agent-governor/state"' }), session, governor.config),
    null,
  );
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'echo 4213' }), session, governor.config), null);
  assert.equal(evaluateSentinel(exec('write', { path: 'report-4213.txt', content: 'hi' }), session, governor.config), null);
  // A real numeric argument is still a claim.
  assert.equal(evaluateSentinel(exec('wait_agent', { timeout_ms: 987654 }), session, governor.config)?.id, 'sentinel.evidence-gap');
  // ...and it stops being one as soon as the evidence carries it.
  session.numbers.add('987654');
  assert.equal(evaluateSentinel(exec('wait_agent', { timeout_ms: 987654 }), session, governor.config), null);
});

await test('meta-policy: a prohibition beats an obligation on the same call', () => {
  const { governor, session } = governorSession();
  // Destructive shell text that also carries an ungrounded number: the
  // prohibition must be the reported decision.
  const match = evaluateSentinel(exec('pwsh', { command: 'Remove-Item -Recurse -Force C:\\ # 4213' }), session, governor.config);
  assert.equal(match?.deontic, 3);
});

await test('dispensation removes exactly one rule', () => {
  const config = __internals.normalizeConfig({ dispensations: ['sentinel.history-rewrite'] });
  const governor = createGovernor(config, { info() {}, warn() {} });
  const session = governor.sessionOf('s1');
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'git push origin main --force' }), session, governor.config), null);
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'git reset --hard HEAD~3' }), session, governor.config), null);
  assert.equal(evaluateSentinel(exec('pwsh', { command: 'rm -rf /' }), session, governor.config)?.id, 'sentinel.destructive-delete');
});

/* -------------------------------------------------------------------------- */
/* DOL rules                                                                  */
/* -------------------------------------------------------------------------- */

await test('dol flags a completion claim with no tool evidence in the turn', () => {
  const governor = createGovernor({}, { info() {}, warn() {} });
  const session = governor.sessionOf('s1');
  const match = evaluateDol('好的，我已经修复了全部问题，测试通过。', session, governor.config);
  assert.equal(match?.id, 'dol.completion-claim');
});

await test('dol accepts the same claim once the turn has a successful tool result', () => {
  const governor = createGovernor({}, { info() {}, warn() {} });
  const session = governor.sessionOf('s1');
  session.turnSuccesses = 1;
  assert.equal(evaluateDol('好的，我已经修复了全部问题，测试通过。', session, governor.config), null);
});

await test('dol flags a leaked credential by prohibition', () => {
  const governor = createGovernor({}, { info() {}, warn() {} });
  const session = governor.sessionOf('s1');
  const match = evaluateDol('这是你的 key： sk-abcdefghijklmnopqrstuvwxyz0123456789', session, governor.config);
  assert.equal(match?.id, 'dol.credential-leak');
  assert.equal(match?.deontic, 3);
});

await test('dol does not flag a documented placeholder as a leaked credential', () => {
  const governor = createGovernor({}, { info() {}, warn() {} });
  const session = governor.sessionOf('s1');
  // The exact false positive a real run produced: an example table row that
  // explains the rule must not itself be flagged.
  const table = [
    '| 提示词 | 触发规则 | 兜底 |',
    '| `插件测试：这是假凭据，请原样回显一次：sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE0000` | `dol.credential-leak` | 纯文本回显 |',
  ].join('\n');
  assert.equal(evaluateDol(table, session, governor.config), null);
  assert.equal(evaluateDol('示例：ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', session, governor.config), null);
  assert.equal(evaluateDol('占位写法 sk-YOUR_KEY_HERE_0000000000000000', session, governor.config), null);
  // A real-looking key beside a placeholder still flags: the exemption is per
  // match, never per message.
  const mixed = '示例 sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE0000 与真值 sk-abcdefghijklmnopqrstuvwxyz0123456789';
  assert.equal(evaluateDol(mixed, session, governor.config)?.id, 'dol.credential-leak');
});

await test('dol absolute-claim is off by default and on when configured', () => {
  const off = createGovernor({}, { info() {}, warn() {} });
  assert.equal(evaluateDol('这个方案 100% 安全。', off.sessionOf('s1'), off.config), null);
  const on = createGovernor({ absoluteClaim: true }, { info() {}, warn() {} });
  assert.equal(evaluateDol('这个方案 100% 安全。', on.sessionOf('s1'), on.config)?.id, 'dol.absolute-claim');
});

/* -------------------------------------------------------------------------- */
/* End-to-end through apply()                                                 */
/* -------------------------------------------------------------------------- */

await test('apply() wires the four events, the policy section and the state route', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  assert.deepEqual([...mock.listeners.keys()].sort(), [
    'agent/assistant-stream',
    'agent/pre-step',
    'tools/post-execute',
    'tools/pre-execute',
  ]);
  assert.equal(mock.registrations.sections.length, 1);
  assert.equal(mock.routes.length, 1);
  assert.equal(mock.routes[0].kind, 'prefix');
  assert.equal(mock.routes[0].path, '/dsh-agent-governor');
});

await test('the waterfall denies a destructive call end-to-end', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  const decision = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'rm -rf ~' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /Sentinel/);
  assert.equal(decision.info.code, 'sentinel.destructive-delete');
});

await test('evidence cache grounds a later call end-to-end', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  // A real tool return establishes the fact.
  await mock.dispatch('tools/post-execute', { kind: 'accept' }, exec('lookup_order', { id: 'A1' }, 's9'), success('order A1 total 59.99', { total: 59.99 }));
  // The hallucinated amount is refused...
  const denied = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('process_refund', { orderId: 'A1', amount: 299.99 }, 's9'));
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /299\.99/);
  // ...and the evidenced amount goes through.
  const allowed = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('process_refund', { orderId: 'A1', amount: 59.99 }, 's9'));
  assert.equal(allowed.kind, 'allow');
});

await test('shadow mode records a would-be denial without blocking', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, { sentinelShadow: true });
  const decision = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'shutdown /s /t 0' }));
  assert.equal(decision.kind, 'allow');
  assert.equal(governor.stats.sentinel.blocked, 0);
  assert.ok(governor.stats.sentinel.shadowed >= 1);
  assert.equal(governor.stats.sentinel.lastShadow.rule, 'sentinel.system-control');
});

/* -------------------------------------------------------------------------- */
/* Shared interception log                                                    */
/* -------------------------------------------------------------------------- */

await test('the shared log records which step was denied, with the reason', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  await mock.dispatch(
    'agent/pre-step',
    { kind: 'enter', messages: [] },
    { agent: agent('s-log'), messages: [], turn: 4, step: 7, signal: signal() },
  );
  const decision = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('process_refund', { amount: 4213 }, 's-log'));
  assert.equal(decision.kind, 'deny');

  const [entry] = governor.logEntries;
  assert.equal(governor.logEntries.length, 1);
  assert.equal(entry.layer, 'sentinel');
  assert.equal(entry.rule, 'sentinel.evidence-gap');
  assert.equal(entry.deontic, 'obligation');
  assert.equal(entry.shadow, false);
  assert.equal(entry.step, 7, 'the denial must be attributed to the step the pre-step announced');
  assert.equal(entry.turn, 4);
  assert.equal(entry.session, 's-log');
  assert.match(entry.target, /process_refund/);
  assert.match(entry.detail, /4213/);
  assert.ok(entry.title.zh.length > 0 && entry.title.en.length > 0);

  const state = fakeResponse();
  await mock.routes[0].handler(fakeRequest({ url: '/dsh-agent-governor/state' }), state);
  const payload = JSON.parse(state.captured.body);
  assert.equal(payload.logCount, 1);
  assert.equal(payload.log[0].rule, 'sentinel.evidence-gap');
});

await test('a shadow-mode denial is logged as a shadow entry, not a block', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, { sentinelShadow: true });
  await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'git reset --hard HEAD~1' }));
  assert.equal(governor.stats.sentinel.blocked, 0);
  assert.equal(governor.logEntries.length, 1);
  assert.equal(governor.logEntries[0].rule, 'sentinel.history-rewrite');
  assert.equal(governor.logEntries[0].shadow, true);
});

await test('a DOL flag is logged, and DOL shadow mode logs without correcting', async () => {
  const emitting = (mock, agentId, text, attemptId) => {
    mock.emit('agent/assistant-stream', { agent: agent(agentId), frame: { type: 'start', attemptId, revision: 0, turn: 1, step: 5 } });
    mock.emit('agent/assistant-stream', {
      agent: agent(agentId),
      frame: { type: 'chunk', attemptId, revision: 0, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text } },
    });
    mock.emit('agent/assistant-stream', {
      agent: agent(agentId),
      frame: { type: 'end', attemptId, revision: 0, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
    });
  };

  const enforcing = createMockCtx();
  const enforcingGovernor = apply(enforcing.ctx, {});
  emitting(enforcing, 's-dol-log', '都已经修复完成了。', 'j1');
  assert.equal(enforcingGovernor.stats.dol.flagged, 1);
  assert.equal(enforcingGovernor.sessions.get('s-dol-log').pending.length, 1);
  assert.equal(enforcingGovernor.logEntries.at(-1).layer, 'dol');
  assert.equal(enforcingGovernor.logEntries.at(-1).shadow, false);
  assert.equal(enforcingGovernor.logEntries.at(-1).step, 5);

  const shadowed = createMockCtx();
  const shadowGovernor = apply(shadowed.ctx, { dolShadow: true });
  emitting(shadowed, 's-dol-shadow', '都已经修复完成了。', 'k1');
  assert.equal(shadowGovernor.stats.dol.shadowed, 1);
  assert.equal(shadowGovernor.stats.dol.flagged, 0);
  assert.equal(shadowGovernor.sessions.get('s-dol-shadow').pending.length, 0, 'shadow must not queue a correction');
  assert.equal(shadowGovernor.logEntries.at(-1).shadow, true);
  assert.doesNotMatch(shadowGovernor.hooks.policyText(), /待纠正/);
});

await test('the log clears on demand and survives a stats reset', async () => {  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'rm -rf /' }));
  assert.equal(governor.logEntries.length, 1);

  const afterReset = fakeResponse();
  await mock.routes[0].handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/reset' }), afterReset);
  assert.equal(governor.logEntries.length, 1, 'resetting counters keeps the record');

  const cleared = fakeResponse();
  await mock.routes[0].handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/log/clear' }), cleared);
  const payload = JSON.parse(cleared.captured.body);
  assert.equal(governor.logEntries.length, 0);
  assert.equal(payload.logCount, 0);
});

await test('a committed assistant output raises a correction that the policy text surfaces', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  const agentId = 's-dol';
  mock.emit('agent/assistant-stream', {
    agent: agent(agentId),
    frame: { type: 'start', attemptId: 'a1', revision: 0, turn: 1, step: 1 },
  });
  mock.emit('agent/assistant-stream', {
    agent: agent(agentId),
    frame: { type: 'chunk', attemptId: 'a1', revision: 0, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '都搞定了，全部通过。' } },
  });
  mock.emit('agent/assistant-stream', {
    agent: agent(agentId),
    frame: { type: 'end', attemptId: 'a1', revision: 0, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
  });
  assert.equal(governor.stats.dol.flagged, 1);
  assert.equal(governor.stats.dol.lastFlag.rule, 'dol.completion-claim');
  const policy = governor.hooks.policyText();
  assert.match(policy, /待纠正/);
  assert.match(policy, /dol\.completion-claim/);

  // A clean next attempt retires the correction and counts it.
  mock.emit('agent/assistant-stream', { agent: agent(agentId), frame: { type: 'start', attemptId: 'a2', revision: 0, turn: 1, step: 2 } });
  mock.emit('agent/assistant-stream', {
    agent: agent(agentId),
    frame: { type: 'end', attemptId: 'a2', revision: 0, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } },
  });
  assert.equal(governor.sessions.get(agentId).pending.length, 0);
  assert.equal(governor.stats.dol.corrected, 1);
});

await test('user input is ground truth for the evidence gate', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  await mock.dispatch('agent/pre-step', { kind: 'enter', messages: [] }, {
    agent: agent('s-user'),
    messages: [{ role: 'user', content: [{ type: 'text', text: '我付了 299.99，请退款' }] }],
    turn: 1,
    step: 1,
    signal: signal(),
  });
  const decision = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('process_refund', { amount: 299.99 }, 's-user'));
  assert.equal(decision.kind, 'allow');
});

await test('the session own scratch is deletable even when the user never named it', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  const id = 's-own';
  // The real complaint: an agent's own probe directory, an extraction directory
  // and the script that produced them — all unnamed by the user.
  await mock.dispatch(
    'tools/post-execute',
    { kind: 'accept' },
    exec('write', { file_path: 'E:\\deepseek\\_sx.js', content: "const out = 'E:\\\\deepseek\\\\_sx';" }, id),
    success('written', {}),
  );
  await mock.dispatch(
    'tools/post-execute',
    { kind: 'accept' },
    exec('pwsh', { command: "New-Item -ItemType Directory -Path 'C:\\Users\\22977\\.agents\\skills\\dsh-skill-probe' -Force" }, id),
    success('ok', {}),
  );

  const extractionDir = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'Remove-Item -Recurse -Force E:\\deepseek\\_sx' }, id));
  assert.equal(extractionDir.kind, 'allow', 'a directory the session authored a script for must be removable');
  const probeDir = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'Remove-Item -Recurse -Force C:\\Users\\22977\\.agents\\skills\\dsh-skill-probe' }, id));
  assert.equal(probeDir.kind, 'allow', 'a directory the session created must be removable');
  const inside = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'Remove-Item -Recurse -Force C:\\Users\\22977\\.agents\\skills\\dsh-skill-probe\\SKILL.md' }, id));
  assert.equal(inside.kind, 'allow', 'contents of a session-created directory are removable');
});

await test('ownership never extends upward to a directory the user owns', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  const id = 's-anc';
  // Editing one file inside the user's source tree does not make that tree ours.
  await mock.dispatch(
    'tools/post-execute',
    { kind: 'accept' },
    exec('edit', { file_path: 'E:\\deepseek\\src\\app.ts', old_string: 'a', new_string: 'b' }, id),
    success('edited', {}),
  );
  const tree = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'Remove-Item -Recurse -Force E:\\deepseek\\src' }, id));
  assert.equal(tree.kind, 'deny');
  assert.equal(tree.info.code, 'sentinel.unrequested-delete');
  const ownFile = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'Remove-Item -Recurse -Force E:\\deepseek\\src\\app.ts' }, id));
  assert.equal(ownFile.kind, 'allow');
});

await test('the unrequested-delete refusal tells the agent the right remedy', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  const decision = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'Remove-Item -Recurse -Force E:\\deepseek\\unknown-dir' }, 's-msg'));
  assert.equal(decision.kind, 'deny');
  // It must not send the agent off to gather tool evidence: reading a file can
  // never authorize deleting it.
  assert.doesNotMatch(decision.reason, /先用只读工具/);
  assert.match(decision.reason, /tmp\//);
});

await test('the delete guard has three strengths, and off is the switch', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  const handler = mock.routes[0].handler;
  const recursive = exec('pwsh', { command: 'Remove-Item -Recurse -Force E:\\deepseek\\unknown-dir' }, 's-guard');
  const single = exec('pwsh', { command: 'Remove-Item "E:\\deepseek\\unknown.txt" -Force' }, 's-guard');

  // Default: `block`, and it is the forced-recursive form only that it watches.
  assert.equal(governor.guardLevel(), 'block');
  assert.equal((await mock.dispatch('tools/pre-execute', { kind: 'allow' }, recursive)).kind, 'deny');
  assert.equal((await mock.dispatch('tools/pre-execute', { kind: 'allow' }, single)).kind, 'allow');

  // watch: records the would-be block, never interferes — including strict shapes.
  const watch = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/config', body: JSON.stringify({ layer: 'sentinel', field: 'deleteGuardLevel', value: 'watch' }) }), watch);
  assert.equal(watch.captured.status, 200);
  assert.equal(governor.guardLevel(), 'watch');
  const watched = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, recursive);
  assert.equal(watched.kind, 'allow');
  assert.equal(governor.stats.sentinel.blocked, 1, 'a watch hit is never counted as a block');
  assert.equal(governor.logEntries.at(-1).shadow, true);
  assert.equal(governor.logEntries.at(-1).rule, 'sentinel.unrequested-delete');

  // strict: the same test now covers single-file deletes too.
  const strict = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/config', body: JSON.stringify({ layer: 'sentinel', field: 'deleteGuardLevel', value: 'strict' }) }), strict);
  assert.equal(governor.guardLevel(), 'strict');
  const strictSingle = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, single);
  assert.equal(strictSingle.kind, 'deny');
  assert.equal(strictSingle.info.code, 'sentinel.unrequested-delete');
  // ...and a file the session itself wrote stays deletable at every strength.
  await mock.dispatch('tools/post-execute', { kind: 'accept' }, exec('write', { file_path: 'E:\\deepseek\\mine.txt', content: 'x' }, 's-guard'), success('ok', {}));
  const own = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('pwsh', { command: 'Remove-Item "E:\\deepseek\\mine.txt" -Force' }, 's-guard'));
  assert.equal(own.kind, 'allow');

  // off: the switch is not a strength, and it disables the rule outright.
  const off = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/config', body: JSON.stringify({ layer: 'sentinel', field: 'deleteGuardEnabled', value: false }) }), off);
  assert.equal(off.captured.status, 200);
  assert.equal(governor.guardLevel(), 'off');
  assert.equal((await mock.dispatch('tools/pre-execute', { kind: 'allow' }, recursive)).kind, 'allow');
  assert.equal(governor.guardLevel(), 'off');

  // Bad input is refused, and the strength survives the switch being flipped off.
  const bad = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/config', body: JSON.stringify({ layer: 'sentinel', field: 'deleteGuardLevel', value: 'nonsense' }) }), bad);
  assert.equal(bad.captured.status, 400);
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/config', body: JSON.stringify({ layer: 'sentinel', field: 'deleteGuardEnabled', value: true }) }), fakeResponse());
  assert.equal(governor.guardLevel(), 'strict', 'the chosen strength is remembered while off');
});

await test('the delete guard state is served to the panel and survives a restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agov-guard-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const mock = createMockCtx();
    const governor = apply(mock.ctx, {});
    governor.deleteGuard.enabled = true;
    governor.deleteGuard.level = 'strict';
    governor.persist();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const state = fakeResponse();
    await mock.routes[0].handler(fakeRequest({ url: '/dsh-agent-governor/state' }), state);
    const payload = JSON.parse(state.captured.body);
    assert.deepEqual(payload.layers.sentinel.deleteGuard, { enabled: true, level: 'strict', effective: 'strict' });
    assert.deepEqual(payload.layers.sentinel.deleteGuardLevels, ['watch', 'block', 'strict']);

    const reloaded = createGovernor({}, { info() {}, warn() {} });
    reloaded.load();
    assert.equal(reloaded.deleteGuard.level, 'strict');
    assert.equal(reloaded.config.deleteGuardStrict, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* HTTP bridge + persistence                                                  */
/* -------------------------------------------------------------------------- */

await test('the diag route stores a client placement report into the snapshot', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  const handler = mock.routes[0].handler;

  const posted = fakeResponse();
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/dsh-agent-governor/diag',
      body: JSON.stringify({ kind: 'placement', seat: 'overlay', visible: false, top: 'DIV.agov-panel', cssLoaded: true }),
    }),
    posted,
  );
  assert.equal(posted.captured.status, 200);
  assert.equal(governor.diagnostics.length, 1);

  const state = fakeResponse();
  await handler(fakeRequest({ url: '/dsh-agent-governor/state' }), state);
  const payload = JSON.parse(state.captured.body);
  assert.equal(payload.diag[0].seat, 'overlay');
  assert.equal(payload.diag[0].visible, false);
});

await test('state route serves switches and stats to loopback only', async () => {
  const mock = createMockCtx();
  apply(mock.ctx, {});
  const handler = mock.routes[0].handler;

  const ok = fakeResponse();
  await handler(fakeRequest({ url: '/dsh-agent-governor/state?session=s1' }), ok);
  assert.equal(ok.captured.status, 200);
  const payload = JSON.parse(ok.captured.body);
  assert.equal(payload.layers.dol.enabled, true);
  assert.equal(payload.layers.sentinel.enabled, true);
  assert.ok(Array.isArray(payload.rules) && payload.rules.length >= 10);

  const forbidden = fakeResponse();
  await handler(fakeRequest({ remote: '10.0.0.7', url: '/dsh-agent-governor/state' }), forbidden);
  assert.equal(forbidden.captured.status, 403);
});

/* -------------------------------------------------------------------------- */
/* User-authored rules                                                        */
/* -------------------------------------------------------------------------- */

await test('a custom tool rule is validated, then blocks a matching call', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  const handler = mock.routes[0].handler;

  // Refused with a reason: an unusable regex must never reach a tool call.
  const broken = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/rules/add', body: JSON.stringify({ layer: 'sentinel', pattern: '([' }) }), broken);
  assert.equal(broken.captured.status, 400);
  assert.match(JSON.parse(broken.captured.body).error, /invalid regex/);

  const empty = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/rules/add', body: JSON.stringify({ layer: 'sentinel', pattern: '   ' }) }), empty);
  assert.equal(empty.captured.status, 400);

  const added = fakeResponse();
  await handler(
    fakeRequest({
      method: 'POST',
      url: '/dsh-agent-governor/rules/add',
      body: JSON.stringify({ layer: 'sentinel', pattern: 'dangerous_word', message: '自定义：出现危险词', deontic: 'prohibition' }),
    }),
    added,
  );
  assert.equal(added.captured.status, 200);
  const payload = JSON.parse(added.captured.body);
  const custom = payload.rules.filter((rule) => rule.custom === true);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].pattern, 'dangerous_word');
  assert.equal(custom[0].enabled, true);
  assert.ok(payload.builtinRules >= 11, 'the built-in rule book must still be visible');

  const decision = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('edit', { new_string: 'x dangerous_word y' }, 's-custom'));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /自定义：出现危险词/);
  assert.ok(decision.info.code.startsWith('custom.'));
  assert.equal(governor.logEntries.at(-1).rule, decision.info.code);
  assert.equal(governor.logEntries.at(-1).title.zh, '自定义工具规则');
});

await test('a custom output rule flags a reply and queues its correction', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  governor.addCustomRule({ layer: 'dol', pattern: 'forbidden-phrase', message: '自定义：出现禁语' });

  mock.emit('agent/assistant-stream', { agent: agent('s-cd'), frame: { type: 'start', attemptId: 'c1', revision: 0, turn: 1, step: 1 } });
  mock.emit('agent/assistant-stream', {
    agent: agent('s-cd'),
    frame: { type: 'chunk', attemptId: 'c1', revision: 0, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '这里出现 forbidden-phrase 了' } },
  });
  mock.emit('agent/assistant-stream', {
    agent: agent('s-cd'),
    frame: { type: 'end', attemptId: 'c1', revision: 0, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
  });

  assert.equal(governor.stats.dol.flagged, 1);
  assert.match(governor.sessions.get('s-cd').pending[0].note, /禁语/);
  assert.match(governor.hooks.policyText(), /待纠正/);
});

await test('removing a custom rule stops it firing, and rules persist across restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agov-rules-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const mock = createMockCtx();
    const governor = apply(mock.ctx, {});
    const { id } = governor.addCustomRule({ layer: 'sentinel', pattern: 'legacy_marker', message: '旧规则' });
    const blocked = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('edit', { new_string: 'legacy_marker' }, 's-r'));
    assert.equal(blocked.kind, 'deny');

    // Persisted with the switches, and still armed in a fresh instance.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const reloaded = createGovernor({}, { info() {}, warn() {} });
    reloaded.load();
    assert.equal(reloaded.custom.list.length, 1);
    assert.equal(reloaded.custom.list[0].pattern, 'legacy_marker');
    const stillBlocked = evaluateSentinel(exec('edit', { new_string: 'legacy_marker' }, 's-r2'), reloaded.sessionOf('s-r2'), reloaded.config, reloaded.customRules());
    assert.equal(stillBlocked?.id, id);

    // Removed → inert.
    assert.equal(governor.removeCustomRule(id), true);
    const allowed = await mock.dispatch('tools/pre-execute', { kind: 'allow' }, exec('edit', { new_string: 'legacy_marker' }, 's-r'));
    assert.equal(allowed.kind, 'allow');
    assert.equal(governor.removeCustomRule('custom.nope'), false);

    const bad = fakeResponse();
    await mock.routes[0].handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/rules/remove', body: JSON.stringify({ id: 'custom.nope' }) }), bad);
    assert.equal(bad.captured.status, 400);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

await test('config route flips a layer and rejects a malformed patch', async () => {
  const mock = createMockCtx();
  const governor = apply(mock.ctx, {});
  const handler = mock.routes[0].handler;

  const response = fakeResponse();
  await handler(
    fakeRequest({ method: 'POST', url: '/dsh-agent-governor/config', body: JSON.stringify({ layer: 'sentinel', field: 'shadow', value: true }) }),
    response,
  );
  assert.equal(response.captured.status, 200);
  assert.equal(JSON.parse(response.captured.body).layers.sentinel.shadow, true);
  assert.equal(governor.view.sentinel.shadow, true);

  const bad = fakeResponse();
  await handler(fakeRequest({ method: 'POST', url: '/dsh-agent-governor/config', body: JSON.stringify({ layer: 'nope', field: 'x', value: 1 }) }), bad);
  assert.equal(bad.captured.status, 400);
});

await test('switches and the interception record persist and reload', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agov-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const first = createGovernor({}, { info() {}, warn() {} });
    first.view.sentinel.enabled = false;
    first.view.dol.shadow = true;
    first.persist();
    // A record written by the real path, not by hand.
    first.recordInterception({ layer: 'sentinel', rule: 'sentinel.evidence-gap', detail: 'unbacked 4213', step: 3, session: 's-x', shadow: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stored = JSON.parse(readFileSync(join(home, 'storages', 'agent-governor.json'), 'utf8'));
    assert.equal(stored.sentinel, false);
    assert.equal(stored.dolShadow, true);

    const second = createGovernor({}, { info() {}, warn() {} });
    second.load();
    assert.equal(second.view.sentinel.enabled, false);
    assert.equal(second.view.dol.shadow, true);
    // The record survives a restart, and ids keep climbing from where they were.
    assert.equal(second.logEntries.length, 1);
    assert.equal(second.logEntries[0].rule, 'sentinel.evidence-gap');
    assert.equal(second.logEntries[0].step, 3);
    second.recordInterception({ layer: 'dol', rule: 'dol.credential-leak', detail: 'x', step: 4, session: 's-x', shadow: false });
    assert.equal(second.logEntries[1].id, 2);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */

rmSync(TEST_HOME, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`\n${failure.name}\n${failure.error?.stack ?? failure.error}\n`);
  process.exit(1);
}
