import React from 'react';
import { useBrowserStore } from '../store/browserStore';
import { X, Plus, Pin } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const TabBar: React.FC = () => {
  const { tabs, activeTabId, addTab, closeTab, setActiveTabId, reorderTabs, updateTab } = useBrowserStore();

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', index.toString());
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent, destIndex: number) => {
    e.preventDefault();
    const srcIndexStr = e.dataTransfer.getData('text/plain');
    if (srcIndexStr === '') return;
    const srcIndex = parseInt(srcIndexStr, 10);
    if (srcIndex !== destIndex) {
      await reorderTabs(srcIndex, destIndex);
    }
  };

  const handlePinToggle = async (e: React.MouseEvent, tabId: string, pinned: boolean) => {
    e.stopPropagation();
    await updateTab(tabId, { pinned: !pinned });
  };

  return (
    <div className="flex items-center h-full bg-[#0f172a] px-2 select-none w-full overflow-hidden">
      {/* Draggable TitleBar Handle for Frameless window */}
      <div 
        className="flex items-center flex-1 h-full overflow-x-auto overflow-y-hidden gap-1 scrollbar-none py-1"
        onDoubleClick={async () => {
          const win = getCurrentWindow();
          if (await win.isMaximized()) {
            await win.unmaximize();
          } else {
            await win.maximize();
          }
        }}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, idx)}
              onClick={() => setActiveTabId(tab.id)}
              className={`group relative flex items-center h-7 gap-1.5 px-2.5 rounded-md cursor-pointer transition-all duration-150 border ${
                isActive
                  ? 'bg-[#1e293b] border-slate-600/70 text-white font-medium shadow-sm'
                  : 'bg-[#0b0f19]/60 border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#131b2e]'
              } ${tab.pinned ? 'min-w-[34px] max-w-[34px] justify-center px-1' : 'min-w-[110px] max-w-[190px] flex-1'}`}
            >
              {/* Favicon or fallback */}
              {tab.favicon ? (
                <img src={tab.favicon} className="w-3.5 h-3.5 rounded shrink-0" alt="" />
              ) : (
                <div className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[9px] font-bold shrink-0 ${
                  isActive ? 'bg-[#3b82f6] text-white' : 'bg-slate-700 text-slate-300'
                }`}>
                  {tab.title[0]?.toUpperCase() || 'A'}
                </div>
              )}

              {/* Title (hidden if pinned) */}
              {!tab.pinned && (
                <span className="text-xs truncate flex-1 leading-none select-none">
                  {tab.title}
                </span>
              )}

              {/* Loading Indicator */}
              {tab.loading && !tab.pinned && (
                <div className="w-2.5 h-2.5 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin shrink-0"></div>
              )}

              {/* Tab Actions: Pin & Close (Non-overlapping) */}
              <div className="flex items-center gap-0.5 shrink-0">
                {/* Pin Button */}
                <button
                  onClick={(e) => handlePinToggle(e, tab.id, tab.pinned)}
                  className={`p-0.5 rounded text-slate-400 hover:text-white hover:bg-slate-700/60 leading-none transition-opacity ${
                    tab.pinned ? 'opacity-100 text-[#3b82f6]' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  title={tab.pinned ? 'Unpin Tab' : 'Pin Tab'}
                >
                  <Pin size={10} className={tab.pinned ? 'fill-[#3b82f6]' : ''} />
                </button>

                {/* Close Button */}
                {!tab.pinned && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 leading-none transition-opacity opacity-0 group-hover:opacity-100"
                    title="Close Tab"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* New Tab Button */}
      <button
        onClick={() => addTab()}
        className="p-1 mx-1.5 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-all cursor-pointer border border-slate-700/80 shrink-0"
        title="Open New Tab (Cmd+T)"
      >
        <Plus size={13} />
      </button>
    </div>
  );
};
