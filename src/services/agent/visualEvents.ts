import { useAgentCursorStore, TargetHighlightRect, AgentCursorAction } from '../../store/agentCursorStore';
import { ElementRect } from './observer';

export type VisualActionType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'press'
  | 'select'
  | 'scroll'
  | 'wait';

export interface AgentActionVisualEvent {
  action: VisualActionType;
  elementId?: string;
  label?: string;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  rect?: ElementRect;
  timestamp: number;
}

let completionTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Retrieves the bounding rectangle of the active native webview container
 * in React application window coordinates.
 */
export function getWebviewContainerBounds(): DOMRect | null {
  const el = document.getElementById('aria-webview-container');
  if (el) {
    return el.getBoundingClientRect();
  }
  return null;
}

/**
 * Converts webview-relative element coordinates to React application window coordinates.
 */
export function convertWebviewToAppCoordinates(
  domRect?: ElementRect
): {
  cursorX: number;
  cursorY: number;
  highlightRect: TargetHighlightRect | null;
} {
  const container = getWebviewContainerBounds();
  const baseLeft = container ? container.left : 0;
  const baseTop = container ? container.top : 80;
  const baseWidth = container ? container.width : window.innerWidth;
  const baseHeight = container ? container.height : window.innerHeight - 80;

  if (domRect && typeof domRect.x === 'number' && typeof domRect.y === 'number') {
    const appX = Math.round(baseLeft + domRect.x);
    const appY = Math.round(baseTop + domRect.y);
    const appW = Math.round(domRect.width || 0);
    const appH = Math.round(domRect.height || 0);

    const cursorX = Math.round(appX + (appW > 0 ? appW / 2 : 0));
    const cursorY = Math.round(appY + (appH > 0 ? appH / 2 : 0));

    return {
      cursorX,
      cursorY,
      highlightRect: {
        x: appX,
        y: appY,
        width: Math.max(appW, 16),
        height: Math.max(appH, 16)
      }
    };
  }

  // Default viewport center / top position for global actions (navigate, scroll, wait)
  const cursorX = Math.round(baseLeft + baseWidth / 2);
  const cursorY = Math.round(baseTop + Math.min(160, baseHeight / 3));

  return {
    cursorX,
    cursorY,
    highlightRect: null
  };
}

/**
 * Emits a visualization event to trigger the AI agent cursor and target highlight.
 */
export function emitAgentVisualEvent(event: AgentActionVisualEvent): void {
  if (completionTimer) {
    clearTimeout(completionTimer);
    completionTimer = null;
  }

  const store = useAgentCursorStore.getState();
  const { cursorX, cursorY, highlightRect } = convertWebviewToAppCoordinates(event.rect);

  // Set target and coordinates
  store.setTarget({
    x: cursorX,
    y: cursorY,
    elementId: event.elementId,
    label: event.label,
    highlight: highlightRect
  });

  // Map to visual cursor action state
  let actionState: AgentCursorAction = 'moving';
  if (event.action === 'click') {
    actionState = 'clicking';
  } else if (event.action === 'type') {
    actionState = 'typing';
    if (event.text !== undefined) {
      store.setTypingText(event.text);
    }
  } else if (event.action === 'press') {
    actionState = 'pressing';
    useAgentCursorStore.setState({ key: event.key || 'Enter' });
  } else if (event.action === 'scroll') {
    actionState = 'scrolling';
    useAgentCursorStore.setState({ scrollDirection: event.direction || 'down' });
  } else if (event.action === 'navigate') {
    actionState = 'navigating';
  } else if (event.action === 'wait') {
    actionState = 'waiting';
  }

  store.setAction(actionState as any);

  // Populate debug info if debug mode is active or for inspection
  store.setDebugInfo({
    elementId: event.elementId,
    action: event.action,
    targetLabel: event.label || event.text || event.key,
    domRect: event.rect || null,
    appRect: highlightRect,
    cursorPos: { x: cursorX, y: cursorY }
  });
}

/**
 * Signals that an action execution and verification has completed.
 */
export function completeAgentVisualAction(result: {
  success: boolean;
  error?: string;
}): void {
  if (completionTimer) {
    clearTimeout(completionTimer);
  }

  const store = useAgentCursorStore.getState();

  if (result.success) {
    store.setAction('success');
    completionTimer = setTimeout(() => {
      useAgentCursorStore.getState().setAction('idle');
      useAgentCursorStore.getState().setTargetHighlight(false);
    }, 600);
  } else {
    store.setError(result.error || 'Action failed');
    completionTimer = setTimeout(() => {
      useAgentCursorStore.getState().setAction('idle');
      useAgentCursorStore.getState().setTargetHighlight(false);
    }, 1000);
  }
}

/**
 * Immediately hides and resets the agent cursor.
 */
export function hideAgentCursor(): void {
  if (completionTimer) {
    clearTimeout(completionTimer);
    completionTimer = null;
  }
  useAgentCursorStore.getState().reset();
}
