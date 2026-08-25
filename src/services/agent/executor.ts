import { AgentAction } from './actions';
import { ElementRect } from './observer';

export interface ActionResult {
  success: boolean;
  action: AgentAction['action'];
  element_id?: string;
  error?: string;
}

export function buildExecutionScript(
  action: AgentAction | any,
  targetRect?: ElementRect
): string {
  const payload = JSON.stringify(action);
  const rectPayload = JSON.stringify(targetRect || null);
  return `
(function() {
  try {
    var rawAction = ${payload};
    var targetRect = ${rectPayload};

    var actionType = rawAction.type || rawAction.action;
    var elementId = rawAction.elementId || rawAction.element_id;
    var textToType = rawAction.text || '';
    var key = rawAction.key || 'Enter';
    var value = rawAction.value || '';
    var direction = rawAction.direction || 'down';
    var amount = rawAction.amount || 500;

    console.log('[ARIA_EXEC] START action=' + actionType + ' elementId=' + elementId);

    // --- Inject In-Page CSS Animation Styles if needed ---
    if (!document.getElementById('aria-inpage-styles')) {
      var styleEl = document.createElement('style');
      styleEl.id = 'aria-inpage-styles';
      styleEl.textContent = \`
        @keyframes ariaCursorPulse {
          0% { transform: scale(1); box-shadow: 0 0 8px #22d3ee; }
          50% { transform: scale(1.3); box-shadow: 0 0 16px #38bdf8, 0 0 24px #818cf8; }
          100% { transform: scale(1); box-shadow: 0 0 8px #22d3ee; }
        }
        @keyframes ariaRippleWave {
          0% { transform: scale(0.2); opacity: 1; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes ariaGlowOutline {
          0%, 100% { box-shadow: 0 0 12px rgba(168,85,247,0.7), inset 0 0 6px rgba(168,85,247,0.3); }
          50% { box-shadow: 0 0 20px rgba(168,85,247,0.95), inset 0 0 12px rgba(168,85,247,0.5); }
        }
        @keyframes ariaBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      \`;
      document.head.appendChild(styleEl);
    }

    // --- Shared Safe Chunked IPC Transport ---
    var sendIpc = function(payload) {
      try {
        var rawStr = String(payload);
        var CHUNK_SIZE = 1000;
        var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
        var msgId = 'msg_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

        if (total === 1 && rawStr.length < 1500) {
          location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(rawStr);
          return;
        }

        for (var i = 0; i < total; i++) {
          (function(idx) {
            setTimeout(function() {
              var slice = rawStr.substring(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
              var chunkUrl = 'https://tauri-ipc-bridge/chunk?id=' + encodeURIComponent(msgId) +
                             '&index=' + idx +
                             '&total=' + total +
                             '&data=' + encodeURIComponent(slice);
              location.href = chunkUrl;
            }, idx * 25);
          })(i);
        }
      } catch(e) {}
    };

    // --- IPC result reporter ---
    var result = function(data) {
      try { window.__ARIA_AGENT_RESULT__ = data; } catch(e) {}
      var payloadStr = JSON.stringify(data);
      console.log('[ARIA_EXEC] RESULT_READY payload=' + payloadStr);
      sendIpc('ARIA_AGENT_RESULT:' + payloadStr);
    };

    // 1. Resolve Target Element
    var el = null;
    if (elementId) {
      el = document.querySelector('[aria-agent-id="' + elementId + '"]');
    }

    // Fallback 1: Geometric Center Point Query
    if (!el && targetRect && typeof targetRect.x === 'number' && typeof targetRect.y === 'number') {
      var cx = Math.round(targetRect.x + (targetRect.width || 0) / 2);
      var cy = Math.round(targetRect.y + (targetRect.height || 0) / 2);
      if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
        el = document.elementFromPoint(cx, cy);
      }
    }

    // Fallback 2: Candidate search by element_id attribute
    if (!el && elementId) {
      var candidates = document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="searchbox"]');
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].getAttribute('aria-agent-id') === elementId) {
          el = candidates[i];
          break;
        }
      }
    }

    if (!el && ['click', 'type', 'type_and_submit', 'press', 'select'].includes(actionType)) {
      throw new Error('Element not found in DOM or at coordinates for action: ' + actionType + ' (id: ' + elementId + ')');
    }

    if (el && (el.disabled || el.getAttribute('aria-disabled') === 'true')) {
      throw new Error('Element ' + elementId + ' is disabled');
    }

    // Ensure element is visible in viewport
    if (el) {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch(e) {}
    }

    // Calculate center coordinates
    var rect = el ? el.getBoundingClientRect() : null;
    var clientX = rect ? Math.round(rect.left + rect.width / 2) : (targetRect ? Math.round(targetRect.x + targetRect.width / 2) : Math.round(window.innerWidth / 2));
    var clientY = rect ? Math.round(rect.top + rect.height / 2) : (targetRect ? Math.round(targetRect.y + targetRect.height / 2) : Math.round(window.innerHeight / 3));

    // Retrieve previous cursor coordinates for smooth gliding
    var prevPos = window.__ARIA_AGENT_CURSOR_POS__ || { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
    window.__ARIA_AGENT_CURSOR_POS__ = { x: clientX, y: clientY };

    // --- IN-PAGE LIVE AGENT VISUAL OVERLAY ENGINE (NON-BLOCKING) ---
    var renderInPageCursor = function(badgeText, actionIcon) {
      try {
        var cursorEl = document.getElementById('aria-inpage-agent-cursor');
        if (!cursorEl) {
          cursorEl = document.createElement('div');
          cursorEl.id = 'aria-inpage-agent-cursor';
          cursorEl.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;transform:translate(' + prevPos.x + 'px, ' + prevPos.y + 'px);transition:transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1);will-change:transform;';
          
          cursorEl.innerHTML = \`
            <div style="position:relative;display:flex;align-items:flex-start;">
              <!-- Custom SVG Pointer -->
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="filter:drop-shadow(0 3px 8px rgba(0,0,0,0.85));">
                <path d="M3 3L10.07 20.97L13.58 13.58L20.97 10.07L3 3Z" fill="url(#aria-cursor-grad)" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round" />
                <defs>
                  <linearGradient id="aria-cursor-grad" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                    <stop stop-color="#8b5cf6" />
                    <stop offset="1" stop-color="#06b6d4" />
                  </linearGradient>
                </defs>
              </svg>
              <!-- Glowing Pulse Node on Tip -->
              <div style="position:absolute;top:-2px;left:-2px;width:7px;height:7px;border-radius:50%;background:#22d3ee;box-shadow:0 0 10px #22d3ee;animation:ariaCursorPulse 1.2s infinite ease-in-out;"></div>
              
              <!-- Floating Live Action Pill Badge -->
              <div id="aria-cursor-badge" style="margin-left:14px;margin-top:2px;background:rgba(15,23,42,0.94);color:#f8fafc;border:1.5px solid rgba(168,85,247,0.8);border-radius:8px;padding:4px 10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,0.7),0 0 12px rgba(168,85,247,0.4);backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;transition:all 0.2s ease;">
                <span id="aria-badge-icon" style="font-size:12px;">\${actionIcon || '⚡'}</span>
                <span id="aria-badge-text">\${badgeText || 'ARIA Agent'}</span>
              </div>
            </div>
          \`;
          document.body.appendChild(cursorEl);
        } else {
          var badgeEl = document.getElementById('aria-badge-text');
          var iconEl = document.getElementById('aria-badge-icon');
          if (badgeEl) badgeEl.textContent = badgeText || 'ARIA Agent';
          if (iconEl) iconEl.textContent = actionIcon || '⚡';
        }

        // Animate cursor to target position asynchronously
        requestAnimationFrame(function() {
          if (cursorEl) {
            cursorEl.style.transform = 'translate(' + (clientX - 2) + 'px, ' + (clientY - 2) + 'px)';
          }
        });

        // Target Element Highlight Box
        if (el && rect) {
          var hl = document.getElementById('aria-inpage-highlight');
          if (!hl) {
            hl = document.createElement('div');
            hl.id = 'aria-inpage-highlight';
            hl.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #a855f7;border-radius:6px;animation:ariaGlowOutline 1.5s infinite ease-in-out;transition:all 0.2s ease-out;';
            document.body.appendChild(hl);
          }
          hl.style.left = Math.max(0, rect.left - 3) + 'px';
          hl.style.top = Math.max(0, rect.top - 3) + 'px';
          hl.style.width = (rect.width + 6) + 'px';
          hl.style.height = (rect.height + 6) + 'px';
          hl.style.opacity = '1';
        }
      } catch(err) {}
    };

    // Helper: Trigger Click Ripple
    var triggerClickRipple = function(x, y) {
      try {
        var ripple = document.createElement('div');
        ripple.style.cssText = 'position:fixed;left:' + (x - 20) + 'px;top:' + (y - 20) + 'px;width:40px;height:40px;border-radius:50%;background:rgba(168,85,247,0.5);border:2px solid #c084fc;box-shadow:0 0 16px #a855f7;z-index:2147483647;pointer-events:none;animation:ariaRippleWave 0.45s ease-out forwards;';
        document.body.appendChild(ripple);
        setTimeout(function() { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 500);
      } catch(e) {}
    };

    // Fast, framework-compatible value setter
    var applyInputValue = function(targetEl, text) {
      if (!targetEl) return;
      if (typeof targetEl.focus === 'function') {
        try { targetEl.focus({ preventScroll: true }); } catch(e) {}
      }

      var isContentEditable = targetEl.isContentEditable;
      var isTextArea = targetEl instanceof HTMLTextAreaElement;
      var proto = isTextArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');

      if (isContentEditable) {
        targetEl.textContent = text;
      } else if (descriptor && descriptor.set) {
        descriptor.set.call(targetEl, text);
      } else {
        targetEl.value = text;
      }

      try {
        targetEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text }));
      } catch(e) {
        try { targetEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true })); } catch(err) {}
      }
      try { targetEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true })); } catch(e) {}
    };

    // Helper: Submit Search or Form
    var submitSearchElement = function(targetEl) {
      if (!targetEl) return;
      var keyInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };

      try { targetEl.dispatchEvent(new KeyboardEvent('keydown', keyInit)); } catch(e) {}
      try { targetEl.dispatchEvent(new KeyboardEvent('keypress', keyInit)); } catch(e) {}
      try { targetEl.dispatchEvent(new KeyboardEvent('keyup', keyInit)); } catch(e) {}

      var form = targetEl.form || (targetEl.tagName === 'FORM' ? targetEl : (targetEl.closest ? targetEl.closest('form') : null));
      if (form) {
        try {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else if (typeof form.submit === 'function') {
            form.submit();
          }
        } catch(e) {}
      }

      // Adjacent search button click fallback
      var searchBtn = document.querySelector('#search-icon-legacy, button[aria-label="Search"], button[aria-label="search"], button[type="submit"], input[type="submit"]');
      if (searchBtn && typeof searchBtn.click === 'function') {
        try { searchBtn.click(); } catch(e) {}
      }

      // YouTube specific search redirection
      if (location.hostname.includes('youtube.com') && targetEl && (targetEl.id === 'search' || targetEl.name === 'search_query')) {
        var q = targetEl.value;
        if (q) {
          setTimeout(function() {
            if (!location.href.includes('/results?search_query=')) {
              location.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
            }
          }, 100);
        }
      }
    };

    var eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      screenX: clientX,
      screenY: clientY,
      clientX: clientX,
      clientY: clientY,
      button: 0,
      buttons: 1
    };

    var targetName = el ? (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.name || el.tagName).trim().slice(0, 28) : (elementId || '');

    // 2. Execute Action Types with Fast DOM Execution & Non-blocking Visuals
    switch (actionType) {
      case 'click': {
        renderInPageCursor('Clicking ' + (targetName || 'element'), '🖱️');
        if (el) {
          if (typeof el.focus === 'function') {
            try { el.focus({ preventScroll: true }); } catch(e) {}
          }
          triggerClickRipple(clientX, clientY);

          // Dispatch full synthetic event stream
          if (window.PointerEvent) {
            try { el.dispatchEvent(new PointerEvent('pointerdown', eventInit)); } catch(e) {}
          }
          try { el.dispatchEvent(new MouseEvent('mousedown', eventInit)); } catch(e) {}
          
          var upInit = Object.assign({}, eventInit, { buttons: 0 });
          if (window.PointerEvent) {
            try { el.dispatchEvent(new PointerEvent('pointerup', upInit)); } catch(e) {}
          }
          try { el.dispatchEvent(new MouseEvent('mouseup', upInit)); } catch(e) {}
          try { el.dispatchEvent(new MouseEvent('click', upInit)); } catch(e) {}

          if (typeof el.click === 'function') {
            try { el.click(); } catch(e) {}
          }

          // Ensure radio/checkbox state is updated and dispatches change/input events
          var inputTarget = el;
          if (el.tagName === 'LABEL') {
            if (el.htmlFor) {
              try {
                var boundInput = document.getElementById(el.htmlFor);
                if (boundInput) inputTarget = boundInput;
              } catch(e) {}
            } else {
              var nestedInput = el.querySelector('input');
              if (nestedInput) inputTarget = nestedInput;
            }
          }
          if (inputTarget && inputTarget.tagName === 'INPUT') {
            var iType = inputTarget.type ? inputTarget.type.toLowerCase() : '';
            if (iType === 'radio') {
              inputTarget.checked = true;
              try { inputTarget.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
              try { inputTarget.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
            } else if (iType === 'checkbox') {
              try { inputTarget.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
              try { inputTarget.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
            }
          }

          // If it is a link with href, trigger navigation fallback
          var href = el.href || el.getAttribute('href');
          if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
            try {
              if (href.startsWith('/')) href = location.origin + href;
              setTimeout(function() {
                if (location.href !== href && !location.href.includes(href)) {
                  location.href = href;
                }
              }, 120);
            } catch(e) {}
          }
        }
        result({ success: true, action: 'click', element_id: elementId, elementId: elementId });
        break;
      }

      case 'type': {
        renderInPageCursor('Typing: "' + textToType.slice(0, 22) + '"', '⌨️');
        if (!el) {
          result({ success: false, action: 'type', error: 'Target element missing for type action' });
          return;
        }

        applyInputValue(el, textToType);
        result({ success: true, action: 'type', element_id: elementId, elementId: elementId });
        break;
      }

      case 'type_and_submit': {
        renderInPageCursor('Searching: "' + textToType.slice(0, 22) + '" ↵', '🔍');
        if (!el) {
          result({ success: false, action: 'type_and_submit', error: 'Target element missing for type_and_submit action' });
          return;
        }

        applyInputValue(el, textToType);
        submitSearchElement(el);
        result({ success: true, action: 'type_and_submit', element_id: elementId, elementId: elementId });
        break;
      }

      case 'press': {
        var keyName = key === 'ENTER' ? 'Enter' : key;
        renderInPageCursor('Pressing [' + keyName + ' ↵]', '↵');
        var targetNode = el || (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);

        if (typeof targetNode.focus === 'function') {
          try { targetNode.focus({ preventScroll: true }); } catch(e) {}
        }

        if (keyName === 'Enter') {
          submitSearchElement(targetNode);
        } else {
          var keyCode = 0;
          var keyInit = { key: keyName, code: keyName, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
          try { targetNode.dispatchEvent(new KeyboardEvent('keydown', keyInit)); } catch(e) {}
          try { targetNode.dispatchEvent(new KeyboardEvent('keypress', keyInit)); } catch(e) {}
          try { targetNode.dispatchEvent(new KeyboardEvent('keyup', keyInit)); } catch(e) {}
        }

        result({ success: true, action: 'press', element_id: elementId, elementId: elementId });
        break;
      }

      case 'select': {
        renderInPageCursor('Selecting option: ' + value, '📋');
        if (!el || !(el instanceof HTMLSelectElement)) {
          result({ success: false, action: 'select', error: 'Target element is not a select element' });
          return;
        }
        var protoSel = window.HTMLSelectElement.prototype;
        var descSel = Object.getOwnPropertyDescriptor(protoSel, 'value');
        if (descSel && descSel.set) {
          descSel.set.call(el, value);
        } else {
          el.value = value;
        }
        try {
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
        } catch(e) {}
        result({ success: true, action: 'select', element_id: elementId, elementId: elementId });
        break;
      }

      case 'scroll': {
        renderInPageCursor('Scrolling ' + direction, direction === 'up' ? '⬆' : '⬇');
        var scrollY = (direction === 'up' ? -1 : 1) * amount;
        if (el && typeof el.scrollBy === 'function') {
          try { el.scrollBy({ top: scrollY, behavior: 'instant' }); } catch(e) {}
        } else {
          try { window.scrollBy({ top: scrollY, behavior: 'instant' }); } catch(e) {}
          if (document.scrollingElement && typeof document.scrollingElement.scrollBy === 'function') {
            try { document.scrollingElement.scrollBy({ top: scrollY, behavior: 'instant' }); } catch(e) {}
          }
        }
        result({ success: true, action: 'scroll' });
        break;
      }

      default: {
        renderInPageCursor('Executing ' + actionType, '⚡');
        result({ success: true, action: actionType });
        break;
      }
    }
  } catch (err) {
    var errorMsg = String(err && err.message ? err.message : err);
    console.log('[ARIA_EXEC] ERROR ' + errorMsg);
    var payloadStr = JSON.stringify({
      success: false,
      action: typeof rawAction !== 'undefined' && rawAction ? (rawAction.action || rawAction.type || 'unknown') : 'unknown',
      error: errorMsg
    });
    try { window.__ARIA_AGENT_RESULT__ = JSON.parse(payloadStr); } catch(e) {}
    sendIpc('ARIA_AGENT_RESULT:' + payloadStr);
  }
})();
  `;
}

export const executionScript = buildExecutionScript;
