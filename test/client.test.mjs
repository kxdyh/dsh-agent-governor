/**
 * Client-half contract tests.
 *
 * `client.js` is a page artifact (it calls `window.__ModuleLoader__.load`), so
 * this suite loads the real file with a stub React and drives the real
 * `apply(ctx)` against a mock slot/locale context. That verifies the things a
 * browser would otherwise be needed for:
 *
 *  - module identity equals the package name (the loader requires it),
 *  - the three slot contributions land on the documented seats with the
 *    documented ids/orders,
 *  - both locale dictionaries exist and every dotted key used in the source is
 *    defined in BOTH of them (a missing key renders as a raw key in the UI),
 *  - the stylesheet carries the open/closed animation contract.
 *
 *   node test/client.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = readFileSync(join(root, 'client.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n       ${error?.message ?? error}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Load the page artifact with a stub React                                   */
/* -------------------------------------------------------------------------- */

/**
 * A minimal React stand-in. It is deliberately more than a set of dummies: it
 * lets the component functions actually RUN, which is what catches a seat that
 * renders an exception instead of a control — the `t is not a function` class of
 * bug a registration-only check cannot see.
 */
const stubReact = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    const merged = children.length <= 1 ? children[0] : children;
    return { __element: true, type, props: { ...(props ?? {}), children: merged } };
  },
  useState(initial) {
    return [initial, () => {}];
  },
  useRef(initial) {
    return { current: initial === undefined ? null : initial };
  },
  useEffect() {
    return undefined;
  },
  useLayoutEffect() {
    return undefined;
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return typeof fn === 'function' ? fn() : undefined;
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot();
  },
  Component: class StubComponent {
    constructor(props) {
      this.props = props ?? {};
      this.state = {};
    }

    setState(next) {
      this.state = { ...this.state, ...next };
    }
  },
};

let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
  // Opens the module state for the render tests below.
  __AGOV_DEBUG__: true,
};

/** The stylesheet effect writes through `document`; capture it like the page does. */
const styleElements = [];
globalThis.document = {
  createElement() {
    const element = { dataset: {}, textContent: '', remove() {} };
    styleElements.push(element);
    return element;
  },
  head: { appendChild() {} },
};

const requireStub = (id) => {
  if (id === 'react') return stubReact;
  throw new Error(`unexpected require("${id}") — the client half must not import Harness packages`);
};

await import(`file://${join(root, 'client.js').replace(/\\/g, '/')}`);

const plugin = captured.factory(requireStub);
/** The seam belongs to THIS factory instance; later calls replace the global. */
const seam = globalThis.window.__AGOV_TEST__;

/* -------------------------------------------------------------------------- */
/* Module identity + manifest                                                 */
/* -------------------------------------------------------------------------- */

test('the module loader id equals the package name (loader requirement)', () => {
  assert.equal(captured.id, manifest.name);
  assert.equal(plugin.name, manifest.name);
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
});

test('the client half imports nothing but react', () => {
  assert.doesNotThrow(() => captured.factory(requireStub));
  assert.match(source, /require\('react'\)/);
  assert.doesNotMatch(source, /require\('@deepseek-ai/);
});

/* -------------------------------------------------------------------------- */
/* Slot contributions                                                         */
/* -------------------------------------------------------------------------- */

function applyClient() {
  const registrations = [];
  const injections = [];
  const effects = [];
  const dictionaries = {};
  const ctx = {
    effect(callback) {
      effects.push(callback);
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    locale: {
      register(ns, dicts) {
        dictionaries[ns] = dicts;
        return () => {};
      },
      bind(ns) {
        const dicts = dictionaries[ns] ?? {};
        return (key) => {
          for (const dict of Object.values(dicts)) {
            if (dict[key] !== undefined) return dict[key];
          }
          return key;
        };
      },
    },
    slots: {
      inject(key, callback) {
        injections.push(key);
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return { registrations, injections, effects, dictionaries, ctx };
}

const applied = applyClient();

test('apply() registers the layers, the record button and both popovers', () => {
  const ids = applied.registrations.map((entry) => `${entry.options.name}#${entry.options.id ?? '-'}@${entry.options.order ?? 0}`);
  assert.deepEqual(ids, [
    'conversation.session.header.utilities#agent-governor@-20',
    'conversation.session.header.utilities#agent-governor-log@-19',
    'conversation.header.leading#-@0',
    'shell.overlay#agent-governor-panel@201',
    'shell.overlay#agent-governor-log-panel@202',
    'shell.overlay#agent-governor-fallback@190',
  ]);
  assert.deepEqual(applied.injections, [
    'conversation.session.header.utilities',
    'conversation.session.header.utilities',
    'conversation.header.leading',
    'shell.overlay',
    'shell.overlay',
    'shell.overlay',
  ]);
});

test('the header seat is registered before the shipped utilities (left of them)', () => {
  const header = applied.registrations.find((entry) => entry.options.name === 'conversation.session.header.utilities');
  // Shipped occupants: open-in-app @ -10, session-log-download @ 0.
  assert.ok(header.options.order < -10);
  assert.equal(typeof header.options.label, 'function');
});

test('every seat is wrapped in the error boundary and uses a distinct component', () => {
  const components = applied.registrations.map((entry) => entry.component);
  assert.equal(new Set(components).size, 6);
  for (const component of components) assert.equal(typeof component, 'function');
});

/* -------------------------------------------------------------------------- */
/* Locales                                                                    */
/* -------------------------------------------------------------------------- */

test('zh and en dictionaries are registered for this namespace', () => {
  const dicts = applied.dictionaries['agent-governor'];
  assert.ok(dicts, 'namespace agent-governor was not registered');
  assert.ok(dicts.zh && dicts.en);
});

test('every locale key used in the source exists in BOTH dictionaries', () => {
  const dicts = applied.dictionaries['agent-governor'];
  // Dotted strings in this file are either locale keys or slot keys.
  const slotKeys = new Set(applied.registrations.map((entry) => entry.options.name));
  const used = new Set();
  for (const match of source.matchAll(/'([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)'/g)) {
    if (slotKeys.has(match[1])) continue;
    if (match[1].endsWith('.css')) continue;
    used.add(match[1]);
  }
  const missing = [];
  for (const key of used) {
    if (dicts.zh[key] === undefined || dicts.en[key] === undefined) missing.push(key);
  }
  assert.deepEqual(missing, []);
  assert.ok(used.size >= 20, `expected the UI to use many keys, saw ${used.size}`);
});

test('zh and en have identical key sets', () => {
  const dicts = applied.dictionaries['agent-governor'];
  const zh = Object.keys(dicts.zh).sort();
  const en = Object.keys(dicts.en).sort();
  assert.deepEqual(zh, en);
});

/* -------------------------------------------------------------------------- */
/* Stylesheet: the animation contract                                         */
/* -------------------------------------------------------------------------- */

test('the stylesheet defines the closed and open states with a transition', () => {
  const css = applied.effects.map((effect) => effect).length > 0 ? capturedCss() : '';
  assert.match(css, /\.agov-panel\{[^}]*opacity:0/);
  assert.match(css, /\.agov-panel\{[^}]*visibility:hidden/);
  assert.match(css, /\.agov-panel\{[^}]*transition:opacity[^}]*transform/);
  assert.match(css, /\.agov-panel\.is-open\{[^}]*opacity:1/);
  assert.match(css, /\.agov-panel\.is-open\{[^}]*transform:none/);
  assert.match(css, /transform-origin:top right/);
  assert.match(css, /@keyframes agov-pulse/);
});

test('the "?" disclosures are collapsed by default and animate open', () => {
  const css = capturedCss();
  assert.match(css, /\.agov-detail\{[^}]*max-height:0/);
  assert.match(css, /\.agov-detail\{[^}]*visibility:hidden/);
  assert.match(css, /\.agov-detail\{[^}]*transition:max-height/);
  assert.match(css, /\.agov-detail\.is-open\{[^}]*max-height:640px/);
  assert.match(css, /\.agov-detail\.is-open\{[^}]*visibility:visible/);
  assert.match(css, /\.agov-help\{[^}]*border-radius:50%/);
  assert.match(css, /\.agov-row\{[^}]*border-top/);
});

test('the panel is anchored to the trigger and stays clickable in the overlay', () => {
  const css = capturedCss();
  assert.match(css, /\.agov-panel\{[^}]*position:fixed/);
  assert.match(css, /\.agov-panel\.is-open\{[^}]*pointer-events:auto/);
  // The overlay triggers sit inside a full-viewport, click-through host, so
  // `fixed` stays meaningful even when the layer's own box is collapsed.
  assert.match(css, /\.agov-fallback-host\{[^}]*position:fixed/);
  assert.match(css, /\.agov-fallback-host\{[^}]*inset:0/);
  assert.match(css, /\.agov-fallback-host\{[^}]*pointer-events:none/);
  assert.match(css, /\.agov-fallback-row\{[^}]*position:absolute/);
  assert.match(css, /\.agov-fallback-row\{[^}]*pointer-events:auto/);
});

test('the stylesheet uses theme tokens, with exactly two documented constants', () => {
  const css = capturedCss();
  assert.match(css, /--dsw-alias-label-primary/);
  assert.match(css, /--dsw-alias-brand-primary/);
  // Deliberate constants, nothing else: the knob is white in both themes, and
  // the ON track is the brand blue because the theme token resolved near-white
  // in the running app — which is what made the switch unreadable.
  const rawFills = [...new Set([...css.matchAll(/background:(?!0 0|var\()([^;}]+)/g)].map((match) => match[1].trim()))].sort();
  assert.deepEqual(rawFills, ['#4d6bfe', '#fff']);
  assert.match(css, /\.agov-switch\[aria-checked=true\]\{background:#4d6bfe/);
  assert.match(css, /\.agov-knob\{[^}]*box-shadow/);
  assert.match(css, /appearance:none/);
});

/** The CSS lives inside the stylesheet effect, captured by the document stub. */
function capturedCss() {
  return styleElements.map((element) => element.textContent).join('');
}

/* -------------------------------------------------------------------------- */
/* Render tests: the seats must produce controls, not exceptions              */
/* -------------------------------------------------------------------------- */

/** Run function/class components until only host elements remain. */
function render(node, depth = 0) {
  if (depth > 40) throw new Error('render did not terminate — likely a component loop');
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child) => render(child, depth + 1));
  if (node.__element !== true) return node;
  const { type, props } = node;
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      const instance = new type(props ?? {});
      return render(instance.render(), depth + 1);
    }
    return render(type(props ?? {}), depth + 1);
  }
  return { __element: true, type, props: { ...(props ?? {}), children: render(props?.children, depth + 1) } };
}

/** Flatten a rendered tree into its host elements. */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (node.__element !== true) return out;
  out.push(node);
  collect(node.props?.children, out);
  return out;
}

const seatProps = (extra = {}) => ({
  // Mirrors the real translator: `locale` resolves to the active locale id, so
  // localized host titles ({zh,en}) pick the right branch.
  t: (key) => (key === 'locale' ? 'zh' : `«${key}»`),
  useSessions: (selector) => selector(undefined),
  ...extra,
});

const seatOf = (name, id) =>
  applied.registrations.find((entry) => entry.options.name === name && (id === undefined || entry.options.id === id));

test('every seat renders without throwing (the t is not a function regression)', () => {
  // The original bug: `t` is not a standard slot prop, so a seat that rendered
  // without it threw and drew nothing at all.
  for (const entry of applied.registrations) {
    const label = `${entry.options.name}#${entry.options.id ?? '-'}`;
    assert.doesNotThrow(() => render(stubReact.createElement(entry.component, seatProps())), label);
    assert.doesNotThrow(() => {
      const bare = render(stubReact.createElement(entry.component, { useSessions: (selector) => selector(undefined) }));
      return bare;
    }, `${label} (without the injected translator)`);
  }
});

test('every registration injects the translator into its occupant', () => {
  for (const entry of applied.registrations) {
    assert.equal(typeof entry.options.inject, 'function', `${entry.options.name} has no inject`);
    const injected = entry.options.inject();
    assert.equal(typeof injected.t, 'function', `${entry.options.name} does not inject t`);
  }
});

test('the header seat renders the shield trigger, not a gear', () => {
  const header = seatOf('conversation.session.header.utilities', 'agent-governor');
  const nodes = collect(render(stubReact.createElement(header.component, seatProps())));
  const button = nodes.find((node) => node.type === 'button');
  assert.ok(button, 'no button was rendered');
  assert.match(button.props.className, /agov-trigger/);
  assert.equal(button.props['aria-haspopup'], 'dialog');
  assert.equal(button.props['aria-expanded'], false);
  const shield = nodes.find((node) => node.type === 'svg');
  assert.ok(shield, 'the shield svg is missing');
  assert.match(shield.props.className, /agov-shield/);
  // The shield is a shield: one outline path plus a bang, never a gear body.
  const paths = nodes.filter((node) => node.type === 'path');
  assert.ok(paths.length >= 2 && paths.length <= 3);
});

test('the no-Session overlay seat renders both buttons inside its fixed host', () => {
  const overlay = seatOf('shell.overlay', 'agent-governor-fallback');
  const nodes = collect(render(stubReact.createElement(overlay.component, seatProps())));
  const host = nodes.find((node) => node.props?.className === 'agov-fallback-host');
  assert.ok(host, 'the full-viewport host wrapper is missing');
  const row = nodes.find((node) => node.props?.className === 'agov-fallback-row');
  assert.ok(row, 'the row that positions the trigger pair is missing');
  const buttons = nodes.filter((node) => node.type === 'button');
  assert.equal(buttons.length, 2, 'expected the shield and the record button');
  assert.equal(buttons[0].props['aria-haspopup'], 'dialog');
  assert.equal(buttons[1].props['aria-haspopup'], 'dialog');
  // The record button draws the ledger glyph (a frame plus ruled lines).
  const svgs = nodes.filter((node) => node.type === 'svg');
  assert.equal(svgs.length, 2);
});

test('the record popover lists interceptions with the step and the reason', () => {
  const logPanel = seatOf('shell.overlay', 'agent-governor-log-panel');
  const store = seam;
  store.data.set({
    phase: 'ready',
    snapshot: {
      layers: {
        dol: { enabled: true, shadow: false },
        sentinel: {
          enabled: true,
          shadow: false,
          deleteGuard: { enabled: true, level: 'watch', effective: 'watch' },
          deleteGuardLevels: ['watch', 'block', 'strict'],
        },
      },
      stats: {
        dol: { audited: 5, flagged: 1, corrected: 0, shadowed: 0, lastFlag: null },
        sentinel: { inspected: 6, blocked: 1, shadowed: 1, evidence: 4, lastBlock: null, lastShadow: null },
        session: null,
      },
      rules: [],
      diag: [],
      logCount: 3,
      log: [
        {
          id: 3,
          at: '2026-09-30T05:45:50.924Z',
          layer: 'sentinel',
          rule: 'sentinel.history-rewrite',
          deontic: 'prohibition',
          title: { zh: '不可逆的版本库操作', en: 'Irreversible VCS operation' },
          detail: '匹配到 git push --force',
          target: 'pwsh {"command":"git push --force origin main"}',
          turn: 6,
          step: 12,
          session: 'session-abc',
          shadow: false,
        },
        {
          id: 2,
          at: '2026-09-30T05:46:19.269Z',
          layer: 'dol',
          rule: 'dol.credential-leak',
          deontic: 'prohibition',
          title: { zh: '凭据外泄', en: 'Credential leak' },
          detail: '匹配到 sk- API key',
          target: '）凭据串，用来故意触发',
          turn: 6,
          step: 13,
          session: 'session-abc',
          shadow: true,
        },
      ],
    },
    error: undefined,
  });
  store.ui.set({ open: true, view: 'log', anchor: null });

  const nodes = collect(render(stubReact.createElement(logPanel.component, seatProps())));
  const dialog = nodes.find((node) => node.props?.role === 'dialog');
  assert.ok(dialog, 'the record popover is not a dialog');
  assert.match(dialog.props.className, /agov-panel/);
  assert.match(dialog.props.className, /agov-log/);
  assert.match(dialog.props.className, /is-open/);

  const text = nodes.map((node) => (typeof node.props?.children === 'string' ? node.props.children : '')).join('|');
  assert.match(text, /«log.title»/);
  assert.match(text, /«log.filter.all»/);
  assert.match(text, /«log.clear»/);
  // One row per record, each carrying its rule title, step and reason.
  const rows = nodes.filter((node) => String(node.props?.className ?? '').startsWith('agov-log-row'));
  assert.equal(rows.length, 2);
  assert.match(text, /不可逆的版本库操作|Irreversible VCS operation/);
  assert.match(text, /«log.step» 12/);
  assert.match(text, /匹配到 git push --force/);
  assert.match(text, /«log.step» 13/);
  // A shadow entry is marked as such.
  assert.ok(nodes.some((node) => String(node.props?.className ?? '').includes('agov-shadow-tag')));

  // Filtering to the tool layer drops the output flag.
  const filters = nodes.filter((node) => String(node.props?.className ?? '').startsWith('agov-filter'));
  assert.equal(filters.length, 3);

  // The empty state is its own message.
  store.data.set({ phase: 'ready', snapshot: { ...store.data.getSnapshot().snapshot, log: [], logCount: 0 }, error: undefined });
  const empty = collect(render(stubReact.createElement(logPanel.component, seatProps())));
  const emptyText = empty.map((node) => (typeof node.props?.children === 'string' ? node.props.children : '')).join('|');
  assert.match(emptyText, /«log.empty»/);

  store.ui.set({ open: false, view: 'panel', anchor: null });
});

test('the panel opens minimal: two rows, three help buttons, details collapsed', () => {
  const panel = seatOf('shell.overlay', 'agent-governor-panel');
  const store = seam;
  assert.ok(store, 'the debug seam is missing');

  const closed = collect(render(stubReact.createElement(panel.component, seatProps())));
  const dialog = closed.find((node) => node.props?.role === 'dialog');
  assert.ok(dialog, 'the panel is not a dialog');
  assert.match(dialog.props.className, /agov-panel/);
  assert.doesNotMatch(dialog.props.className, /is-open/);

  store.data.set({
    phase: 'ready',
    snapshot: {
      layers: {
        dol: { enabled: true, shadow: false },
        sentinel: {
          enabled: true,
          shadow: false,
          deleteGuard: { enabled: true, level: 'watch', effective: 'watch' },
          deleteGuardLevels: ['watch', 'block', 'strict'],
        },
      },
      stats: {
        dol: { audited: 37, flagged: 1, corrected: 0, lastFlag: null },
        sentinel: { inspected: 50, blocked: 2, shadowed: 0, evidence: 50, lastBlock: null, lastShadow: null },
        session: { dolAudited: 4, dolFlagged: 1, sentinelInspected: 5, sentinelBlocked: 1, evidence: 5 },
      },
      rules: [
        { id: 'dol.completion-claim', layer: 'dol', enabled: true, custom: false, title: { zh: '完成性断言', en: 'completion' }, summary: { zh: '无证据不得声称完成', en: 'no evidence, no claim' } },
        { id: 'sentinel.evidence-gap', layer: 'sentinel', enabled: true, custom: false, title: { zh: '数值证据缺失', en: 'evidence' }, summary: { zh: '数值须有依据', en: 'numbers need evidence' } },
        { id: 'custom.abc', layer: 'sentinel', enabled: true, custom: true, pattern: 'dangerous_word', message: '自定义：出现危险词', title: { zh: '自定义工具规则', en: 'Custom tool rule' }, summary: { zh: '自定义正则：dangerous_word', en: 'Custom regex' } },
      ],
      diag: [],
    },
    error: undefined,
  });
  store.ui.set({ open: true, anchor: null });

  const open = collect(render(stubReact.createElement(panel.component, seatProps())));
  const openDialog = open.find((node) => node.props?.role === 'dialog');
  assert.match(openDialog.props.className, /is-open/);

  // The default view is exactly: two layer rows with a name, one metric, a "?"
  // and the layer switch — plus the header's own "?".
  const rows = open.filter((node) => node.props?.className === 'agov-row');
  assert.equal(rows.length, 2, 'expected one row per layer');
  const helps = open.filter((node) => typeof node.props?.className === 'string' && node.props.className.startsWith('agov-help'));
  assert.equal(helps.length, 3, 'expected a "?" on the header and on each row');
  assert.ok(helps.every((node) => node.props['aria-expanded'] === false));
  assert.ok(helps.every((node) => node.props.children === '?'));

  // Everything else is present but collapsed (max-height 0 + visibility hidden).
  const details = open.filter((node) => /^agov-detail( is-open)?$/.test(String(node.props?.className ?? '')));
  assert.equal(details.length, 3, 'expected a detail body per help button');
  assert.ok(details.every((node) => node.props.className === 'agov-detail'));

  // The one number that matters is on the row itself.
  const text = open.map((node) => (typeof node.props?.children === 'string' ? node.props.children : '')).join('|');
  assert.match(text, /«dol.name»/);
  assert.match(text, /«sentinel.name»/);
  assert.match(text, /«metric.blocked» 2/);
  assert.match(text, /«metric.flagged» 1/);
  // The full counters stay behind the "?".
  assert.match(text, /«stat.inspected» 50/);
  assert.match(text, /«stat.audited» 37/);

  // The rule book is visible: built-ins with their names, the user's rule marked
  // as removable, and the "+" that authors a new one.
  assert.match(text, /«rules.title»/);
  assert.match(text, /«rules.add»/);
  assert.match(text, /数值证据缺失/);
  assert.match(text, /自定义工具规则/);
  assert.match(text, /dangerous_word/);
  assert.match(text, /«rules.builtin»/);
  const ruleRows = open.filter((node) => String(node.props?.className ?? '') === 'agov-rule');
  assert.equal(ruleRows.length, 3, 'two built-ins plus one custom rule');
  const removeButtons = open.filter((node) => String(node.props?.className ?? '') === 'agov-rule-remove');
  assert.equal(removeButtons.length, 1, 'only a custom rule can be removed from the UI');
  assert.match(String(removeButtons[0].props['aria-label']), /«rules.remove»/);
  // The form is closed until the "+" is pressed.
  assert.equal(open.filter((node) => String(node.props?.className ?? '') === 'agov-form').length, 0);

  // Each switch must read as a control: a knob, plus an inscribed on/off mark.
  const switches = open.filter((node) => node.props?.role === 'switch');
  assert.equal(switches.length, 5, 'two layers × (enable, shadow) + the delete guard');
  for (const button of switches) {
    const parts = Array.isArray(button.props.children) ? button.props.children : [button.props.children];
    const classes = parts.filter(Boolean).map((child) => String(child.props?.className ?? ''));
    assert.ok(classes.includes('agov-knob'), 'a switch without a knob is not a switch');
    assert.ok(classes.includes('agov-mark agov-mark-on') && classes.includes('agov-mark agov-mark-off'), 'missing the 开/关 marks');
    assert.equal(button.props.type, 'button');
  }
  // Both layers on, and the delete guard on: three switches checked, two (shadow) not.
  assert.equal(switches.filter((node) => node.props['aria-checked'] === true).length, 3);
  assert.equal(switches.filter((node) => node.props['aria-checked'] === false).length, 2);

  // The delete guard is a Sentinel sub-control with three strengths, none of
  // which is "off" — off is the switch.
  const segments = open.filter((node) => String(node.props?.className ?? '').startsWith('agov-seg-item'));
  assert.equal(segments.length, 3, 'expected 开/关 style strengths: 关注 / 拦截 / 严格');
  const active = segments.filter((node) => String(node.props.className).includes('is-on'));
  assert.equal(active.length, 1);
  assert.equal(active[0].props.children, '«guard.watch»');
  assert.match(text, /«guard.chip.watch»/, 'a non-default strength is visible on the row itself');
  assert.match(text, /«guard.hint.watch»/);

  store.ui.set({ open: false, anchor: null });
});

/* -------------------------------------------------------------------------- */

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`\n${failure.name}\n${failure.error?.stack ?? failure.error}\n`);
  process.exit(1);
}
