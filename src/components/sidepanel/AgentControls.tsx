import React from 'react';
import { Play, StopCircle, Pause, RefreshCw } from 'lucide-react';

interface AgentControlsProps {
  isRunning: boolean;
  isPaused: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  status: string;
}

export const AgentControls: React.FC<AgentControlsProps> = ({
  isRunning,
  isPaused,
  onStart,
  onStop,
  onPause,
  status
}) => {
  return (
    <div className="bg-[#0f172a] border border-slate-800 rounded-xl p-3 flex flex-col gap-3 shadow-xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <div className="relative">
              <div className="w-2.5 h-2.5 bg-purple-500 rounded-full animate-ping absolute inset-0 opacity-75"></div>
              <div className="w-2.5 h-2.5 bg-purple-600 rounded-full relative"></div>
            </div>
          ) : (
            <div className="w-2.5 h-2.5 bg-slate-700 rounded-full"></div>
          )}
          <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
            {isRunning ? (isPaused ? 'Paused' : 'Active') : 'Idle'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {!isRunning ? (
            <button
              onClick={onStart}
              className="flex items-center gap-1.5 bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-lg shadow-purple-900/20 cursor-pointer"
            >
              <Play size={10} fill="currentColor" />
              Begin Mission
            </button>
          ) : (
            <>
              <button
                onClick={onPause}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-400 border border-slate-700 transition-all cursor-pointer"
                title={isPaused ? "Resume" : "Pause"}
              >
                {isPaused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}
              </button>
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-lg shadow-red-900/20 cursor-pointer"
              >
                <StopCircle size={10} fill="currentColor" />
                Abort
              </button>
            </>
          )}
        </div>
      </div>
      
      {isRunning && (
        <div className="flex flex-col gap-1.5">
          <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-purple-500 animate-pulse w-full"></div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-slate-500 font-mono truncate max-w-[200px]">
              {status || 'Waiting for instructions...'}
            </span>
            {isRunning && !isPaused && <RefreshCw size={8} className="animate-spin text-purple-400" />}
          </div>
        </div>
      )}
    </div>
  );
};
