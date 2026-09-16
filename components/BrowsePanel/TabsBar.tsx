
import React from 'react';
import { RotateCw, Globe, X, Plus } from 'lucide-react';
import { useTabs } from '../../engines/useBrowse/useTabs';

interface TabsBarProps {
    tabs: ReturnType<typeof useTabs>['tabs'];
    activeTabId: string;
    actions: ReturnType<typeof useTabs>['actions'];
}

export const TabsBar: React.FC<TabsBarProps> = ({ tabs, activeTabId, actions }) => {
    return (
        <div className="h-9 bg-slate-900 flex items-center px-2 gap-1 border-b border-slate-800 overflow-x-auto scrollbar-hide">
            {tabs.map(tab => (
                <div
                    key={tab.id}
                    onClick={() => actions.switchTab(tab.id)}
                    className={`group flex items-center gap-2 px-3 py-1.5 rounded-t-lg cursor-pointer min-w-[120px] max-w-[200px] transition-all select-none ${
                        tab.id === activeTabId 
                            ? 'bg-slate-950 text-white' 
                            : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                >
                    {tab.isLoading ? (
                        <RotateCw className="w-3 h-3 animate-spin shrink-0" />
                    ) : (
                        <Globe className="w-3 h-3 shrink-0" />
                    )}
                    <span className="truncate text-xs flex-1">{tab.title}</span>
                    <button
                        onClick={(e) => { e.stopPropagation(); actions.closeTab(tab.id); }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-slate-700 rounded transition"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            ))}
            <button
                onClick={() => actions.createTab()}
                className="p-1.5 text-slate-500 hover:text-white hover:bg-slate-800 rounded transition"
                title="新建标签页"
            >
                <Plus className="w-4 h-4" />
            </button>
        </div>
    );
};
