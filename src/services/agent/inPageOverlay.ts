
/**
 * Generates JavaScript code to be injected into the child webview DOM
 * to render and animate the ARIA AI Agent cursor, target highlights,
 * click ripples, live typing indicators, and status badges.
 */

export function getInPageStatusScript(statusText: string, stepNumber?: number): string {
  const safeText = JSON.stringify(statusText);
  const stepStr = stepNumber ? `Step ${stepNumber} · ` : '';
  return `
    (function() {
      try {
        var existing = document.getElementById('aria-inpage-status-badge');
        if (!existing) {
          existing = document.createElement('div');
          existing.id = 'aria-inpage-status-badge';
          existing.style.cssText = 'position:fixed;top:14px;right:18px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:7px 14px;background:rgba(15,23,42,0.92);color:#e2e8f0;border:1.5px solid rgba(168,85,247,0.7);border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:11px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.6),0 0 14px rgba(168,85,247,0.35);backdrop-filter:blur(10px);pointer-events:none;transition:all 0.25s ease-out;';
          document.body.appendChild(existing);
        }
        existing.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#a855f7;box-shadow:0 0 8px #c084fc;animation:ariaPulse 1s infinite alternate;"></span><span style="color:#c084fc;font-size:10px;font-weight:700;">ARIA AGENT</span><span style="color:#64748b;">|</span><span style="color:#f1f5f9;">${stepStr}' + ${safeText} + '</span>';
      } catch(e) {}
    })();
  `;
}

export function getInPageCleanupScript(): string {
  return `
    (function() {
      try {
        var ids = ['aria-inpage-overlay-root', 'aria-inpage-status-badge', 'aria-inpage-highlight', 'aria-inpage-agent-cursor'];
        ids.forEach(function(id) {
          var el = document.getElementById(id);
          if (el && el.parentNode) {
            el.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';
            el.style.opacity = '0';
            setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 450);
          }
        });
      } catch(e) {}
    })();
  `;
}
