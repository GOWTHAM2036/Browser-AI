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
    <div className="flex items-end bg-[#0f172a] border-b border-slate-800 px-3 select-none w-full overflow-hidden">
      {/* Draggable TitleBar Handle for Frameless window */}
      <div 
        className="flex items-center flex-1 overflow-x-auto overflow-y-hidden gap-1.5 py-1.5 scrollbar-none"
        onDoubleClick={async () => {
          // Double click titlebar to maximize window
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
              className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-t-lg cursor-pointer transition-all duration-200 border-t border-x ${
                isActive
                  ? 'bg-[#1e293b] border-slate-700 text-white font-medium shadow-md'
                  : 'bg-[#0b0f19] border-transparent text-slate-400 hover:text-slate-200 hover:bg-[#131b2e]'
              } ${tab.pinned ? 'min-w-[44px] max-w-[44px] justify-center' : 'min-w-[120px] max-w-[180px] flex-1'}`}
            >
              {/* Favicon or fallback */}
              {tab.favicon ? (
                <img src={tab.favicon} className="w-3.5 h-3.5 rounded" alt="" />
              ) : (
                <div className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[9px] font-bold ${
                  isActive ? 'bg-[#3b82f6] text-white' : 'bg-slate-700 text-slate-300'
                }`}>
                  {tab.title[0]?.toUpperCase() || 'A'}
                </div>
              )}

              {/* Title (hidden if pinned) */}
              {!tab.pinned && (
                <span className="text-xs truncate flex-1 leading-none">
                  {tab.title}
                </span>
              )}

              {/* Loading Indicator */}
              {tab.loading && !tab.pinned && (
                <div className="w-2.5 h-2.5 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin"></div>
              )}

              {/* Close Button */}
              {!tab.pinned && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 leading-none transition-all"
                >
                  <X size={11} />
                </button>
              )}

              {/* Pin Icon (Only visible on hover/pin state) */}
              <button
                onClick={(e) => handlePinToggle(e, tab.id, tab.pinned)}
                className={`absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 leading-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 ${
                  tab.pinned ? 'opacity-100 right-[unset] top-[unset] translate-y-0 relative' : ''
                }`}
                title={tab.pinned ? 'Unpin Tab' : 'Pin Tab'}
              >
                {tab.pinned ? <Pin size={10} className="text-[#3b82f6] fill-[#3b82f6]" /> : <Pin size={10} />}
              </button>
            </div>
          );
        })}
      </div>

      {/* New Tab Button */}
      <button
        onClick={() => addTab()}
        className="p-1.5 mb-1.5 ml-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-all cursor-pointer border border-slate-700"
        title="Open New Tab (Cmd+T)"
      >
        <Plus size={14} />
      </button>
    </div>
  );
};
