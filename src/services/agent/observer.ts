export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentElement {
  id: string;
  tag: string;
  role: string;
  type?: string;
  name?: string;
  text: string;
  placeholder?: string;
  ariaLabel?: string;
  value?: string;
  href?: string;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  rect?: ElementRect;
}

export interface AgentObservation {
  url: string;
  title: string;
  text: string;
  elements: AgentElement[];
}

/** Runs in the child native webview. Returns a rich, compact DOM snapshot with aria-agent-id attributes. */
export const observationScript = `
  (function () {
    try {
      document.querySelectorAll('[aria-agent-id]').forEach(function (el) { el.removeAttribute('aria-agent-id'); });
      var selector = 'button,a,input,textarea,select,option,checkbox,radio,combobox,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[contenteditable="true"]';
      var elements = [];
      Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) {
        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
        var id = 'e' + (elements.length + 1);
        el.setAttribute('aria-agent-id', id);
        
        var ariaLabel = el.getAttribute('aria-label') || undefined;
        var nameText = (ariaLabel || el.getAttribute('name') || el.title || el.innerText || el.textContent || el.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        var textContent = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160);
        var val = typeof el.value === 'string' ? el.value : (el.isContentEditable ? el.textContent || '' : undefined);

        elements.push({
          id: id,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          type: el.type || undefined,
          name: nameText || undefined,
          text: textContent,
          placeholder: el.placeholder || undefined,
          ariaLabel: ariaLabel,
          value: val !== undefined ? val.slice(0, 200) : undefined,
          href: el.href || undefined,
          visible: true,
          enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
          checked: typeof el.checked === 'boolean' ? el.checked : undefined,
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        });
      });
      var snapshot = {
        url: location.href,
        title: document.title,
        text: (document.body && document.body.innerText || '').trim().slice(0, 6000),
        elements: elements.slice(0, 120)
      };
      location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('ARIA_AGENT_OBSERVATION:' + JSON.stringify(snapshot));
    } catch (error) {
      location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('ARIA_AGENT_OBSERVATION_ERROR:' + String(error));
    }
  })();
`;


