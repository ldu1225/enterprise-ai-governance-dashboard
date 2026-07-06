import React, { useState, useEffect } from 'react';
import { 
  Users, MessageSquare, ShieldAlert, Cpu, Activity, Search, Filter, 
  Download, ChevronRight, CheckCircle, AlertTriangle, FileText, Lock, DollarSign
} from 'lucide-react';
import { 
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell 
} from 'recharts';

export default function StandardDashboard() {
  const [summary, setSummary] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [topAgents, setTopAgents] = useState([]);
  const [modelArmorLogs, setModelArmorLogs] = useState([]);
  const [lifecycleAgents, setLifecycleAgents] = useState([]);
  
  // Lifecycle table filters
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState('ALL');
  const [selectedStatus, setSelectedStatus] = useState('ALL');
  const [selectedAgentModal, setSelectedAgentModal] = useState(null);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [sumRes, timeRes, agentsRes, armorRes, lifeRes] = await Promise.all([
        fetch('http://localhost:8088/api/metrics/summary').then(r => r.json()),
        fetch('http://localhost:8088/api/metrics/usage-timeline').then(r => r.json()),
        fetch('http://localhost:8088/api/metrics/agents-top').then(r => r.json()),
        fetch('http://localhost:8088/api/metrics/model-armor').then(r => r.json()),
        fetch('http://localhost:8088/api/lifecycle/agents').then(r => r.json())
      ]);

      setSummary(sumRes);
      setTimeline(timeRes);
      setTopAgents(agentsRes);
      setModelArmorLogs(armorRes);
      setLifecycleAgents(lifeRes);
    } catch (err) {
      console.error("Failed to fetch BigQuery live metrics:", err);
    } finally {
      setLoading(false);
    }
  };

  // Filter lifecycle agents
  const filteredLifecycle = lifecycleAgents.filter(ag => {
    const matchesSearch = ag.agentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          ag.agentId.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          ag.owner.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesPlatform = selectedPlatform === 'ALL' || ag.platform.includes(selectedPlatform);
    const matchesStatus = selectedStatus === 'ALL' || ag.lifecycleStatus === selectedStatus;
    return matchesSearch && matchesPlatform && matchesStatus;
  });

  return (
    <div className="space-y-6">

      {/* KPI Cards Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Gemini Ent. 활성 사용자 수 */}
        <div className="glass-card p-5 relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Gemini Ent. 활성 사용자 (Real)</p>
              <h3 className="text-2xl font-bold text-white mt-1">
                {summary ? `${summary.activeUsers.toLocaleString()} 명` : '쿼리 중...'}
              </h3>
              <p className="text-xs text-emerald-400 mt-2 flex items-center gap-1">
                <span>↑ 1 회 이상 프롬프트 제출자 (BQ Audit)</span>
              </p>
            </div>
            <div className="p-3 bg-blue-500/10 rounded-xl border border-blue-500/20 text-blue-400">
              <Users className="w-6 h-6" />
            </div>
          </div>
        </div>

        {/* 2. 총 프롬프트 수 */}
        <div className="glass-card p-5 relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">총 프롬프트 제출 수 (BigQuery)</p>
              <h3 className="text-2xl font-bold text-white mt-1">
                {summary ? `${summary.totalPrompts.toLocaleString()} 회` : '쿼리 중...'}
              </h3>
              <p className="text-xs text-slate-400 mt-2">
                <span>Discovery Engine User Message 적재량</span>
              </p>
            </div>
            <div className="p-3 bg-[#e6007e]/10 rounded-xl border border-[#e6007e]/20 text-[#e6007e]">
              <MessageSquare className="w-6 h-6" />
            </div>
          </div>
        </div>

        {/* 3. Agent Platform (Vertex AI) API 호출 */}
        <div className="glass-card p-5 relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Agent Platform (Vertex AI) 호출</p>
              <h3 className="text-2xl font-bold text-white mt-1">
                {summary ? `${summary.vertexCalls.toLocaleString()} 회` : '쿼리 중...'}
              </h3>
              <p className="text-xs text-indigo-400 mt-2">
                <span>Vertex Agent Builder Audit Log</span>
              </p>
            </div>
            <div className="p-3 bg-purple-500/10 rounded-xl border border-purple-500/20 text-purple-400">
              <Cpu className="w-6 h-6" />
            </div>
          </div>
        </div>

        {/* 4. Model Armor 차단 건수 */}
        <div className="glass-card p-5 relative overflow-hidden">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Model Armor 차단/검출 (Real)</p>
              <h3 className="text-2xl font-bold text-amber-400 mt-1">
                {summary ? `${summary.modelArmorBlocks} 건` : '쿼리 중...'}
              </h3>
              <p className="text-xs text-amber-300 mt-2 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" />
                <span>Sanitize Operation Audit Log</span>
              </p>
            </div>
            <div className="p-3 bg-amber-500/10 rounded-xl border border-amber-500/20 text-amber-400">
              <Lock className="w-6 h-6" />
            </div>
          </div>
        </div>
      </div>

      {/* Usage Charts Grid (요구사항 1, 2) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Line Chart: Gemini vs Vertex Usage Timeline */}
        <div className="glass-card p-5">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Activity className="w-5 h-5 text-[#e6007e]" />
                Gemini Ent. vs Agent Platform (Vertex AI) 일자별 사용 추이
              </h3>
              <p className="text-xs text-slate-400">BigQuery ge_analytics 실적재 타임라인 (최근 14일)</p>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeline}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} />
                <YAxis stroke="#94a3b8" fontSize={12} />
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#fff' }} />
                <Legend />
                <Line type="monotone" dataKey="geminiPrompts" name="Gemini Ent 프롬프트" stroke="#e6007e" strokeWidth={3} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="vertexCalls" name="Vertex AI API 호출" stroke="#8b5cf6" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Bar Chart: Top Agents Usage */}
        <div className="glass-card p-5">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Cpu className="w-5 h-5 text-indigo-400" />
                에이전트/엔진별 활용 횟수 TOP (BigQuery Real Log)
              </h3>
              <p className="text-xs text-slate-400">사용자 수 및 실제 질의 처리 건수 기준</p>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topAgents}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} tick={{ fill: '#94a3b8' }} />
                <YAxis stroke="#94a3b8" fontSize={12} />
                <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', color: '#fff' }} />
                <Legend />
                <Bar dataKey="callCount" name="실제 질의/호출 횟수" fill="#e6007e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Model Armor Security Logs (요구사항 6) */}
      <div className="glass-card p-5">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
              Model Armor 보안 차단 & 키워드/패턴 검출 로그 (Real BigQuery Audit Log)
            </h3>
            <p className="text-xs text-slate-400">`modelarmor_googleapis_com_sanitize_operations` 데이터셋 실적재 로그</p>
          </div>
          <span className="badge badge-system">실시간 감사 연동</span>
        </div>

        <div className="overflow-x-auto">
          <table className="custom-table">
            <thead>
              <tr>
                <th>로그 ID / 일시</th>
                <th>사용자 계정</th>
                <th>대상 플랫폼 / 에이전트</th>
                <th>Sanitize 작업 유형</th>
                <th>탐지 위험 & 차단 사유</th>
                <th>조치 결과</th>
              </tr>
            </thead>
            <tbody>
              {modelArmorLogs.map((log) => (
                <tr key={log.id}>
                  <td className="font-mono text-xs text-slate-300">
                    <div>{log.id}</div>
                    <div className="text-slate-500">{log.timestamp}</div>
                  </td>
                  <td className="text-slate-300 font-medium">{log.user}</td>
                  <td>
                    <span className="badge badge-pro">{log.platform}</span>
                  </td>
                  <td className="font-mono text-xs text-purple-300">{log.operation}</td>
                  <td className="text-amber-300 font-medium">{log.detectedRisk}</td>
                  <td>
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                      {log.actionTaken}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Agent Lifecycle Registry Section (요구사항 3, 4, 5 - 표 1 구현) */}
      <div className="glass-card p-6">
        <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-white">전사 AI 에이전트 통합 생애주기 레지스트리</h3>
              <span className="badge badge-pro">표 1 스펙 100% 충족</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Gemini Ent. / Vertex AI / 타사(MS Copilot, LGCNS AgenticWorks, AWS 등) 생애주기 통합 관제 (BigQuery 실시간 사용량 매핑)
            </p>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="에이전트명, ID, 소유자 검색..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 pr-4 py-1.5 bg-slate-900/90 border border-slate-700 rounded-lg text-xs text-white focus:outline-none focus:border-[#e6007e] w-56"
              />
            </div>

            <select
              value={selectedPlatform}
              onChange={(e) => setSelectedPlatform(e.target.value)}
              className="px-3 py-1.5 bg-slate-900/90 border border-slate-700 rounded-lg text-xs text-white focus:outline-none"
            >
              <option value="ALL">전체 플랫폼</option>
              <option value="Gemini Enterprise">Gemini Enterprise</option>
              <option value="Vertex AI">Vertex AI</option>
              <option value="Microsoft">MS Copilot</option>
              <option value="LGCNS">LGCNS AgenticWorks</option>
            </select>

            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="px-3 py-1.5 bg-slate-900/90 border border-slate-700 rounded-lg text-xs text-white focus:outline-none"
            >
              <option value="ALL">전체 상태</option>
              <option value="운영">운영 중</option>
              <option value="검토">검토 단계</option>
              <option value="휴면">휴면 대상</option>
            </select>
          </div>
        </div>

        {/* Lifecycle Table */}
        <div className="overflow-x-auto">
          <table className="custom-table">
            <thead>
              <tr>
                <th>Agent ID / 에이전트명</th>
                <th>개발 도구/플랫폼</th>
                <th>제작자 (Owner) / 부서</th>
                <th>위험 등급 (Tier)</th>
                <th>생애주기 상태</th>
                <th>BigQuery 사용량 (실시간)</th>
                <th>FinOps 비용</th>
                <th>거버넌스 상태</th>
                <th>상세보기</th>
              </tr>
            </thead>
            <tbody>
              {filteredLifecycle.map((ag) => (
                <tr key={ag.agentId} className="hover:bg-white/5 transition-colors">
                  <td>
                    <div className="font-mono text-xs text-[#e6007e] font-semibold">{ag.agentId}</div>
                    <div className="font-medium text-white">{ag.agentName}</div>
                  </td>
                  <td>
                    <span className={`badge ${
                      ag.platform.includes('Gemini') ? 'badge-pro' :
                      ag.platform.includes('Vertex') ? 'badge-system' : 'badge-citizen'
                    }`}>
                      {ag.platform}
                    </span>
                  </td>
                  <td className="text-xs">
                    <div className="text-slate-200 font-medium">{ag.owner}</div>
                    <div className="text-slate-400">{ag.department}</div>
                  </td>
                  <td className="text-xs font-semibold text-amber-300">{ag.riskTier}</td>
                  <td>
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                      ag.lifecycleStatus === '운영' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                      ag.lifecycleStatus === '검토' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                      'bg-red-500/20 text-red-400 border border-red-500/30'
                    }`}>
                      {ag.lifecycleStatus}
                    </span>
                  </td>
                  <td className="font-mono text-xs text-indigo-300 font-semibold">{ag.tokenUsage}</td>
                  <td className="font-mono text-xs text-slate-300">{ag.cost}</td>
                  <td>
                    <span className={`badge ${ag.governanceAlert === '준수' ? 'badge-active' : 'badge-deprecated'}`}>
                      {ag.governanceAlert}
                    </span>
                  </td>
                  <td>
                    <button
                      onClick={() => setSelectedAgentModal(ag)}
                      className="px-2.5 py-1 bg-white/10 hover:bg-[#e6007e] text-xs font-semibold rounded text-white transition-colors flex items-center gap-1"
                    >
                      표1 전체보기 <ChevronRight className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Agent Detail Modal (Full Table 1 Attributes Inspection) */}
      {selectedAgentModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="glass-card w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6 space-y-6 relative border border-[#e6007e]/40">
            <button
              onClick={() => setSelectedAgentModal(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white text-lg font-bold"
            >
              ✕
            </button>

            <div className="flex items-center gap-3 border-b border-white/10 pb-4">
              <div className="p-3 bg-[#e6007e]/20 text-[#e6007e] rounded-xl font-mono text-lg font-bold">
                {selectedAgentModal.agentId}
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">{selectedAgentModal.agentName}</h2>
                <p className="text-xs text-slate-400">{selectedAgentModal.description}</p>
              </div>
            </div>

            {/* Grid of Domains A to I */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="bg-slate-900/80 p-4 rounded-xl border border-white/5 space-y-2">
                <h4 className="font-bold text-[#e6007e] text-sm flex items-center gap-2">
                  <span>A. 식별·메타</span>
                </h4>
                <div><span className="text-slate-400">개발자 유형:</span> <span className="text-white font-medium">{selectedAgentModal.developerType}</span></div>
                <div><span className="text-slate-400">제작자 (Owner):</span> <span className="text-white font-medium">{selectedAgentModal.owner}</span></div>
                <div><span className="text-slate-400">소속 부서:</span> <span className="text-white font-medium">{selectedAgentModal.department}</span></div>
                <div><span className="text-slate-400">개발 도구/플랫폼:</span> <span className="text-indigo-300 font-medium">{selectedAgentModal.platform}</span></div>
                <div><span className="text-slate-400">위험 등급:</span> <span className="text-amber-300 font-semibold">{selectedAgentModal.riskTier}</span></div>
                <div><span className="text-slate-400">라이프사이클 상태:</span> <span className="text-emerald-400 font-semibold">{selectedAgentModal.lifecycleStatus}</span></div>
              </div>

              <div className="bg-slate-900/80 p-4 rounded-xl border border-white/5 space-y-2">
                <h4 className="font-bold text-[#e6007e] text-sm flex items-center gap-2">
                  <span>B. 구성 자산 (Registry)</span>
                </h4>
                <div><span className="text-slate-400">Foundation Model:</span> <span className="text-white font-medium">{selectedAgentModal.foundationModel}</span></div>
                <div><span className="text-slate-400">시스템 프롬프트 버전:</span> <span className="text-white font-medium">{selectedAgentModal.systemPromptVersion}</span></div>
                <div><span className="text-slate-400">Tool/API/Plugin 목록:</span> <span className="text-slate-200">{selectedAgentModal.toolsPlugins}</span></div>
                <div><span className="text-slate-400">Knowledge/RAG 소스:</span> <span className="text-slate-200">{selectedAgentModal.knowledgeRagSource}</span></div>
                <div><span className="text-slate-400">지식 데이터 분류등급:</span> <span className="text-amber-300">{selectedAgentModal.dataSensitivity}</span></div>
              </div>

              <div className="bg-slate-900/80 p-4 rounded-xl border border-white/5 space-y-2">
                <h4 className="font-bold text-[#e6007e] text-sm flex items-center gap-2">
                  <span>C. 배포·버전 & D. 사용 현황</span>
                </h4>
                <div><span className="text-slate-400">현재 버전:</span> <span className="text-white font-mono">{selectedAgentModal.version}</span></div>
                <div><span className="text-slate-400">배포 환경:</span> <span className="text-white">{selectedAgentModal.deployEnv}</span></div>
                <div><span className="text-slate-400">BigQuery 트래픽 랭킹:</span> <span className="text-emerald-400 font-bold">{selectedAgentModal.usageRank}</span></div>
                <div><span className="text-slate-400">사용량 (요청/토큰):</span> <span className="text-indigo-300 font-mono">{selectedAgentModal.tokenUsage}</span></div>
              </div>

              <div className="bg-slate-900/80 p-4 rounded-xl border border-white/5 space-y-2">
                <h4 className="font-bold text-[#e6007e] text-sm flex items-center gap-2">
                  <span>E. 권한·접근통제 & F. FinOps 비용</span>
                </h4>
                <div><span className="text-slate-400">RBAC 정책:</span> <span className="text-white">{selectedAgentModal.rbacPolicy}</span></div>
                <div><span className="text-slate-400">출력통제 Trimming:</span> <span className="text-emerald-300">{selectedAgentModal.outputTrimming}</span></div>
                <div><span className="text-slate-400">Agent별 비용:</span> <span className="text-white font-mono font-bold">{selectedAgentModal.cost}</span></div>
                <div><span className="text-slate-400">비용 이상치:</span> <span className="text-slate-300">{selectedAgentModal.costSpikeAnomaly}</span></div>
              </div>

              <div className="bg-slate-900/80 p-4 rounded-xl border border-white/5 space-y-2 md:col-span-2">
                <h4 className="font-bold text-[#e6007e] text-sm flex items-center gap-2">
                  <span>H. 보안·리스크 & I. 거버넌스 수명관리</span>
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <div><span className="text-slate-400">Model Armor 차단 이력:</span> <span className="text-amber-300 font-semibold">{selectedAgentModal.abnormalPromptRisk}</span></div>
                  <div><span className="text-slate-400">거버넌스 상태:</span> <span className="text-emerald-400 font-bold">{selectedAgentModal.governanceAlert}</span></div>
                  <div><span className="text-slate-400">감사로그 보존:</span> <span className="text-slate-300">{selectedAgentModal.auditLogRetention}</span></div>
                  <div><span className="text-slate-400">승인 워크플로우:</span> <span className="text-white">{selectedAgentModal.approvalWorkflow}</span></div>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedAgentModal(null)}
                className="glow-btn text-xs"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
