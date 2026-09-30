/**
 * Client half of the Agent Governor bundle.
 *
 * Registers three things, all additive:
 *
 *  - the switch itself, into `conversation.session.header.utilities` — the
 *    right-aligned Session utilities row in the conversation header (order -20,
 *    so it sits left of the shipped utilities, exactly where the header's
 *    empty-right area is);
 *  - a fallback switch in `shell.overlay`, rendered only while no Session is
 *    selected (the Hero screen), so the control is reachable in every state —
 *    the overlay is a frame-wide click-through layer, and entries opt back into
 *    pointer events;
 *  - the expandable panel, also in `shell.overlay`, positioned from the
 *    trigger's own bounding rect so no header overflow can clip it.
 *
 * The trigger is a plain shield outline (no gear): one simple shape, plus a
 * status dot and a counter. Clicking it expands the panel with a scale + fade +
 * rise transition; the two layer rows stagger in behind it.
 *
 * All live numbers come from the Host half over `/dsh-agent-governor/state`;
 * the switches POST to `/dsh-agent-governor/config`. Nothing is estimated.
 */

window.__ModuleLoader__.load({
  id: '@kxdyh/dsh-agent-governor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useSyncExternalStore, useCallback } = React;

    const ENDPOINT = '/dsh-agent-governor';
    const CSS_TAG = '@kxdyh/dsh-agent-governor/governor.css';
    /** Reported by the placement probe, so "which client build is live" is data. */
    const BUILD = 'guard-v5';
    const PANEL_WIDTH = 340;
    /** The record popover needs a little more room for reasons. */
    const LOG_WIDTH = 396;
    const PANEL_GAP = 8;

    // Styling follows the host: only --dsw-alias-* theme tokens with fallbacks,
    // so light and dark themes both read correctly.
    const CSS = [
      // --- trigger ---------------------------------------------------------
      '.agov-trigger{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}',
      '.agov-trigger:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.agov-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.agov-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.agov-shield{display:block;width:16px;height:16px;flex:none}',
      '.agov-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary,#8a8f98);transition:background .2s ease,transform .2s ease}',
      '.agov-dot[data-level="one"]{background:var(--dsw-alias-state-warn-primary,#d9a441)}',
      '.agov-dot[data-level="two"]{background:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.agov-pulse{animation:agov-pulse .5s ease-out}',
      '@keyframes agov-pulse{0%{transform:scale(1)}45%{transform:scale(1.45)}100%{transform:scale(1)}}',
      '.agov-count{font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-error-primary,#e5484d);font-weight:600}',
      '.agov-fallback-host{position:fixed;inset:0;pointer-events:none;z-index:2147482000}',
      '.agov-fallback-row{position:absolute;top:58px;right:176px;display:flex;align-items:center;gap:6px;pointer-events:auto}',
      // --- panel -----------------------------------------------------------
      '.agov-panel{position:fixed;z-index:2147483000;box-sizing:border-box;width:' + PANEL_WIDTH + 'px;max-height:min(72vh,560px);overflow:auto;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#1c1d21));color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.28);transform-origin:top right;opacity:0;transform:translateY(-6px) scale(.96);visibility:hidden;pointer-events:none;transition:opacity .16s ease-out,transform .18s cubic-bezier(.2,.8,.2,1),visibility 0s linear .18s}',
      '.agov-panel.is-open{opacity:1;transform:none;visibility:visible;pointer-events:auto;transition:opacity .18s ease-out,transform .2s cubic-bezier(.2,.8,.2,1),visibility 0s linear 0s}',
      '.agov-head{display:flex;align-items:center;gap:8px;padding:0 2px 9px}',
      '.agov-head-main{flex:1 1 auto;min-width:0}',
      '.agov-head-title{font-size:13px;font-weight:600;line-height:18px}',
      // A row is the whole default view: name, the one number that matters, the
      // switch, and the "?" that holds everything else.
      '.agov-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));padding:9px 0 3px;opacity:0;transform:translateY(-3px);transition:opacity .18s ease,transform .18s ease}',
      '.agov-panel.is-open .agov-row{opacity:1;transform:none}',
      '.agov-panel.is-open .agov-row[data-index="0"]{transition-delay:.03s}',
      '.agov-panel.is-open .agov-row[data-index="1"]{transition-delay:.07s}',
      '.agov-row-top{display:flex;align-items:center;gap:6px}',
      '.agov-row-name{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.agov-metric{flex:none;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-warn-primary,#d9a441)}',
      '.agov-help{box-sizing:border-box;flex:none;width:18px;height:18px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:50%;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:15px;text-align:center;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}',
      '.agov-help:hover,.agov-help.is-open{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.45));color:var(--dsw-alias-label-primary)}',
      '.agov-help:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      // Collapsed by default; `visibility` also keeps it out of the tab order.
      // The open cap is generous because the detail now carries the rule book;
      // the panel itself scrolls.
      '.agov-detail{overflow:hidden;max-height:0;opacity:0;visibility:hidden;transform:translateY(-2px);transition:max-height .22s cubic-bezier(.2,.8,.2,1),opacity .16s ease,transform .18s ease,visibility 0s linear .22s}',
      '.agov-detail.is-open{max-height:640px;opacity:1;visibility:visible;transform:none;transition-delay:0s}',
      '.agov-detail-inner{padding:6px 0 2px}',
      '.agov-desc{margin:0 0 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.agov-chip{flex:none;font-size:10px;line-height:14px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));color:var(--dsw-alias-label-secondary)}',
      // The layer switch. Sized and coloured as an unmistakable control: a
      // bordered track, a hard brand fill when on, an inscribed 开/关 mark, and a
      // raised knob. The fill is an explicit brand constant on purpose — the
      // theme token measured out to a near-white value here, which is exactly
      // how the switch ended up looking like a decorative white pill.
      '.agov-switch{box-sizing:border-box;position:relative;flex:none;width:48px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(200,200,200,.35));border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.42));color:var(--dsw-alias-label-secondary);font:inherit;appearance:none;-webkit-appearance:none;cursor:pointer;transition:background .18s ease,border-color .18s ease,box-shadow .18s ease}',
      '.agov-switch:hover{box-shadow:0 0 0 3px rgba(77,107,254,.22)}',
      '.agov-switch[aria-checked=true]{background:#4d6bfe;border-color:#4d6bfe}',
      '.agov-switch:focus-visible{outline:2px solid #4d6bfe;outline-offset:2px}',
      '.agov-mark{position:absolute;top:0;height:20px;line-height:20px;font-size:10px;font-weight:600;letter-spacing:.02em;transition:opacity .15s ease}',
      '.agov-mark-on{left:7px;color:#fff;opacity:0}',
      '.agov-mark-off{right:7px;color:var(--dsw-alias-label-secondary);opacity:1}',
      '.agov-switch[aria-checked=true] .agov-mark-on{opacity:1}',
      '.agov-switch[aria-checked=true] .agov-mark-off{opacity:0}',
      '.agov-knob{position:absolute;top:1px;left:1px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.45);transition:transform .18s cubic-bezier(.2,.8,.2,1)}',
      '.agov-switch[aria-checked=true] .agov-knob{transform:translateX(26px)}',
      '.agov-switch-slim{width:40px;height:20px}',
      '.agov-switch-slim .agov-mark{display:none}',
      '.agov-switch-slim .agov-knob{width:16px;height:16px}',
      '.agov-switch-slim[aria-checked=true] .agov-knob{transform:translateX(20px)}',
      '.agov-sub{display:flex;align-items:center;gap:8px;margin-top:8px}',
      '.agov-sub-label{flex:1 1 auto;min-width:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
      '.agov-stats{margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.agov-last{margin-top:2px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.agov-last-rule{color:var(--dsw-alias-label-primary)}',
      '.agov-shadow-tag{color:var(--dsw-alias-state-warn-primary,#d9a441)}',
      '.agov-foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.agov-foot-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.agov-foot-row{display:flex;align-items:center;gap:8px;margin-top:6px}',
      '.agov-link{border:0;background:0 0;padding:0;font:inherit;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);text-decoration:underline;cursor:pointer}',
      '.agov-link:hover{color:var(--dsw-alias-label-primary)}',
      '.agov-err{flex:1 1 auto;font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary,#e5484d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // --- shared interception record --------------------------------------
      '.agov-log{width:396px}',
      '.agov-log-total{flex:none;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.agov-log-filters{display:flex;align-items:center;gap:6px;padding:0 2px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.agov-filter{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:999px;background:0 0;padding:1px 8px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}',
      '.agov-filter:hover{color:var(--dsw-alias-label-primary)}',
      '.agov-filter.is-on{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.45));color:var(--dsw-alias-label-primary)}',
      '.agov-log-clear{margin-left:auto}',
      '.agov-log-empty{margin:10px 2px 2px}',
      '.agov-log-row{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));padding:7px 2px 6px}',
      '.agov-log-head{display:flex;align-items:center;gap:6px;width:100%;padding:0;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.agov-log-head:hover .agov-log-title{color:var(--dsw-alias-label-primary)}',
      '.agov-log-time{flex:none;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.agov-log-tag{flex:none;font-size:10px;line-height:14px;padding:1px 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary)}',
      '.agov-log-tag[data-layer=sentinel]{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.agov-log-title{flex:0 1 auto;min-width:0;font-size:11px;font-weight:600;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.agov-log-step{flex:none;margin-left:auto;font-size:10px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.agov-log-reason{margin-top:3px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.agov-log-row.is-open .agov-log-reason{white-space:normal}',
      '.agov-log-more{margin-top:4px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      // --- the rule book: built-ins stay visible, user rules join them --------
      '.agov-rules{margin-top:9px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
      '.agov-rules-head{display:flex;align-items:center;gap:8px}',
      '.agov-rules-title{flex:1 1 auto;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.agov-rule{display:flex;align-items:center;gap:6px;margin-top:4px}',
      '.agov-rule-name{flex:0 1 auto;min-width:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.agov-rule-id{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.agov-rule-flag{flex:none;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.agov-rule-remove{box-sizing:border-box;flex:none;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:16px;cursor:pointer;transition:background .15s ease,color .15s ease}',
      '.agov-rule-remove:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.agov-form{display:flex;flex-direction:column;gap:4px;margin-top:7px}',
      '.agov-input{box-sizing:border-box;width:100%;padding:3px 6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px}',
      '.agov-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}',
      '.agov-input:focus-visible{outline:2px solid #4d6bfe;outline-offset:1px}',
      '.agov-form-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:2px}',
      '.agov-btn{box-sizing:border-box;padding:2px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;transition:background .15s ease,color .15s ease}',
      '.agov-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.agov-btn-primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}',
      // --- the Sentinel sub-control: delete guard -----------------------------
      '.agov-guard{margin-top:9px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.22))}',
      '.agov-seg{display:flex;gap:4px;margin-top:6px}',
      '.agov-seg.is-disabled{opacity:.45}',
      '.agov-seg-item{box-sizing:border-box;flex:1 1 0;min-width:0;padding:2px 6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;text-align:center;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}',
      '.agov-seg-item:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.agov-seg-item.is-on{background:#4d6bfe;border-color:#4d6bfe;color:#fff}',
      '.agov-seg-item:disabled{cursor:default}',
      '.agov-seg-item:focus-visible{outline:2px solid #4d6bfe;outline-offset:1px}',
      '.agov-guard-tag{border-color:var(--dsw-alias-state-warn-primary,#d9a441);color:var(--dsw-alias-state-warn-primary,#d9a441)}',
    ].join('');

    /** Minimal observable store so plain React can share one piece of state. */
    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(next) {
          snapshot = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    /**
     * Panel open state, which surface it shows (`panel` = the layer switches,
     * `log` = the shared interception record) and the element it hangs from.
     */
    const ui = createStore({ open: false, view: 'panel', anchor: null });
    /** Latest Host snapshot. */
    const data = createStore({ phase: 'idle', snapshot: null, error: undefined });
    /**
     * Placement health. A slot registration proves the entry EXISTS; it does not
     * prove the control is on screen — the frame overlay could clip it, cover
     * it, or a transformed ancestor could misplace its `position: fixed`. When
     * the probe says the overlay seat is not actually visible, the in-flow
     * header seat takes over instead of leaving the user with nothing.
     */
    const overlayHealth = createStore({ unusable: false, probe: null });

    /**
     * Test seam. The page can open the module state for the offline suite by
     * setting `window.__AGOV_DEBUG__ = true` before the bundle loads; nothing is
     * exported otherwise, and the plugin object keeps its documented shape.
     */
    if (window.__AGOV_DEBUG__ === true) {
      window.__AGOV_TEST__ = { ui, data, overlayHealth };
    }

    /** Push one report to the Host; diagnostics must never break the UI. */
    function reportDiag(kind, payload) {
      try {
        void fetch(`${ENDPOINT}/diag`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, ...(payload ?? {}) }),
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    }

    /** Measure whether an element is really painted where it claims to be. */
    function probePlacement(element, seat) {
      const report = { seat, build: BUILD, cssLoaded: false, visible: false };
      try {
        report.cssLoaded = document.head.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null;
        report.viewport = `${window.innerWidth}x${window.innerHeight}`;
        if (element === null || element === undefined) {
          report.missing = true;
          return report;
        }
        const rect = element.getBoundingClientRect();
        report.rect = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
        const style = window.getComputedStyle(element);
        report.style = {
          position: style.position,
          top: style.top,
          right: style.right,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
        };
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        report.center = [Math.round(cx), Math.round(cy)];
        const inViewport = cx > 0 && cy > 0 && cx < window.innerWidth && cy < window.innerHeight;
        let top = null;
        try {
          top = document.elementFromPoint(cx, cy);
        } catch {
          top = null;
        }
        report.top = top === null ? null : `${top.tagName}${top.className ? `.${String(top.className).split(' ')[0]}` : ''}`;
        const onTop = top !== null && (top === element || element.contains(top) === true);
        report.visible =
          inViewport === true &&
          rect.width > 0 &&
          rect.height > 0 &&
          onTop === true &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
        // A transformed/filtered/contained ancestor turns `position: fixed` into
        // "fixed to that ancestor", which is the classic way an overlay entry
        // ends up somewhere else entirely.
        let node = element.parentElement;
        let depth = 0;
        while (node !== null && node !== undefined && depth < 8) {
          const computed = window.getComputedStyle(node);
          const contained = typeof computed.contain === 'string' ? computed.contain : '';
          if (computed.transform !== 'none' || computed.filter !== 'none' || computed.perspective !== 'none' || contained.includes('paint')) {
            report.transformedAncestor = `${node.tagName}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}`;
            break;
          }
          node = node.parentElement;
          depth += 1;
        }
        // Controls are measured too: "the switch is on but still looks white"
        // is a styling bug, and this is how it becomes a number instead of an
        // opinion. Read the custom properties from inside the theme scope — the
        // tokens are not defined on documentElement, so reading them there
        // reports empty strings and hides the real value.
        const anchor = document.querySelector('.agov-switch') ?? document.querySelector('.agov-panel');
        const themeScope = anchor === null ? window.getComputedStyle(document.documentElement) : window.getComputedStyle(anchor);
        report.tokens = {
          scope: anchor === null ? 'documentElement' : 'panel',
          brandPrimary: themeScope.getPropertyValue('--dsw-alias-brand-primary').trim(),
          borderL2: themeScope.getPropertyValue('--dsw-alias-border-l2').trim(),
        };
        report.switches = [...document.querySelectorAll('.agov-switch')].slice(0, 4).map((node) => {
          const computed = window.getComputedStyle(node);
          return {
            checked: node.getAttribute('aria-checked'),
            background: computed.backgroundColor,
            border: computed.borderTopColor,
            width: computed.width,
          };
        });
        // Every header button is measured too: a sibling rendering is not
        // evidence that this one did.
        report.triggers = [...document.querySelectorAll('.agov-trigger')].slice(0, 4).map((node) => {
          const rect = node.getBoundingClientRect();
          let hit = null;
          try {
            hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          } catch {
            hit = null;
          }
          return {
            title: node.getAttribute('title') ?? '',
            rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
            onTop: hit !== null && (hit === node || node.contains(hit) === true),
          };
        });
      } catch (error) {
        report.probeError = String(error?.message ?? error);
      }
      return report;
    }

    async function request(path, init) {
      const response = await fetch(`${ENDPOINT}${path}`, { cache: 'no-store', ...init });
      if (!response.ok) {
        // The Host refuses with a reason ("invalid regex: …"); carry that into
        // the UI instead of showing a bare status code.
        let detail = `http ${response.status}`;
        try {
          const body = await response.json();
          if (typeof body?.error === 'string' && body.error !== '') detail = body.error;
        } catch {
          /* keep the status */
        }
        throw new Error(detail);
      }
      return response.json();
    }

    async function refresh(sessionId) {
      try {
        const snapshot = await request(`/state?session=${encodeURIComponent(sessionId ?? '')}`);
        data.set({ phase: 'ready', snapshot, error: undefined });
      } catch (error) {
        const previous = data.getSnapshot();
        data.set({ phase: 'failed', snapshot: previous.snapshot, error: String(error?.message ?? error) });
      }
    }

    async function patch(layer, field, value, sessionId) {
      // Optimistic flip so the knob answers the click immediately.
      const current = data.getSnapshot();
      if (current.snapshot !== null) {
        const optimistic = {
          ...current.snapshot,
          layers: { ...current.snapshot.layers, [layer]: { ...current.snapshot.layers[layer], [field]: value } },
        };
        data.set({ phase: 'ready', snapshot: optimistic, error: undefined });
      }
      try {
        const snapshot = await request('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layer, field, value, session: sessionId ?? '' }),
        });
        data.set({ phase: 'ready', snapshot, error: undefined });
      } catch (error) {
        data.set({ phase: 'failed', snapshot: data.getSnapshot().snapshot, error: String(error?.message ?? error) });
        void refresh(sessionId);
      }
    }

    async function resetStats(sessionId) {
      try {
        const snapshot = await request(`/reset?session=${encodeURIComponent(sessionId ?? '')}`, { method: 'POST' });
        data.set({ phase: 'ready', snapshot, error: undefined });
      } catch (error) {
        data.set({ phase: 'failed', snapshot: data.getSnapshot().snapshot, error: String(error?.message ?? error) });
      }
    }

    /** Wipe the shared interception record (counters and evidence stay). */
    async function clearLog(sessionId) {
      try {
        const snapshot = await request(`/log/clear?session=${encodeURIComponent(sessionId ?? '')}`, { method: 'POST' });
        data.set({ phase: 'ready', snapshot, error: undefined });
      } catch (error) {
        data.set({ phase: 'failed', snapshot: data.getSnapshot().snapshot, error: String(error?.message ?? error) });
      }
    }

    /** Author one rule. Returns the Host's refusal reason instead of throwing. */
    async function addRule(layer, draft) {
      try {
        const snapshot = await request('/rules/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layer, pattern: draft.pattern, message: draft.message, deontic: draft.deontic }),
        });
        data.set({ phase: 'ready', snapshot, error: undefined });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }

    /** Drop one user-authored rule. */
    async function removeRule(id) {
      try {
        const snapshot = await request('/rules/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        data.set({ phase: 'ready', snapshot, error: undefined });
      } catch (error) {
        data.set({ phase: 'failed', snapshot: data.getSnapshot().snapshot, error: String(error?.message ?? error) });
      }
    }

    /** Anchor a popover under whichever trigger opened it. */
    function useAnchoredPosition(open, anchor, width) {
      const [position, setPosition] = useState({ top: 56, right: 150 });
      useEffect(() => {
        if (!open) return undefined;
        const compute = () => {
          let rect;
          try {
            rect = anchor?.getBoundingClientRect?.();
          } catch {
            rect = undefined;
          }
          if (rect === undefined || rect === null) {
            setPosition({ top: 56, right: 150 });
            return;
          }
          const maxRight = Math.max(12, window.innerWidth - width - 12);
          const right = Math.min(maxRight, Math.max(12, window.innerWidth - rect.right));
          const top = Math.max(12, Math.min(window.innerHeight - 140, rect.bottom + PANEL_GAP));
          setPosition({ top, right });
        };
        compute();
        window.addEventListener('resize', compute);
        window.addEventListener('scroll', compute, true);
        return () => {
          window.removeEventListener('resize', compute);
          window.removeEventListener('scroll', compute, true);
        };
      }, [open, anchor, width]);
      return position;
    }

    /** Close on an outside pointer press or Escape. */
    function useDismiss(open) {
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('.agov-scope') !== null) return;
          ui.set({ ...ui.getSnapshot(), open: false });
        };
        const onKey = (event) => {
          if (event.key === 'Escape') ui.set({ ...ui.getSnapshot(), open: false });
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);
    }

    /** Any retained conversation — the strict reading of "a session is open". */
    const ACTIVE_SELECTOR = (state) => {
      const rows = state?.byId ?? {};
      for (const id of Object.keys(rows)) {
        if ((rows[id]?.retainedBy?.mainView ?? 0) > 0) return id;
      }
      return undefined;
    };

    const SELECTOR = (state) => {
      const rows = state?.byId ?? {};
      for (const id of Object.keys(rows)) {
        if ((rows[id]?.retainedBy?.mainView ?? 0) > 0) return id;
      }
      return state?.ids?.[0];
    };

    /**
     * The Session this widget speaks for; both seats expose `useSessions`.
     * `strict` ignores merely-listed sessions, which is what the overlay seats
     * need: they must step aside exactly when the header seat takes over.
     */
    function useGovernedSession(props, strict) {
      const useSessions = props.useSessions ?? ((selector) => selector?.(undefined));
      const selected = useSessions(strict === true ? ACTIVE_SELECTOR : SELECTOR);
      return props.sessionId ?? selected;
    }

    /**
     * `t` reaches a slot occupant only through the registration's `inject`, so
     * a registration that forgets it would otherwise crash the whole seat. Fail
     * loud in development, stay readable in production.
     */
    const fallbackT = (key) => String(key);

    function translatorOf(props) {
      return typeof props?.t === 'function' ? props.t : fallbackT;
    }

    /** A small ledger glyph: three ruled lines in a frame — a record, not a gear. */
    function LedgerIcon() {
      return h(
        'svg',
        { className: 'agov-shield', viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none' },
        h('rect', { x: 3.6, y: 3, width: 12.8, height: 14, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M6.9 7.3h6.2M6.9 10h6.2M6.9 12.7h3.4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    /** Plain shield outline — deliberately not a gear. */
    function Shield(props) {
      return h(
        'svg',
        { className: 'agov-shield', viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none' },
        h('path', {
          d: 'M10 2.4 4.2 4.6v5c0 3.6 2.4 6.4 5.8 7.9 3.4-1.5 5.8-4.3 5.8-7.9v-5L10 2.4Z',
          stroke: 'currentColor',
          strokeWidth: props.active ? 1.7 : 1.5,
          strokeLinejoin: 'round',
          fill: props.active ? 'currentColor' : 'none',
          fillOpacity: props.active ? 0.16 : 0,
        }),
        h('path', { d: 'M10 6.6v4.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 10, cy: 13.6, r: 0.85, fill: 'currentColor' }),
      );
    }

    /**
     * Accessible switch: `role="switch"` + `aria-checked`, plus an inscribed
     * 开/关 mark and a raised knob so it never reads as a decorative pill.
     */
    function Switch(props) {
      const { checked, onChange, label, slim, t } = props;
      const mark = (key, fallback) => (typeof t === 'function' ? t(key) : fallback);
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          'aria-label': label,
          title: label,
          className: slim === true ? 'agov-switch agov-switch-slim' : 'agov-switch',
          onClick: () => onChange(checked !== true),
        },
        h('span', { className: 'agov-mark agov-mark-on' }, mark('switch.on', 'ON')),
        h('span', { className: 'agov-mark agov-mark-off' }, mark('switch.off', 'OFF')),
        h('span', { className: 'agov-knob' }),
      );
    }

    function useLayerState(snapshot, layer) {
      const value = snapshot?.layers?.[layer];
      return { enabled: value?.enabled === true, shadow: value?.shadow === true };
    }

    /**
     * The Sentinel sub-control. `off` is the switch, never a strength: the three
     * strengths are 关注 (record only) / 拦截 (forced recursive) / 严格 (any delete).
     */
    function useGuardState(snapshot) {
      const sentinel = snapshot?.layers?.sentinel;
      const guard = sentinel?.deleteGuard;
      const level = typeof guard?.level === 'string' ? guard.level : 'block';
      const enabled = guard?.enabled !== false;
      return {
        enabled,
        level,
        effective: enabled ? level : 'off',
        levels: Array.isArray(sentinel?.deleteGuardLevels) ? sentinel.deleteGuardLevels : ['watch', 'block', 'strict'],
        nonDefault: enabled !== true || level !== 'block',
      };
    }

    /** A compact segmented control: the delete guard's three strengths. */
    function Segments(props) {
      const { t, options, value, disabled, onChange, label } = props;
      return h(
        'div',
        { className: disabled === true ? 'agov-seg is-disabled' : 'agov-seg', role: 'group', 'aria-label': label },
        ...options.map((option) =>
          h(
            'button',
            {
              key: option,
              type: 'button',
              className: value === option && disabled !== true ? 'agov-seg-item is-on' : 'agov-seg-item',
              'aria-pressed': value === option && disabled !== true,
              disabled: disabled === true,
              title: t(`guard.hint.${option}`),
              onClick: () => onChange(option),
            },
            t(`guard.${option}`),
          ),
        ),
      );
    }

    function formatStats(t, layer, snapshot) {
      const stats = snapshot?.stats ?? {};
      if (layer === 'sentinel') {
        const own = stats.sentinel ?? {};
        return `${t('stat.inspected')} ${own.inspected ?? 0} · ${t('stat.blocked')} ${own.blocked ?? 0} · ${t('stat.evidence')} ${own.evidence ?? 0}`;
      }
      const own = stats.dol ?? {};
      return `${t('stat.audited')} ${own.audited ?? 0} · ${t('stat.flagged')} ${own.flagged ?? 0} · ${t('stat.corrected')} ${own.corrected ?? 0}`;
    }

    function formatSession(t, layer, snapshot) {
      const session = snapshot?.stats?.session;
      if (session === null || session === undefined) return null;
      if (layer === 'sentinel') {
        return `${t('stat.session')} ${t('stat.inspected')} ${session.sentinelInspected ?? 0} · ${t('stat.blocked')} ${session.sentinelBlocked ?? 0}`;
      }
      return `${t('stat.session')} ${t('stat.audited')} ${session.dolAudited ?? 0} · ${t('stat.flagged')} ${session.dolFlagged ?? 0}`;
    }

    function lastEventText(t, layer, snapshot, rulesById) {
      const stats = snapshot?.stats ?? {};
      if (layer === 'sentinel') {
        const shadow = stats.sentinel?.lastShadow;
        const block = stats.sentinel?.lastBlock;
        const event = block ?? shadow;
        if (event === undefined || event === null) return null;
        const rule = rulesById.get(event.rule);
        const title = rule?.title?.[t('locale')] ?? rule?.title?.en ?? event.rule;
        const tag = block === undefined || block === null ? `${t('tag.shadow')} ` : '';
        return `${t('last')}: ${tag}${title}${event.tool !== undefined ? ` · ${event.tool}` : ''}`;
      }
      const flag = stats.dol?.lastFlag;
      if (flag === undefined || flag === null) return null;
      const rule = rulesById.get(flag.rule);
      const title = rule?.title?.[t('locale')] ?? rule?.title?.en ?? flag.rule;
      return `${t('last')}: ${title}`;
    }

    /** Shared interception record: the compact ledger popover. */
    function LogPanel(props) {
      const t = translatorOf(props);
      const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
      const dataSnapshot = useSyncExternalStore(data.subscribe, data.getSnapshot, data.getSnapshot);
      const sessionId = useGovernedSession(props, true);
      const [filter, setFilter] = useState('all');
      const [detailId, setDetailId] = useState(null);
      const open = uiSnapshot.open === true && uiSnapshot.view === 'log';
      const position = useAnchoredPosition(open, uiSnapshot.anchor, LOG_WIDTH);
      useDismiss(open);

      useEffect(() => {
        if (open) void refresh(sessionId);
      }, [open, sessionId]);

      const snapshot = dataSnapshot.snapshot;
      const entries = (snapshot?.log ?? []).filter((entry) => filter === 'all' || entry.layer === filter);
      const filters = [
        ['all', 'log.filter.all'],
        ['sentinel', 'log.filter.sentinel'],
        ['dol', 'log.filter.dol'],
      ];

      return h(
        'div',
        {
          className: open ? 'agov-panel agov-log agov-scope is-open' : 'agov-panel agov-log agov-scope',
          style: { top: `${position.top}px`, right: `${position.right}px` },
          role: 'dialog',
          'aria-label': t('log.title'),
          'aria-hidden': open ? undefined : 'true',
        },
        h(
          'div',
          { className: 'agov-head' },
          h(LedgerIcon, {}),
          h('div', { className: 'agov-head-main' }, h('div', { className: 'agov-head-title' }, t('log.title'))),
          h('span', { className: 'agov-log-total' }, String(snapshot?.logCount ?? 0)),
        ),
        h(
          'div',
          { className: 'agov-log-filters' },
          ...filters.map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: filter === key ? 'agov-filter is-on' : 'agov-filter',
                onClick: () => setFilter(key),
              },
              t(label),
            ),
          ),
          h('button', { type: 'button', className: 'agov-link agov-log-clear', onClick: () => clearLog(sessionId) }, t('log.clear')),
        ),
        entries.length === 0
          ? h('p', { className: 'agov-desc agov-log-empty' }, t('log.empty'))
          : h(
              'div',
              {},
              ...entries.map((entry) => h(LogRow, { key: entry.id, entry, t, open: detailId === entry.id, onToggle: () => setDetailId(detailId === entry.id ? null : entry.id) })),
            ),
      );
    }

    /** One record: time, layer tag, rule title, step, then the reason. */
    function LogRow(props) {
      const { entry, t, open, onToggle } = props;
      const locale = typeof t === 'function' ? t('locale') : 'en';
      const title = entry.title?.[locale] ?? entry.title?.en ?? entry.rule;
      let time = '';
      try {
        time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        time = String(entry.at ?? '').slice(11, 16);
      }
      const stepLabel = entry.step === null || entry.step === undefined ? t('log.step.none') : `${t('log.step')} ${entry.step}`;
      return h(
        'div',
        { className: open ? 'agov-log-row is-open' : 'agov-log-row' },
        h(
          'button',
          { type: 'button', className: 'agov-log-head', 'aria-expanded': open === true, onClick: onToggle },
          h('span', { className: 'agov-log-time' }, time),
          h('span', { className: 'agov-log-tag', 'data-layer': entry.layer }, entry.layer === 'dol' ? t('log.filter.dol') : t('log.filter.sentinel')),
          h('span', { className: 'agov-log-title' }, title),
          entry.shadow === true ? h('span', { className: 'agov-chip agov-shadow-tag' }, t('tag.shadow')) : null,
          h('span', { className: 'agov-log-step' }, stepLabel),
        ),
        h('div', { className: 'agov-log-reason' }, entry.detail),
        open === true
          ? h(
              'div',
              { className: 'agov-log-more' },
              h('div', {}, `${t('log.target')}: ${entry.target ?? '—'}`),
              h('div', {}, `${t('log.origin')}: ${entry.session ?? '—'}${entry.turn === null || entry.turn === undefined ? '' : ` · ${t('log.turn')} ${entry.turn}`}`),
              h('div', {}, `${t('log.rule')}: ${entry.rule} · ${entry.deontic}`),
            )
          : null,
      );
    }

    /** The small round "?" that holds everything not essential at a glance. */
    function HelpButton(props) {
      const { open, label, onClick } = props;
      return h(
        'button',
        {
          type: 'button',
          className: open === true ? 'agov-help is-open' : 'agov-help',
          'aria-expanded': open === true,
          'aria-label': label,
          title: label,
          onClick,
        },
        '?',
      );
    }

    /** Collapsible body: height + fade, so it opens with the panel's own feel. */
    function Detail(props) {
      const { open, children } = props;
      return h('div', { className: open === true ? 'agov-detail is-open' : 'agov-detail' }, h('div', { className: 'agov-detail-inner' }, children));
    }

    /**
     * One layer row. Default view is deliberately three things: what the layer
     * is, the one number that matters, and the switch. Description, shadow mode,
     * counters and the last event live behind the row's "?".
     */
    /** One rule row: localized name, its id, and a remove control when it is ours. */
    function RuleRow(props) {
      const { rule, t, onRemove } = props;
      const locale = typeof t === 'function' ? t('locale') : 'en';
      const title = rule.title?.[locale] ?? rule.title?.en ?? rule.id;
      const summary = rule.summary?.[locale] ?? rule.summary?.en ?? '';
      return h(
        'div',
        { className: 'agov-rule', title: summary },
        h('span', { className: 'agov-rule-name' }, title),
        h('span', { className: 'agov-rule-id' }, rule.pattern ?? rule.id),
        rule.custom === true
          ? h(
              'button',
              {
                type: 'button',
                className: 'agov-rule-remove',
                'aria-label': `${t('rules.remove')} ${title}`,
                title: t('rules.remove'),
                onClick: onRemove,
              },
              '×',
            )
          : h('span', { className: 'agov-rule-flag' }, t('rules.builtin')),
      );
    }

    /** The add-a-rule form; the Host validates and its reason is shown here. */
    function RuleForm(props) {
      const { t, draft, setDraft, error, onSubmit, onCancel } = props;
      const field = (key, placeholder) =>
        h('input', {
          className: 'agov-input',
          value: draft[key],
          placeholder,
          onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
        });
      return h(
        'div',
        { className: 'agov-form' },
        field('pattern', t('rules.pattern')),
        field('message', t('rules.message')),
        h(
          'select',
          {
            className: 'agov-input',
            value: draft.deontic,
            onChange: (event) => setDraft({ ...draft, deontic: event.target.value }),
          },
          h('option', { value: 'prohibition' }, t('rules.prohibition')),
          h('option', { value: 'obligation' }, t('rules.obligation')),
        ),
        error !== null && error !== undefined ? h('div', { className: 'agov-err' }, error) : null,
        h(
          'div',
          { className: 'agov-form-actions' },
          h('button', { type: 'button', className: 'agov-btn', onClick: onCancel }, t('rules.cancel')),
          h('button', { type: 'button', className: 'agov-btn agov-btn-primary', onClick: onSubmit }, t('rules.save')),
        ),
      );
    }

    function LayerRow(props) {
      const { t, layer, index, snapshot, rulesById, sessionId, expanded, onToggle } = props;
      const state = useLayerState(snapshot, layer);
      const rule = rulesById.get(layer === 'sentinel' ? 'sentinel.evidence-gap' : 'dol.completion-claim');
      const name = t(layer === 'sentinel' ? 'sentinel.name' : 'dol.name');
      const counters = snapshot?.stats ?? {};
      const metric = layer === 'sentinel' ? (counters.sentinel?.blocked ?? 0) : (counters.dol?.flagged ?? 0);
      const metricLabel = layer === 'sentinel' ? t('metric.blocked') : t('metric.flagged');
      const sessionLine = formatSession(t, layer, snapshot);
      const eventLine = lastEventText(t, layer, snapshot, rulesById);
      const [formOpen, setFormOpen] = useState(false);
      const [draft, setDraft] = useState({ pattern: '', message: '', deontic: 'prohibition' });
      const [formError, setFormError] = useState(null);
      const guard = useGuardState(snapshot);
      // The built-in book is always visible; user rules join it in the same list.
      const book = (snapshot?.rules ?? []).filter((entry) => entry.layer === layer);
      const submit = async () => {
        const result = await addRule(layer, draft);
        if (result.ok === true) {
          setDraft({ pattern: '', message: '', deontic: 'prohibition' });
          setFormError(null);
          setFormOpen(false);
          return;
        }
        setFormError(result.error);
      };
      return h(
        'section',
        { className: 'agov-row', 'data-on': state.enabled ? 'true' : 'false', 'data-index': index },
        h(
          'div',
          { className: 'agov-row-top' },
          h('span', { className: 'agov-row-name' }, name),
          state.shadow ? h('span', { className: 'agov-chip agov-shadow-tag' }, t('tag.shadow')) : null,
          layer === 'sentinel' && guard.nonDefault
            ? h('span', { className: 'agov-chip agov-guard-tag' }, t(`guard.chip.${guard.effective}`))
            : null,
          metric > 0 ? h('span', { className: 'agov-metric' }, `${metricLabel} ${metric}`) : null,
          h(HelpButton, { open: expanded === true, label: `${t('help.layer')} · ${name}`, onClick: onToggle }),
          h(Switch, {
            t,
            checked: state.enabled,
            label: `${t('layer.enable')} · ${name}`,
            onChange: (next) => patch(layer, 'enabled', next, sessionId),
          }),
        ),
        h(
          Detail,
          { open: expanded === true },
          h('p', { className: 'agov-desc' }, t(layer === 'sentinel' ? 'sentinel.desc' : 'dol.desc')),
          h(
            'div',
            { className: 'agov-sub' },
            h('span', { className: 'agov-sub-label' }, t('layer.shadow')),
            h(Switch, {
              t,
              slim: true,
              checked: state.shadow,
              label: `${t('layer.shadow')} · ${name}`,
              onChange: (next) => patch(layer, 'shadow', next, sessionId),
            }),
          ),
          h('div', { className: 'agov-stats' }, `${t('tag.scope')}: ${t(layer === 'sentinel' ? 'tag.tool' : 'tag.speech')}`),
          h('div', { className: 'agov-stats' }, formatStats(t, layer, snapshot)),
          sessionLine !== null ? h('div', { className: 'agov-last' }, sessionLine) : null,
          eventLine !== null ? h('div', { className: 'agov-last' }, eventLine) : null,
          rule?.enabled === false && state.enabled ? h('div', { className: 'agov-last' }, t('hint.ruleOff')) : null,
          // The Sentinel sub-control: on/off is the switch, and the three
          // strengths sit beside it. 关注 records without ever interfering.
          layer === 'sentinel'
            ? h(
                'div',
                { className: 'agov-guard' },
                h(
                  'div',
                  { className: 'agov-sub' },
                  h('span', { className: 'agov-sub-label' }, t('guard.title')),
                  h(Switch, {
                    t,
                    slim: true,
                    checked: guard.enabled,
                    label: t('guard.title'),
                    onChange: (next) => patch('sentinel', 'deleteGuardEnabled', next, sessionId),
                  }),
                ),
                h(Segments, {
                  t,
                  label: t('guard.title'),
                  options: guard.levels,
                  value: guard.level,
                  disabled: guard.enabled !== true,
                  onChange: (level) => patch('sentinel', 'deleteGuardLevel', level, sessionId),
                }),
                h('div', { className: 'agov-last' }, t(`guard.hint.${guard.effective}`)),
              )
            : null,
          h(
            'div',
            { className: 'agov-rules' },
            h(
              'div',
              { className: 'agov-rules-head' },
              h('span', { className: 'agov-rules-title' }, `${t('rules.title')} ${book.length}`),
              h(
                'button',
                { type: 'button', className: 'agov-link', onClick: () => setFormOpen(formOpen !== true) },
                t('rules.add'),
              ),
            ),
            ...book.map((entry) =>
              h(RuleRow, { key: entry.id, rule: entry, t, onRemove: () => removeRule(entry.id) }),
            ),
            formOpen === true
              ? h(RuleForm, { t, draft, setDraft, error: formError, onSubmit: submit, onCancel: () => setFormOpen(false) })
              : null,
          ),
        ),
      );
    }

    /** The expandable panel; lives in the click-through frame overlay. */
    function Panel(props) {
      const t = translatorOf(props);
      const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
      const dataSnapshot = useSyncExternalStore(data.subscribe, data.getSnapshot, data.getSnapshot);
      // The panel is an overlay seat: it must speak for the retained
      // conversation only, never for a session that is merely listed.
      const sessionId = useGovernedSession(props, true);
      const panelRef = useRef(null);

      // Only the layer-switch surface; the log surface has its own component.
      const open = uiSnapshot.open === true && (uiSnapshot.view ?? 'panel') === 'panel';
      const position = useAnchoredPosition(open, uiSnapshot.anchor, PANEL_WIDTH);
      useDismiss(open);

      useEffect(() => {
        if (open) void refresh(sessionId);
      }, [open, sessionId]);

      const snapshot = dataSnapshot.snapshot;
      const rulesById = new Map((snapshot?.rules ?? []).map((rule) => [rule.id, rule]));
      const enabledRules = (snapshot?.rules ?? []).filter((rule) => rule.enabled === true).length;
      const dol = useLayerState(snapshot, 'dol');
      const sentinel = useLayerState(snapshot, 'sentinel');
      const anyOn = dol.enabled || sentinel.enabled;
      // One disclosure open at a time keeps the panel short.
      const [expanded, setExpanded] = useState(null);
      const toggle = (key) => setExpanded((current) => (current === key ? null : key));

      return h(
        'div',
        {
          ref: panelRef,
          className: open ? 'agov-panel agov-scope is-open' : 'agov-panel agov-scope',
          style: { top: `${position.top}px`, right: `${position.right}px` },
          role: 'dialog',
          'aria-label': t('panel.title'),
          'aria-hidden': open ? undefined : 'true',
        },
        h(
          'div',
          { className: 'agov-head' },
          h(Shield, { active: anyOn }),
          h('div', { className: 'agov-head-main' }, h('div', { className: 'agov-head-title' }, t('panel.title'))),
          h(HelpButton, { open: expanded === 'global', label: t('help.global'), onClick: () => toggle('global') }),
        ),
        h(
          Detail,
          { open: expanded === 'global' },
          h('p', { className: 'agov-desc' }, t('panel.subtitle')),
          h('p', { className: 'agov-desc' }, t('foot.note')),
          h(
            'div',
            { className: 'agov-foot-row' },
            dataSnapshot.error !== undefined
              ? h('span', { className: 'agov-err' }, `${t('error.host')} (${dataSnapshot.error})`)
              : h('span', { className: 'agov-foot-note' }, `${t('rules.enabled')} ${enabledRules}/${(snapshot?.rules ?? []).length}`),
            h(
              'button',
              { type: 'button', className: 'agov-link', onClick: () => resetStats(sessionId) },
              t('action.reset'),
            ),
          ),
        ),
        snapshot === null
          ? h('p', { className: 'agov-desc' }, dataSnapshot.phase === 'failed' ? t('error.host') : t('loading'))
          : h(
              'div',
              {},
              h(LayerRow, {
                t,
                layer: 'dol',
                index: 0,
                snapshot,
                rulesById,
                sessionId,
                expanded: expanded === 'dol',
                onToggle: () => toggle('dol'),
              }),
              h(LayerRow, {
                t,
                layer: 'sentinel',
                index: 1,
                snapshot,
                rulesById,
                sessionId,
                expanded: expanded === 'sentinel',
                onToggle: () => toggle('sentinel'),
              }),
            ),
      );
    }

    /** The switch in the conversation header (and its no-Session fallback). */
    function Trigger(props) {
      const t = translatorOf(props);
      const seat = props.seat;
      const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
      const dataSnapshot = useSyncExternalStore(data.subscribe, data.getSnapshot, data.getSnapshot);
      const sessionId = useGovernedSession(props, props.strictSession === true);
      const ref = useRef(null);
      const [pulse, setPulse] = useState(false);
      const open = uiSnapshot.open === true;
      const snapshot = dataSnapshot.snapshot;
      const dor = useLayerState(snapshot, 'dol');
      const sentinel = useLayerState(snapshot, 'sentinel');
      const blocks = (snapshot?.stats?.sentinel?.blocked ?? 0) + (snapshot?.stats?.dol?.flagged ?? 0);
      const level = dor.enabled && sentinel.enabled ? 'two' : dor.enabled || sentinel.enabled ? 'one' : 'off';

      // One poller per trigger: fast while the panel is open, slow for the dot.
      useEffect(() => {
        void refresh(sessionId);
        const timer = setInterval(() => {
          // A hidden tab does not need the dot to be fresh.
          if (document.hidden === true) return;
          void refresh(sessionId);
        }, open ? 2000 : 8000);
        return () => clearInterval(timer);
      }, [sessionId, open]);

      // A fresh block pings the dot once, so a background turn is noticeable.
      const seenBlocks = useRef(blocks);
      useEffect(() => {
        if (blocks > seenBlocks.current) {
          setPulse(true);
          const timer = setTimeout(() => setPulse(false), 520);
          seenBlocks.current = blocks;
          return () => clearTimeout(timer);
        }
        seenBlocks.current = blocks;
        return undefined;
      }, [blocks]);

      // Prove the control is actually on screen; report either way, and hand the
      // job to the in-flow header seat when the overlay placement failed.
      useEffect(() => {
        const timer = setTimeout(() => {
          const report = probePlacement(ref.current, seat ?? 'header');
          reportDiag('placement', report);
          if (seat === 'overlay' && report.visible !== true && overlayHealth.getSnapshot().unusable !== true) {
            overlayHealth.set({ unusable: true, probe: report });
          }
        }, 400);
        return () => clearTimeout(timer);
      }, [seat]);

      const onClick = useCallback(() => {
        const current = ui.getSnapshot();
        const isOpen = current.open === true && (current.view ?? 'panel') === 'panel';
        ui.set({ open: !isOpen, view: 'panel', anchor: ref.current });
      }, []);

      const button = h(
        'button',
        {
          ref,
          type: 'button',
          className: 'agov-trigger agov-scope',
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          title: t('trigger.title'),
          onClick,
        },
        h(Shield, { active: level !== 'off' }),
        h('span', { className: pulse ? 'agov-dot agov-pulse' : 'agov-dot', 'data-level': level, 'aria-hidden': 'true' }),
        blocks > 0 ? h('span', { className: 'agov-count' }, String(blocks)) : null,
      );

      return button;
    }

    /** The record button: ledger glyph + how many interceptions are on file. */
    function LogTrigger(props) {
      const t = translatorOf(props);
      const uiSnapshot = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
      const dataSnapshot = useSyncExternalStore(data.subscribe, data.getSnapshot, data.getSnapshot);
      const ref = useRef(null);
      const count = dataSnapshot.snapshot?.logCount ?? 0;
      const open = uiSnapshot.open === true && uiSnapshot.view === 'log';
      const onClick = useCallback(() => {
        const current = ui.getSnapshot();
        const isOpen = current.open === true && current.view === 'log';
        ui.set({ open: !isOpen, view: 'log', anchor: ref.current });
      }, []);
      return h(
        'button',
        {
          ref,
          type: 'button',
          className: 'agov-trigger agov-scope',
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          title: t('log.open'),
          onClick,
        },
        h(LedgerIcon, {}),
        count > 0 ? h('span', { className: 'agov-count' }, String(count)) : null,
      );
    }

    /** No Session is retained: the header utilities row is not mounted at all. */
    function OverlayTrigger(props) {
      const { useSessions } = props;
      const hook = useSessions ?? ((selector) => selector?.(undefined));
      const sessionId = hook(ACTIVE_SELECTOR);
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') return null;
      // The overlay is a click-through layer, so the pair gets a full-viewport
      // host of its own: that keeps `fixed` meaningful even where the layer's
      // own box is collapsed or a transformed ancestor would capture it.
      return h(
        'div',
        { className: 'agov-fallback-host' },
        h(
          'div',
          { className: 'agov-fallback-row' },
          h(Trigger, { ...props, seat: 'overlay', strictSession: true }),
          h(LogTrigger, { ...props, seat: 'overlay' }),
        ),
      );
    }

    /**
     * In-flow rescue seat (`conversation.header.leading`, available without a
     * Session). It stays empty until the overlay probe fails, so a working
     * overlay never shows two triggers.
     */
    function HeaderRescueTrigger(props) {
      const health = useSyncExternalStore(overlayHealth.subscribe, overlayHealth.getSnapshot, overlayHealth.getSnapshot);
      if (health.unusable !== true) return null;
      return h(Trigger, { ...props, seat: 'header-leading', strictSession: true });
    }

    /**
     * Any render error inside a seat is reported instead of vanishing, and it
     * also flips the rescue seat on — a crash must be visible, not silent.
     */
    class SeatBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        reportDiag('error', { seat: this.props.seat, message: String(error?.message ?? error) });
        if (overlayHealth.getSnapshot().unusable !== true) {
          overlayHealth.set({ unusable: true, probe: { seat: this.props.seat, error: String(error?.message ?? error) } });
        }
      }

      render() {
        if (this.state.failed === true) return null;
        return this.props.children;
      }
    }

    /** Wrap a seat component so its failures are reported and recoverable. */
    function seat(component, seatName) {
      return function Seat(props) {
        return h(SeatBoundary, { seat: seatName }, h(component, props));
      };
    }

    const DICTIONARIES = {
      zh: {
        locale: 'zh',
        'trigger.title': '拦截层：DOL 通信语义治理 · Sentinel 工具执行治理',
        'panel.title': 'Agent 治理 · 双层拦截',
        'panel.subtitle': '说的每句话要有依据，做的每个动作要可查',
        'help.layer': '该层详情',
        'help.global': '说明与统计',
        'metric.blocked': '拦截',
        'metric.flagged': '标记',
        'switch.on': '开',
        'switch.off': '关',
        'log.open': '拦截记录（哪一步被拦、为什么）',
        'log.title': '拦截记录',
        'log.filter.all': '全部',
        'log.filter.sentinel': '工具拦截',
        'log.filter.dol': '输出标记',
        'log.clear': '清空',
        'log.empty': '还没有拦截记录。',
        'log.step': '第',
        'log.step.none': '未标注步骤',
        'log.target': '对象',
        'log.origin': '来源',
        'log.turn': '轮次',
        'log.rule': '规则',
        'rules.title': '规则',
        'rules.add': '＋ 自定义规则',
        'rules.builtin': '内置',
        'rules.pattern': '正则（工具拦截匹配调用，输出标记匹配正文）',
        'rules.message': '命中时显示的理由',
        'rules.prohibition': '禁止',
        'rules.obligation': '义务',
        'rules.save': '保存',
        'rules.cancel': '取消',
        'rules.remove': '删除这条自定义规则',
        'guard.title': '删除防护',
        'guard.watch': '关注',
        'guard.block': '拦截',
        'guard.strict': '严格',
        'guard.hint.watch': '关注：只记录，不拦截任何删除',
        'guard.hint.block': '拦截：拦下未点名的递归强制删除（默认）',
        'guard.hint.strict': '严格：连单文件删除也拦（你自己创建的产物仍可删）',
        'guard.hint.off': '已关闭：不检查删除操作',
        'guard.chip.watch': '删除:关注',
        'guard.chip.block': '删除:拦截',
        'guard.chip.strict': '删除:严格',
        'guard.chip.off': '删除:关',
        'tag.scope': '作用面',
        'dol.name': 'DOL 层 · 通信语义治理',
        'dol.desc': '在通信边上校验"说什么"：没有工具证据的完成性断言、凭据外泄、绝对化承诺会被标记，并把纠正要求送回下一步，强制自我纠正。',
        'sentinel.name': 'Sentinel 层 · 工具执行治理',
        'sentinel.desc': '在工具调用执行前用证据缓存校验"做什么"：破坏性命令、无依据的数值参数会被拦下，并返回结构化的重试反馈。',
        'tag.tool': '工具调用',
        'tag.speech': '消息 / 输出',
        'tag.shadow': '影子',
        'layer.enable': '启用该层',
        'layer.shadow': '影子模式（只记录，不拦截）',
        'stat.inspected': '检查',
        'stat.blocked': '拦截',
        'stat.evidence': '证据',
        'stat.audited': '审计',
        'stat.flagged': '标记',
        'stat.corrected': '纠正',
        'stat.session': '本会话',
        'last': '最近',
        'rules.enabled': '生效规则',
        'hint.ruleOff': '该层的主规则已在配置中豁免，请在配置里移除 dispensation 后生效。',
        'foot.note': '两层共用一个证据缓存：DOL 管"说什么"，Sentinel 管"做什么"。',
        'action.reset': '清零统计',
        'loading': '正在读取宿主状态…',
        'error.host': '读取宿主状态失败（插件可能未启用或路由不可达）',
      },
      en: {
        locale: 'en',
        'trigger.title': 'Interception layers: DOL communication semantics · Sentinel tool execution',
        'panel.title': 'Agent Governor · two layers',
        'panel.subtitle': 'Every statement backed, every action checkable',
        'help.layer': 'Layer details',
        'help.global': 'About and counters',
        'metric.blocked': 'blocked',
        'metric.flagged': 'flagged',
        'switch.on': 'ON',
        'switch.off': 'OFF',
        'log.open': 'Interception record (which step, and why)',
        'log.title': 'Interception record',
        'log.filter.all': 'All',
        'log.filter.sentinel': 'Tool blocks',
        'log.filter.dol': 'Output flags',
        'log.clear': 'Clear',
        'log.empty': 'No interceptions recorded yet.',
        'log.step': 'step',
        'log.step.none': 'step n/a',
        'log.target': 'Target',
        'log.origin': 'Origin',
        'log.turn': 'turn',
        'log.rule': 'Rule',
        'rules.title': 'Rules',
        'rules.add': '+ Custom rule',
        'rules.builtin': 'built-in',
        'rules.pattern': 'Regex (tool rules match the call, output rules match the text)',
        'rules.message': 'Reason shown when it hits',
        'rules.prohibition': 'Prohibition',
        'rules.obligation': 'Obligation',
        'rules.save': 'Save',
        'rules.cancel': 'Cancel',
        'rules.remove': 'Remove this custom rule',
        'guard.title': 'Delete guard',
        'guard.watch': 'Watch',
        'guard.block': 'Block',
        'guard.strict': 'Strict',
        'guard.hint.watch': 'Watch: record only, never block a delete',
        'guard.hint.block': 'Block: refuse an unrequested forced recursive delete (default)',
        'guard.hint.strict': 'Strict: refuse single-file deletes too (your own artifacts stay removable)',
        'guard.hint.off': 'Off: deletions are not checked',
        'guard.chip.watch': 'delete: watch',
        'guard.chip.block': 'delete: block',
        'guard.chip.strict': 'delete: strict',
        'guard.chip.off': 'delete: off',
        'tag.scope': 'Scope',
        'dol.name': 'DOL layer · communication semantics',
        'dol.desc': 'Audits "what is said" at the communication edge: completion claims with no tool evidence, credential leaks, and absolute promises are flagged and the correction is pushed into the next step.',
        'sentinel.name': 'Sentinel layer · tool execution',
        'sentinel.desc': 'Gates "what is done" before dispatch, using the evidence cache: destructive commands and ungrounded numeric arguments are denied with structured retry feedback.',
        'tag.tool': 'tool call',
        'tag.speech': 'message / output',
        'tag.shadow': 'shadow',
        'layer.enable': 'Enable this layer',
        'layer.shadow': 'Shadow mode (record only, never block)',
        'stat.inspected': 'checked',
        'stat.blocked': 'blocked',
        'stat.evidence': 'evidence',
        'stat.audited': 'audited',
        'stat.flagged': 'flagged',
        'stat.corrected': 'corrected',
        'stat.session': 'this session',
        'last': 'last',
        'rules.enabled': 'active rules',
        'hint.ruleOff': 'This layer’s main rule is dispensed in the profile config; remove the dispensation to activate it.',
        'foot.note': 'Both layers share one evidence cache: DOL governs what is said, Sentinel what is done.',
        'action.reset': 'Reset counters',
        'loading': 'Reading host state…',
        'error.host': 'Could not read host state (plugin not enabled, or route unreachable)',
      },
    };

    const NS = 'agent-governor';

    return {
      name: '@kxdyh/dsh-agent-governor',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'agent-governor: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = '@kxdyh/dsh-agent-governor';
          style.dataset.pluginCss = CSS_TAG;
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            style.remove();
          };
        }, 'agent-governor: stylesheet');

        /**
         * Contribute one seat. Every occupant needs `inject` to receive the
         * translator: `t` is not a standard slot prop, and a registration
         * without it renders an exception instead of a control. Registration
         * failures are reported rather than swallowed.
         */
        const contribute = (key, register) => {
          ctx.effect(() => {
            try {
              return ctx.slots.inject(key, () => {
                try {
                  return register();
                } catch (error) {
                  reportDiag('error', { seat: key, message: String(error?.message ?? error) });
                  return () => {};
                }
              });
            } catch (error) {
              reportDiag('error', { seat: key, message: String(error?.message ?? error) });
              return () => {};
            }
          }, `agent-governor: ${key}`);
        };

        // The header seat the user pointed at: right-aligned Session utilities.
        contribute('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'agent-governor',
              order: -20,
              label: () => t('panel.title'),
              inject: () => ({ t }),
            },
            seat(Trigger, 'header-utilities'),
          ),
        );

        // The public record button, right beside the shield.
        contribute('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'agent-governor-log',
              order: -19,
              label: () => t('log.title'),
              inject: () => ({ t }),
            },
            seat(LogTrigger, 'header-log'),
          ),
        );

        // In-flow rescue seat: the only header slot that exists without a
        // Session. Stays empty unless the overlay probe proved unusable.
        contribute('conversation.header.leading', () =>
          ctx.slots.register({ name: 'conversation.header.leading', inject: () => ({ t }) }, seat(HeaderRescueTrigger, 'header-leading')),
        );

        // Frame overlay: both popovers, plus the pair of triggers for the
        // no-Session Hero state.
        contribute('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'agent-governor-panel', order: 201, inject: () => ({ t }) },
            seat(Panel, 'overlay-panel'),
          ),
        );
        contribute('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'agent-governor-log-panel', order: 202, inject: () => ({ t }) },
            seat(LogPanel, 'overlay-log'),
          ),
        );
        contribute('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'agent-governor-fallback', order: 190, inject: () => ({ t }) },
            seat(OverlayTrigger, 'overlay-trigger'),
          ),
        );
      },
    };
  },
});
