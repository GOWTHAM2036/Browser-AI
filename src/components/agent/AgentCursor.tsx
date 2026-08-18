import React, { useEffect, useState } from 'react';
import { useAgentCursorStore } from '../../store/agentCursorStore';
import { Sparkles, Check, X, ArrowDown, ArrowUp, CornerDownLeft, Loader2, Keyboard, Type } from 'lucide-react';

export const AgentCursor: React.FC = () => {
  const {
    visible,
    x,
    y,
    action,
    targetElementId,
    targetLabel,
    text,
    key,
    scrollDirection,
    errorMessage,
    showTargetHighlight,
    targetHighlight,
    debugMode,
    debugInfo
  } = useAgentCursorStore();

  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  // Trigger ripple effect on click action
  useEffect(() => {
    if (action === 'clicking' && x > 0 && y > 0) {
      const newRipple = { id: Date.now(), x, y };
      setRipples((prev) => [...prev, newRipple]);
      const timer = setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r.id !== newRipple.id));
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [action, x, y]);

  if (!visible && !showTargetHighlight && ripples.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[999999] overflow-hidden select-none"
      aria-hidden="true"
    >
      {/* 1. Target Element Highlight Box */}
      {showTargetHighlight && targetHighlight && (
        <div
          className="fixed rounded-md border-2 border-purple-500/80 bg-purple-500/10 shadow-[0_0_15px_rgba(168,85,247,0.35)] transition-all duration-200 ease-out pointer-events-none"
          style={{
            left: `${targetHighlight.x}px`,
            top: `${targetHighlight.y}px`,
            width: `${targetHighlight.width}px`,
            height: `${targetHighlight.height}px`
          }}
        >
          {/* Element Tag Badge */}
          <div className="absolute -top-5 left-0 flex items-center gap-1 bg-purple-900/90 text-purple-200 border border-purple-700/60 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shadow-md whitespace-nowrap">
            <Sparkles size={9} className="text-purple-300" />
            <span>
              {targetElementId || 'Target'}
              {targetLabel ? ` · ${targetLabel.slice(0, 24)}` : ''}
            </span>
          </div>
        </div>
      )}

      {/* 2. Click Ripple Animations */}
      {ripples.map((ripple) => (
        <div
          key={ripple.id}
          className="fixed rounded-full pointer-events-none border-2 border-purple-400 bg-purple-500/20 animate-ping shadow-[0_0_12px_#c084fc]"
          style={{
            left: `${ripple.x - 16}px`,
            top: `${ripple.y - 16}px`,
            width: '32px',
            height: '32px',
            animationDuration: '0.6s'
          }}
        />
      ))}

      {/* 3. AI Agent Cursor Pointer */}
      {visible && x > 0 && y > 0 && (
        <div
          className="fixed pointer-events-none transition-all duration-200 ease-out flex flex-col items-start"
          style={{
            left: `${x}px`,
            top: `${y}px`,
            transform: 'translate(-3px, -3px)'
          }}
        >
          {/* Custom SVG Pointer */}
          <div className="relative">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className={`drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] transition-transform duration-150 ${
                action === 'clicking' ? 'scale-90 translate-x-0.5 translate-y-0.5' : 'scale-100'
              }`}
            >
              {/* Cursor Body */}
              <path
                d="M3 3L10.07 20.97L13.58 13.58L20.97 10.07L3 3Z"
                fill="url(#agent-cursor-gradient)"
                stroke="#ffffff"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <defs>
                <linearGradient id="agent-cursor-gradient" x1="3" y1="3" x2="20.97" y2="20.97" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#8b5cf6" />
                  <stop offset="1" stopColor="#3b82f6" />
                </linearGradient>
              </defs>
            </svg>

            {/* Glowing ARIA Pulsing Node */}
            <div className="absolute -top-0.5 -left-0.5 w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#22d3ee]" />
          </div>

          {/* 4. Action State Badge */}
          <div className="mt-1 ml-4 flex items-center gap-1.5 bg-[#0f172a]/95 text-slate-100 border border-slate-700/80 px-2 py-1 rounded-lg text-[10px] font-sans font-medium shadow-2xl backdrop-blur-md whitespace-nowrap">
            {action === 'typing' && (
              <>
                <Type size={11} className="text-blue-400 animate-pulse" />
                <span className="text-slate-300">Typing:</span>
                <span className="font-mono text-blue-300 font-semibold max-w-[140px] truncate">
                  "{text || ''}"
                </span>
                <span className="w-1 h-3 bg-blue-400 animate-ping inline-block" />
              </>
            )}

            {action === 'clicking' && (
              <>
                <Sparkles size={11} className="text-purple-400 animate-spin" />
                <span className="text-purple-200 font-semibold">Clicking...</span>
              </>
            )}

            {action === 'pressing' && (
              <>
                <Keyboard size={11} className="text-amber-400" />
                <span className="text-slate-300">Pressing:</span>
                <span className="font-mono text-amber-300 font-bold flex items-center gap-0.5 bg-slate-800 px-1 rounded">
                  {key === 'Enter' ? <CornerDownLeft size={10} /> : null}
                  {key || 'Enter'}
                </span>
              </>
            )}

            {action === 'scrolling' && (
              <>
                {scrollDirection === 'up' ? (
                  <ArrowUp size={11} className="text-cyan-400 animate-bounce" />
                ) : (
                  <ArrowDown size={11} className="text-cyan-400 animate-bounce" />
                )}
                <span className="text-cyan-200 font-semibold">
                  Scrolling {scrollDirection || 'down'}...
                </span>
              </>
            )}

            {action === 'navigating' && (
              <>
                <Loader2 size={11} className="text-sky-400 animate-spin" />
                <span className="text-sky-200 font-semibold">Navigating...</span>
              </>
            )}

            {action === 'waiting' && (
              <>
                <Loader2 size={11} className="text-slate-400 animate-spin" />
                <span className="text-slate-300">Waiting for page...</span>
              </>
            )}

            {action === 'moving' && (
              <>
                <Sparkles size={11} className="text-purple-400" />
                <span className="text-purple-200">
                  {targetLabel ? `Moving to ${targetLabel.slice(0, 20)}` : 'Moving...'}
                </span>
              </>
            )}

            {action === 'success' && (
              <>
                <div className="w-3.5 h-3.5 rounded-full bg-green-500/20 border border-green-500 flex items-center justify-center">
                  <Check size={9} className="text-green-400" />
                </div>
                <span className="text-green-300 font-semibold">Done</span>
              </>
            )}

            {action === 'error' && (
              <>
                <div className="w-3.5 h-3.5 rounded-full bg-red-500/20 border border-red-500 flex items-center justify-center">
                  <X size={9} className="text-red-400" />
                </div>
                <span className="text-red-300 font-semibold max-w-[160px] truncate">
                  {errorMessage || 'Action failed'}
                </span>
              </>
            )}

            {action === 'idle' && (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                <span className="text-slate-400 font-mono text-[9px]">ARIA</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 5. Developer Debug Mode HUD Overlay (Phase 16) */}
      {debugMode && debugInfo && (
        <div className="fixed bottom-4 left-4 bg-slate-950/95 border border-purple-600/60 rounded-xl p-3 shadow-2xl text-[10px] font-mono text-slate-300 pointer-events-none backdrop-blur-md max-w-sm z-[999999]">
          <div className="flex items-center gap-1.5 text-purple-400 font-bold border-b border-slate-800 pb-1.5 mb-2">
            <Sparkles size={12} />
            <span>AGENT CURSOR DEBUG HUD</span>
          </div>
          <div className="space-y-1">
            <div>
              <span className="text-slate-500">Element ID: </span>
              <span className="text-emerald-400 font-bold">{debugInfo.elementId || 'N/A'}</span>
            </div>
            <div>
              <span className="text-slate-500">Action: </span>
              <span className="text-purple-300 font-bold uppercase">{debugInfo.action || action}</span>
            </div>
            <div>
              <span className="text-slate-500">Target Label: </span>
              <span className="text-amber-300 truncate inline-block max-w-[200px] align-bottom">
                {debugInfo.targetLabel || targetLabel || 'N/A'}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Cursor (App): </span>
              <span className="text-cyan-300">
                x={Math.round(x)}, y={Math.round(y)}
              </span>
            </div>
            {debugInfo.domRect && (
              <div>
                <span className="text-slate-500">DOM Rect: </span>
                <span className="text-slate-400">
                  [{debugInfo.domRect.x}, {debugInfo.domRect.y}, {debugInfo.domRect.width}×{debugInfo.domRect.height}]
                </span>
              </div>
            )}
            {debugInfo.appRect && (
              <div>
                <span className="text-slate-500">App Rect: </span>
                <span className="text-slate-400">
                  [{debugInfo.appRect.x}, {debugInfo.appRect.y}, {debugInfo.appRect.width}×{debugInfo.appRect.height}]
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
