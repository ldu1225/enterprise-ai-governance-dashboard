import React from 'react';
import { History, RotateCcw, CheckCircle2, Clock, User } from 'lucide-react';

export default function VersionHistoryModal({ versions, currentVersion, onSelectVersion, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="glass-card w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 space-y-6 relative border border-purple-500/40">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white text-lg font-bold"
        >
          ✕
        </button>

        <div className="flex items-center gap-3 border-b border-white/10 pb-4">
          <div className="p-3 bg-purple-500/20 text-purple-400 rounded-xl">
            <History className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">대시보드 스키마 버전 관리 & 롤백 (Version History)</h2>
            <p className="text-xs text-slate-400">Conversational API 및 자연어 변경 이력을 확인하고 특정 버전으로 즉시 복구(Rollback)합니다.</p>
          </div>
        </div>

        <div className="space-y-3">
          {versions.map((v) => {
            const isCurrent = currentVersion && currentVersion.versionId === v.versionId;
            return (
              <div
                key={v.versionId}
                className={`p-4 rounded-xl border transition-all ${
                  isCurrent
                    ? 'bg-[#e6007e]/10 border-[#e6007e] shadow-lg shadow-[#e6007e]/10'
                    : 'bg-slate-900/80 border-white/10 hover:border-slate-600'
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-sm text-purple-300">{v.versionId}</span>
                      <h4 className="font-bold text-white text-sm">{v.title}</h4>
                      {isCurrent && (
                        <span className="badge badge-active flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> 활성 버전
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-slate-300 mt-1">{v.description}</p>

                    <div className="flex items-center gap-4 text-[11px] text-slate-400 mt-3">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" /> {v.createdAt}
                      </span>
                      <span className="flex items-center gap-1">
                        <User className="w-3.5 h-3.5" /> {v.author}
                      </span>
                      <span>위젯 {v.widgets ? v.widgets.length : 0}개 포함</span>
                    </div>
                  </div>

                  {!isCurrent && (
                    <button
                      onClick={() => {
                        onSelectVersion(v);
                        onClose();
                      }}
                      className="btn-secondary text-xs flex items-center gap-1 hover:border-[#e6007e] hover:text-[#e6007e]"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>이 버전으로 복구</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="btn-secondary text-xs">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
