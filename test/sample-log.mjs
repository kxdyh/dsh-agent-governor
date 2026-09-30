/**
 * Developer demo: drive the real Host half through the real hooks and print the
 * records the header's log popover will render. No Harness process needed.
 *
 *   node test/sample-log.mjs
 */

import { createGovernor } from '../index.js';

process.env.DSH_HOME = process.env.DSH_HOME ?? '';

const governor = createGovernor({}, { info() {}, warn() {} });
const quiet = async () => ({ kind: 'allow' });

/** One denial, attributed to turn 6 / step 12 like a real tool call. */
const agent = { id: 'session-2f1c' };
await governor.hooks.governorPreStep({ agent, messages: [], turn: 6, step: 12 }, quiet);
const denied = await governor.hooks.governorPreExecute(
  { callId: 'call-1', name: 'process_refund', arguments: { orderId: 'A-1', amount: 4213 }, agent, signal: new AbortController().signal },
  quiet,
);
process.stdout.write(`sentinel decision: ${denied.kind} (${denied.info?.code})\n\n`);

/** One flagged assistant output, two steps later. */
const id = 'session-2f1c';
governor.hooks.onAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 0, turn: 6, step: 14 } });
governor.hooks.onAssistantStream({
  agent,
  frame: { type: 'chunk', attemptId: 'a1', revision: 0, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '已经修复完成，测试全部通过。' } },
});
governor.hooks.onAssistantStream({
  agent,
  frame: { type: 'end', attemptId: 'a1', revision: 0, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } },
});
void id;

const snapshot = governor.snapshot('session-2f1c');
process.stdout.write(`logCount: ${snapshot.logCount}\n`);
process.stdout.write(`${JSON.stringify(snapshot.log, null, 2)}\n`);
