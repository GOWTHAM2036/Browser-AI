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
    function extractSnapshot() {
      try {
        document.querySelectorAll('[aria-agent-id]').forEach(function (el) { el.removeAttribute('aria-agent-id'); });

        var isYouTube = location.hostname.includes('youtube.com');
        var isYouTubeResults = isYouTube && location.href.includes('results');

        // Extract video links first with high priority
        var videoLinks = [];
        if (isYouTube) {
          var vNodes = document.querySelectorAll('a[href*="/watch?v="], a[href*="watch?v="], a#video-title, ytd-video-renderer a, yt-lockup-view-model a');
          for (var v = 0; v < vNodes.length; v++) {
            var vEl = vNodes[v];
            var vHref = vEl.href || vEl.getAttribute('href') || '';
            if (!vHref || !vHref.includes('watch?v=')) continue;
            var vRect = vEl.getBoundingClientRect();
            if (vRect.width > 0 && vRect.height > 0) {
              var vAria = vEl.getAttribute('aria-label') || '';
              var vTitle = vEl.getAttribute('title') || vEl.innerText || vEl.textContent || '';
              var vName = (vAria || vTitle).trim().replace(/\\s+/g, ' ').slice(0, 100);
              if (vName && !videoLinks.some(function(item) { return item.href === vHref; })) {
                videoLinks.push({
                  el: vEl,
                  name: '[Video] ' + vName,
                  href: vHref.startsWith('/') ? location.origin + vHref : vHref,
                  rect: vRect
                });
              }
            }
          }
        }

        var selector = 'button,a,input,textarea,select,option,checkbox,radio,combobox,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[contenteditable="true"]';
        var elements = [];
        var assignedMap = new Set();

        // 1. Insert prioritized video links first
        for (var vl = 0; vl < videoLinks.length && elements.length < 30; vl++) {
          var vItem = videoLinks[vl];
          var vId = 'e' + (elements.length + 1);
          vItem.el.setAttribute('aria-agent-id', vId);
          assignedMap.add(vItem.el);
          elements.push({
            id: vId,
            tag: 'a',
            role: 'video_link',
            name: vItem.name,
            text: vItem.name,
            href: vItem.href,
            visible: true,
            enabled: true,
            rect: {
              x: Math.round(vItem.rect.left),
              y: Math.round(vItem.rect.top),
              width: Math.round(vItem.rect.width),
              height: Math.round(vItem.rect.height)
            }
          });
        }

        // 2. Insert other interactive elements
        var domNodes = document.querySelectorAll(selector);
        for (var i = 0; i < domNodes.length; i++) {
          if (elements.length >= 80) break;
          var el = domNodes[i];
          if (assignedMap.has(el)) continue;

          var rect = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);

          // Filter out hidden or zero-dimension elements
          if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

          var id = 'e' + (elements.length + 1);
          el.setAttribute('aria-agent-id', id);
          
          var ariaLabel = el.getAttribute('aria-label') || undefined;
          var rawName = ariaLabel || el.getAttribute('name') || el.title || el.placeholder || el.innerText || el.textContent || '';
          var nameText = rawName.trim().replace(/\\s+/g, ' ').slice(0, 100);
          var textContent = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
          var val = typeof el.value === 'string' ? el.value : (el.isContentEditable ? el.textContent || '' : undefined);
          var href = el.href || el.getAttribute('href') || undefined;
          if (href && href.startsWith('/')) href = location.origin + href;

          var role = el.getAttribute('role') || el.tagName.toLowerCase();
          if (href && (href.includes('/watch?v=') || href.includes('youtube.com/watch'))) {
            role = 'video_link';
            if (!nameText.toLowerCase().includes('video')) {
              nameText = '[Video] ' + nameText;
            }
          }

          elements.push({
            id: id,
            tag: el.tagName.toLowerCase(),
            role: role,
            type: el.type || undefined,
            name: nameText || undefined,
            text: textContent,
            placeholder: el.placeholder || undefined,
            ariaLabel: ariaLabel,
            value: val !== undefined ? val.slice(0, 100) : undefined,
            href: href ? href.slice(0, 150) : undefined,
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
        }

        var snapshot = {
          url: location.href,
          title: document.title || 'Untitled',
          text: (document.body && document.body.innerText || '').trim().slice(0, 2000),
          elements: elements
        };

        location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('ARIA_AGENT_OBSERVATION:' + JSON.stringify(snapshot));
      } catch (error) {
        location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent('ARIA_AGENT_OBSERVATION_ERROR:' + String(error));
      }
    }

    // If on YouTube search results, ensure video cards have rendered before capturing
    var isYouTubeResults = location.hostname.includes('youtube.com') && location.href.includes('results');
    if (isYouTubeResults && document.querySelectorAll('a[href*="/watch?v="], a#video-title').length === 0) {
      var attempts = 0;
      var checkInterval = setInterval(function() {
        attempts++;
        if (document.querySelectorAll('a[href*="/watch?v="], a#video-title').length > 0 || attempts >= 8) {
          clearInterval(checkInterval);
          extractSnapshot();
        }
      }, 150);
    } else {
      extractSnapshot();
    }
  })();
`;
