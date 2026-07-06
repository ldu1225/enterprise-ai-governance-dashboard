import React from 'react';
import { LayoutDashboard, Sparkles, History, ShieldAlert, Database, Cpu } from 'lucide-react';

export default function Header({ activeTab, setActiveTab, currentVersion, onOpenVersionModal }) {
  return (
    <header className="glass-card mb-6 p-4 flex flex-wrap justify-between items-center gap-4 border-b border-white/10" style={{ backdropFilter: 'blur(16px)' }}>
      {/* Brand & Identity */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-[#e6007e] to-[#ff4da6] flex items-center justify-center shadow-lg shadow-[#e6007e]/30">
          <Cpu className="w-6 h-6 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-white tracking-tight">LG Energy Solution</h1>
            <span className="badge badge-system font-mono">BigQuery Live</span>
            <span className="badge badge-pro font-mono">Conversational API</span>
          </div>
          <p className="text-xs text-slate-400">Gemini Enterprise & Agent Platform Governance & Custom Dashboard</p>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 bg-slate-900/80 p-1.5 rounded-xl border border-white/5">
        <button
          onClick={() => setActiveTab('standard')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'standard'
              ? 'bg-[#e6007e] text-white shadow-md shadow-[#e6007e]/20'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
          기본 관제 대시보드
        </button>

        <button
          onClick={() => setActiveTab('custom')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'custom'
              ? 'bg-gradient-to-r from-purple-600 to-[#e6007e] text-white shadow-md shadow-purple-500/20'
              : 'text-slate-400 hover:text-white hover:bg-white/5'
          }`}
        >
          <Sparkles className="w-4 h-4 text-amber-300 animate-pulse" />
          자연어 커스텀 스튜디오
        </button>
      </div>

      {/* Actions & Version info */}
      <div className="flex items-center gap-3">
        <div className="text-right hidden sm:block">
          <div className="text-xs text-slate-400">현재 적용 스키마</div>
          <div className="text-sm font-semibold text-emerald-400 font-mono flex items-center justify-end gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
            {currentVersion ? currentVersion.versionId : 'v1.0.0'}
          </div>
        </div>

        <button
          onClick={onOpenVersionModal}
          className="btn-secondary text-xs flex items-center gap-1.5 hover:border-[#e6007e]/50 transition-colors"
          title="버전 이력 관리 및 복구"
        >
          <History className="w-4 h-4 text-purple-400" />
          <span>버전 히스토리</span>
        </button>
      </div>
    </header>
  );
}
