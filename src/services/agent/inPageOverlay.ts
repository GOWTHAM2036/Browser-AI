
/**
 * Generates JavaScript code to be injected into the child webview DOM
 * to render and animate the ARIA AI Agent cursor, target highlights,
 * click ripples, live typing indicators, and status badges.
 */

export function getInPageStatusScript(
  statusText: string,
  stepNumber?: number,
  executionState: 'running' | 'pausing' | 'paused' | 'stopping' = 'running'
): string {
  const safeText = JSON.stringify(statusText);
  const stepStr = stepNumber ? `Step ${stepNumber} · ` : '';
  const isPaused = executionState === 'paused';
  const isPausing = executionState === 'pausing';
  const isStopping = executionState === 'stopping';

  const dotColor = isPaused || isPausing ? '#f59e0b' : isStopping ? '#ef4444' : '#a855f7';
  const dotShadow = isPaused || isPausing ? '#fbbf24' : isStopping ? '#f87171' : '#c084fc';
  const borderColor = isPaused || isPausing ? 'rgba(245,158,11,0.7)' : isStopping ? 'rgba(239,68,68,0.7)' : 'rgba(168,85,247,0.7)';
  const labelColor = isPaused || isPausing ? '#fbbf24' : isStopping ? '#f87171' : '#c084fc';
  const stateLabel = isPaused ? 'PAUSED' : isPausing ? 'PAUSING' : isStopping ? 'STOPPING' : 'ARIA AGENT';

  return `
    (function() {
      try {
        ${isPaused ? `
          var hl = document.getElementById('aria-inpage-highlight');
          if (hl && hl.parentNode) hl.parentNode.removeChild(hl);
          var cur = document.getElementById('aria-inpage-agent-cursor');
          if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
        ` : ''}
        var existing = document.getElementById('aria-inpage-status-badge');
        if (!existing) {
          existing = document.createElement('div');
          existing.id = 'aria-inpage-status-badge';
          existing.style.cssText = 'position:fixed;top:14px;right:18px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:7px 14px;background:rgba(15,23,42,0.92);color:#e2e8f0;border:1.5px solid ${borderColor};border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:11px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.6),0 0 14px ${dotShadow};backdrop-filter:blur(10px);pointer-events:none;transition:all 0.25s ease-out;';
          document.body.appendChild(existing);
        } else {
          existing.style.borderColor = '${borderColor}';
        }
        existing.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};box-shadow:0 0 8px ${dotShadow};${!isPaused ? 'animation:ariaPulse 1s infinite alternate;' : ''}"></span><span style="color:${labelColor};font-size:10px;font-weight:700;">${stateLabel}</span><span style="color:#64748b;">|</span><span style="color:#f1f5f9;">${stepStr}' + ${safeText} + '</span>';
      } catch(e) {}
    })();
  `;
}

export function getInPageInteractionBlockerScript(blocked: boolean): string {
  if (!blocked) {
    return `
      (function() {
        try {
          window.__ARIA_AGENT_USER_INPUT_BLOCKED__ = false;
          if (typeof window.__ARIA_RELEASE_INTERACTION_BLOCK__ === 'function') {
            window.__ARIA_RELEASE_INTERACTION_BLOCK__();
          }
          var lockStyle = document.getElementById('aria-inpage-lock-style');
          if (lockStyle && lockStyle.parentNode) {
            lockStyle.parentNode.removeChild(lockStyle);
          }
          if (document.body) {
            document.body.classList.remove('aria-interaction-locked');
          }
        } catch(e) {}
      })();
    `;
  }

  return `
    (function() {
      try {
        window.__ARIA_AGENT_USER_INPUT_BLOCKED__ = true;

        if (!document.getElementById('aria-inpage-lock-style')) {
          var styleEl = document.createElement('style');
          styleEl.id = 'aria-inpage-lock-style';
          styleEl.textContent = 'body.aria-interaction-locked * { cursor: progress !important; }';
          document.head.appendChild(styleEl);
        }
        if (document.body) {
          document.body.classList.add('aria-interaction-locked');
        }

        if (window.__ARIA_INTERACTION_BLOCKER_INITIALIZED__) {
          return;
        }
        window.__ARIA_INTERACTION_BLOCKER_INITIALIZED__ = true;

        if (typeof window.__ARIA_AGENT_DISPATCHING__ === 'undefined') {
          window.__ARIA_AGENT_DISPATCHING__ = false;
        }

        function shouldBlock(e) {
          if (!window.__ARIA_AGENT_USER_INPUT_BLOCKED__) return false;
          if (window.__ARIA_AGENT_DISPATCHING__) return false;
          // Synthetic events dispatched by ARIA agent have isTrusted === false
          if (e && e.isTrusted === false) return false;
          return true;
        }

        function blockEventHandler(e) {
          if (!shouldBlock(e)) return;
          try {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
          } catch(err) {}

          var badge = document.getElementById('aria-inpage-status-badge');
          if (badge) {
            badge.style.transform = 'scale(1.06)';
            badge.style.boxShadow = '0 0 24px rgba(245,158,11,0.95)';
            setTimeout(function() {
              if (badge) {
                badge.style.transform = 'scale(1)';
                badge.style.boxShadow = '';
              }
            }, 300);
          }
          return false;
        }

        var eventsToBlock = [
          'click', 'dblclick', 'auxclick', 'mousedown', 'mouseup',
          'pointerdown', 'pointerup', 'contextmenu',
          'keydown', 'keypress', 'keyup', 'beforeinput',
          'wheel', 'touchmove', 'dragstart', 'drop', 'submit'
        ];

        eventsToBlock.forEach(function(eventType) {
          window.addEventListener(eventType, blockEventHandler, { capture: true, passive: false });
        });

        window.addEventListener('selectstart', function(e) {
          if (shouldBlock(e)) {
            e.preventDefault();
            return false;
          }
        }, { capture: true });

        // Frame traversal: attach capture blocker to accessible iframes
        try {
          var iframes = document.querySelectorAll('iframe, frame');
          for (var f = 0; f < iframes.length; f++) {
            try {
              var fDoc = iframes[f].contentDocument || (iframes[f].contentWindow && iframes[f].contentWindow.document);
              if (fDoc) {
                eventsToBlock.forEach(function(ev) {
                  fDoc.addEventListener(ev, blockEventHandler, { capture: true, passive: false });
                });
              }
            } catch(eFrame) {}
          }
        } catch(eFrames) {}

        window.__ARIA_RELEASE_INTERACTION_BLOCK__ = function() {
          window.__ARIA_AGENT_USER_INPUT_BLOCKED__ = false;
          try {
            if (document.body) document.body.classList.remove('aria-interaction-locked');
            var lockSt = document.getElementById('aria-inpage-lock-style');
            if (lockSt && lockSt.parentNode) lockSt.parentNode.removeChild(lockSt);
          } catch(e) {}
        };
      } catch(e) {}
    })();
  `;
}

export function getInPageCleanupScript(): string {
  return `
    (function() {
      try {
        window.__ARIA_AGENT_USER_INPUT_BLOCKED__ = false;
        if (typeof window.__ARIA_RELEASE_INTERACTION_BLOCK__ === 'function') {
          try { window.__ARIA_RELEASE_INTERACTION_BLOCK__(); } catch(e) {}
        }
        var ids = ['aria-inpage-overlay-root', 'aria-inpage-status-badge', 'aria-inpage-highlight', 'aria-inpage-agent-cursor', 'aria-inpage-lock-style'];
        ids.forEach(function(id) {
          var el = document.getElementById(id);
          if (el && el.parentNode) {
            el.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';
            el.style.opacity = '0';
            setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
          }
        });
        if (document.body) {
          document.body.classList.remove('aria-interaction-locked');
        }
      } catch(e) {}
    })();
  `;
}

