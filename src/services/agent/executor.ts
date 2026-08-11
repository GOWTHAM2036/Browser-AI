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

    // ---- IPC result reporter ----
    // CRITICAL FIX: Delay the location.href navigation by 50ms so that
    // all synchronous DOM event dispatching and framework state updates
    // complete before we trigger the IPC navigation. Without this delay,
    // the location.href fires immediately after event dispatch, which can
    // cancel/undo pending DOM events and tear down the page context on
    // WebView2 before the page has time to process the synthetic events.
    var result = function(data) {
      // Stash on window as fallback in case IPC navigation fails
      try { window.__ARIA_AGENT_RESULT__ = data; } catch(e) {}
      var payloadStr = JSON.stringify(data);
      console.log('[ARIA_EXEC] RESULT_READY payload=' + payloadStr);
      setTimeout(function() {
        console.log('[ARIA_EXEC] IPC_SEND via location.href');
        location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('ARIA_AGENT_RESULT:' + payloadStr);
      }, 50);
    };
    
    // 1. Resolve Target Element
    var el = null;
    if (elementId) {
      el = document.querySelector('[aria-agent-id="' + elementId + '"]');
      console.log('[ARIA_EXEC] SELECTOR_QUERY aria-agent-id="' + elementId + '" found=' + !!el);
    }
    
    // Fallback 1: Geometric Center Point Query
    if (!el && targetRect && typeof targetRect.x === 'number' && typeof targetRect.y === 'number') {
      var cx = Math.round(targetRect.x + (targetRect.width || 0) / 2);
      var cy = Math.round(targetRect.y + (targetRect.height || 0) / 2);
      if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
        el = document.elementFromPoint(cx, cy);
        console.log('[ARIA_EXEC] FALLBACK_GEOMETRIC cx=' + cx + ' cy=' + cy + ' found=' + !!el + ' tag=' + (el ? el.tagName : 'N/A'));
      }
    }

    // Fallback 2: Candidate search by element_id attribute
    if (!el && elementId) {
      var candidates = document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"]');
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].getAttribute('aria-agent-id') === elementId) {
          el = candidates[i];
          console.log('[ARIA_EXEC] FALLBACK_CANDIDATE found at index=' + i);
          break;
        }
      }
    }

    if (!el && ['click', 'type', 'press', 'select'].includes(actionType)) {
      throw new Error('Element not found in DOM or at coordinates for action: ' + actionType + ' (id: ' + elementId + ')');
    }

    if (el && (el.disabled || el.getAttribute('aria-disabled') === 'true')) {
      throw new Error('Element ' + elementId + ' is disabled');
    }

    console.log('[ARIA_EXEC] ELEMENT_RESOLVED tag=' + (el ? el.tagName : 'null') + ' action=' + actionType);

    // Calculate center coordinates for pointer events
    var rect = el ? el.getBoundingClientRect() : null;
    var clientX = rect ? Math.round(rect.left + rect.width / 2) : (targetRect ? Math.round(targetRect.x + targetRect.width / 2) : 0);
    var clientY = rect ? Math.round(rect.top + rect.height / 2) : (targetRect ? Math.round(targetRect.y + targetRect.height / 2) : 0);

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

    // Helper: Inject temporary visual feedback overlay into DOM
    var showVisualFeedback = function(type, x, y, targetEl) {
      try {
        if (type === 'click') {
          var ripple = document.createElement('div');
          ripple.style.cssText = 'position:fixed;left:' + (x - 16) + 'px;top:' + (y - 16) + 'px;width:32px;height:32px;border-radius:50%;background:rgba(168,85,247,0.7);border:2px solid #c084fc;box-shadow:0 0 15px #a855f7;z-index:2147483647;pointer-events:none;transform:scale(0.3);transition:transform 0.4s ease-out, opacity 0.4s ease-out;opacity:1;';
          document.body.appendChild(ripple);
          requestAnimationFrame(function() {
            ripple.style.transform = 'scale(1.8)';
            ripple.style.opacity = '0';
          });
          setTimeout(function() { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 450);
        } else if (type === 'type' && targetEl) {
          var r = targetEl.getBoundingClientRect();
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border:2px solid #3b82f6;box-shadow:0 0 12px rgba(59,130,246,0.8);border-radius:4px;z-index:2147483647;pointer-events:none;transition:all 0.4s ease-out;opacity:1;';
          document.body.appendChild(overlay);
          setTimeout(function() {
            overlay.style.opacity = '0';
            setTimeout(function() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
          }, 450);
        }
      } catch(e) {}
    };

    // 2. Execute Action Types
    switch (actionType) {
      case 'click': {
        if (el) {
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e) {}
          if (typeof el.focus === 'function') {
            try { el.focus({ preventScroll: true }); } catch(e) {}
          }
          showVisualFeedback('click', clientX, clientY, el);
          
          console.log('[ARIA_EXEC] CLICK_DISPATCH pointer+mouse events at (' + clientX + ',' + clientY + ')');
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
          console.log('[ARIA_EXEC] CLICK_COMPLETE element=' + elementId);
        }
        result({ success: true, action: 'click', element_id: elementId, elementId: elementId });
        break;
      }

      case 'type': {
        if (!el) throw new Error('Target element missing for type action');
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e) {}
        try { el.dispatchEvent(new Event('focus', { bubbles: true, cancelable: true, composed: true })); } catch(e) {}
        if (typeof el.focus === 'function') {
          try { el.focus({ preventScroll: true }); } catch(e) {}
        }

        showVisualFeedback('type', clientX, clientY, el);
        console.log('[ARIA_EXEC] TYPE_START text="' + textToType + '" isContentEditable=' + el.isContentEditable);

        if (el.isContentEditable) {
          el.textContent = textToType;
          try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: textToType }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
          } catch(e) {}
        } else {
          var isTextArea = el instanceof HTMLTextAreaElement;
          var proto = isTextArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');

          if (descriptor && descriptor.set) {
            descriptor.set.call(el, textToType);
            console.log('[ARIA_EXEC] TYPE_SETTER used native prototype descriptor');
          } else {
            el.value = textToType;
            console.log('[ARIA_EXEC] TYPE_SETTER used direct .value assignment');
          }

          try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: textToType }));
          } catch(e) {
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
          }

          try {
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
          } catch(e) {}
        }

        try { el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true, composed: true })); } catch(e) {}
        console.log('[ARIA_EXEC] TYPE_COMPLETE element=' + elementId + ' newValue="' + (el.value || el.textContent || '') + '"');
        result({ success: true, action: 'type', element_id: elementId, elementId: elementId });
        break;
      }

      case 'press': {
        var keyCode = key === 'ENTER' || key === 'Enter' ? 13 : 0;
        var keyName = key === 'ENTER' ? 'Enter' : key;
        var keyInit = { key: keyName, code: keyName === 'Enter' ? 'Enter' : keyName, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };

        var targetNode = el || (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);

        console.log('[ARIA_EXEC] PRESS_START key=' + keyName + ' targetTag=' + targetNode.tagName);

        if (typeof targetNode.focus === 'function') {
          try { targetNode.focus({ preventScroll: true }); } catch(e) {}
        }

        try { targetNode.dispatchEvent(new KeyboardEvent('keydown', keyInit)); } catch(e) {}
        try { targetNode.dispatchEvent(new KeyboardEvent('keypress', keyInit)); } catch(e) {}
        try { targetNode.dispatchEvent(new KeyboardEvent('keyup', keyInit)); } catch(e) {}

        if (keyName === 'Enter') {
          var form = targetNode.form || (targetNode.tagName === 'FORM' ? targetNode : (targetNode.closest ? targetNode.closest('form') : null));
          if (form) {
            console.log('[ARIA_EXEC] PRESS_FORM_SUBMIT formAction=' + (form.action || 'default'));
            try {
              if (typeof form.requestSubmit === 'function') {
                form.requestSubmit();
              } else if (typeof form.submit === 'function') {
                form.submit();
              }
            } catch(e) {
              console.log('[ARIA_EXEC] PRESS_FORM_SUBMIT_ERROR ' + e);
            }
          } else {
            console.log('[ARIA_EXEC] PRESS_NO_FORM found for Enter key');
          }
        }
        console.log('[ARIA_EXEC] PRESS_COMPLETE key=' + keyName);
        result({ success: true, action: 'press', element_id: elementId, elementId: elementId });
        break;
      }

      case 'select': {
        if (!el || !(el instanceof HTMLSelectElement)) {
          throw new Error('Target element is not a select element');
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
        console.log('[ARIA_EXEC] SELECT_COMPLETE element=' + elementId + ' value=' + value);
        result({ success: true, action: 'select', element_id: elementId, elementId: elementId });
        break;
      }

      case 'scroll': {
        var scrollY = (direction === 'up' ? -1 : 1) * amount;
        console.log('[ARIA_EXEC] SCROLL_START direction=' + direction + ' amount=' + amount);

        if (el && typeof el.scrollBy === 'function') {
          try { el.scrollBy({ top: scrollY, behavior: 'smooth' }); } catch(e) {}
        } else {
          try { window.scrollBy({ top: scrollY, behavior: 'smooth' }); } catch(e) {}
          if (document.scrollingElement && typeof document.scrollingElement.scrollBy === 'function') {
            try { document.scrollingElement.scrollBy({ top: scrollY, behavior: 'smooth' }); } catch(e) {}
          }
          if (document.documentElement && typeof document.documentElement.scrollBy === 'function') {
            try { document.documentElement.scrollBy({ top: scrollY, behavior: 'smooth' }); } catch(e) {}
          }
          if (document.body && typeof document.body.scrollBy === 'function') {
            try { document.body.scrollBy({ top: scrollY, behavior: 'smooth' }); } catch(e) {}
          }
        }
        console.log('[ARIA_EXEC] SCROLL_COMPLETE');
        result({ success: true, action: 'scroll' });
        break;
      }

      default:
        console.log('[ARIA_EXEC] DEFAULT_ACTION actionType=' + actionType);
        result({ success: true, action: actionType });
        break;
    }
  } catch (err) {
    var errorMsg = String(err && err.message ? err.message : err);
    console.log('[ARIA_EXEC] ERROR ' + errorMsg);
    var payloadStr = JSON.stringify({
      success: false,
      action: typeof rawAction !== 'undefined' && rawAction ? (rawAction.action || rawAction.type || 'unknown') : 'unknown',
      error: errorMsg
    });
    // Stash error result as fallback
    try { window.__ARIA_AGENT_RESULT__ = JSON.parse(payloadStr); } catch(e) {}
    // Same delayed IPC for errors
    setTimeout(function() {
      location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('ARIA_AGENT_RESULT:' + payloadStr);
    }, 50);
  }
})();
  `;
}

export const executionScript = buildExecutionScript;
