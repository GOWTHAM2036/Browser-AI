import { create } from 'zustand';

export type AgentCursorAction =
  | 'idle'
  | 'moving'
  | 'hovering'
  | 'clicking'
  | 'typing'
  | 'pressing'
  | 'scrolling'
  | 'navigating'
  | 'waiting'
  | 'success'
  | 'error';

export interface TargetHighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentCursorState {
  visible: boolean;

  // Window coordinates of cursor
  x: number;
  y: number;

  // Target window coordinates
  targetX: number;
  targetY: number;

  action: AgentCursorAction;

  targetElementId?: string;
  targetLabel?: string;
  text?: string;
  key?: string;
  scrollDirection?: 'up' | 'down';
  errorMessage?: string;

  startedAt?: number;

  // Target element highlight box in window coordinates
  showTargetHighlight: boolean;
  targetHighlight?: TargetHighlightRect | null;

  // Developer Debug Mode
  debugMode: boolean;
  debugInfo?: {
    elementId?: string;
    action?: string;
    targetLabel?: string;
    domRect?: TargetHighlightRect | null;
    appRect?: TargetHighlightRect | null;
    cursorPos?: { x: number; y: number };
  } | null;

  // Store actions
  showCursor: () => void;
  hideCursor: () => void;
  moveCursor: (x: number, y: number) => void;
  setAction: (action: AgentCursorAction) => void;
  setTarget: (params: {
    x: number;
    y: number;
    elementId?: string;
    label?: string;
    highlight?: TargetHighlightRect | null;
  }) => void;
  setTypingText: (text: string) => void;
  setTargetHighlight: (show: boolean, highlight?: TargetHighlightRect | null) => void;
  setError: (errorMessage: string) => void;
  setDebugMode: (enabled: boolean) => void;
  setDebugInfo: (info: AgentCursorState['debugInfo']) => void;
  reset: () => void;
}

export const useAgentCursorStore = create<AgentCursorState>((set) => ({
  visible: false,
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  action: 'idle',
  targetElementId: undefined,
  targetLabel: undefined,
  text: undefined,
  key: undefined,
  scrollDirection: undefined,
  errorMessage: undefined,
  startedAt: undefined,
  showTargetHighlight: false,
  targetHighlight: null,
  debugMode: false,
  debugInfo: null,

  showCursor: () => set({ visible: true }),
  hideCursor: () => set({ visible: false, showTargetHighlight: false }),
  moveCursor: (x, y) => set({ x, y, targetX: x, targetY: y }),
  setAction: (action) => set({ action }),
  setTarget: ({ x, y, elementId, label, highlight }) =>
    set({
      visible: true,
      targetX: x,
      targetY: y,
      x,
      y,
      targetElementId: elementId,
      targetLabel: label,
      showTargetHighlight: !!highlight,
      targetHighlight: highlight || null,
      startedAt: Date.now()
    }),
  setTypingText: (text) => set({ text, action: 'typing' }),
  setTargetHighlight: (show, highlight) =>
    set({
      showTargetHighlight: show,
      targetHighlight: highlight !== undefined ? highlight : null
    }),
  setError: (errorMessage) =>
    set({
      action: 'error',
      errorMessage,
      visible: true
    }),
  setDebugMode: (debugMode) => set({ debugMode }),
  setDebugInfo: (debugInfo) => set({ debugInfo }),
  reset: () =>
    set({
      visible: false,
      action: 'idle',
      targetElementId: undefined,
      targetLabel: undefined,
      text: undefined,
      key: undefined,
      scrollDirection: undefined,
      errorMessage: undefined,
      startedAt: undefined,
      showTargetHighlight: false,
      targetHighlight: null,
      debugInfo: null
    })
}));
