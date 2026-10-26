import React from 'react';

export interface TimelineItem {
  id: string;
  timestamp: string;
  actionType: string;
  target: string;
  result: string;
  status: 'success' | 'error' | 'pending' | 'info';
}

interface AgentTimelineProps {
  timeline: TimelineItem[];
  feedMode: 'timeline' | 'logs';
  setFeedMode: (mode: 'timeline' | 'logs') => void;
  logs: string[];
}

export const AgentTimeline: React.FC<AgentTimelineProps> = ({ 
  timeline, 
  feedMode, 
  setFeedMode, 
  logs 
}) => {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Action Feed</span>
        <div className="flex bg-slate-950/50 rounded-lg p-0.5 border border-slate-800">
          <button
            onClick={() => setFeedMode('timeline')}
            className={`px-2 py-1 text-[9px] font-bold rounded transition-all cursor-pointer ${
              feedMode === 'timeline'
                ? 'bg-purple-900/40 text-purple-200 border border-purple-800/30'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Timeline
          </button>
          <button
            onClick={() => setFeedMode('logs')}
            className={`px-2 py-1 text-[9px] font-bold rounded transition-all cursor-pointer ${
              feedMode === 'logs'
                ? 'bg-purple-900/40 text-purple-200 border border-purple-800/30'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            Raw Logs
          </button>
        </div>
      </div>

      {/* Feed Content */}
      <div className="flex-1 overflow-y-auto border border-slate-800/60 bg-slate-950/15 rounded-xl p-3 text-[10px] min-h-0 select-text">
        {feedMode === 'timeline' ? (
          <div className="space-y-4">
            {timeline.length === 0 ? (
              <div className="text-slate-600 text-center py-8 font-sans">
                Timeline events will appear here.
              </div>
            ) : (
              timeline.map((item) => (
                <div key={item.id} className="relative pl-5 border-l border-slate-800 last:border-0 pb-1">
                  {/* Dot icon */}
                  <div className={`absolute -left-1.5 top-0.5 w-3 h-3 rounded-full border-2 ${
                    item.status === 'success' ? 'bg-green-500 border-green-950 shadow-[0_0_5px_rgba(34,197,94,0.4)]' :
                    item.status === 'error' ? 'bg-red-500 border-red-950 shadow-[0_0_5px_rgba(239,68,68,0.4)]' :
                    item.status === 'pending' ? 'bg-amber-500 border-amber-950 shadow-[0_0_5px_rgba(245,158,11,0.4)]' :
                    'bg-blue-500 border-blue-950'
                  }`} />

                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className="text-[9px] text-slate-500 font-mono">{item.timestamp}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold font-mono uppercase tracking-wider ${
                      item.actionType === 'click' ? 'bg-purple-950 text-purple-300 border border-purple-800/40' :
                      item.actionType === 'type' ? 'bg-blue-950 text-blue-300 border border-blue-800/40' :
                      item.actionType === 'scroll' ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/40' :
                      item.actionType === 'navigate' ? 'bg-sky-950 text-sky-300 border border-sky-800/40' :
                      item.actionType === 'done' ? 'bg-green-950 text-green-300 border border-green-800/40' :
                      'bg-slate-900 text-slate-400 border border-slate-800'
                    }`}>
                      {item.actionType}
                    </span>
                    {item.target && (
                      <span className="text-slate-400 font-mono font-medium truncate max-w-[120px]" title={item.target}>
                        {item.target}
                      </span>
                    )}
                  </div>

                  <div className="text-slate-300 font-sans leading-relaxed text-[10px]">
                    {item.result || 'Awaiting action...'}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-1.5 font-mono text-slate-400 leading-relaxed">
            {logs.length === 0 ? (
              <div className="text-slate-600 text-center py-8 font-sans">
                Raw console output will appear here.
              </div>
            ) : (
              logs.map((log, idx) => (
                <div key={idx} className="border-b border-slate-900/40 pb-1">
                  {log}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
