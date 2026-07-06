import React, { useState, useEffect } from 'react';
import { Sparkles, Send, Plus, Trash2, Save, RefreshCw, Layers, Cpu, Activity, ShieldCheck, BarChart2 } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function CustomDashboardStudio({ currentVersion, onSaveVersion }) {
  const [promptInput, setPromptInput] = useState('');
  const [chatHistory, setChatHistory] = useState([
    {
      role: 'system',
      content: '안녕하세요! LGES Conversational Analytics API 기반 대시보드 스튜디오입니다. 원하는 메트릭이나 차트를 자연어로 말씀하시면 BigQuery 실데이터를 SQL로 즉시 쿼리하여 위젯을 추가해 드립니다.\n예시: "부서별 Gemini 프롬프트 제출 수 차트 추가해줘", "Model Armor 최근 차단율 KPI 생성해줘"'
    }
  ]);
  const [widgets, setWidgets] = useState(currentVersion ? currentVersion.widgets : []);
  const [isProcessing, setIsProcessing] = useState(false);
  const [versionTitle, setVersionTitle] = useState('');
  const [showSaveModal, setShowSaveModal] = useState(false);

  useEffect(() => {
    if (currentVersion && currentVersion.widgets) {
      setWidgets(currentVersion.widgets);
    }
  }, [currentVersion]);

  // Handle Natural Language Submission via Conversational API
  const handleConversationalSubmit = async (e) => {
    e.preventDefault();
    if (!promptInput.trim() || isProcessing) return;

    const userMsg = promptInput.trim();
    setPromptInput('');
    setChatHistory(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsProcessing(true);

    try {
      const res = await fetch('http://localhost:8088/api/conversational', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userMsg })
      });
      const data = await res.json();

      if (data.status === 'success') {
        setChatHistory(prev => [...prev, { role: 'assistant', content: data.reply }]);
        if (data.createdWidget) {
          setWidgets(prev => [data.createdWidget, ...prev]);
        }
      }
    } catch (err) {
      setChatHistory(prev => [...prev, { role: 'assistant', content: 'Conversational API 처리 중 오류가 발생했습니다.' }]);
    } finally {
      setIsProcessing(false);
    }
  };

  // Remove Widget
  const handleRemoveWidget = (widgetId) => {
    setWidgets(prev => prev.filter(w => w.id !== widgetId));
  };

  // Save Version
  const handleSaveVersionConfirm = () => {
    if (!versionTitle.trim()) return;
    onSaveVersion({
      title: versionTitle,
      description: `Conversational API 커스텀 (${widgets.length}개 메트릭 포함)`,
      widgets: widgets
    });
    setShowSaveModal(false);
    setVersionTitle('');
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

      {/* Left Column: Conversational API Chat Panel */}
      <div className="glass-card p-5 lg:col-span-1 flex flex-col h-[780px]">
        <div className="flex items-center gap-2 pb-3 border-b border-white/10 mb-4">
          <Sparkles className="w-5 h-5 text-amber-300 animate-pulse" />
          <h3 className="text-base font-bold text-white">Conversational API 에이전트</h3>
        </div>

        {/* Chat Message Box */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1 mb-4">
          {chatHistory.map((msg, idx) => (
            <div
              key={idx}
              className={`p-3.5 rounded-xl text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-[#e6007e]/20 text-white border border-[#e6007e]/40 ml-6'
                  : 'bg-slate-900/90 text-slate-200 border border-white/10 mr-4'
              }`}
            >
              <div className="font-semibold text-[10px] text-slate-400 mb-1">
                {msg.role === 'user' ? '사용자 (자연어 커스텀)' : 'Conversational Engine API'}
              </div>
              <div className="whitespace-pre-line">{msg.content}</div>
            </div>
          ))}
          {isProcessing && (
            <div className="p-3 bg-slate-900/80 rounded-xl text-xs text-amber-300 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>BigQuery 실데이터 NL2SQL 변환 및 메트릭 생성 중...</span>
            </div>
          )}
        </div>

        {/* Input Form */}
        <form onSubmit={handleConversationalSubmit} className="flex gap-2">
          <input
            type="text"
            placeholder="예: '부서별 Gemini 프롬프트 제출 수 차트 추가해줘'"
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            className="flex-1 px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-xs text-white focus:outline-none focus:border-[#e6007e]"
          />
          <button
            type="submit"
            disabled={isProcessing}
            className="glow-btn px-4"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Right Column: Dynamic Custom Dashboard View */}
      <div className="lg:col-span-2 space-y-4">
        <div className="glass-card p-4 flex justify-between items-center">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Layers className="w-5 h-5 text-purple-400" />
              자연어 커스텀 대시보드 캔버스 ({widgets.length}개 메트릭)
            </h3>
            <p className="text-xs text-slate-400">자연어 커스텀 메트릭 추가/삭제 및 버전 저장</p>
          </div>

          <button
            onClick={() => setShowSaveModal(true)}
            className="glow-btn text-xs flex items-center gap-1.5"
          >
            <Save className="w-4 h-4" />
            <span>현재 스키마 버전 저장</span>
          </button>
        </div>

        {/* Dynamic Widgets Canvas */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[700px] overflow-y-auto pr-1">
          {widgets.map((w) => (
            <div key={w.id} className="glass-card p-5 relative group border hover:border-[#e6007e]/50 transition-all">
              <button
                onClick={() => handleRemoveWidget(w.id)}
                className="absolute top-3 right-3 text-slate-500 hover:text-red-400 p-1 opacity-80 group-hover:opacity-100 transition-opacity"
                title="위젯 삭제"
              >
                <Trash2 className="w-4 h-4" />
              </button>

              <h4 className="text-xs font-semibold text-slate-400 uppercase mb-2">{w.title}</h4>

              {w.type === 'kpi' && (
                <div className="mt-2">
                  <div className="text-2xl font-bold text-white">{w.value || w.metricKey}</div>
                  <div className="text-xs text-emerald-400 mt-1">{w.trend || 'BigQuery Live'}</div>
                </div>
              )}

              {w.type === 'bar-chart' && (
                <div className="h-44 w-full mt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={w.data || [
                      { name: '05-22', val: 3197 },
                      { name: '05-28', val: 46 },
                      { name: '06-16', val: 8 }
                    ]}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="name" stroke="#94a3b8" fontSize={10} />
                      <YAxis stroke="#94a3b8" fontSize={10} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#fff' }} />
                      <Bar dataKey="val" fill="#e6007e" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {w.type === 'line-chart' && (
                <div className="h-44 w-full mt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={[
                      { date: '06-25', val: 540 },
                      { date: '06-28', val: 1120 },
                      { date: '06-30', val: 1420 }
                    ]}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="date" stroke="#94a3b8" fontSize={10} />
                      <YAxis stroke="#94a3b8" fontSize={10} />
                      <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#fff' }} />
                      <Line type="monotone" dataKey="val" stroke="#8b5cf6" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Save Version Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass-card w-full max-w-md p-6 space-y-4 border border-[#e6007e]/50">
            <h3 className="text-base font-bold text-white">커스텀 대시보드 버전 저장</h3>
            <p className="text-xs text-slate-400">현재 수정된 메트릭 위젯 구성을 신규 스키마 버전으로 생성하고 관리 이력에 동기화합니다.</p>
            
            <div>
              <label className="text-xs text-slate-300 font-medium block mb-1">버전 이름 / 메세지</label>
              <input
                type="text"
                placeholder="예: 2026 Q3 R&D 부서별 사용량 커스텀 뷰"
                value={versionTitle}
                onChange={(e) => setVersionTitle(e.target.value)}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-[#e6007e]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowSaveModal(false)}
                className="btn-secondary text-xs"
              >
                취소
              </button>
              <button
                onClick={handleSaveVersionConfirm}
                className="glow-btn text-xs"
              >
                버전 저장하기
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
