import React from 'react';
import { Play, StopCircle, Pause, RefreshCw } from 'lucide-react';
import { AgentExecutionState } from '../../types';

interface AgentControlsProps {
  isRunning?: boolean;
  isPaused?: boolean;
  executionState?: AgentExecutionState;
  pendingAction?: string | null;
  onStart?: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume?: () => void;
  status: string;
}

export const AgentControls: React.FC<AgentControlsProps> = ({
  isRunning,
  isPaused,
  executionState,
  pendingAction,
  onStart,
  onStop,
  onPause,
  onResume,
  status
}) => {
  // Resolve effective execution state with backwards compatibility
  const effectiveState: AgentExecutionState =
    executionState ||
    (isRunning ? (isPaused ? 'paused' : 'running') : 'idle');

  const isActive = ['running', 'pausing', 'paused', 'stopping'].includes(effectiveState);

  const getStatusColor = () => {
    switch (effectiveState) {
      case 'running':
        return 'bg-purple-500';
      case 'pausing':
      case 'paused':
        return 'bg-amber-500';
      case 'stopping':
      case 'error':
        return 'bg-red-500';
      case 'completed':
        return 'bg-emerald-500';
      default:
        return 'bg-slate-700';
    }
  };

  const getStateLabel = () => {
    switch (effectiveState) {
      case 'running':
        return 'Active';
      case 'pausing':
        return 'Pausing...';
      case 'paused':
        return 'Paused';
      case 'stopping':
        return 'Stopping...';
      case 'completed':
        return 'Completed';
      case 'error':
        return 'Error';
      default:
        return 'Idle';
    }
  };

  return (
    <div className="bg-[#0f172a] border border-slate-800 rounded-xl p-3 flex flex-col gap-3 shadow-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isActive ? (
            <div className="relative">
              <div className={`w-2.5 h-2.5 ${getStatusColor()} rounded-full ${effectiveState === 'paused' ? '' : 'animate-ping'} absolute inset-0 opacity-75`}></div>
              <div className={`w-2.5 h-2.5 ${getStatusColor()} rounded-full relative`}></div>
            </div>
          ) : (
            <div className={`w-2.5 h-2.5 ${getStatusColor()} rounded-full`}></div>
          )}
          <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
            {getStateLabel()}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Running State: Show Pause and Stop */}
          {effectiveState === 'running' && (
            <>
              <button
                onClick={onPause}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-400 border border-slate-700 transition-all cursor-pointer"
                title="Pause Agent"
              >
                <Pause size={12} fill="currentColor" />
              </button>
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-lg shadow-red-900/20 cursor-pointer"
                title="Stop Agent"
              >
                <StopCircle size={10} fill="currentColor" />
                Stop
              </button>
            </>
          )}

          {/* Pausing State: Pause button disabled with spinner, Stop enabled */}
          {effectiveState === 'pausing' && (
            <>
              <button
                disabled
                className="p-1.5 rounded-lg bg-slate-800/60 text-amber-500/50 border border-slate-700/50 cursor-not-allowed"
                title="Pausing at safe boundary..."
              >
                <RefreshCw size={12} className="animate-spin text-amber-400" />
              </button>
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-lg shadow-red-900/20 cursor-pointer"
                title="Stop Agent"
              >
                <StopCircle size={10} fill="currentColor" />
                Stop
              </button>
            </>
          )}

          {/* Paused State: Show Resume and Stop */}
          {effectiveState === 'paused' && (
            <>
              <button
                onClick={onResume || onPause}
                className="flex items-center gap-1 bg-amber-600 hover:bg-amber-500 text-white px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-lg shadow-amber-900/20 cursor-pointer"
                title="Resume Agent"
              >
                <Play size={10} fill="currentColor" />
                Resume
              </button>
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-lg shadow-red-900/20 cursor-pointer"
                title="Stop Agent"
              >
                <StopCircle size={10} fill="currentColor" />
                Stop
              </button>
            </>
          )}

          {/* Stopping State: Conflicting controls disabled */}
          {effectiveState === 'stopping' && (
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-red-400 uppercase tracking-wider bg-red-950/60 border border-red-800/50 px-2.5 py-1 rounded-lg">
              <RefreshCw size={10} className="animate-spin text-red-400" />
              Stopping...
            </div>
          )}

          {/* Idle / Completed / Error: Show Begin Mission if onStart provided */}
          {!isActive && onStart && (
            <button
              onClick={onStart}
              className="flex items-center gap-1.5 bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-lg shadow-purple-900/20 cursor-pointer"
            >
              <Play size={10} fill="currentColor" />
              Begin Mission
            </button>
          )}
        </div>
      </div>

      {isActive && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full ${
                effectiveState === 'paused' || effectiveState === 'pausing'
                  ? 'bg-amber-500'
                  : effectiveState === 'stopping'
                  ? 'bg-red-500'
                  : 'bg-purple-500 animate-pulse'
              } w-full transition-all duration-300`}
            ></div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] text-slate-400 font-mono truncate max-w-[220px]">
              {status || 'Waiting for instructions...'}
            </span>
            {effectiveState === 'running' && (
              <RefreshCw size={8} className="animate-spin text-purple-400 shrink-0" />
            )}
          </div>
          {pendingAction && (
            <div className="text-[9px] text-amber-300 font-mono truncate bg-amber-950/30 border border-amber-900/40 px-1.5 py-0.5 rounded">
              Pending: {pendingAction}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
