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
    function sendIpc(payload) {
      try {
        var rawStr = String(payload);
        var CHUNK_SIZE = 600;
        var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
        var msgId = 'msg_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

        if (total === 1 && encodeURIComponent(rawStr).length < 1500) {
          console.log('[OBSERVE-IPC-SEND] messageId=' + msgId + ' payloadBytes=' + rawStr.length + ' transport=single');
          location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(rawStr);
          return;
        }

        console.log('[OBSERVE-IPC-SEND] messageId=' + msgId + ' payloadBytes=' + rawStr.length + ' transport=chunked total=' + total);
        for (var i = 0; i < total; i++) {
          (function(idx) {
            setTimeout(function() {
              var slice = rawStr.substring(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
              var encoded = encodeURIComponent(slice);
              console.log('[OBSERVE-IPC-CHUNK-SEND] messageId=' + msgId + ' index=' + idx + ' total=' + total + ' encodedBytes=' + encoded.length);
              var chunkUrl = 'https://tauri-ipc-bridge/chunk?id=' + encodeURIComponent(msgId) +
                             '&index=' + idx +
                             '&total=' + total +
                             '&data=' + encoded;
              location.href = chunkUrl;
            }, idx * 25);
          })(i);
        }
      } catch(e) {}
    }

    function extractSnapshot() {
      try {
        document.querySelectorAll('[aria-agent-id]').forEach(function (el) { el.removeAttribute('aria-agent-id'); });

        var isYouTube = location.hostname.includes('youtube.com');

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

        var selector = 'button,a,input,textarea,select,option,label,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="option"],[role="menuitem"],[contenteditable="true"]';
        var elements = [];
        var assignedMap = new Set();

        // 1. Insert prioritized video links first (if on YouTube)
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
          if (elements.length >= 200) break;
          var el = domNodes[i];
          if (assignedMap.has(el)) continue;

          var rect = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);

          // Filter out hidden or zero-dimension elements
          if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

          var tag = el.tagName.toLowerCase();
          var inputType = el.type ? el.type.toLowerCase() : '';
          var role = el.getAttribute('role') || tag;
          var isChecked = !!(el.checked || el.getAttribute('aria-checked') === 'true');

          // Find rich label text especially for radio buttons, checkboxes, and inputs
          var labelText = '';
          if (el.id) {
            try {
              var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
              if (lbl) labelText = (lbl.innerText || lbl.textContent || '').trim();
            } catch(e) {}
          }
          if (!labelText) {
            var parentLabel = el.closest ? el.closest('label') : null;
            if (parentLabel) {
              labelText = (parentLabel.innerText || parentLabel.textContent || '').trim();
            }
          }
          if (!labelText && (inputType === 'radio' || inputType === 'checkbox' || role === 'radio' || role === 'checkbox')) {
            if (el.nextElementSibling && (el.nextElementSibling.tagName === 'SPAN' || el.nextElementSibling.tagName === 'LABEL' || el.nextElementSibling.tagName === 'DIV')) {
              labelText = (el.nextElementSibling.innerText || el.nextElementSibling.textContent || '').trim();
            } else if (el.parentElement) {
              labelText = (el.parentElement.innerText || el.parentElement.textContent || '').trim();
            }
          }

          var ariaLabel = el.getAttribute('aria-label') || undefined;
          var rawName = labelText || ariaLabel || el.getAttribute('name') || el.title || el.placeholder || el.innerText || el.textContent || '';
          var nameText = rawName.trim().replace(/\\s+/g, ' ').slice(0, 120);
          var textContent = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
          var val = typeof el.value === 'string' ? el.value : (el.isContentEditable ? el.textContent || '' : undefined);
          var href = el.href || el.getAttribute('href') || undefined;
          if (href && href.startsWith('/')) href = location.origin + href;

          // Format specialized descriptions for MCQs, radio buttons, checkboxes, dropdowns
          if (inputType === 'radio' || role === 'radio') {
            role = 'radio';
            nameText = (isChecked ? '[Checked Radio] ' : '[Radio] ') + (nameText || val || 'Option');
          } else if (inputType === 'checkbox' || role === 'checkbox') {
            role = 'checkbox';
            nameText = (isChecked ? '[Checked Checkbox] ' : '[Checkbox] ') + (nameText || val || 'Option');
          } else if (tag === 'select') {
            role = 'select';
            var optTexts = [];
            for (var o = 0; o < el.options.length && o < 10; o++) {
              optTexts.push(el.options[o].value + ': ' + el.options[o].text.trim());
            }
            if (optTexts.length > 0) {
              nameText = (nameText ? nameText + ' ' : '') + '[Options: ' + optTexts.join(' | ') + ']';
            }
          } else if (tag === 'button' || role === 'button' || inputType === 'submit' || inputType === 'button') {
            role = 'button';
            if (!nameText.startsWith('[')) {
              nameText = '[Button] ' + nameText;
            }
          }

          if (href && (href.includes('/watch?v=') || href.includes('youtube.com/watch'))) {
            role = 'video_link';
            if (!nameText.toLowerCase().includes('video')) {
              nameText = '[Video] ' + nameText;
            }
          }

          var id = 'e' + (elements.length + 1);
          el.setAttribute('aria-agent-id', id);
          assignedMap.add(el);

          elements.push({
            id: id,
            tag: tag,
            role: role,
            type: inputType || undefined,
            name: nameText || undefined,
            text: textContent,
            placeholder: el.placeholder || undefined,
            ariaLabel: ariaLabel,
            value: val !== undefined ? val.slice(0, 100) : undefined,
            href: href ? href.slice(0, 150) : undefined,
            visible: true,
            enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
            checked: isChecked,
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
          text: (document.body && document.body.innerText || '').trim().slice(0, 4000),
          elements: elements
        };
        console.log('[OBSERVE-DOM-EXTRACTED] elementCount=' + elements.length);
        var serialized = 'ARIA_AGENT_OBSERVATION:' + JSON.stringify(snapshot);
        console.log('[OBSERVE-SERIALIZED] bytes=' + serialized.length);
        sendIpc(serialized);
      } catch (error) {
        sendIpc('ARIA_AGENT_OBSERVATION_ERROR:' + String(error));
      }
    }

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
    } else if (document.readyState === 'loading') {
      var fired = false;
      var onReady = function() {
        if (!fired) {
          fired = true;
          extractSnapshot();
        }
      };
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
      window.addEventListener('load', onReady, { once: true });
      setTimeout(onReady, 1000);
    } else {
      extractSnapshot();
    }
  })();
`;
