'use strict';

/*
 * AI 거버넌스 콘솔 — Google Gemini governance front-end.
 * Every number comes from the BFF (/api/*), which calls ONLY gcp-ai-usage-caps-api (/v1/*).
 * Security: no HTML-string injection (DOM built with createElement/textContent), no inline handlers,
 * no web storage, CSRF header on every state change.
 */
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SERVICES = [
    ['gemini_platform', 'Gemini Platform', 'Gemini API · Model Garden'],
    ['antigravity', 'Antigravity', '에이전트 개발 환경'],
    ['gemini_enterprise', 'Gemini Enterprise', '업무용 Gemini 앱'],
  ];
  const SURFACE_COLORS = { gemini_platform: '#4f8cff', antigravity: '#a78bfa', gemini_enterprise: '#22d3ee' };
  const GATE_LABELS = {
    G1_POLICY_READABLE: ['IAM Deny 정책 조회', '관리 대상 Deny 정책을 읽을 수 있는지'],
    G2_ANY_DETERMINATE: ['사용자 상태 판정', '모든 사용자의 상태가 확정 가능한지'],
    G3_TELEMETRY_HEALTHY: ['텔레메트리 정상', '사용량 로그가 정상 수집되는지'],
    G4_CHANGE_BUDGET: ['변경 예산 이내', '1회 집행 변경 수가 한도 이내인지'],
    G5_NON_USER_GRANT_ABSENT: ['우회 권한 차단', '그룹·도메인 권한 우회까지 차단되는지'],
    G6_DENY_CAPACITY: ['Deny 정책 용량', '정책당 차단 주체 수가 한도 이내인지'],
    G7_SURGE_GUARD: ['급증 가드', '대량 차단 급증을 방지하는지'],
  };
  const ACTION_LABELS = {
    'GET /api/overview': '개요 · 사용자 현황',
    'GET /api/user/detail': '사용자 상세 드릴다운',
    'GET /api/user/cap': '집행 상태 폴링 (fresh)',
    'GET /api/costs': '비용 탐색기',
    'GET /api/models/catalog': '모델 거버넌스',
    'GET /api/projects/overview': '정책 · 프로젝트',
    'GET /api/audit': '감사 · 위반',
    'POST /api/caps/policy': '전역 정책 저장',
    'POST /api/caps/enforce': 'G1–G7 집행 점검',
    'POST /api/caps/users/set': '사용자 한도 저장',
    'POST /api/caps/users/delete': '사용자 한도 삭제',
    'POST /api/users/block': '사용자 즉시 차단',
    'POST /api/users/unblock': '사용자 차단 해제',
    'POST /api/model-rules/default/set': '기본 모델 규칙 저장',
    'POST /api/model-rules/default/delete': '기본 모델 규칙 삭제',
    'POST /api/model-rules/user/set': '사용자 모델 규칙 저장',
    'POST /api/model-rules/user/delete': '사용자 모델 규칙 삭제',
    'POST /api/model-rules/evaluate': '모델 규칙 평가',
    'POST /api/model-access/toggle': 'Org Policy 모델 접근',
    'POST /api/caps/projects/set': '프로젝트 하드캡 설정',
    'POST /api/caps/projects/lift': '프로젝트 하드캡 해제',
    'POST /api/projects/inference-logging/enable': '추론 로그 활성화',
  };
  const PAGE_META = {
    overview: ['Google Gemini · Caps REST API', '거버넌스 개요', 'Google Gemini 사용량 · 비용 · 통제 현황을 기존 OpenAI · Anthropic 거버넌스와 한 화면에서'],
    users: ['사용자 거버넌스', '사용자 & 차단', '사용자별 사용량 추적, 예산 한도, IAM Deny 기반 즉시 차단 · 해제'],
    costs: ['FinOps', '비용 탐색기', '공식 Cloud Billing Catalog SKU 단가 × 로그 토큰 수 기반 사용자 · 모델별 추정 비용'],
    models: ['모델 통제', '모델 거버넌스', 'Org Policy 모델 접근 제어와 모델별 예산 규칙 — 모든 변경은 Dry-run 영향 미리보기 후 적용'],
    policies: ['정책 · 안전장치', '정책 & 안전 게이트', '전역 지출 한도, 프로젝트 하드캡, IAM Deny 집행 전 안전 게이트 G1–G7'],
    audit: ['컴플라이언스', '감사 & 위반', '모델 규칙 위반 이벤트와 모든 거버넌스 변경의 감사 로그'],
  };

  const state = {
    authenticated: false,
    csrf: '',
    hub: '',
    spokes: [],
    managed: [],
    tab: 'overview',
    project: 'all',
    start: '',
    end: '',
    fresh: false,
    mask: true,
    overview: null,
    costs: null,
    models: null,
    projects: null,
    audit: null,
    loaded: {},
    userSearch: '',
    userStatus: 'all',
    costView: 'users',
    costSearch: '',
    costSort: { users: { key: 'estimated_cost', dir: 'desc' }, models: { key: 'estimated_cost', dir: 'desc' } },
    trace: { seq: 0, calls: [], open: false, expanded: new Set(), host: '', inflight: 0, live: null, pulling: false, again: false },
    drawerEmail: null,
    drawerData: null,
    trackers: new Map(),
    trackerShown: null,
    ma: { action: 'restrict', lastDryKey: null },
    ruleScope: null,
  };

  // ---------------------------------------------------------------------------
  // DOM helpers (no HTML-string parsing)
  // ---------------------------------------------------------------------------
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === 'className') node.className = String(val);
      else if (key === 'text') node.textContent = String(val);
      else if (key === 'dataset') for (const [dk, dv] of Object.entries(val)) node.dataset[dk] = String(dv);
      else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
      else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') node[key] = Boolean(val);
      else if (key === 'value') node.value = String(val);
      else node.setAttribute(key, val === true ? '' : String(val));
    }
    appendAll(node, children);
    return node;
  }
  function appendAll(node, children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendAll(node, child);
      else node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
  }
  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'text') node.textContent = String(v);
      else node.setAttribute(k, String(v));
    }
    for (const c of children) if (c) node.appendChild(c);
    return node;
  }
  const ICONS = {
    dollar: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.7-1.1-3.3-3.2-3.8V3h-3v2.2C8.1 5.6 6.5 6.9 6.5 8.8c0 2.3 1.9 3.4 4.6 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H6.2c.1 2.2 1.8 3.5 3.8 3.9V21h3v-2.1c1.9-.4 3.5-1.5 3.5-3.6 0-2.9-2.5-3.9-4.7-4.4z',
    bolt: 'M7 2v11h3v9l7-12h-4l4-8z',
    layers: 'M12 16.5 3.5 11 2 12l10 6.5L22 12l-1.5-1zM12 13 22 6.5 12 0 2 6.5z',
    users: 'M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z',
    alert: 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z',
    shield: 'M12 1 3 5v6c0 5.5 3.8 10.7 9 12 5.2-1.3 9-6.5 9-12V5zm0 6a2 2 0 0 1 2 2v2h1v6H9v-6h1V9a2 2 0 0 1 2-2zm0 1.5a.5.5 0 0 0-.5.5v2h1V9a.5.5 0 0 0-.5-.5z',
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    x: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z',
    spin: 'M12 4V1L8 5l4 4V6a6 6 0 0 1 6 6h2a8 8 0 0 0-8-8z',
    lock: 'M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9z',
    unlock: 'M18 8h-1V6A5 5 0 0 0 7.1 5l1.9.6A3 3 0 0 1 15 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2z',
    cpu: 'M9 9h6v6H9zm12 2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2zm-4 6H7V7h10z',
    warn: 'M12 2 1 21h22zm1 15h-2v-2h2zm0-4h-2V9h2z',
    info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 10 10A10 10 0 0 0 12 2z',
  };
  function icon(name, cls) {
    return svg('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', class: cls || null, 'aria-hidden': 'true' }, [svg('path', { d: ICONS[name] || ICONS.info })]);
  }
  const $ = (id) => document.getElementById(id);
  const clear = (node) => { node.replaceChildren(); return node; };
  const nextFrame = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

  function setWidth(span, pct) {
    const v = `${Math.max(0, Math.min(100, Number(pct) || 0)).toFixed(2)}%`;
    if (REDUCED_MOTION) span.style.width = v;
    else nextFrame(() => { span.style.width = v; });
  }
  function bar(pct, cls = '') {
    const fill = el('span');
    setWidth(fill, pct);
    return el('div', { className: `bar ${cls}`.trim(), role: 'presentation' }, [fill]);
  }
  function utilClass(pct) {
    if (pct === null || pct === undefined) return '';
    if (pct >= 100) return 'danger';
    if (pct >= 80) return 'warn';
    return 'ok';
  }

  // ---------------------------------------------------------------------------
  // Formatters & masking
  // ---------------------------------------------------------------------------
  const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
  function fmtUSD(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    if (n === 0) return '$0.00';
    if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const fmtInt = (v) => num(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  function fmtCompact(v) {
    const n = num(v);
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }
  const fmtPct = (v, d = 1) => (v === null || v === undefined ? '—' : `${num(v).toFixed(d)}%`);
  function fmtDateTime(iso, withSec = false) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: withSec ? '2-digit' : undefined, hour12: false });
  }
  function fmtRel(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return String(iso);
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 0) { const f = -s; if (f < 3600) return `${Math.max(1, Math.round(f / 60))}분 후`; if (f < 86400) return `${Math.round(f / 3600)}시간 후`; return `${Math.round(f / 86400)}일 후`; }
    if (s < 60) return '방금 전';
    if (s < 3600) return `${Math.round(s / 60)}분 전`;
    if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
    return `${Math.round(s / 86400)}일 전`;
  }
  function slug(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function maskEmail(email) {
    const raw = String(email || '');
    if (!state.mask || !raw.includes('@')) return raw;
    const at = raw.indexOf('@');
    const local = raw.slice(0, at);
    const keep = local.length <= 3 ? 1 : Math.min(4, Math.ceil(local.length / 3));
    return `${local.slice(0, keep)}•••${raw.slice(at)}`;
  }
  const EMAIL_RE = /([A-Za-z0-9._+-]+)(@|%40)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
  function maskText(text) {
    const s = String(text ?? '');
    if (!state.mask) return s;
    return s.replace(EMAIL_RE, (m, local, at, domain) => {
      const keep = local.length <= 3 ? 1 : Math.min(4, Math.ceil(local.length / 3));
      return `${local.slice(0, keep)}•••${at}${domain}`;
    });
  }
  function surfaceLabel(s) {
    const found = SERVICES.find(([id]) => id === s);
    if (found) return found[1];
    if (s === 'vertex_ai') return 'Gemini Platform';
    return String(s || '—');
  }
  const isHub = (pid) => pid === state.hub;
  function projectTag(pid, withId = true) {
    const hub = isHub(pid);
    return el('span', { className: 'chips' }, [
      el('span', { className: `tag ${hub ? 'tag-hub' : 'tag-spoke'}`, text: hub ? 'HUB' : 'SPOKE' }),
      withId ? el('span', { className: 'mono small', text: pid }) : null,
    ]);
  }
  function svcChip(s) { return el('span', { className: `chip svc-${s}`, text: surfaceLabel(s) }); }
  function avatar(email) {
    const raw = String(email || '?');
    let h = 0;
    for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) % 360;
    const node = el('span', { className: 'avatar', 'aria-hidden': 'true', text: raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?' });
    node.style.background = `linear-gradient(135deg, hsl(${h} 72% 58%), hsl(${(h + 48) % 360} 70% 44%))`;
    return node;
  }

  const STATUS_META = {
    active: ['정상', 'st-active'],
    over_cap: ['한도 초과', 'st-over_cap'],
    suspended: ['자동 정지', 'st-suspended'],
    blocked: ['차단됨', 'st-blocked'],
  };
  function statusBadge(status, id) {
    const [label, cls] = STATUS_META[status] || [status || '—', 'st-unknown'];
    return el('span', { className: `badge ${cls}`, id: id || null, dataset: { status: status || 'unknown' } }, [el('span', { className: 'bdot', 'aria-hidden': 'true' }), label]);
  }
  function enfBadge(enf, opts = {}) {
    const e = enf || 'none';
    if (e === 'propagating') {
      return el('span', { className: 'enf enf-propagating', dataset: { enforcement: e } }, [el('span', { className: 'spinner', 'aria-hidden': 'true' }), opts.restore ? 'IAM Deny 갱신 중' : 'IAM Deny 전파 중']);
    }
    if (e === 'enforced') return el('span', { className: 'enf enf-enforced', dataset: { enforcement: e } }, [icon('lock'), '차단 적용됨']);
    if (opts.restored) return el('span', { className: 'enf enf-restored', dataset: { enforcement: e } }, [icon('unlock'), '해제 완료']);
    return el('span', { className: 'enf enf-none', dataset: { enforcement: e } }, '미차단');
  }

  // ---------------------------------------------------------------------------
  // Toasts & confirm dialog
  // ---------------------------------------------------------------------------
  function toast(message, kind = 'info', ms = 4200) {
    const node = el('div', { className: `toast ${kind}` }, [el('span', { text: maskText(message) })]);
    $('toast-region').appendChild(node);
    window.setTimeout(() => {
      node.classList.add('leaving');
      window.setTimeout(() => node.remove(), 380);
    }, ms);
  }
  function askConfirm(message, okLabel = '확인', danger = true) {
    return new Promise((resolve) => {
      const dlg = $('confirm-dialog');
      $('confirm-message').textContent = maskText(message);
      const ok = $('confirm-ok-btn');
      ok.textContent = okLabel;
      ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        ok.removeEventListener('click', onOk);
        $('confirm-cancel-btn').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(v);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onClose = () => done(false);
      ok.addEventListener('click', onOk);
      $('confirm-cancel-btn').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }
  async function withLoading(btn, fn) {
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }
    try { return await fn(); } finally { if (btn) { btn.classList.remove('loading'); btn.disabled = false; } }
  }

  // ---------------------------------------------------------------------------
  // BFF transport (+ API Call Inspector feed)
  // ---------------------------------------------------------------------------
  function beginRequest() {
    state.trace.inflight += 1;
    if (state.trace.open && !state.trace.live) state.trace.live = window.setInterval(pullTrace, 650);
  }
  function endRequest() {
    state.trace.inflight = Math.max(0, state.trace.inflight - 1);
    if (state.trace.inflight === 0 && state.trace.live) { window.clearInterval(state.trace.live); state.trace.live = null; }
    pullTrace();
  }
  async function request(method, path, { params, body } = {}) {
    let url = path;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      if (qs.toString()) url += `?${qs.toString()}`;
    }
    const headers = { Accept: 'application/json' };
    const init = { method, credentials: 'same-origin', headers };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = state.csrf;
      init.body = JSON.stringify(body || {});
    }
    const track = path !== '/api/_trace' && !path.startsWith('/api/auth/');
    if (track) beginRequest();
    try {
      const resp = await fetch(url, init);
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401 && !path.startsWith('/api/auth/')) {
        handleUnauthorized();
        throw new Error('세션이 만료되었습니다. 다시 로그인하세요.');
      }
      if (!resp.ok) {
        const err = new Error((data.error && data.error.message) || `요청 실패 (HTTP ${resp.status})`);
        err.status = resp.status;
        err.code = data.error && data.error.code;
        throw err;
      }
      return data;
    } finally {
      if (track) endRequest();
    }
  }
  const apiGet = (path, params) => request('GET', path, { params });
  const apiPost = (path, body) => request('POST', path, { body });

  function handleUnauthorized() {
    if (!state.authenticated) return;
    state.authenticated = false;
    state.csrf = '';
    stopAllTrackers();
    showAuth();
    checkAuthStatus();
  }

  // ---------------------------------------------------------------------------
  // Count-up animation
  // ---------------------------------------------------------------------------
  function countUp(node, target, formatter) {
    const to = num(target);
    const from = num(node.dataset.value);
    node.dataset.value = String(to);
    if (REDUCED_MOTION || from === to) { node.textContent = formatter(to); return; }
    const dur = 1100;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - p) ** 3;
      node.textContent = formatter(from + (to - from) * e);
      if (p < 1 && node.dataset.value === String(to)) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------------------
  // Auth lifecycle
  // ---------------------------------------------------------------------------
  function showAuth() {
    $('app-shell').hidden = true;
    $('auth-view').hidden = false;
    closeInspector();
  }
  function applyProjectInfo(info) {
    state.hub = info.hub_project || state.hub;
    state.spokes = info.spoke_projects || state.spokes;
    state.managed = info.managed_projects || [state.hub, ...state.spokes];
    $('hub-chip-id').textContent = state.hub;
    $('spoke-chip-id').textContent = state.spokes.join(', ');
    $('proj-hub').dataset.project = state.hub;
    $('proj-hub').textContent = `Hub · ${state.hub}`;
    $('proj-spoke').dataset.project = state.spokes[0] || '';
    $('proj-spoke').textContent = `Spoke · ${state.spokes[0] || '—'}`;
    $('auth-subtitle').textContent = `Hub(${state.hub}) · Spoke(${state.spokes.join(', ')}) — OpenAI · Anthropic · Google Gemini 통합 거버넌스`;
  }
  async function checkAuthStatus() {
    const alertBox = $('auth-alert');
    alertBox.hidden = true;
    try {
      const info = await apiGet('/api/auth/status');
      state.csrf = info.csrf_token || '';
      applyProjectInfo(info);
      if (info.authenticated) {
        enterApp();
      } else {
        state.authenticated = false;
        showAuth();
        $('setup-form').hidden = !info.needs_setup;
        $('login-form').hidden = Boolean(info.needs_setup);
        if (!info.needs_setup && info.auth_configured === false) {
          alertBox.textContent = '서버에 관리자 비밀번호 해시(DASHBOARD_ADMIN_PASSWORD_HASH)가 설정되지 않았습니다.';
          alertBox.hidden = false;
        }
        window.setTimeout(() => { const f = info.needs_setup ? $('setup-password') : $('login-password'); if (f) f.focus(); }, 50);
      }
    } catch (err) {
      alertBox.textContent = err.message || '서버 상태를 확인할 수 없습니다.';
      alertBox.hidden = false;
      $('auth-view').hidden = false;
    }
  }
  function enterApp() {
    state.authenticated = true;
    $('auth-view').hidden = true;
    $('app-shell').hidden = false;
    initDefaultDates();
    renderGateGrid(null);
    switchTab(state.tab, true);
    pullTrace();
    startAutoRefresh();
  }
  // Enforcement can also happen server-side (scheduler, real-time model-violation detection, automatic cap
  // enforcement). Refresh the overview/users view every 30 s while it is visible so those changes appear without
  // a manual refresh; the auto tracker then follows any user that is still propagating.
  let autoRefreshTimer = null;
  function startAutoRefresh() {
    if (autoRefreshTimer) return;
    autoRefreshTimer = window.setInterval(() => {
      if (!state.authenticated || document.visibilityState !== 'visible') return;
      if (state.tab !== 'overview' && state.tab !== 'users') return;
      if (document.querySelector('dialog[open]')) return;
      loadTab(state.tab, true);
    }, 30000);
  }
  async function onLogin(e) {
    e.preventDefault();
    const pw = $('login-password').value;
    if (!pw) { $('login-password').focus(); return; }
    await withLoading($('login-submit'), async () => {
      try {
        const data = await apiPost('/api/auth/login', { password: pw });
        state.csrf = data.csrf_token;
        $('login-password').value = '';
        enterApp();
      } catch (err) {
        $('auth-alert').textContent = err.message;
        $('auth-alert').hidden = false;
      }
    });
  }
  async function onSetup(e) {
    e.preventDefault();
    const pw = $('setup-password').value;
    const cf = $('setup-password-confirm').value;
    await withLoading($('setup-submit'), async () => {
      try {
        const data = await apiPost('/api/auth/setup', { password: pw, confirm_password: cf });
        state.csrf = data.csrf_token;
        enterApp();
      } catch (err) {
        $('auth-alert').textContent = err.message;
        $('auth-alert').hidden = false;
      }
    });
  }
  async function onLogout() {
    try { await apiPost('/api/auth/logout', {}); } catch (_) { /* ignore */ }
    state.authenticated = false;
    stopAllTrackers();
    state.loaded = {};
    state.trace.calls = [];
    state.trace.seq = 0;
    renderInspector(true);
    showAuth();
    checkAuthStatus();
  }

  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function initDefaultDates() {
    if (state.start && state.end) return;
    const now = new Date();
    state.end = isoDate(now);
    state.start = `${state.end.slice(0, 8)}01`;
    $('filter-start').value = state.start;
    $('filter-end').value = state.end;
  }
  const filterKey = () => `${state.project}|${state.start}|${state.end}|${state.fresh}`;

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  function switchTab(tab, force = false) {
    state.tab = tab;
    for (const btn of document.querySelectorAll('.nav-item[data-tab]')) {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of document.querySelectorAll('.panel')) {
      const on = p.id === `panel-${tab}`;
      p.hidden = !on;
      p.classList.toggle('active', on);
    }
    const [eyebrow, title, sub] = PAGE_META[tab];
    $('page-eyebrow').textContent = eyebrow;
    $('page-title').textContent = title;
    $('page-subtitle').textContent = sub;
    $('filter-bar').hidden = !['overview', 'users', 'costs', 'models'].includes(tab);
    loadTab(tab, force);
  }
  async function loadTab(tab, force = false) {
    try {
      if (tab === 'overview' || tab === 'users') {
        await ensureOverview(force);
        renderOverview();
        renderUsers();
      } else if (tab === 'costs') {
        await ensureCosts(force);
        renderCosts();
      } else if (tab === 'models') {
        await ensureModels(force);
        renderModels();
      } else if (tab === 'policies') {
        await Promise.all([ensureProjects(force), ensureOverview(false)]);
        renderPolicies();
      } else if (tab === 'audit') {
        await ensureAudit(force);
        renderAudit();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  function showPartialErrors(data) {
    const box = $('global-warning');
    const errs = (data && data.partial_errors) || {};
    const keys = Object.keys(errs);
    if (keys.length) {
      box.textContent = `일부 API 응답 지연/오류 (${keys.join(', ')}): ${Object.values(errs)[0]}`;
      box.hidden = false;
    } else box.hidden = true;
  }
  async function ensureOverview(force) {
    const key = filterKey();
    if (!force && state.overview && state.loaded.overview === key) return;
    if (!state.overview) renderOverviewSkeleton();
    const data = await apiGet('/api/overview', { start: state.start, end: state.end, project: state.project, fresh: state.fresh ? 'true' : 'false' });
    state.overview = data;
    state.loaded.overview = key;
    // Keep in-flight tracker state authoritative over a slower snapshot.
    for (const t of state.trackers.values()) if (!t.done && t.lastCap) mergeCapIntoUser(t.email, t.lastCap);
    showPartialErrors(data);
    renderHeaderHealth(data.health);
    autoTrackPropagating();
  }
  // Any user whose IAM Deny change is still rolling out (manual block/unblock, cap enforcement,
  // scheduler, model-rule violation) is polled automatically until the lifecycle settles.
  function autoTrackPropagating() {
    for (const u of usersList()) {
      const key = String(u.email).toLowerCase();
      const t = state.trackers.get(key);
      if (u.enforcement_status === 'propagating' && (!t || t.done)) {
        const hasKeys = (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0;
        const restoring = !(u.blocked_services || []).length && !(u.pending_blocked_services || []).length &&
          !hasKeys(u.blocked_projects) && !hasKeys(u.pending_blocked_projects);
        window.setTimeout(() => startTracking(u.email, restoring ? 'unblock' : 'block', u), 0);
      }
    }
  }
  async function ensureCosts(force) {
    const key = filterKey();
    if (!force && state.costs && state.loaded.costs === key) return;
    const data = await apiGet('/api/costs', { start: state.start, end: state.end, project: state.project });
    state.costs = data;
    state.loaded.costs = key;
    showPartialErrors(data);
  }
  async function ensureModels(force) {
    const key = filterKey();
    if (!force && state.models && state.loaded.models === key) return;
    const data = await apiGet('/api/models/catalog', { start: state.start, end: state.end, project: state.project });
    state.models = data;
    state.loaded.models = key;
    showPartialErrors(data);
  }
  async function ensureProjects(force) {
    if (!force && state.projects) return;
    state.projects = await apiGet('/api/projects/overview');
    showPartialErrors(state.projects);
  }
  async function ensureAudit(force) {
    if (!force && state.audit) return;
    state.audit = await apiGet('/api/audit', { limit: 200 });
    showPartialErrors(state.audit);
    const n = (state.audit.violations || []).length;
    $('nav-badge-audit').hidden = n === 0;
    $('nav-badge-audit').textContent = String(n);
  }

  function renderHeaderHealth(health) {
    const badge = $('health-badge');
    if (health && health.status === 'ok') {
      badge.className = 'health-badge ok';
      $('health-text').textContent = `Caps API v${health.version || '?'} · 정상`;
      $('side-api-version').textContent = `v${health.version || '?'}`;
    } else {
      badge.className = 'health-badge bad';
      $('health-text').textContent = 'Caps API 점검 필요';
    }
  }

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------
  function renderOverviewSkeleton() {
    const grid = clear($('kpi-grid'));
    for (let i = 0; i < 6; i += 1) grid.appendChild(el('div', { className: 'kpi glass' }, [el('div', { className: 'skeleton sk-line' }), el('div', { className: 'skeleton sk-block' })]));
  }
  function kpiCard({ id, label, value, formatter, sub, iconName, tone }) {
    const valueNode = el('div', { className: 'kpi-value', id: `${id}-value`, text: formatter(0) });
    const card = el('div', { className: `kpi glass k-${tone}`, id }, [
      el('div', { className: 'kpi-top' }, [el('span', { className: 'kpi-label', text: label }), el('span', { className: 'kpi-icon' }, [icon(iconName)])]),
      valueNode,
      el('div', { className: 'kpi-sub', text: sub || '' }),
    ]);
    countUp(valueNode, value, formatter);
    return card;
  }
  function usersList() { return (state.overview && state.overview.users) || []; }
  function enforcementCounts() {
    const users = usersList();
    return {
      enforced: users.filter((u) => u.enforcement_status === 'enforced').length,
      propagating: users.filter((u) => u.enforcement_status === 'propagating').length,
      blocked: users.filter((u) => u.status === 'blocked' || u.status === 'suspended').length,
    };
  }
  function renderOverview() {
    const d = state.overview;
    if (!d) return;
    const s = d.summary || {};
    const cs = d.caps_summary || {};
    const ps = d.pricing_source || {};
    const ec = enforcementCounts();

    renderHeroStats();

    const grid = clear($('kpi-grid'));
    grid.append(
      kpiCard({ id: 'kpi-cost', label: 'Google AI 추정 비용', value: s.total_estimated_cost, formatter: fmtUSD, sub: `공식 SKU 단가 ${fmtInt(ps.official_sku_models)}개 모델 기준`, iconName: 'dollar', tone: 'blue' }),
      kpiCard({ id: 'kpi-requests', label: '총 요청 수', value: s.total_requests, formatter: fmtInt, sub: `미귀속 요청 ${fmtInt(s.unattributed_requests)}건`, iconName: 'bolt', tone: 'violet' }),
      kpiCard({ id: 'kpi-tokens', label: '총 토큰', value: s.total_tokens, formatter: fmtCompact, sub: '입력 · 출력 · 캐시 포함', iconName: 'layers', tone: 'cyan' }),
      kpiCard({ id: 'kpi-users', label: '활성 사용자', value: s.active_users, formatter: fmtInt, sub: `Hub+Spoke 동시 사용 ${fmtInt(s.multi_project_users)}명`, iconName: 'users', tone: 'green' }),
      kpiCard({ id: 'kpi-overcap', label: '한도 초과', value: cs.over_cap, formatter: fmtInt, sub: `자동 정지 ${fmtInt(cs.suspended)}명`, iconName: 'alert', tone: 'amber' }),
      kpiCard({ id: 'kpi-blocked', label: '차단 · IAM Deny 적용', value: num(cs.blocked) + num(cs.suspended), formatter: fmtInt, sub: `적용됨 ${ec.enforced} · 전파 중 ${ec.propagating}`, iconName: 'shield', tone: 'red' }),
    );

    renderProjectCards();
    renderVendorCoverage();
    renderTopModels();
    renderSurfaceDonut();
    renderTopUsers();
    renderEngineCard();

    const nb = $('nav-badge-users');
    const blockedN = num(cs.blocked) + num(cs.suspended);
    nb.hidden = blockedN === 0;
    nb.textContent = String(blockedN);
  }
  function traceStats() {
    const calls = state.trace.calls;
    const n = calls.length;
    const avg = n ? Math.round(calls.reduce((a, c) => a + num(c.latency_ms), 0) / n) : 0;
    const errors = calls.filter((c) => c.status >= 400).length;
    return { n, avg, errors };
  }
  function renderHeroStats() {
    const box = $('hero-stats');
    if (!box) return;
    const d = state.overview || {};
    const health = d.health || {};
    const enf = health.enforcement || {};
    const last = enf.last_run || {};
    const ts = traceStats();
    const stat = (id, label, value, sub) => el('div', { className: 'hero-stat', id }, [
      el('div', { className: 'hs-label', text: label }),
      el('div', { className: 'hs-value', text: value }),
      el('div', { className: 'hs-sub', text: sub }),
    ]);
    clear(box).append(
      stat('hero-api-version', '연동 API', health.version ? `v${health.version}` : '—', health.status === 'ok' ? 'gcp-ai-usage-caps-api · 정상' : '상태 확인 필요'),
      stat('hero-api-calls', '이번 세션 REST 호출', `${fmtInt(ts.n)}건`, `오류 ${ts.errors}건 · SDK 호출 0건`),
      stat('hero-api-latency', '평균 응답 지연', ts.n ? `${fmtInt(ts.avg)} ms` : '—', 'BFF → Caps API 왕복'),
      stat('hero-last-run', '마지막 자동 집행', last.at ? fmtRel(last.at) : '—', last.at ? `${last.result || '—'} · ${last.trigger || ''} · 차단 ${num(last.blocked)} / 복구 ${num(last.restored)}` : '집행 기록 없음'),
    );
  }
  function projectCostShare() {
    const totals = (state.overview && state.overview.project_totals) || [];
    const total = totals.reduce((a, p) => a + num(p.estimated_cost), 0);
    return { totals, total };
  }
  function renderProjectCards() {
    const box = clear($('project-cards'));
    const { totals, total } = projectCostShare();
    const caps = (state.overview && state.overview.project_caps) || [];
    for (const p of totals) {
      const hub = isHub(p.project_id);
      const capRow = caps.find((c) => c.project_id === p.project_id) || {};
      const cfg = capRow.configured;
      const costNode = el('div', { className: 'pc-cost', text: fmtUSD(0) });
      countUp(costNode, p.estimated_cost, fmtUSD);
      const share = total ? (num(p.estimated_cost) / total) * 100 : 0;
      let capBlock;
      if (cfg && cfg.monthly_usd) {
        const util = (num(p.estimated_cost) / num(cfg.monthly_usd)) * 100;
        capBlock = el('div', { className: 'pc-cap' }, [
          el('div', { className: 'pc-cap-row' }, [el('span', { text: `월 하드캡 ${fmtUSD(cfg.monthly_usd)} · ${cfg.action === 'notify' ? '알림' : '하드캡'}` }), el('b', { text: fmtPct(util, 2) })]),
          bar(Math.max(util, 0.8), utilClass(util)),
        ]);
      } else {
        capBlock = el('div', { className: 'pc-cap' }, [el('div', { className: 'pc-cap-row' }, [el('span', { className: 'muted', text: '월 하드캡 미설정' }), el('span', { className: 'muted', text: '정책 탭에서 설정' })])]);
      }
      box.appendChild(el('div', { className: `project-card ${hub ? 'hub' : 'spoke'}`, id: `project-card-${p.project_id}` }, [
        el('div', { className: 'pc-head' }, [
          el('span', { className: 'pc-id', text: p.project_id }),
          el('span', { className: `tag ${hub ? 'tag-hub' : 'tag-spoke'}`, text: hub ? 'HUB' : 'SPOKE' }),
        ]),
        el('div', {}, [costNode, el('div', { className: 'muted small', text: `전체 비용의 ${fmtPct(share)}` })]),
        bar(share, hub ? '' : 'cyan'),
        el('div', { className: 'pc-meta' }, [
          el('div', {}, ['사용자', el('b', { text: fmtInt(p.active_users) })]),
          el('div', {}, ['요청', el('b', { text: fmtInt(p.requests) })]),
          el('div', {}, ['토큰', el('b', { text: fmtCompact(p.total_tokens) })]),
        ]),
        capBlock,
      ]));
    }
    $('project-cards-sub').textContent = `${state.overview.range.start} ~ ${state.overview.range.end} · ${state.project === 'all' ? '전체 프로젝트' : state.project}`;
  }
  function renderVendorCoverage() {
    const box = clear($('vendor-coverage'));
    const s = (state.overview && state.overview.summary) || {};
    const legacy = (id, mono, monoCls, name, desc) => el('div', { className: 'vc-row legacy', id }, [
      el('span', { className: `vmono ${monoCls}`, text: mono, 'aria-hidden': 'true' }),
      el('div', {}, [el('div', { className: 'vc-name', text: name }), el('div', { className: 'vc-desc', text: desc })]),
      el('span', { className: 'vc-state', text: '기존 연동 (별도 시스템)' }),
    ]);
    box.append(
      legacy('vc-openai', 'O', 'v-openai', 'OpenAI', '사내 기존 거버넌스 모듈에서 관리 · 이 화면 수치에 미포함'),
      legacy('vc-anthropic', 'A', 'v-anthropic', 'Anthropic', '직접 계약분은 기존 모듈에서 관리 · Gemini Platform 경유 Claude는 Google 데이터에 포함'),
      el('div', { className: 'vc-row new', id: 'vc-google' }, [
        el('span', { className: 'vmono v-google', text: 'G', 'aria-hidden': 'true' }),
        el('div', {}, [
          el('div', { className: 'vc-name', text: 'Google Gemini' }),
          el('div', { className: 'vc-desc', text: 'gcp-ai-usage-caps-api REST 연동 · 사용량 · 비용 · 차단 · 모델 통제' }),
          el('div', { className: 'vc-metrics' }, [
            el('span', {}, ['비용', el('b', { text: fmtUSD(s.total_estimated_cost) })]),
            el('span', {}, ['사용자', el('b', { text: fmtInt(s.active_users) })]),
            el('span', {}, ['요청', el('b', { text: fmtInt(s.total_requests) })]),
          ]),
        ]),
        el('span', { className: 'vc-state', text: 'Caps API 신규 연동' }),
      ]),
    );
  }
  function renderTopModels() {
    const box = clear($('chart-top-models'));
    const models = ((state.overview && state.overview.top_models) || []).slice().sort((a, b) => num(b.estimated_cost) - num(a.estimated_cost)).slice(0, 7);
    if (!models.length) { box.appendChild(el('p', { className: 'muted', text: '이 기간 모델 사용 기록이 없습니다.' })); return; }
    const max = Math.max(...models.map((m) => num(m.estimated_cost)), 0.000001);
    models.forEach((m) => {
      box.appendChild(el('div', { className: 'hbar' }, [
        el('div', { className: 'hbar-name' }, [
          el('b', { text: m.model, title: m.model }),
          el('small', { text: `${m.publisher || '—'} · ${(m.surfaces || [m.surface]).map(surfaceLabel).join(', ')} · ${fmtInt(m.active_users)}명` }),
        ]),
        bar((num(m.estimated_cost) / max) * 100),
        el('div', { className: 'hbar-val', text: fmtUSD(m.estimated_cost) }),
      ]));
    });
  }
  function renderSurfaceDonut() {
    const box = clear($('chart-surface'));
    const agg = {};
    for (const u of usersList()) for (const m of u.by_model || []) {
      const sname = m.surface || 'unknown';
      agg[sname] = agg[sname] || { cost: 0, requests: 0 };
      agg[sname].cost += num(m.estimated_cost);
      agg[sname].requests += num(m.requests);
    }
    for (const u of usersList()) for (const sname of u.surfaces || []) { agg[sname] = agg[sname] || { cost: 0, requests: 0 }; }
    const entries = Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost);
    const total = entries.reduce((a, [, v]) => a + v.cost, 0);
    const R = 70;
    const C = 2 * Math.PI * R;
    const svgNode = svg('svg', { viewBox: '0 0 190 190', class: 'donut', role: 'img', 'aria-label': '서비스별 비용 구성' }, [svg('circle', { cx: 95, cy: 95, r: R, class: 'donut-track' })]);
    let offset = 0;
    const segs = [];
    for (const [sname, v] of entries) {
      const frac = total ? v.cost / total : 0;
      const c = svg('circle', { cx: 95, cy: 95, r: R, class: 'seg', stroke: SURFACE_COLORS[sname] || '#94a3b8', 'stroke-dasharray': `0 ${C}`, 'stroke-dashoffset': -offset * C });
      svgNode.appendChild(c);
      segs.push([c, frac]);
      offset += frac;
    }
    svgNode.append(
      svg('text', { x: 95, y: 92, 'text-anchor': 'middle', class: 'donut-center', text: fmtUSD(total) }),
      svg('text', { x: 95, y: 110, 'text-anchor': 'middle', class: 'donut-center-sub', text: '서비스 합계' }),
    );
    box.appendChild(svgNode);
    const apply = () => { for (const [c, frac] of segs) c.setAttribute('stroke-dasharray', `${Math.max(0, frac * C - (frac > 0.02 ? 2 : 0))} ${C}`); };
    if (REDUCED_MOTION) apply(); else nextFrame(apply);
    const tokenSources = (state.overview.telemetry || {}).token_sources || {};
    const legend = el('div', { className: 'legend' });
    for (const [sname, v] of entries) {
      const dot = el('span', { className: 'legend-dot' });
      dot.style.background = SURFACE_COLORS[sname] || '#94a3b8';
      legend.appendChild(el('div', { className: 'legend-row' }, [
        dot,
        el('span', { text: tokenSources[sname] === 'requests_only' ? `${surfaceLabel(sname)} · 요청 수만 집계` : surfaceLabel(sname) }),
        el('span', { className: 'lv', text: fmtUSD(v.cost) }),
        el('span', { className: 'lp', text: total ? fmtPct((v.cost / total) * 100, 0) : '0%' }),
      ]));
    }
    box.appendChild(legend);
  }
  function hubSpokeCost(byProject) {
    let hub = 0;
    let spoke = 0;
    for (const bp of byProject || []) {
      if (isHub(bp.project)) hub += num(bp.estimated_cost);
      else spoke += num(bp.estimated_cost);
    }
    return { hub, spoke };
  }
  function splitBar(byProject) {
    const { hub, spoke } = hubSpokeCost(byProject);
    const total = hub + spoke;
    const a = el('span', { className: 's-hub', title: `Hub ${fmtUSD(hub)}` });
    const b = el('span', { className: 's-spoke', title: `Spoke ${fmtUSD(spoke)}` });
    setWidth(a, total ? (hub / total) * 100 : 0);
    setWidth(b, total ? (spoke / total) * 100 : 0);
    return el('div', { className: 'split-bar', title: `Hub ${fmtUSD(hub)} · Spoke ${fmtUSD(spoke)}` }, [a, b]);
  }
  function renderTopUsers() {
    const box = clear($('top-users'));
    const users = usersList().slice().sort((a, b) => num(b.estimated_cost) - num(a.estimated_cost)).slice(0, 6);
    if (!users.length) { box.appendChild(el('p', { className: 'muted', text: '사용자 데이터가 없습니다.' })); return; }
    users.forEach((u, i) => {
      box.appendChild(el('button', { className: 'lb-row', type: 'button', id: `top-user-${slug(u.email)}`, onClick: () => openDrawer(u.email) }, [
        el('span', { className: 'lb-rank', text: String(i + 1) }),
        el('span', { className: 'user-cell' }, [avatar(u.email), el('span', { className: 'lb-email', text: maskEmail(u.email) })]),
        splitBar(u.by_project),
        el('span', { className: 'lb-cost', text: fmtUSD(u.estimated_cost) }),
      ]));
    });
  }
  function renderEngineCard() {
    const box = clear($('engine-card'));
    const d = state.overview || {};
    const health = d.health || {};
    const enf = health.enforcement || {};
    const last = enf.last_run || {};
    const pol = d.policy || {};
    const stat = (label, value) => el('div', { className: 'engine-stat' }, [el('span', { text: label }), el('b', { text: value })]);
    box.append(
      el('div', { className: 'engine-row' }, [
        stat('집행 모드', enf.mode === 'auto' ? '자동 (auto)' : (enf.mode || '—')),
        stat('집행 백엔드', enf.backend === 'iam_deny' ? 'IAM Deny v2' : (enf.backend || '—')),
        stat('정책 주기', pol.period ? `${{ daily: '일간', weekly: '주간', monthly: '월간' }[pol.period] || pol.period} · ${pol.reset_timezone || 'UTC'}` : '—'),
      ]),
      el('div', { className: 'engine-row' }, [
        stat('Deny 정책 ID', enf.deny_policy_id || '—'),
        stat('다음 리셋', pol.current_window ? fmtDateTime(pol.current_window.next_reset) : '—'),
        stat('지출 한도 기능', health.spend_caps_enabled ? '활성' : '비활성'),
      ]),
      el('div', { className: `engine-last ${last.result && last.result !== 'success' ? 'fail' : ''}` }, [
        el('span', { className: 'live-dot', 'aria-hidden': 'true' }),
        el('span', { text: last.at ? `마지막 집행 ${fmtDateTime(last.at)} (${fmtRel(last.at)}) · ${last.trigger || '—'} · ${last.result || '—'} — 차단 ${num(last.blocked)} · 정지 ${num(last.suspended)} · 복구 ${num(last.restored)} · 실패 ${num(last.failed)}` : '집행 기록이 없습니다.' }),
      ]),
    );
  }

  // ---------------------------------------------------------------------------
  // Users table
  // ---------------------------------------------------------------------------
  function userHasBlock(u) {
    return u.status === 'blocked' || u.status === 'suspended' || (u.enforcement_status && u.enforcement_status !== 'none') || (u.blocked_services || []).length > 0 || Object.keys(u.blocked_projects || {}).length > 0;
  }
  function effectiveLimit(u) {
    const lim = u.limit || {};
    if (lim.cost_cap) return { kind: 'cost', cap: num(lim.cost_cap), used: num((u.cap_usage || {}).estimated_cost ?? u.estimated_cost), fmt: fmtUSD };
    if (lim.token_cap) return { kind: 'tokens', cap: num(lim.token_cap), used: num((u.cap_usage || {}).total_tokens ?? u.total_tokens), fmt: fmtCompact };
    if (lim.request_cap) return { kind: 'requests', cap: num(lim.request_cap), used: num((u.cap_usage || {}).requests ?? u.requests), fmt: fmtInt };
    return null;
  }
  function filteredUsers() {
    const q = state.userSearch.trim().toLowerCase();
    return usersList().filter((u) => {
      if (q && !String(u.email).toLowerCase().includes(q) && !(u.surfaces || []).join(' ').includes(q)) return false;
      if (state.userStatus === 'all') return true;
      if (state.userStatus === 'blocked') return u.status === 'blocked' || u.status === 'suspended';
      if (state.userStatus === 'propagating') return u.enforcement_status === 'propagating';
      return u.status === state.userStatus;
    });
  }
  function enfCell(u) {
    const tracker = state.trackers.get(String(u.email).toLowerCase());
    const restore = tracker && tracker.kind === 'unblock';
    const restored = tracker && tracker.done && tracker.kind === 'unblock' && tracker.success;
    const td = el('td', { className: 'enf-cell', id: `enf-status-${slug(u.email)}`, dataset: { email: u.email, enforcement: u.enforcement_status || 'none' } }, [
      enfBadge(u.enforcement_status, { restore, restored }),
    ]);
    const svcs = (u.blocked_services && u.blocked_services.length) ? u.blocked_services : (u.pending_blocked_services || []);
    let sub = '';
    if (tracker && !tracker.done) sub = `${tracker.kind === 'block' ? '차단' : '해제'} 추적 중 · ${((performance.now() - tracker.t0) / 1000).toFixed(1)}초`;
    else if (tracker && tracker.done && tracker.success) sub = `${tracker.finalSeconds.toFixed(1)}초 만에 ${tracker.kind === 'block' ? '적용' : '해제'}`;
    else if (svcs.length) sub = svcs.map(surfaceLabel).join(' · ');
    if (sub) td.appendChild(el('span', { className: 'enf-sub', text: sub }));
    return td;
  }
  function userRow(u, idx) {
    const s = slug(u.email);
    const lim = effectiveLimit(u);
    const util = lim ? (lim.cap ? (lim.used / lim.cap) * 100 : 0) : null;
    const blocked = userHasBlock(u);
    const tr = el('tr', { id: `user-row-${s}`, dataset: { email: u.email, status: u.status, enforcement: u.enforcement_status || 'none' } }, [
      el('td', {}, [el('button', { className: 'link-btn user-cell', type: 'button', id: `user-link-${s}`, onClick: () => openDrawer(u.email) }, [
        avatar(u.email),
        el('span', { className: 'u-main' }, [
          el('span', { className: 'u-email', text: maskEmail(u.email), title: maskEmail(u.email) }),
          el('span', { className: 'u-sub', text: `${u.is_service_account ? '서비스 계정' : '사용자'} · 최근 ${fmtRel(u.last_active)}` }),
        ]),
      ])]),
      el('td', {}, [el('div', { className: 'chips' }, (u.projects || []).slice().sort((x, y) => (isHub(y) ? 1 : 0) - (isHub(x) ? 1 : 0)).map((p) => el('span', { className: `tag ${isHub(p) ? 'tag-hub' : 'tag-spoke'}`, text: isHub(p) ? 'HUB' : 'SPOKE', title: p })))]),
      el('td', {}, [el('div', { className: 'chips' }, (u.surfaces || []).map(svcChip))]),
      el('td', { className: 'num', text: fmtInt(u.requests) }),
      el('td', { className: 'num', text: fmtCompact(u.total_tokens) }),
      el('td', { className: 'num cost-cell' }, [el('b', { text: fmtUSD(u.estimated_cost) }), splitBar(u.by_project)]),
      el('td', { className: 'util-cell' }, lim ? [
        el('div', { className: 'util-top' }, [el('span', { className: 'muted', text: `${lim.fmt(lim.used)} / ${lim.fmt(lim.cap)}` }), el('b', { text: fmtPct(util) })]),
        bar(Math.max(util, 1), utilClass(util)),
      ] : [el('span', { className: 'muted small', text: u.rule_source === 'user' ? '개별 규칙' : '한도 미설정' })]),
      el('td', { id: `status-cell-${s}` }, [statusBadge(u.status)]),
      enfCell(u),
      el('td', { className: 'actions-col' }, [el('div', { className: 'row-actions' }, [
        el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `user-detail-btn-${s}`, dataset: { action: 'detail', email: u.email }, text: '상세' }),
        el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `user-cap-btn-${s}`, dataset: { action: 'cap', email: u.email }, text: '한도' }),
        el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `user-rule-btn-${s}`, dataset: { action: 'model-rule', email: u.email }, text: '모델 규칙' }),
        blocked
          ? el('button', { className: 'btn btn-ok btn-xs', type: 'button', id: `user-unblock-btn-${s}`, dataset: { action: 'unblock', email: u.email }, text: '해제' })
          : el('button', { className: 'btn btn-danger btn-xs', type: 'button', id: `user-block-btn-${s}`, dataset: { action: 'block', email: u.email }, text: '차단' }),
      ])]),
    ]);
    tr.style.animationDelay = `${Math.min(idx, 20) * 25}ms`;
    return tr;
  }
  function renderUsers() {
    const tbody = clear($('users-tbody'));
    const rows = filteredUsers();
    $('users-count').textContent = `${rows.length} / ${usersList().length}명`;
    if (!rows.length) {
      tbody.appendChild(el('tr', {}, [el('td', { colspan: '10', className: 'empty-cell', text: state.overview ? '조건에 맞는 사용자가 없습니다.' : '불러오는 중…' })]));
      return;
    }
    rows.forEach((u, i) => tbody.appendChild(userRow(u, i)));
  }
  function refreshUserRow(email, flash = false) {
    const u = findUser(email);
    const old = $(`user-row-${slug(email)}`);
    if (!u || !old) return;
    const fresh = userRow(u, 0);
    fresh.style.animation = 'none';
    old.replaceWith(fresh);
    if (flash && !REDUCED_MOTION) { fresh.classList.add('flash'); }
  }
  function findUser(email) {
    const key = String(email || '').toLowerCase();
    return usersList().find((u) => String(u.email).toLowerCase() === key) || null;
  }
  function onUsersTableClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const email = btn.dataset.email;
    const action = btn.dataset.action;
    if (action === 'detail') openDrawer(email);
    else if (action === 'cap') openCapModal(email);
    else if (action === 'block') openBlockModal(email);
    else if (action === 'unblock') openUnblockModal(email);
    else if (action === 'model-rule') openRuleModal(email);
  }

  // ---------------------------------------------------------------------------
  // User drill-down drawer
  // ---------------------------------------------------------------------------
  async function openDrawer(email) {
    state.drawerEmail = email;
    state.drawerData = null;
    const dlg = $('user-drawer');
    renderDrawerIdentity();
    const body = clear($('drawer-body'));
    body.append(el('div', { className: 'drawer-kpis' }, [0, 1, 2, 3].map(() => el('div', { className: 'skeleton sk-block' }))), el('div', { className: 'skeleton sk-block' }), el('div', { className: 'skeleton sk-block' }));
    if (!dlg.open) dlg.showModal();
    await loadDrawer(false);
  }
  async function loadDrawer(fresh) {
    const email = state.drawerEmail;
    if (!email) return;
    try {
      const data = await apiGet('/api/user/detail', { email, start: state.start, end: state.end, fresh: fresh ? 'true' : 'false' });
      if (state.drawerEmail !== email) return;
      state.drawerData = data;
      if (data.cap) mergeCapIntoUser(email, data.cap);
      renderDrawer();
    } catch (err) {
      toast(err.message, 'error');
      clear($('drawer-body')).appendChild(el('p', { className: 'muted', text: err.message }));
    }
  }
  function drawerCap() {
    const t = state.trackers.get(String(state.drawerEmail || '').toLowerCase());
    if (t && t.lastCap) return t.lastCap;
    return (state.drawerData && state.drawerData.cap) || findUser(state.drawerEmail) || {};
  }
  function renderDrawerIdentity() {
    const email = state.drawerEmail;
    const u = findUser(email) || {};
    const cap = drawerCap();
    const box = clear($('drawer-identity'));
    const projects = (u.projects && u.projects.length) ? u.projects : (cap.projects || []).map((p) => p.project);
    box.append(
      avatar(email),
      el('div', {}, [
        el('p', { className: 'eyebrow', text: (u.is_service_account || String(email).endsWith('.gserviceaccount.com')) ? '서비스 계정 드릴다운' : '사용자 드릴다운' }),
        el('h2', { id: 'drawer-title', text: maskEmail(email) }),
        el('div', { className: 'di-meta' }, [
          ...projects.slice().sort((x, y) => (isHub(y) ? 1 : 0) - (isHub(x) ? 1 : 0)).map((p) => projectTag(p)),
          el('span', { id: 'drawer-status' }, [statusBadge(cap.status || u.status)]),
          el('span', { id: 'drawer-enf' }, [enfBadge(cap.enforcement_status || u.enforcement_status)]),
        ]),
      ]),
    );
    const blocked = userHasBlock({ ...u, ...cap });
    $('drawer-unblock-btn').disabled = !blocked;
  }
  function renderDrawer() {
    const d = state.drawerData;
    if (!d) return;
    renderDrawerIdentity();
    const usage = (d.usage && d.usage.user) || {};
    const cap = drawerCap();
    const body = clear($('drawer-body'));
    const projRows = ((d.projects && d.projects.data) || []).filter((p) => p.used || num(p.requests) > 0 || p.managed);
    const totalCost = num(usage.estimated_cost);

    const kpi = (label, value, formatter, sub, id) => {
      const b = el('b', { id, text: formatter(0) });
      countUp(b, value, formatter);
      return el('div', { className: 'dk' }, [el('span', { text: label }), b, el('small', { text: sub })]);
    };
    body.appendChild(el('div', { className: 'drawer-kpis' }, [
      kpi('추정 비용', usage.estimated_cost, fmtUSD, `${d.range.start} ~ ${d.range.end}`, 'drawer-kpi-cost'),
      kpi('요청 수', usage.requests, fmtInt, `${(usage.surfaces || []).map(surfaceLabel).join(' · ') || '—'}`, 'drawer-kpi-requests'),
      kpi('토큰', usage.total_tokens, fmtCompact, `입력 ${fmtCompact(usage.input_tokens)} · 출력 ${fmtCompact(usage.output_tokens)} · 캐시 ${fmtCompact(usage.cached_tokens)}`, 'drawer-kpi-tokens'),
      el('div', { className: 'dk' }, [el('span', { text: '최근 활동' }), el('b', { text: fmtRel(usage.last_active || (cap.usage || {}).last_active) }), el('small', { text: fmtDateTime(usage.last_active || (cap.usage || {}).last_active) })]),
    ]));

    // Gauge + enforcement
    body.appendChild(el('div', { className: 'drawer-grid' }, [
      el('section', { className: 'dsec', id: 'drawer-cap-section' }, [el('h3', {}, ['예산 한도 사용률', el('span', { className: 'muted small', text: cap.rule_source === 'user' ? '개별 한도' : '전역 정책' })]), capGauge(cap)]),
      el('section', { className: 'dsec', id: 'drawer-enforcement' }, []),
    ]));
    renderDrawerEnforcement();

    // Daily chart
    const ts = (d.usage && d.usage.timeseries) || [];
    body.appendChild(el('section', { className: 'dsec', id: 'drawer-chart-section' }, [
      el('h3', {}, ['일별 사용 추이', el('span', { className: 'muted small' }, [legendDot('#7c6cff'), ' 요청  ', legendDot('#22d3ee'), ' 토큰'])]),
      dailyChart(ts),
    ]));

    // By project
    const capProjects = Object.fromEntries((cap.projects || []).map((p) => [p.project, p]));
    const projTable = el('table', { className: 'mini-table', id: 'drawer-projects-table' }, [
      el('thead', {}, [el('tr', {}, ['프로젝트', '요청', '토큰', '추정 비용', '비중', '상태', '집행', '차단 서비스'].map((h, i) => el('th', { className: i >= 1 && i <= 3 ? 'num' : '', text: h })))]),
      el('tbody', {}, projRows.length ? projRows.map((p) => {
        const cp = capProjects[p.project] || p.cap || {};
        const share = totalCost ? (num(p.estimated_cost) / totalCost) * 100 : 0;
        return el('tr', {}, [
          el('td', {}, [projectTag(p.project)]),
          el('td', { className: 'num', text: fmtInt(p.requests) }),
          el('td', { className: 'num', text: fmtCompact(p.total_tokens) }),
          el('td', { className: 'num', text: fmtUSD(p.estimated_cost) }),
          el('td', {}, [el('div', { className: 'util-top' }, [el('span', { className: 'muted', text: fmtPct(share) })]), bar(share, isHub(p.project) ? '' : 'cyan')]),
          el('td', {}, [statusBadge(cp.status || 'active')]),
          el('td', {}, [enfBadge(cp.enforcement_status)]),
          el('td', {}, [el('div', { className: 'chips' }, (cp.blocked_services || []).length ? cp.blocked_services.map(svcChip) : [el('span', { className: 'muted small', text: '—' })])]),
        ]);
      }) : [el('tr', {}, [el('td', { colspan: '8', className: 'empty-cell', text: '프로젝트 사용 기록이 없습니다.' })])]),
    ]);
    body.appendChild(el('section', { className: 'dsec' }, [el('h3', {}, ['프로젝트별 (Hub vs Spoke)']), projTable]));

    // By model
    const byModel = (usage.by_model || []).slice().sort((a, b) => num(b.estimated_cost) - num(a.estimated_cost));
    const modelTable = el('table', { className: 'mini-table', id: 'drawer-models-table' }, [
      el('thead', {}, [el('tr', {}, ['모델', '서비스', '요청', '토큰', '추정 비용', '비중'].map((h, i) => el('th', { className: i >= 2 && i <= 4 ? 'num' : '', text: h })))]),
      el('tbody', {}, byModel.length ? byModel.map((m) => {
        const share = totalCost ? (num(m.estimated_cost) / totalCost) * 100 : 0;
        return el('tr', {}, [
          el('td', {}, [el('span', { className: 'mono', text: m.model })]),
          el('td', {}, [svcChip(m.surface)]),
          el('td', { className: 'num', text: fmtInt(m.requests) }),
          el('td', { className: 'num', text: fmtCompact(m.total_tokens) }),
          el('td', { className: 'num', text: fmtUSD(m.estimated_cost) }),
          el('td', {}, [el('div', { className: 'util-top' }, [el('span', { className: 'muted', text: fmtPct(share) })]), bar(share)]),
        ]);
      }) : [el('tr', {}, [el('td', { colspan: '6', className: 'empty-cell', text: '모델 사용 기록이 없습니다.' })])]),
    ]);
    body.appendChild(el('section', { className: 'dsec' }, [el('h3', {}, ['모델별 사용량']), modelTable]));

    // Model rules
    const mr = d.model_rules || {};
    const rule = mr.effective_rule;
    body.appendChild(el('section', { className: 'dsec', id: 'drawer-model-rule' }, [
      el('h3', {}, ['적용 중인 모델 규칙', el('span', { className: 'muted small', text: { user: '사용자 규칙', default: '기본 규칙', group: '그룹 규칙', none: '규칙 없음' }[mr.effective_source] || (mr.effective_source || '규칙 없음') })]),
      rule ? ruleSummary(rule) : el('p', { className: 'muted small', text: '적용 중인 모델 예산 규칙이 없습니다 — 모든 모델 사용 가능.' }),
      (mr.today || []).length ? el('div', { className: 'chips', id: 'drawer-today-models' }, [el('span', { className: 'muted small', text: '오늘 사용 모델:' }), ...(mr.today || []).map((t) => el('span', { className: `chip ${t.status === 'allowed' ? '' : 'svc-gemini_platform'}`, text: `${t.model} · ${fmtInt(t.requests)}회 · ${t.status === 'allowed' ? '허용' : t.status}` }))]) : null,
    ]));
  }
  function legendDot(color) { const s = el('span', { className: 'legend-dot' }); s.style.display = 'inline-block'; s.style.background = color; return s; }
  function capGauge(cap) {
    const lim = cap.limit || {};
    const usage = cap.usage || {};
    const hasLimit = Boolean(lim.cost_cap || lim.token_cap || lim.request_cap);
    const pct = hasLimit ? num(cap.utilization_pct) : 0;
    const R = 60;
    const C = 2 * Math.PI * R;
    const color = pct >= 100 ? '#fb7185' : pct >= 80 ? '#fbbf24' : '#4f8cff';
    const val = svg('circle', { cx: 75, cy: 75, r: R, class: 'g-val', stroke: color, 'stroke-dasharray': C, 'stroke-dashoffset': C });
    const g = svg('svg', { viewBox: '0 0 150 150', class: 'gauge', id: 'drawer-gauge', role: 'img', 'aria-label': `한도 사용률 ${hasLimit ? fmtPct(pct) : '한도 없음'}` }, [
      svg('circle', { cx: 75, cy: 75, r: R, class: 'g-track' }),
      val,
      svg('text', { x: 75, y: 80, 'text-anchor': 'middle', class: 'g-text', text: hasLimit ? fmtPct(pct, 0) : '—' }),
      svg('text', { x: 75, y: 98, 'text-anchor': 'middle', class: 'g-sub', text: hasLimit ? '사용률' : '한도 없음' }),
    ]);
    const target = C * (1 - Math.min(100, pct) / 100);
    if (REDUCED_MOTION) val.setAttribute('stroke-dashoffset', String(target)); else nextFrame(() => val.setAttribute('stroke-dashoffset', String(target)));
    const rem = cap.remaining || {};
    const row = (label, value) => el('div', {}, [el('span', { text: label }), el('b', { text: value })]);
    return el('div', { className: 'gauge-wrap' }, [g, el('div', { className: 'gauge-facts' }, [
      row('비용 한도', lim.cost_cap ? fmtUSD(lim.cost_cap) : '—'),
      row('토큰 한도', lim.token_cap ? fmtCompact(lim.token_cap) : '—'),
      row('요청 한도', lim.request_cap ? fmtInt(lim.request_cap) : '—'),
      row('현재 비용', fmtUSD(usage.estimated_cost)),
      row('남은 예산', rem.cost !== null && rem.cost !== undefined ? fmtUSD(rem.cost) : '—'),
      row('한도 범위', cap.cap_scope === 'per_project' ? '프로젝트별' : '합산'),
      cap.restore_at ? row('자동 복구', fmtDateTime(cap.restore_at)) : null,
    ])]);
  }
  function stepperNode(t, enf) {
    const kind = t ? t.kind : (enf === 'none' ? 'none' : 'block');
    const restore = kind === 'unblock';
    const labels = restore ? ['해제 요청 접수', 'IAM Deny 갱신 중', '해제 완료'] : ['차단 요청 접수', 'IAM Deny 전파 중', '차단 적용됨'];
    let stage = 0;
    if (t) {
      stage = t.done && t.success ? 3 : (t.marks.propagating !== undefined ? 2 : 1);
    } else if (enf === 'propagating') stage = 2;
    else if (enf === 'enforced') stage = 3;
    const times = t ? [t.marks.accepted, t.marks.propagating, t.marks.final] : [];
    return el('div', { className: `stepper ${restore ? 'restore' : ''}` }, labels.map((label, i) => {
      const cls = ['step'];
      if (i === 2) cls.push('final');
      if (stage > i) cls.push('done');
      else if (stage === i) cls.push('current');
      const tm = times[i];
      return el('div', { className: cls.join(' ') }, [
        el('span', { className: 'sdot' }, [icon('check')]),
        el('span', { text: label }),
        el('span', { className: 'stime', text: tm !== undefined ? `+${tm.toFixed(1)}s` : '' }),
      ]);
    }));
  }
  function renderDrawerEnforcement() {
    const sec = $('drawer-enforcement');
    if (!sec || !state.drawerEmail) return;
    const cap = drawerCap();
    const enf = cap.enforcement_status || 'none';
    const t = state.trackers.get(String(state.drawerEmail).toLowerCase());
    const audits = (state.drawerData && state.drawerData.audit_logs) || [];
    const elapsedNode = el('span', { className: 'et-elapsed', id: 'drawer-enf-elapsed' });
    if (t) elapsedNode.append(`${(t.done ? t.finalSeconds : (performance.now() - t.t0) / 1000).toFixed(1)}`, el('small', { text: '초' }));
    const svcs = (cap.blocked_services && cap.blocked_services.length) ? cap.blocked_services : (cap.pending_blocked_services || []);
    clear(sec).append(
      el('h3', {}, ['IAM Deny 집행 상태', el('span', { className: 'muted small', text: 'GET /v1/caps/users/{email}?fresh=true' })]),
      el('div', { className: 'enf-panel' }, [
        el('div', { className: 'enf-now' }, [
          el('div', { id: 'drawer-enf-badge' }, [enfBadge(enf, { restore: t && t.kind === 'unblock', restored: t && t.done && t.success && t.kind === 'unblock' })]),
          t ? elapsedNode : el('span', { className: 'muted small', text: svcs.length ? `차단 서비스: ${svcs.map(surfaceLabel).join(' · ')}` : '차단된 서비스 없음' }),
        ]),
        (t || enf !== 'none') ? stepperNode(t, enf) : null,
        el('h4', { className: 'muted small', text: '거버넌스 이력 (감사 로그)' }),
        audits.length ? el('ol', { className: 'timeline', id: 'drawer-timeline' }, audits.slice(0, 12).map((a) => el('li', { className: 'tl-item' }, [
          el('span', { className: `tl-dot ${actionClass(a.action)}`, 'aria-hidden': 'true' }),
          el('span', { className: 'tl-text' }, [el('b', { text: a.action }), el('small', { text: maskText(auditSummary(a)) })]),
          el('span', { className: 'ts', text: fmtDateTime(a.timestamp) }),
        ]))) : el('p', { className: 'muted small', text: '이 사용자에 대한 감사 이력이 없습니다.' }),
      ]),
    );
  }
  function dailyChart(ts) {
    const W = 860;
    const H = 190;
    const pad = { l: 36, r: 10, t: 12, b: 24 };
    const n = ts.length;
    const node = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', id: 'drawer-chart', preserveAspectRatio: 'none', role: 'img', 'aria-label': '일별 요청 및 토큰 추이' }, [
      svg('defs', {}, [svg('linearGradient', { id: 'barGrad', x1: '0', y1: '0', x2: '0', y2: '1' }, [
        svg('stop', { offset: '0', 'stop-color': '#8b5cf6' }), svg('stop', { offset: '1', 'stop-color': '#4f8cff', 'stop-opacity': '0.55' }),
      ])]),
    ]);
    if (!n) { node.appendChild(svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'c-axis', text: '데이터 없음' })); return node; }
    const maxReq = Math.max(1, ...ts.map((p) => num(p.requests)));
    const maxTok = Math.max(1, ...ts.map((p) => num(p.total_tokens)));
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    for (let g = 0; g <= 4; g += 1) {
      const y = pad.t + (ih * g) / 4;
      node.appendChild(svg('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'c-grid' }));
      node.appendChild(svg('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end', class: 'c-axis', text: fmtCompact(maxReq * (1 - g / 4)) }));
    }
    const bw = iw / n;
    const pts = [];
    ts.forEach((p, i) => {
      const x = pad.l + i * bw;
      const h = (num(p.requests) / maxReq) * ih;
      const rect = svg('rect', { x: x + bw * 0.18, y: pad.t + ih - h, width: Math.max(1, bw * 0.64), height: Math.max(0, h), rx: 2, class: 'c-bar' }, [svg('title', { text: `${p.date} · 요청 ${fmtInt(p.requests)} · 토큰 ${fmtInt(p.total_tokens)}` })]);
      rect.style.animationDelay = `${Math.min(i, 40) * 18}ms`;
      node.appendChild(rect);
      pts.push(`${(x + bw / 2).toFixed(1)},${(pad.t + ih - (num(p.total_tokens) / maxTok) * ih).toFixed(1)}`);
      if (n <= 10 || i % Math.ceil(n / 8) === 0 || i === n - 1) node.appendChild(svg('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'c-axis', text: String(p.date).slice(5) }));
    });
    node.appendChild(svg('polyline', { points: pts.join(' '), class: 'c-line' }));
    return node;
  }

  // ---------------------------------------------------------------------------
  // Enforcement lifecycle tracking (propagating -> enforced / none)
  // ---------------------------------------------------------------------------
  function mergeCapIntoUser(email, cap) {
    const u = findUser(email);
    if (!u || !cap) return;
    for (const k of ['status', 'enforcement_status', 'blocked_services', 'blocked_projects', 'pending_blocked_services', 'pending_blocked_projects', 'over_cap', 'utilization_pct', 'limit', 'remaining', 'restore_at', 'block_source', 'status_scope']) {
      if (cap[k] !== undefined) u[k] = cap[k];
    }
    if (Array.isArray(cap.projects)) {
      const map = Object.fromEntries(cap.projects.map((p) => [p.project, p]));
      for (const bp of u.by_project || []) {
        const cp = map[bp.project];
        if (cp) { bp.status = cp.status; bp.enforcement_status = cp.enforcement_status || 'none'; bp.blocked_services = cp.blocked_services || []; }
      }
    }
  }
  function startTracking(email, kind, initialCap) {
    const key = String(email).toLowerCase();
    const prev = state.trackers.get(key);
    if (prev) stopTracker(prev);
    const t = { email, key, kind, t0: performance.now(), marks: { accepted: 0 }, done: false, success: false, polls: 0, timer: null, ticker: null, lastCap: null, finalSeconds: 0 };
    state.trackers.set(key, t);
    state.trackerShown = key;
    if (initialCap && typeof initialCap === 'object' && initialCap.enforcement_status) applyTrackerCap(t, initialCap);
    t.ticker = window.setInterval(() => tickTracker(t), 100);
    renderTrackerCard();
    refreshUserRow(email, true);
    if (state.drawerEmail && state.drawerEmail.toLowerCase() === key) { renderDrawerIdentity(); renderDrawerEnforcement(); }
    window.setTimeout(() => pollTracker(t), 1200);
  }
  function stopTracker(t) {
    if (t.timer) window.clearTimeout(t.timer);
    if (t.ticker) window.clearInterval(t.ticker);
    t.timer = null;
    t.ticker = null;
  }
  function stopAllTrackers() {
    for (const t of state.trackers.values()) stopTracker(t);
    state.trackers.clear();
    $('enforce-tracker').hidden = true;
  }
  async function pollTracker(t) {
    if (t.done || state.trackers.get(t.key) !== t || !state.authenticated) return;
    t.polls += 1;
    try {
      const r = await apiGet('/api/user/cap', { email: t.email, fresh: 'true' });
      applyTrackerCap(t, r.cap || {});
    } catch (err) {
      if (err.status === 429) toast('API 요청 한도에 근접했습니다. 폴링 간격을 늘립니다.', 'warn');
    }
    if (t.done) return;
    const elapsed = (performance.now() - t.t0) / 1000;
    if (elapsed > 300) {
      finishTracker(t, false);
      toast('5분 내 IAM Deny 상태 확정이 확인되지 않았습니다. 잠시 후 새로고침하세요.', 'warn');
      return;
    }
    t.timer = window.setTimeout(() => pollTracker(t), elapsed < 60 ? 3000 : 6000);
  }
  function applyTrackerCap(t, cap) {
    t.lastCap = cap;
    const enf = cap.enforcement_status || 'none';
    const elapsed = (performance.now() - t.t0) / 1000;
    mergeCapIntoUser(t.email, cap);
    if (enf === 'propagating' && t.marks.propagating === undefined) t.marks.propagating = elapsed;
    if (t.kind === 'block' && enf === 'enforced') {
      if (t.marks.propagating === undefined) t.marks.propagating = elapsed;
      t.marks.final = elapsed;
      finishTracker(t, true);
    } else if (t.kind === 'unblock' && enf === 'none' && t.polls > 0) {
      if (t.marks.propagating === undefined) t.marks.propagating = elapsed;
      t.marks.final = elapsed;
      finishTracker(t, true);
    } else {
      refreshUserRow(t.email, false);
      if (state.drawerEmail && state.drawerEmail.toLowerCase() === t.key) { renderDrawerIdentity(); renderDrawerEnforcement(); }
      renderTrackerCard();
    }
  }
  function finishTracker(t, success) {
    t.done = true;
    t.success = success;
    t.finalSeconds = (performance.now() - t.t0) / 1000;
    if (success && t.marks.final !== undefined) t.finalSeconds = t.marks.final;
    stopTracker(t);
    refreshUserRow(t.email, true);
    if (state.drawerEmail && state.drawerEmail.toLowerCase() === t.key) { renderDrawerIdentity(); renderDrawerEnforcement(); }
    renderTrackerCard();
    if (success) toast(t.kind === 'block' ? `${t.email} — IAM Deny 차단 적용 완료 (${t.finalSeconds.toFixed(1)}초)` : `${t.email} — 차단 해제 완료 (${t.finalSeconds.toFixed(1)}초)`, 'success', 6000);
    if (state.overview) renderOverview();
    window.setTimeout(() => {
      if (state.trackerShown === t.key && t.done) $('enforce-tracker').hidden = true;
    }, 12000);
  }
  function tickTracker(t) {
    const secs = ((performance.now() - t.t0) / 1000).toFixed(1);
    if (state.trackerShown === t.key) {
      const node = $('enforce-tracker-elapsed');
      if (node && node.firstChild) node.firstChild.nodeValue = secs;
    }
    const sub = document.querySelector(`#enf-status-${slug(t.email)} .enf-sub`);
    if (sub) sub.textContent = `${t.kind === 'block' ? '차단' : '해제'} 추적 중 · ${secs}초`;
    const de = $('drawer-enf-elapsed');
    if (de && de.firstChild && state.drawerEmail && state.drawerEmail.toLowerCase() === t.key) de.firstChild.nodeValue = secs;
  }
  function renderTrackerCard() {
    const t = state.trackers.get(state.trackerShown);
    const box = $('enforce-tracker');
    if (!t) { box.hidden = true; return; }
    const enf = (t.lastCap && t.lastCap.enforcement_status) || (t.kind === 'block' ? 'propagating' : 'propagating');
    const secs = t.done ? t.finalSeconds : (performance.now() - t.t0) / 1000;
    const elapsed = el('span', { className: 'et-elapsed', id: 'enforce-tracker-elapsed' }, [secs.toFixed(1), el('small', { text: '초 경과' })]);
    clear(box).append(
      el('div', { className: 'et-head' }, [
        el('div', {}, [
          el('div', { className: 'et-title', text: t.kind === 'block' ? 'IAM Deny 차단 집행 추적' : 'IAM Deny 차단 해제 추적' }),
          el('div', { className: 'et-email', text: maskEmail(t.email) }),
        ]),
        elapsed,
      ]),
      el('div', { id: 'enforce-tracker-state' }, [
        t.done && t.success
          ? enfBadge(t.kind === 'block' ? 'enforced' : 'none', { restored: t.kind === 'unblock' })
          : (t.done ? el('span', { className: 'enf', text: '확인 시간 초과' }) : enfBadge(t.kind === 'unblock' && enf === 'enforced' ? 'propagating' : (enf === 'none' && t.kind === 'block' ? 'propagating' : enf), { restore: t.kind === 'unblock' })),
      ]),
      stepperNode(t, enf),
    );
    box.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Cap / block / unblock / model-rule modals
  // ---------------------------------------------------------------------------
  function bindModalClose(dlg) {
    for (const b of dlg.querySelectorAll('.modal-close, .modal-cancel')) b.addEventListener('click', () => dlg.close());
  }
  function targetLine(email) {
    return [avatar(email), el('span', { text: maskEmail(email) })];
  }
  function openCapModal(email) {
    const u = findUser(email) || {};
    const rule = u.cap_rule || {};
    const lim = u.limit || {};
    $('cap-modal').dataset.email = email;
    clear($('cap-modal-target')).append(...targetLine(email));
    $('cap-cost-input').value = rule.cost_cap ?? (u.rule_source === 'user' ? (lim.cost_cap ?? '') : '');
    $('cap-token-input').value = rule.token_cap ?? '';
    $('cap-request-input').value = rule.request_cap ?? '';
    $('cap-scope-select').value = rule.scope || u.cap_scope || 'total';
    $('cap-note-input').value = rule.note || '';
    const box = clear($('cap-project-fields'));
    const pc = rule.project_caps || {};
    for (const pid of state.managed) {
      box.appendChild(el('label', { className: 'field' }, [
        el('span', { className: 'field-label' }, [el('span', { className: `tag ${isHub(pid) ? 'tag-hub' : 'tag-spoke'}`, text: isHub(pid) ? 'HUB' : 'SPOKE' }), ` ${pid}`]),
        el('input', { id: `cap-project-cost-${pid}`, type: 'number', min: '0', step: '0.01', placeholder: '미설정', value: (pc[pid] && pc[pid].cost_cap) ?? '' }),
      ]));
    }
    $('cap-delete-btn').disabled = u.rule_source !== 'user';
    $('cap-modal').showModal();
    window.setTimeout(() => $('cap-cost-input').focus(), 60);
  }
  async function submitCap(e) {
    e.preventDefault();
    const email = $('cap-modal').dataset.email;
    const body = {
      email,
      type: 'limit',
      cost_cap: $('cap-cost-input').value,
      token_cap: $('cap-token-input').value,
      request_cap: $('cap-request-input').value,
      scope: $('cap-scope-select').value,
      note: $('cap-note-input').value,
      project_caps: {},
    };
    for (const pid of state.managed) {
      const v = $(`cap-project-cost-${pid}`).value;
      if (v !== '') body.project_caps[pid] = { cost_cap: v };
    }
    await withLoading($('cap-submit-btn'), async () => {
      try {
        await apiPost('/api/caps/users/set', body);
        $('cap-modal').close();
        toast(`${email} 예산 한도를 저장했습니다.`, 'success');
        await afterUserMutation(email);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  async function deleteCap() {
    const email = $('cap-modal').dataset.email;
    if (!(await askConfirm(`${email}의 개별 한도를 삭제하고 전역 정책 기본값으로 되돌릴까요?`, '개별 한도 삭제'))) return;
    await withLoading($('cap-delete-btn'), async () => {
      try {
        await apiPost('/api/caps/users/delete', { email });
        $('cap-modal').close();
        toast('개별 한도를 삭제했습니다.', 'success');
        await afterUserMutation(email);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  async function afterUserMutation(email) {
    await ensureOverview(true).catch((err) => toast(err.message, 'error'));
    if (state.tab === 'overview' || state.tab === 'users') { renderOverview(); renderUsers(); }
    if (state.drawerEmail && state.drawerEmail.toLowerCase() === String(email).toLowerCase() && $('user-drawer').open) await loadDrawer(true);
  }
  function checkCards(container, prefix, items, checkedFn) {
    const box = clear(container);
    for (const [id, label, sub] of items) {
      box.appendChild(el('label', { className: 'check-card', for: `${prefix}-${id}` }, [
        el('input', { type: 'checkbox', id: `${prefix}-${id}`, value: id, checked: checkedFn(id) }),
        el('span', {}, [el('b', { text: label }), el('small', { text: sub })]),
      ]));
    }
  }
  const projectItems = () => state.managed.map((pid) => [pid, pid, isHub(pid) ? 'Hub 프로젝트' : 'Spoke 프로젝트']);
  const checkedValues = (container) => Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((i) => i.value);
  function openBlockModal(email) {
    const u = findUser(email) || {};
    $('block-modal').dataset.email = email;
    clear($('block-modal-target')).append(...targetLine(email));
    const userSurfaces = u.surfaces && u.surfaces.length ? u.surfaces : SERVICES.map((s) => s[0]);
    checkCards($('block-services'), 'block-svc', SERVICES, (id) => userSurfaces.includes(id));
    const userProjects = u.projects && u.projects.length ? u.projects : state.managed;
    checkCards($('block-projects'), 'block-proj', projectItems(), (id) => userProjects.includes(id));
    $('block-reason-input').value = '';
    $('block-until-input').value = '';
    $('block-modal').showModal();
  }
  async function submitBlock(e) {
    e.preventDefault();
    const email = $('block-modal').dataset.email;
    const services = checkedValues($('block-services'));
    const projects = checkedValues($('block-projects'));
    if (!services.length) { toast('차단할 서비스를 1개 이상 선택하세요.', 'warn'); return; }
    if (!projects.length) { toast('차단할 프로젝트를 1개 이상 선택하세요.', 'warn'); return; }
    const untilRaw = $('block-until-input').value;
    const body = { email, services, projects, reason: $('block-reason-input').value || '거버넌스 콘솔 즉시 차단' };
    if (untilRaw) body.until = new Date(untilRaw).toISOString();
    await withLoading($('block-submit-btn'), async () => {
      try {
        const res = await apiPost('/api/users/block', body);
        $('block-modal').close();
        toast(`${email} 차단 요청 접수 — IAM Deny 전파를 추적합니다.`, 'info');
        startTracking(email, 'block', res && res.result);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  function openUnblockModal(email) {
    const u = findUser(email) || {};
    $('unblock-modal').dataset.email = email;
    clear($('unblock-modal-target')).append(...targetLine(email));
    const blockedSvcs = new Set([...(u.blocked_services || []), ...(u.pending_blocked_services || [])]);
    for (const list of Object.values(u.blocked_projects || {})) for (const s of list || []) blockedSvcs.add(s);
    checkCards($('unblock-services'), 'unblock-svc', SERVICES, (id) => blockedSvcs.size === 0 || blockedSvcs.has(id));
    const bp = Object.keys(u.blocked_projects || {});
    checkCards($('unblock-projects'), 'unblock-proj', projectItems(), (id) => bp.length === 0 || bp.includes(id));
    $('unblock-reason-input').value = '';
    $('unblock-modal').showModal();
  }
  async function submitUnblock(e) {
    e.preventDefault();
    const email = $('unblock-modal').dataset.email;
    const services = checkedValues($('unblock-services'));
    const projects = checkedValues($('unblock-projects'));
    const body = { email, reason: $('unblock-reason-input').value || '거버넌스 콘솔 차단 해제' };
    if (services.length && services.length < SERVICES.length) body.services = services;
    if (projects.length && projects.length < state.managed.length) body.projects = projects;
    await withLoading($('unblock-submit-btn'), async () => {
      try {
        const res = await apiPost('/api/users/unblock', body);
        $('unblock-modal').close();
        toast(`${email} 차단 해제 요청 접수 — IAM Deny 갱신을 추적합니다.`, 'info');
        startTracking(email, 'unblock', res && res.result);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function knownModelIds() {
    const set = new Set();
    for (const m of (state.overview && state.overview.top_models) || []) set.add(m.model);
    for (const m of (state.models && state.models.catalog) || []) set.add(m.id);
    for (const m of (state.models && state.models.usage) || []) set.add(m.model);
    return Array.from(set).filter(Boolean).sort();
  }
  function limitRow(limit = {}) {
    const idx = $('rule-limits').children.length;
    const input = (field, ph, step) => el('input', { id: `rule-limit-${field}-${idx}`, dataset: { field }, type: field === 'model' ? 'text' : 'number', min: '0', step: step || '1', placeholder: ph, list: field === 'model' ? 'rule-model-list' : null, value: limit[field] ?? '' });
    const row = el('div', { className: 'limit-row', id: `rule-limit-row-${idx}` }, [
      input('model', 'gemini-4-* 또는 *'),
      input('monthly_cost', 'USD', '0.01'),
      input('monthly_tokens', '토큰'),
      input('daily_requests', '요청'),
      input('rpm', 'RPM'),
      el('button', { className: 'icon-btn', type: 'button', 'aria-label': '한도 삭제', onClick: () => row.remove() }, [icon('x')]),
    ]);
    return row;
  }
  function openRuleModal(scope) {
    state.ruleScope = scope;
    const isDefault = scope === 'default';
    let rule = null;
    if (isDefault) rule = (state.models && state.models.default_rule) || (state.overview && state.overview.default_model_rule) || null;
    else {
      const u = findUser(scope);
      rule = (u && u.user_model_rule) || ((state.models && state.models.user_rules) || []).map((r) => (r.email && String(r.email).toLowerCase() === scope.toLowerCase() ? (r.rule || r) : null)).find(Boolean) || null;
    }
    $('rule-modal-endpoint').textContent = isDefault ? 'PUT /v1/model-rules/default' : 'PUT /v1/users/{email}/model-rules';
    $('rule-modal-title').textContent = isDefault ? '기본 모델 예산 규칙 (전 사용자)' : '사용자별 모델 예산 규칙';
    const target = clear($('rule-modal-target'));
    if (isDefault) target.append(icon('users'), el('span', { text: '모든 사용자에게 적용되는 기본 규칙' }));
    else target.append(...targetLine(scope));
    const modeSel = $('rule-mode-select');
    modeSel.querySelector('option[value="inherit"]').disabled = isDefault;
    modeSel.value = (rule && rule.mode) || (isDefault ? 'unrestricted' : 'inherit');
    $('rule-models-input').value = ((rule && rule.models) || []).join(', ');
    $('rule-violation-select').value = (rule && rule.on_violation) || 'block_service';
    $('rule-block-minutes').value = (rule && rule.block_minutes) ?? '';
    $('rule-note-input').value = (rule && rule.note) || '';
    const dl = clear($('rule-model-list'));
    for (const id of knownModelIds()) dl.appendChild(el('option', { value: id }));
    clear($('rule-limits'));
    const limits = (rule && rule.limits) || [];
    if (limits.length) limits.forEach((l) => $('rule-limits').appendChild(limitRow(l)));
    else $('rule-limits').appendChild(limitRow({}));
    $('rule-delete-btn').disabled = !rule;
    $('rule-modal').showModal();
  }
  async function submitRule(e) {
    e.preventDefault();
    const scope = state.ruleScope;
    const limits = [];
    for (const row of $('rule-limits').children) {
      const entry = {};
      for (const inp of row.querySelectorAll('input')) if (inp.value !== '') entry[inp.dataset.field] = inp.dataset.field === 'model' ? inp.value.trim() : inp.value;
      if (Object.keys(entry).length > (entry.model ? 1 : 0)) limits.push({ model: entry.model || '*', ...entry });
    }
    const body = {
      mode: $('rule-mode-select').value,
      models: $('rule-models-input').value.split(',').map((s) => s.trim()).filter(Boolean),
      limits,
      on_violation: $('rule-violation-select').value,
      note: $('rule-note-input').value,
    };
    if ($('rule-block-minutes').value !== '') body.block_minutes = $('rule-block-minutes').value;
    const isDefault = scope === 'default';
    if (!isDefault) body.email = scope;
    await withLoading($('rule-submit-btn'), async () => {
      try {
        await apiPost(isDefault ? '/api/model-rules/default/set' : '/api/model-rules/user/set', body);
        $('rule-modal').close();
        toast('모델 예산 규칙을 저장했습니다. 평가 미리보기로 영향을 확인하세요.', 'success');
        await afterRuleMutation(isDefault ? null : scope);
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  async function deleteRule(scope) {
    const s = scope || state.ruleScope;
    const isDefault = s === 'default';
    if (!(await askConfirm(isDefault ? '기본 모델 규칙을 삭제할까요?' : `${s}의 모델 규칙을 삭제할까요?`, '규칙 삭제'))) return;
    try {
      if (isDefault) await apiPost('/api/model-rules/default/delete', {});
      else await apiPost('/api/model-rules/user/delete', { email: s });
      if ($('rule-modal').open) $('rule-modal').close();
      toast('모델 규칙을 삭제했습니다.', 'success');
      await afterRuleMutation(isDefault ? null : s);
    } catch (err) { toast(err.message, 'error'); }
  }
  async function afterRuleMutation(email) {
    state.loaded.models = null;
    if (state.tab === 'models') await loadTab('models', true);
    await ensureOverview(true).catch(() => {});
    if (state.tab === 'overview' || state.tab === 'users') { renderOverview(); renderUsers(); }
    if (email && state.drawerEmail && state.drawerEmail.toLowerCase() === email.toLowerCase() && $('user-drawer').open) await loadDrawer(false);
  }
  function ruleSummary(rule) {
    const modeLabel = { unrestricted: '제한 없음', allow_list: '허용 목록', deny_list: '차단 목록', inherit: '기본 규칙 상속' }[rule.mode] || rule.mode;
    const limits = (rule.limits || []).map((l) => {
      const parts = [];
      if (l.monthly_cost !== undefined) parts.push(`${fmtUSD(l.monthly_cost)}/월`);
      if (l.monthly_tokens !== undefined) parts.push(`${fmtCompact(l.monthly_tokens)} tok/월`);
      if (l.daily_tokens !== undefined) parts.push(`${fmtCompact(l.daily_tokens)} tok/일`);
      if (l.monthly_requests !== undefined) parts.push(`${fmtInt(l.monthly_requests)} req/월`);
      if (l.daily_requests !== undefined) parts.push(`${fmtInt(l.daily_requests)} req/일`);
      if (l.rpm !== undefined) parts.push(`${fmtInt(l.rpm)} RPM`);
      if (l.tpm !== undefined) parts.push(`${fmtCompact(l.tpm)} TPM`);
      return el('span', { className: 'limit-chip' }, [el('code', { text: l.model }), parts.join(' · ')]);
    });
    return el('div', { className: 'stack' }, [
      el('div', { className: 'chips' }, [
        el('span', { className: 'chip', text: `모드: ${modeLabel}` }),
        (rule.models || []).length ? el('span', { className: 'chip', text: `모델: ${(rule.models || []).join(', ')}` }) : null,
        el('span', { className: 'chip', text: rule.on_violation === 'notify' ? '위반 시 알림' : '위반 시 서비스 자동 차단' }),
        rule.block_minutes ? el('span', { className: 'chip', text: `${rule.block_minutes}분 후 자동 해제` }) : null,
      ]),
      limits.length ? el('div', { className: 'limit-list' }, limits) : el('span', { className: 'muted small', text: '모델별 한도 없음' }),
      rule.updated_at ? el('span', { className: 'muted small', text: `수정 ${fmtDateTime(rule.updated_at)} · ${maskText(rule.updated_by || '')}` }) : null,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Cost explorer
  // ---------------------------------------------------------------------------
  function pricingFor(model) {
    const rows = (state.costs && state.costs.pricing) || (state.models && (state.models.pricing || {}).data) || [];
    const m = String(model || '').toLowerCase();
    return rows.find((p) => (p.model_ids || []).map((x) => String(x).toLowerCase()).includes(m) || String(p.model).toLowerCase() === m || String(p.model_key || '').toLowerCase() === m) || null;
  }
  function costRows() {
    const c = state.costs || {};
    const users = (c.users || []).map((u) => {
      const { hub, spoke } = hubSpokeCost(u.by_project);
      return { ...u, hub_cost: hub, spoke_cost: spoke };
    });
    const total = users.reduce((a, u) => a + num(u.estimated_cost), 0);
    users.forEach((u) => { u.share = total ? num(u.estimated_cost) / total : 0; });
    const models = (c.models || []).map((m) => {
      const p = pricingFor(m.model);
      return { ...m, input_price: p ? p.input_per_1m_tokens : null, output_price: p ? p.output_per_1m_tokens : null };
    });
    const mtotal = models.reduce((a, m) => a + num(m.estimated_cost), 0);
    models.forEach((m) => { m.share = mtotal ? num(m.estimated_cost) / mtotal : 0; });
    return { users, models, total, mtotal };
  }
  function sortRows(rows, { key, dir }) {
    const mul = dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * mul;
      return (num(va) - num(vb)) * mul;
    });
  }
  function renderCosts() {
    const c = state.costs;
    if (!c) return;
    const { users, models, total } = costRows();
    const hubTotal = users.reduce((a, u) => a + u.hub_cost, 0);
    const spokeTotal = users.reduce((a, u) => a + u.spoke_cost, 0);
    const topModel = models.slice().sort((a, b) => num(b.estimated_cost) - num(a.estimated_cost))[0];
    const topUser = users.slice().sort((a, b) => num(b.estimated_cost) - num(a.estimated_cost))[0];
    const box = clear($('cost-summary'));
    box.append(
      kpiCard({ id: 'cost-kpi-total', label: '기간 총 추정 비용', value: total, formatter: fmtUSD, sub: `${c.range.start} ~ ${c.range.end}`, iconName: 'dollar', tone: 'blue' }),
      kpiCard({ id: 'cost-kpi-hub', label: `Hub · ${c.hub_project}`, value: hubTotal, formatter: fmtUSD, sub: total ? `${fmtPct((hubTotal / total) * 100)} 비중` : '—', iconName: 'cpu', tone: 'violet' }),
      kpiCard({ id: 'cost-kpi-spoke', label: `Spoke · ${(c.spoke_projects || []).join(', ')}`, value: spokeTotal, formatter: fmtUSD, sub: total ? `${fmtPct((spokeTotal / total) * 100)} 비중` : '—', iconName: 'layers', tone: 'cyan' }),
      kpiCard({ id: 'cost-kpi-top-model', label: '최다 비용 모델', value: topModel ? topModel.estimated_cost : 0, formatter: fmtUSD, sub: topModel ? topModel.model : '—', iconName: 'bolt', tone: 'amber' }),
      kpiCard({ id: 'cost-kpi-top-user', label: '최다 비용 사용자', value: topUser ? topUser.estimated_cost : 0, formatter: fmtUSD, sub: topUser ? maskEmail(topUser.email) : '—', iconName: 'users', tone: 'green' }),
    );
    const ps = c.pricing_source || {};
    $('cost-pricing-note').textContent = `단가: 공식 Cloud Billing Catalog SKU (${fmtInt(ps.official_sku_models)}개 모델) · 동기화 ${fmtDateTime(ps.catalog_synced_at)}`;
    $('cost-users-table').hidden = state.costView !== 'users';
    $('cost-models-table').hidden = state.costView !== 'models';
    for (const tbl of ['cost-users-table', 'cost-models-table']) {
      const view = tbl === 'cost-users-table' ? 'users' : 'models';
      for (const th of $(tbl).querySelectorAll('th[data-sort]')) {
        const on = th.dataset.sort === state.costSort[view].key;
        th.classList.toggle('sorted', on);
        th.classList.toggle('asc', on && state.costSort[view].dir === 'asc');
      }
    }
    const q = state.costSearch.trim().toLowerCase();
    if (state.costView === 'users') {
      const tbody = clear($('cost-users-tbody'));
      const rows = sortRows(users.filter((u) => !q || String(u.email).toLowerCase().includes(q) || (u.by_model || []).some((m) => String(m.model).toLowerCase().includes(q))), state.costSort.users);
      if (!rows.length) tbody.appendChild(el('tr', {}, [el('td', { colspan: '9', className: 'empty-cell', text: '데이터가 없습니다.' })]));
      rows.forEach((u, i) => {
        const tr = el('tr', { id: `cost-user-row-${slug(u.email)}`, dataset: { email: u.email } }, [
          el('td', {}, [el('button', { className: 'link-btn user-cell', type: 'button', onClick: () => openDrawer(u.email) }, [avatar(u.email), el('span', { className: 'u-main' }, [el('span', { className: 'u-email', text: maskEmail(u.email) }), el('span', { className: 'u-sub', text: (u.by_model || []).slice(0, 2).map((m) => m.model).join(', ') || '—' })])])]),
          el('td', { className: 'num', text: fmtUSD(u.hub_cost) }),
          el('td', { className: 'num', text: fmtUSD(u.spoke_cost) }),
          el('td', { className: 'num', text: fmtInt(u.requests) }),
          el('td', { className: 'num', text: fmtCompact(u.input_tokens) }),
          el('td', { className: 'num', text: fmtCompact(u.output_tokens) }),
          el('td', { className: 'num', text: fmtCompact(u.cached_tokens) }),
          el('td', { className: 'num' }, [el('b', { text: fmtUSD(u.estimated_cost) })]),
          el('td', { className: 'util-cell' }, [el('div', { className: 'util-top' }, [el('span', { className: 'muted', text: fmtPct(u.share * 100) })]), bar(u.share * 100)]),
        ]);
        tr.style.animationDelay = `${Math.min(i, 20) * 20}ms`;
        tbody.appendChild(tr);
      });
    } else {
      const tbody = clear($('cost-models-tbody'));
      const rows = sortRows(models.filter((m) => !q || String(m.model).toLowerCase().includes(q) || String(m.publisher || '').toLowerCase().includes(q)), state.costSort.models);
      if (!rows.length) tbody.appendChild(el('tr', {}, [el('td', { colspan: '10', className: 'empty-cell', text: '데이터가 없습니다.' })]));
      rows.forEach((m, i) => {
        const tr = el('tr', { id: `cost-model-row-${slug(m.model)}` }, [
          el('td', {}, [el('span', { className: 'mono', text: m.model }), m.cost_partial ? el('span', { className: 'chip', text: '일부 단가 미확인' }) : null]),
          el('td', { text: m.publisher || '—' }),
          el('td', {}, [el('div', { className: 'chips' }, (m.surfaces || [m.surface]).filter(Boolean).map(svcChip))]),
          el('td', { className: 'num', text: fmtInt(m.active_users) }),
          el('td', { className: 'num', text: fmtInt(m.requests) }),
          el('td', { className: 'num', text: fmtCompact(m.total_tokens) }),
          el('td', { className: 'num', text: m.input_price !== null && m.input_price !== undefined ? fmtUSD(m.input_price) : '—' }),
          el('td', { className: 'num', text: m.output_price !== null && m.output_price !== undefined ? fmtUSD(m.output_price) : '—' }),
          el('td', { className: 'num' }, [el('b', { text: fmtUSD(m.estimated_cost) })]),
          el('td', { className: 'util-cell' }, [el('div', { className: 'util-top' }, [el('span', { className: 'muted', text: fmtPct(m.share * 100) })]), bar(m.share * 100, 'cyan')]),
        ]);
        tr.style.animationDelay = `${Math.min(i, 20) * 20}ms`;
        tbody.appendChild(tr);
      });
    }
  }
  function onCostSort(e) {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const view = th.closest('table').id === 'cost-users-table' ? 'users' : 'models';
    const cur = state.costSort[view];
    if (cur.key === th.dataset.sort) cur.dir = cur.dir === 'desc' ? 'asc' : 'desc';
    else { cur.key = th.dataset.sort; cur.dir = ['email', 'model', 'publisher', 'surface'].includes(th.dataset.sort) ? 'asc' : 'desc'; }
    renderCosts();
  }

  // ---------------------------------------------------------------------------
  // Model governance
  // ---------------------------------------------------------------------------
  function accessFor(model, entry) {
    if (!entry) return 'inherit';
    const vals = [model.id, ...(model.policy_values || [])].map((v) => String(v).toLowerCase());
    const match = (list) => (list || []).some((x) => { const s = String(x).toLowerCase(); return vals.some((v) => v === s || s.includes(String(model.id).toLowerCase())); });
    if ((entry.denied_values || []).length && match(entry.denied_values)) return 'denied';
    if (entry.mode === 'allow_list' || (entry.allowed_values || []).length) return match(entry.allowed_values) ? 'allowed' : 'denied';
    if (entry.mode === 'deny_list') return 'allowed';
    return 'inherit';
  }
  function renderModels() {
    const d = state.models;
    if (!d) return;
    const access = d.model_access || [];
    // Org Policy status cards
    const st = clear($('ma-status'));
    const ordered = access.slice().sort((a, b) => (a.scope_type === 'projects' ? 0 : 1) - (b.scope_type === 'projects' ? 0 : 1));
    for (const a of ordered) {
      const isProj = a.scope_type === 'projects';
      const modeLabel = { inherit: '상위 정책 상속', allow_list: '허용 목록 적용', deny_list: '차단 목록 적용', unrestricted: '제한 없음', allow_all: '전체 허용', deny_all: '전체 차단' }[a.mode] || a.mode;
      st.appendChild(el('div', { className: 'ma-card', id: `ma-card-${slug(a.scope_id)}` }, [
        el('div', { className: 'ma-scope' }, [
          el('span', { className: `tag ${isProj ? (isHub(a.scope_id) ? 'tag-hub' : 'tag-spoke') : ''}`, text: isProj ? (isHub(a.scope_id) ? 'HUB' : 'SPOKE') : 'ORG' }),
          el('span', { text: a.scope_id }),
        ]),
        el('div', { className: 'ma-mode', text: modeLabel }),
        el('div', { className: 'ma-vals', text: `허용 ${(a.allowed_values || []).length} · 차단 ${(a.denied_values || []).length} · ${a.policy_exists ? (a.managed_by_api ? 'Caps API 관리' : '정책 존재') : '정책 없음'}` }),
      ]));
    }
    const sel = $('ma-project-select');
    const prev = sel.value;
    clear(sel);
    for (const pid of state.managed) sel.appendChild(el('option', { value: pid, text: `${pid} (${isHub(pid) ? 'Hub' : 'Spoke'})` }));
    if (prev && state.managed.includes(prev)) sel.value = prev;
    const dl = clear($('ma-model-list'));
    for (const id of knownModelIds()) dl.appendChild(el('option', { value: id }));

    // Default rule
    const rd = clear($('rule-default-card'));
    const rule = d.default_rule;
    rd.append(
      el('div', { className: 'rule-default-head' }, [
        el('b', { text: '기본 규칙 (전 사용자)' }),
        el('div', { className: 'form-actions' }, [
          el('button', { className: 'btn btn-secondary btn-sm', type: 'button', id: 'rule-default-edit-btn', text: rule ? '수정' : '기본 규칙 만들기', onClick: () => openRuleModal('default') }),
          rule ? el('button', { className: 'btn btn-ghost btn-sm', type: 'button', id: 'rule-default-delete-btn', text: '삭제', onClick: () => deleteRule('default') }) : null,
        ]),
      ]),
      rule ? ruleSummary(rule) : el('p', { className: 'muted small', text: '기본 규칙이 없습니다 — 사용자별 규칙이 없으면 모든 모델을 무제한 사용할 수 있습니다.' }),
    );
    const ul = clear($('rule-user-list'));
    const userRules = d.user_rules || [];
    $('rule-user-count').textContent = `${userRules.length}명`;
    if (!userRules.length) ul.appendChild(el('p', { className: 'muted small', text: '사용자별 규칙이 없습니다. 사용자 탭의 "모델 규칙" 버튼으로 추가하세요.' }));
    for (const r of userRules) {
      const em = r.email;
      const ru = r.rule || r;
      ul.appendChild(el('div', { className: 'rule-user', id: `rule-user-${slug(em)}` }, [
        el('div', {}, [el('div', { className: 'ru-email', text: maskEmail(em) }), ruleSummary(ru)]),
        el('div', { className: 'form-actions' }, [
          el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `rule-user-edit-btn-${slug(em)}`, text: '수정', onClick: () => openRuleModal(em) }),
          el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `rule-user-delete-btn-${slug(em)}`, text: '삭제', onClick: () => deleteRule(em) }),
        ]),
      ]));
    }

    // Catalog
    const pubSel = $('catalog-publisher');
    const prevPub = pubSel.value;
    clear(pubSel).appendChild(el('option', { value: '', text: '전체 퍼블리셔' }));
    for (const p of ((d.catalog_meta || {}).publishers || [])) pubSel.appendChild(el('option', { value: p, text: p }));
    pubSel.value = prevPub;
    renderCatalog();
  }
  function renderCatalog() {
    const d = state.models;
    if (!d) return;
    const q = $('catalog-search').value.trim().toLowerCase();
    const pub = $('catalog-publisher').value;
    const usageBy = Object.fromEntries((d.usage || []).map((u) => [String(u.model).toLowerCase(), u]));
    const access = Object.fromEntries((d.model_access || []).filter((a) => a.scope_type === 'projects').map((a) => [a.scope_id, a]));
    const rows = (d.catalog || []).filter((m) => (!pub || m.publisher === pub) && (!q || String(m.id).toLowerCase().includes(q) || String(m.display_name || '').toLowerCase().includes(q)))
      .sort((a, b) => num((usageBy[String(b.id).toLowerCase()] || {}).estimated_cost) - num((usageBy[String(a.id).toLowerCase()] || {}).estimated_cost) || String(a.id).localeCompare(String(b.id)));
    const tbody = clear($('catalog-tbody'));
    if (!rows.length) { tbody.appendChild(el('tr', {}, [el('td', { colspan: '8', className: 'empty-cell', text: '조건에 맞는 모델이 없습니다.' })])); return; }
    rows.forEach((m, i) => {
      const p = m.pricing || pricingFor(m.id) || {};
      const u = usageBy[String(m.id).toLowerCase()];
      const stage = (m.lifecycle && m.lifecycle.stage) || '—';
      const s = slug(m.id);
      const tr = el('tr', { id: `catalog-row-${s}` }, [
        el('td', {}, [el('div', { className: 'mono', text: m.id }), el('div', { className: 'muted small', text: m.display_name || '' })]),
        el('td', { text: m.publisher || '—' }),
        el('td', {}, [el('span', { className: `lifecycle ${String(stage).toLowerCase()}`, text: stage })]),
        el('td', { className: 'num', text: p.input_per_1m_tokens !== undefined && p.input_per_1m_tokens !== null ? fmtUSD(p.input_per_1m_tokens) : '—' }),
        el('td', { className: 'num', text: p.output_per_1m_tokens !== undefined && p.output_per_1m_tokens !== null ? fmtUSD(p.output_per_1m_tokens) : '—' }),
        el('td', { className: 'num', text: u ? fmtUSD(u.estimated_cost) : '—' }),
        el('td', {}, [el('div', { className: 'access-dots' }, state.managed.map((pid) => {
          const a = accessFor(m, access[pid]);
          return el('span', { className: `access-dot ${a}`, title: pid, text: `${isHub(pid) ? 'H' : 'S'} · ${{ allowed: '허용', denied: '제한', inherit: '상속' }[a]}` });
        }))]),
        el('td', { className: 'actions-col' }, [el('div', { className: 'row-actions' }, [
          el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `catalog-restrict-btn-${s}`, text: '제한 미리보기', onClick: () => prefillModelAccess(m.id, 'restrict') }),
          el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `catalog-allow-btn-${s}`, text: '허용 미리보기', onClick: () => prefillModelAccess(m.id, 'allow') }),
        ])]),
      ]);
      tr.style.animationDelay = `${Math.min(i, 20) * 15}ms`;
      tbody.appendChild(tr);
    });
  }
  function setMaAction(action) {
    state.ma.action = action;
    $('ma-action-restrict').classList.toggle('active', action === 'restrict');
    $('ma-action-allow').classList.toggle('active', action === 'allow');
    invalidateMaDry();
  }
  function maKey() { return `${$('ma-project-select').value}|${$('ma-model-select').value.trim().toLowerCase()}|${state.ma.action}`; }
  function invalidateMaDry() {
    state.ma.lastDryKey = null;
    $('ma-apply-btn').disabled = true;
  }
  function prefillModelAccess(modelId, action) {
    $('ma-model-select').value = modelId;
    setMaAction(action);
    $('ma-form').scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' });
    runMaDry();
  }
  function impactNode(result, kind, title) {
    const box = el('div', { className: `impact ${kind}` });
    box.appendChild(el('div', { className: 'impact-head' }, [icon(kind === 'error' ? 'warn' : kind === 'applied' ? 'check' : 'info'), title]));
    const grid = el('div', { className: 'impact-grid' });
    const addKV = (k, v) => {
      if (v === null || v === undefined || typeof v === 'object' && !Array.isArray(v)) return;
      let text = v;
      if (Array.isArray(v)) {
        const joined = v.every((x) => typeof x !== 'object') ? v.map(String).join(', ') : null;
        if (!v.length) text = '없음';
        else if (joined !== null && joined.length <= 60) text = joined;
        else text = `${v.length}개 항목`;
      }
      else if (typeof v === 'boolean') text = v ? 'true' : 'false';
      grid.appendChild(el('div', { className: 'impact-kv' }, [el('span', { text: k }), el('b', { text: maskText(String(text)) })]));
    };
    if (result && typeof result === 'object') {
      for (const [k, v] of Object.entries(result)) if (k !== 'object') addKV(k, v);
      for (const nested of ['impact', 'change', 'summary', 'preview']) {
        if (result[nested] && typeof result[nested] === 'object' && !Array.isArray(result[nested])) for (const [k, v] of Object.entries(result[nested])) addKV(`${nested}.${k}`, v);
      }
    }
    if (grid.children.length) box.appendChild(grid);
    box.appendChild(el('details', { className: 'raw' }, [el('summary', { text: '원본 응답 JSON' }), el('pre', { className: 'code-block', text: maskText(JSON.stringify(result, null, 2)) })]));
    return box;
  }
  async function runMaDry() {
    const project_id = $('ma-project-select').value;
    const model_id = $('ma-model-select').value.trim();
    if (!model_id) { toast('모델 ID를 입력하거나 카탈로그에서 선택하세요.', 'warn'); $('ma-model-select').focus(); return; }
    const box = $('ma-impact');
    await withLoading($('ma-dryrun-btn'), async () => {
      try {
        const res = await apiPost('/api/model-access/toggle', { project_id, model_id, action: state.ma.action, dryRun: true, reason: $('ma-reason-input').value });
        state.ma.lastDryKey = maKey();
        $('ma-apply-btn').disabled = false;
        box.replaceWith(Object.assign(impactNode(res.result, 'dry', `Dry-run 영향 미리보기 — ${project_id} · ${model_id} ${state.ma.action === 'restrict' ? '제한' : '허용'}`), { id: 'ma-impact' }));
      } catch (err) {
        invalidateMaDry();
        box.replaceWith(Object.assign(impactNode({ error: err.code || 'error', message: err.message }, 'error', 'Dry-run 실패'), { id: 'ma-impact' }));
      }
    });
  }
  async function runMaApply() {
    if (state.ma.lastDryKey !== maKey()) { toast('먼저 동일한 조건으로 Dry-run을 실행하세요.', 'warn'); return; }
    const project_id = $('ma-project-select').value;
    const model_id = $('ma-model-select').value.trim();
    const verb = state.ma.action === 'restrict' ? '제한' : '허용';
    if (!(await askConfirm(`${project_id} 프로젝트의 Org Policy에서 ${model_id} 모델을 ${verb}합니다.\n실제 GCP 조직 정책이 변경됩니다. 계속할까요?`, `정책 ${verb} 적용`))) return;
    await withLoading($('ma-apply-btn'), async () => {
      try {
        const res = await apiPost('/api/model-access/toggle', { project_id, model_id, action: state.ma.action, dryRun: false, reason: $('ma-reason-input').value });
        $('ma-impact').replaceWith(Object.assign(impactNode(res.result, 'applied', `적용 완료 — ${project_id} · ${model_id} ${verb}`), { id: 'ma-impact' }));
        invalidateMaDry();
        toast(`Org Policy 변경 적용: ${model_id} ${verb}`, 'success');
        state.loaded.models = null;
        await ensureModels(true);
        renderModels();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  async function runRuleEval(dryRun) {
    if (!dryRun && !(await askConfirm('모델 규칙을 평가하고 위반 사용자를 실제로 차단합니다. 계속할까요?', '평가 후 집행'))) return;
    const btn = dryRun ? $('rule-eval-dryrun-btn') : $('rule-eval-apply-btn');
    await withLoading(btn, async () => {
      try {
        const res = await apiPost('/api/model-rules/evaluate', { dryRun });
        const r = res.result || {};
        const box = el('div', { className: `impact ${dryRun ? 'dry' : 'applied'}`, id: 'rule-eval-result' });
        box.appendChild(el('div', { className: 'impact-head' }, [icon(dryRun ? 'info' : 'check'), dryRun ? '평가 미리보기 (Dry-run) — 실제 차단 없음' : '평가 및 집행 완료']));
        box.appendChild(el('div', { className: 'impact-grid' }, [
          el('div', { className: 'impact-kv' }, [el('span', { text: '평가 대상' }), el('b', { text: `${fmtInt(r.evaluated)}명` })]),
          el('div', { className: 'impact-kv' }, [el('span', { text: '위반' }), el('b', { text: `${(r.violations || []).length}건` })]),
          el('div', { className: 'impact-kv' }, [el('span', { text: dryRun ? '차단 예정' : '차단됨' }), el('b', { text: `${(r.blocked || []).length}명` })]),
          r.skipped ? el('div', { className: 'impact-kv' }, [el('span', { text: '건너뜀 사유' }), el('b', { text: r.skipped === 'no_rules' ? '규칙 없음 (no_rules)' : r.skipped })]) : null,
        ]));
        if ((r.violations || []).length) {
          box.appendChild(el('table', { className: 'mini-table' }, [
            el('thead', {}, [el('tr', {}, ['사용자', '모델', '지표', '관측', '한도'].map((h) => el('th', { text: h })))]),
            el('tbody', {}, r.violations.slice(0, 20).map((v) => el('tr', {}, [
              el('td', { text: maskEmail(v.email) }), el('td', { className: 'mono', text: v.model || '—' }), el('td', { text: v.metric || v.type || '—' }),
              el('td', { text: String(v.observed ?? '—') }), el('td', { text: String(v.limit ?? '—') }),
            ]))),
          ]));
        }
        box.appendChild(el('details', { className: 'raw' }, [el('summary', { text: '원본 응답 JSON' }), el('pre', { className: 'code-block', text: maskText(JSON.stringify(r, null, 2)) })]));
        $('rule-eval-result').replaceWith(box);
        if (!dryRun) { await ensureOverview(true).catch(() => {}); }
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ---------------------------------------------------------------------------
  // Policies & safety gates
  // ---------------------------------------------------------------------------
  function renderGateGrid(gates, phase) {
    const grid = clear($('gates-grid'));
    const byId = Object.fromEntries((gates || []).map((g) => [g.id, g]));
    Object.entries(GATE_LABELS).forEach(([id, [name, desc]], i) => {
      const g = byId[id];
      const status = phase === 'checking' ? 'checking' : (g ? (g.status === 'pass' ? 'pass' : g.status === 'warn' ? 'warn' : 'fail') : 'idle');
      const card = el('div', { className: `gate ${status}`, id: `gate-${id.slice(0, 2).toLowerCase()}`, dataset: { gate: id, status } }, [
        el('div', { className: 'gate-id' }, [id.slice(0, 2), el('span', { className: 'gate-icon' }, [icon(status === 'pass' ? 'check' : status === 'fail' ? 'x' : status === 'warn' ? 'warn' : status === 'checking' ? 'spin' : 'shield')])]),
        el('div', { className: 'gate-name', text: name }),
        el('div', { className: 'gate-detail', text: g ? g.detail : (phase === 'checking' ? '검증 중…' : desc) }),
      ]);
      if (g && !REDUCED_MOTION) card.style.animationDelay = `${i * 110}ms`;
      grid.appendChild(card);
    });
  }
  async function runGates(dryRun) {
    if (!dryRun && !(await askConfirm('안전 게이트 통과 시 지출 한도 집행을 실제로 실행합니다 (IAM Deny 정책 변경 가능). 계속할까요?', '집행 실행'))) return;
    const btn = dryRun ? $('gates-dryrun-btn') : $('gates-apply-btn');
    renderGateGrid(null, 'checking');
    $('gates-plan').hidden = true;
    await withLoading(btn, async () => {
      try {
        const res = await apiPost('/api/caps/enforce', { dryRun });
        const r = res.result || {};
        const gates = r.gates || [];
        // Sequential reveal G1 -> G7
        for (let i = 0; i <= gates.length; i += 1) {
          renderGateGrid(gates.slice(0, i), null);
          const grid = $('gates-grid');
          for (const card of grid.querySelectorAll('.gate.idle')) { card.className = 'gate checking'; }
          if (i < gates.length && !REDUCED_MOTION) await new Promise((ok) => window.setTimeout(ok, 220));
        }
        renderGateGrid(gates, null);
        const plan = r.plan || {};
        const allPass = gates.length > 0 && gates.every((g) => g.status === 'pass');
        const chip = (label, value) => el('span', { className: 'plan-chip' }, [label, el('b', { text: String(value) })]);
        const box = clear($('gates-plan'));
        appendAll(box, [
          el('span', { className: `badge ${allPass ? 'st-active' : 'st-blocked'}` }, [el('span', { className: 'bdot' }), allPass ? `G1–G7 전체 통과 (${gates.length}/7)` : `게이트 실패 ${gates.filter((g) => g.status !== 'pass').length}건`]),
          el('span', { className: 'badge st-unknown', text: r.mode === 'dry_run' || dryRun ? 'Dry-run · 실제 변경 없음' : `실행됨 · ${r.result || ''}` }),
          chip('정지 예정 ', (plan.suspend || []).length),
          chip('차단 예정 ', (plan.block || []).length),
          chip('복구 예정 ', (plan.restore || []).length),
          chip('검토 필요 ', (plan.review || []).length),
          chip('보류 ', (plan.deferred || []).length),
          chip('변경 예산 ', plan.change_budget ?? '—'),
          plan.aborted ? el('span', { className: 'badge st-blocked', text: `중단: ${plan.abort_reason || ''}` }) : null,
          r.governance && r.governance.model_rules ? chip('모델 규칙 위반 ', num(r.governance.model_rules.violations)) : null,
        ]);
        box.hidden = false;
        toast(allPass ? '안전 게이트 G1–G7 모두 통과했습니다.' : '일부 안전 게이트가 통과하지 못했습니다.', allPass ? 'success' : 'warn');
        if (!dryRun) {
          // Real enforcement: refresh user states and follow any propagating IAM Deny changes live.
          await ensureOverview(true).catch(() => {});
          for (const email of [...(plan.block || []), ...(plan.suspend || []), ...(plan.restore || [])].map((x) => (typeof x === 'string' ? x : x && x.email)).filter(Boolean)) {
            const key = String(email).toLowerCase();
            const t = state.trackers.get(key);
            if (!t || t.done) startTracking(email, (plan.restore || []).some((x) => (typeof x === 'string' ? x : x && x.email) === email) ? 'unblock' : 'block');
          }
        }
      } catch (err) {
        renderGateGrid(null);
        toast(err.message, 'error');
      }
    });
  }
  function renderPolicies() {
    const d = state.projects;
    if (!d) return;
    const pol = d.policy || {};
    $('policy-cost').value = pol.cost_cap ?? 0;
    $('policy-token').value = pol.token_cap ?? 0;
    $('policy-request').value = pol.request_cap ?? 0;
    $('policy-period').value = pol.period || 'monthly';
    $('policy-mode').value = pol.enforcement_mode || 'auto';
    $('policy-scope').value = pol.cap_scope || 'total';
    $('policy-window').textContent = pol.current_window ? `현재 주기 ${fmtDateTime(pol.current_window.start)} ~ ${fmtDateTime(pol.current_window.end)}` : '';
    const svcBox = clear($('policy-services'));
    for (const [id, label] of SERVICES) {
      svcBox.appendChild(el('label', { className: 'check-pill', for: `policy-svc-${id}` }, [
        el('input', { type: 'checkbox', id: `policy-svc-${id}`, value: id, checked: (pol.default_block_services || []).includes(id) }), label,
      ]));
    }
    const pd = clear($('policy-project-defaults'));
    for (const pid of state.managed) {
      pd.appendChild(el('label', { className: 'field' }, [
        el('span', { className: 'field-label' }, [el('span', { className: `tag ${isHub(pid) ? 'tag-hub' : 'tag-spoke'}`, text: isHub(pid) ? 'HUB' : 'SPOKE' }), ` ${pid}`]),
        el('input', { id: `policy-pd-${pid}`, type: 'number', min: '0', step: '0.01', value: ((pol.project_defaults || {})[pid] || {}).cost_cap ?? 0 }),
      ]));
    }

    // Billing sync banner
    const pcaps = d.project_caps || {};
    const bs = pcaps.billing_sync || null;
    const banner = $('billing-sync-banner');
    if (bs) {
      const ok = bs.status === 'ok';
      banner.className = `billing-banner ${ok ? 'ok' : ''}`;
      clear(banner).append(
        el('span', { className: 'bb-icon' }, [icon(ok ? 'check' : 'warn')]),
        el('div', {}, [
          el('div', { className: 'bb-title', text: ok ? 'Cloud Billing 예산 동기화 정상' : `Cloud Billing 예산 동기화: ${bs.status === 'permission_required' ? '권한 필요' : bs.status}` }),
          bs.message ? el('div', { className: 'bb-text', text: bs.message }) : null,
          el('dl', {}, [
            bs.billing_account ? el('dt', { text: '결제 계정' }) : null, bs.billing_account ? el('dd', { text: bs.billing_account }) : null,
            bs.required_role ? el('dt', { text: '필요 역할' }) : null, bs.required_role ? el('dd', { text: bs.required_role }) : null,
            bs.remediation ? el('dt', { text: '조치 방법' }) : null, bs.remediation ? el('dd', { text: bs.remediation }) : null,
          ]),
        ]),
      );
      banner.hidden = false;
    } else banner.hidden = true;

    const totals = Object.fromEntries(((state.overview && state.overview.project_totals) || []).map((p) => [p.project_id, p]));
    const cards = clear($('pcap-cards'));
    const rows = Object.fromEntries((pcaps.data || []).map((r) => [r.project_id, r]));
    for (const pid of state.managed) {
      const r = rows[pid] || {};
      const cfg = r.configured;
      const cost = num((totals[pid] || {}).estimated_cost);
      const util = cfg && cfg.monthly_usd ? (cost / num(cfg.monthly_usd)) * 100 : null;
      const actionSel = el('select', { id: `pcap-action-${pid}`, 'aria-label': '조치' }, [
        el('option', { value: 'hard_cap', text: '하드캡 (차단)', selected: !cfg || cfg.action !== 'notify' }),
        el('option', { value: 'notify', text: '알림만', selected: cfg && cfg.action === 'notify' }),
      ]);
      cards.appendChild(el('div', { className: 'pcap-card', id: `pcap-card-${pid}` }, [
        el('div', { className: 'pcap-head' }, [projectTag(pid), cfg ? el('span', { className: 'badge st-active', text: `${fmtUSD(cfg.monthly_usd)}/월 · ${cfg.action === 'notify' ? '알림' : '하드캡'}` }) : el('span', { className: 'badge st-unknown', text: '하드캡 미설정' })]),
        util !== null ? el('div', {}, [el('div', { className: 'util-top' }, [el('span', { className: 'muted', text: `AI 추정 비용 ${fmtUSD(cost)} / ${fmtUSD(cfg.monthly_usd)}` }), el('b', { text: fmtPct(util, 2) })]), bar(Math.max(util, 0.8), utilClass(util))]) : el('div', { className: 'muted small', text: `이번 기간 AI 추정 비용 ${fmtUSD(cost)}` }),
        cfg && cfg.updated_at ? el('div', { className: 'muted small', text: `수정 ${fmtDateTime(cfg.updated_at)} · ${cfg.updated_by || ''}` }) : null,
        el('div', { className: 'pcap-form' }, [
          el('input', { id: `pcap-input-${pid}`, type: 'number', min: '0', step: '1', placeholder: '월 USD', value: cfg ? cfg.monthly_usd : '' }),
          actionSel,
          el('button', { className: 'btn btn-secondary btn-sm', type: 'button', id: `pcap-dryrun-${pid}`, text: 'Dry-run', onClick: (e) => setProjectCap(pid, true, e.currentTarget) }),
          el('button', { className: 'btn btn-primary btn-sm', type: 'button', id: `pcap-save-${pid}`, text: '적용', onClick: (e) => setProjectCap(pid, false, e.currentTarget) }),
          cfg ? el('button', { className: 'btn btn-ghost btn-sm', type: 'button', id: `pcap-lift-${pid}`, text: '해제', onClick: (e) => liftProjectCap(pid, e.currentTarget) }) : null,
        ]),
        el('div', { id: `pcap-result-${pid}` }),
      ]));
    }

    const logs = clear($('logging-cards'));
    for (const pid of state.managed) {
      const lg = (d.inference_logging || {})[pid] || {};
      logs.appendChild(el('div', { className: 'logging-row', id: `logging-row-${pid}` }, [
        projectTag(pid),
        lg.enabled ? el('span', { className: 'badge st-active' }, [el('span', { className: 'bdot' }), `요청 로그 ${lg.state || 'ENABLED'}`])
          : el('div', { className: 'form-actions' }, [
            el('span', { className: 'badge st-over_cap', text: lg.state || (lg.error ? '확인 불가' : '비활성') }),
            el('button', { className: 'btn btn-secondary btn-sm', type: 'button', id: `logging-enable-${pid}`, text: '활성화', onClick: (e) => enableLogging(pid, e.currentTarget) }),
          ]),
      ]));
    }
  }
  async function savePolicy(e) {
    e.preventDefault();
    const body = {
      cost_cap: $('policy-cost').value || 0,
      token_cap: $('policy-token').value || 0,
      request_cap: $('policy-request').value || 0,
      period: $('policy-period').value,
      enforcement_mode: $('policy-mode').value,
      cap_scope: $('policy-scope').value,
      default_block_services: checkedValues($('policy-services')),
      project_defaults: {},
    };
    for (const pid of state.managed) body.project_defaults[pid] = { cost_cap: $(`policy-pd-${pid}`).value || 0 };
    if (!body.default_block_services.length) { toast('기본 차단 서비스를 1개 이상 선택하세요.', 'warn'); return; }
    if (!(await askConfirm('전역 지출 한도 정책을 저장합니다. 자동 집행 모드에서는 다음 집행 주기에 반영됩니다.', '정책 저장', false))) return;
    await withLoading($('policy-save-btn'), async () => {
      try {
        await apiPost('/api/caps/policy', body);
        toast('전역 정책을 저장했습니다.', 'success');
        await ensureProjects(true);
        renderPolicies();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  async function setProjectCap(pid, dryRun, btn) {
    const v = $(`pcap-input-${pid}`).value;
    if (v === '') { toast('월 하드캡 금액(USD)을 입력하세요.', 'warn'); return; }
    if (!dryRun && !(await askConfirm(`${pid} 프로젝트에 월 ${fmtUSD(v)} 하드캡을 적용합니다. 계속할까요?`, '하드캡 적용'))) return;
    await withLoading(btn, async () => {
      try {
        const res = await apiPost('/api/caps/projects/set', { project_id: pid, monthly_usd: v, action: $(`pcap-action-${pid}`).value, dryRun, apply: true });
        $(`pcap-result-${pid}`).replaceChildren(impactNode(res.result, dryRun ? 'dry' : 'applied', dryRun ? 'Dry-run 결과 — 실제 변경 없음' : '하드캡 적용 완료'));
        if (!dryRun) { toast(`${pid} 하드캡을 적용했습니다.`, 'success'); await ensureProjects(true); renderPolicies(); }
      } catch (err) { $(`pcap-result-${pid}`).replaceChildren(impactNode({ error: err.code, message: err.message }, 'error', '요청 실패')); }
    });
  }
  async function liftProjectCap(pid, btn) {
    if (!(await askConfirm(`${pid} 프로젝트의 하드캡을 해제할까요?`, '하드캡 해제'))) return;
    await withLoading(btn, async () => {
      try {
        await apiPost('/api/caps/projects/lift', { project_id: pid });
        toast(`${pid} 하드캡을 해제했습니다.`, 'success');
        await ensureProjects(true);
        renderPolicies();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  async function enableLogging(pid, btn) {
    await withLoading(btn, async () => {
      try {
        const dry = await apiPost('/api/projects/inference-logging/enable', { project_id: pid, dryRun: true });
        if (!(await askConfirm(`${pid} 프로젝트의 Gemini Platform 추론 요청 로그를 활성화합니다.\nDry-run: ${JSON.stringify(dry.result).slice(0, 200)}`, '활성화', false))) return;
        await apiPost('/api/projects/inference-logging/enable', { project_id: pid, dryRun: false });
        toast('추론 로그를 활성화했습니다.', 'success');
        await ensureProjects(true);
        renderPolicies();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ---------------------------------------------------------------------------
  // Audit & violations
  // ---------------------------------------------------------------------------
  function actionClass(action) {
    const a = String(action || '');
    if (a.includes('unblock')) return 'a-unblock';
    if (a.includes('block')) return 'a-block';
    if (a.includes('model')) return 'a-rule';
    if (a.includes('caps') || a.includes('cap')) return 'a-cap';
    return '';
  }
  function auditSummary(a) {
    const d = a.details || {};
    if (a.action === 'caps.enforce') return `${d.mode || ''} · ${d.result || ''} — 차단 ${num(d.blocked)} · 정지 ${num(d.suspended)} · 복구 ${num(d.restored)}`;
    const parts = [];
    for (const k of ['services', 'projects', 'reason', 'mode', 'type', 'cost_cap', 'monthly_usd', 'model', 'status', 'enforcement_status', 'note']) {
      if (d[k] === undefined || d[k] === null || d[k] === '') continue;
      const v = Array.isArray(d[k]) ? d[k].join(', ') : (typeof d[k] === 'object' ? JSON.stringify(d[k]) : String(d[k]));
      parts.push(`${k}: ${v}`);
    }
    if (!parts.length) for (const [k, v] of Object.entries(d).slice(0, 3)) parts.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    return parts.join(' · ').slice(0, 200) || '—';
  }
  function renderAudit() {
    const d = state.audit;
    if (!d) return;
    const vq = $('viol-search').value.trim().toLowerCase();
    const vt = $('viol-type-filter').value;
    const vbody = clear($('violations-tbody'));
    const viols = (d.violations || []).filter((v) => (!vt || v.type === vt) && (!vq || String(v.email).toLowerCase().includes(vq) || String(v.model || '').toLowerCase().includes(vq)));
    if (!viols.length) vbody.appendChild(el('tr', {}, [el('td', { colspan: '8', className: 'empty-cell', text: '위반 이벤트가 없습니다.' })]));
    const typeLabel = { limit_exceeded: '한도 초과', model_not_allowed: '허용 외 모델', model_denied: '차단 모델' };
    const actLabel = { block_service: '서비스 차단', notify: '알림', deferred: '보류' };
    viols.forEach((v, i) => {
      const tr = el('tr', { id: `violation-row-${slug(v.id)}` }, [
        el('td', { className: 'ts', text: fmtDateTime(v.detected_at, true) }),
        el('td', {}, [el('span', { className: 'user-cell' }, [avatar(v.email), el('span', { className: 'u-email', text: maskEmail(v.email) })])]),
        el('td', {}, [el('span', { className: `badge ${v.type === 'limit_exceeded' ? 'st-over_cap' : 'st-blocked'}`, text: typeLabel[v.type] || v.type })]),
        el('td', {}, [el('div', { className: 'mono small', text: v.model || '(전체 모델)' }), v.surface ? svcChip(v.surface) : null]),
        el('td', { className: 'mono small', text: v.metric || '—' }),
        el('td', { className: 'num', text: `${v.observed ?? '—'} / ${v.limit ?? '—'}` }),
        el('td', {}, [el('div', { className: 'chips' }, [el('span', { className: 'chip', text: actLabel[v.action] || v.action }), ...(v.block_services || []).map(svcChip)])]),
        el('td', { className: 'ts', text: v.block_until ? `${fmtDateTime(v.block_until)} (${fmtRel(v.block_until)})` : '—' }),
      ]);
      tr.style.animationDelay = `${Math.min(i, 20) * 20}ms`;
      vbody.appendChild(tr);
    });

    const logs = d.audit_logs || [];
    const sel = $('audit-action-filter');
    const prev = sel.value;
    clear(sel).appendChild(el('option', { value: '', text: '전체 액션' }));
    for (const a of Array.from(new Set(logs.map((l) => l.action))).sort()) sel.appendChild(el('option', { value: a, text: a }));
    sel.value = prev;
    const aq = $('audit-search').value.trim().toLowerCase();
    const hideSched = $('audit-hide-scheduler').checked;
    const rows = logs.filter((l) => (!sel.value || l.action === sel.value)
      && (!hideSched || !(l.action === 'caps.enforce' && l.auth_type === 'job'))
      && (!aq || String(l.target || '').toLowerCase().includes(aq) || String(l.actor || '').toLowerCase().includes(aq)));
    const abody = clear($('audit-tbody'));
    if (!rows.length) abody.appendChild(el('tr', {}, [el('td', { colspan: '6', className: 'empty-cell', text: hideSched && logs.length ? '표시할 항목이 없습니다 (스케줄러 자동 집행 기록은 숨김 상태).' : '감사 로그가 없습니다.' })]));
    rows.forEach((l, i) => {
      const tr = el('tr', { id: `audit-row-${slug(l.id || String(i))}` }, [
        el('td', { className: 'ts', text: fmtDateTime(l.timestamp, true) }),
        el('td', {}, [el('span', { className: `action-tag ${actionClass(l.action)}`, text: l.action })]),
        el('td', { className: 'mono small', text: maskText(l.target || '—') }),
        el('td', { className: 'small', text: maskText(`${l.actor || '—'}${l.auth_type ? ` (${l.auth_type})` : ''}`) }),
        el('td', { className: 'summary-text', text: maskText(auditSummary(l)) }),
        el('td', { className: 'actions-col' }, [el('button', { className: 'btn btn-ghost btn-xs', type: 'button', id: `audit-detail-btn-${slug(l.id || String(i))}`, text: 'JSON', onClick: () => showJson(`${l.action} · ${fmtDateTime(l.timestamp, true)}`, l) })]),
      ]);
      tr.style.animationDelay = `${Math.min(i, 20) * 15}ms`;
      abody.appendChild(tr);
    });
  }
  function showJson(title, obj) {
    $('json-title').textContent = maskText(title);
    $('json-body').textContent = maskText(JSON.stringify(obj, null, 2));
    $('json-dialog').showModal();
  }

  // ---------------------------------------------------------------------------
  // API Call Inspector
  // ---------------------------------------------------------------------------
  async function pullTrace() {
    if (!state.authenticated) return;
    if (state.trace.pulling) { state.trace.again = true; return; }
    state.trace.pulling = true;
    try {
      const r = await request('GET', '/api/_trace', { params: { since: state.trace.seq } });
      if (r.api_host && r.api_host !== state.trace.host) {
        state.trace.host = r.api_host;
        $('inspector-host').textContent = `https://${r.api_host}`;
        $('side-api-host').textContent = r.api_host;
      }
      const calls = r.calls || [];
      if (calls.length) {
        state.trace.calls.push(...calls);
        if (state.trace.calls.length > 300) state.trace.calls.splice(0, state.trace.calls.length - 300);
        state.trace.seq = r.last_seq;
        appendInspectorRows(calls);
      } else if (r.last_seq > state.trace.seq) state.trace.seq = r.last_seq;
    } catch (_) {
      /* inspector feed is best-effort */
    } finally {
      state.trace.pulling = false;
      if (state.trace.again) { state.trace.again = false; pullTrace(); }
    }
  }
  function updateTraceCounters(bump) {
    const ts = traceStats();
    const badge = $('inspector-count');
    badge.textContent = String(ts.n);
    if (bump && !REDUCED_MOTION) { badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump'); }
    $('side-call-count').textContent = fmtInt(ts.n);
    clear($('inspector-stats')).append(
      el('span', { className: 'istat' }, ['호출', el('b', { text: fmtInt(ts.n) })]),
      el('span', { className: 'istat' }, ['평균 지연', el('b', { text: ts.n ? `${ts.avg} ms` : '—' })]),
      el('span', { className: 'istat' }, ['오류', el('b', { text: String(ts.errors) })]),
      el('span', { className: 'istat' }, ['브라우저 노출 키', el('b', { text: '0' })]),
    );
    $('inspector-empty').hidden = ts.n > 0;
    if (state.tab === 'overview' && state.overview) renderHeroStats();
  }
  function splitPath(p) {
    const i = String(p).indexOf('?');
    return i === -1 ? [p, ''] : [p.slice(0, i), p.slice(i)];
  }
  function inspectorRow(c, isNew) {
    const [path, query] = splitPath(c.path);
    const statusCls = `s-${String(c.status).charAt(0)}`;
    const li = el('li', { className: `insp-row${isNew ? ' new' : ''}`, id: `insp-${c.seq}`, dataset: { seq: c.seq, method: c.method, status: c.status } });
    const dry = c.request_body && c.request_body.dryRun === true;
    const main = el('button', { className: 'insp-main', type: 'button', 'aria-expanded': state.trace.expanded.has(c.seq) ? 'true' : 'false' }, [
      el('span', { className: 'insp-time', text: String(c.ts).slice(11, 23) }),
      el('span', { className: `method m-${c.method}`, text: c.method }),
      el('span', { className: 'insp-path', title: maskText(c.path) }, [maskText(path), query ? el('span', { className: 'q', text: maskText(query) }) : null]),
      el('span', { className: `http-status ${statusCls}`, text: String(c.status) }),
      el('span', { className: 'insp-lat' }, [el('span', { text: `${c.latency_ms}ms` }), bar(Math.min(100, (num(c.latency_ms) / 2500) * 100), num(c.latency_ms) > 2000 ? 'warn' : 'cyan')]),
      el('span', { className: 'insp-action', text: `${ACTION_LABELS[c.action] || c.action || '—'}${dry ? ' · DRY-RUN' : ''}` }),
    ]);
    main.addEventListener('click', () => {
      if (state.trace.expanded.has(c.seq)) state.trace.expanded.delete(c.seq); else state.trace.expanded.add(c.seq);
      li.replaceWith(inspectorRow(c, false));
    });
    li.appendChild(main);
    if (state.trace.expanded.has(c.seq)) {
      const host = state.trace.host ? `https://${state.trace.host}` : '';
      li.appendChild(el('div', { className: 'insp-detail', id: `insp-detail-${c.seq}` }, [
        el('div', {}, [
          el('h4', { text: '요청' }),
          el('div', { className: 'req-line' }, [
            el('span', { text: `${c.method} ${maskText(host + c.path)}` }),
            el('span', { className: 'hdr', text: 'Authorization: Bearer ‹BFF 서버 보관 · 브라우저 미노출›' }),
            el('span', { className: 'hdr', text: 'Accept: application/json' }),
            el('span', { className: 'hdr', text: `콘솔 동작: ${c.action || '—'}` }),
          ]),
          el('pre', { className: 'code-block', text: c.request_body ? maskText(JSON.stringify(c.request_body, null, 2)) : '(요청 본문 없음)' }),
        ]),
        el('div', {}, [
          el('h4', { text: `응답 · HTTP ${c.status} · ${c.latency_ms}ms${c.error_code ? ` · ${c.error_code}` : ''}` }),
          el('pre', { className: 'code-block', text: c.response_preview ? `${maskText(c.response_preview)}${c.response_truncated ? '\n… (응답 일부만 표시)' : ''}` : '(응답 본문 없음)' }),
        ]),
      ]));
    }
    return li;
  }
  function appendInspectorRows(calls) {
    const list = $('inspector-list');
    for (const c of calls) list.prepend(inspectorRow(c, true));
    while (list.children.length > 300) list.lastChild.remove();
    updateTraceCounters(true);
  }
  function renderInspector(resetOnly) {
    const list = clear($('inspector-list'));
    if (!resetOnly) for (const c of state.trace.calls) list.prepend(inspectorRow(c, false));
    updateTraceCounters(false);
  }
  function openInspector() {
    state.trace.open = true;
    $('api-inspector').classList.add('open');
    $('api-inspector').setAttribute('aria-hidden', 'false');
    $('inspector-toggle').setAttribute('aria-pressed', 'true');
    document.body.classList.add('inspector-open');
    if (state.trace.inflight > 0 && !state.trace.live) state.trace.live = window.setInterval(pullTrace, 650);
    pullTrace();
  }
  function closeInspector() {
    state.trace.open = false;
    $('api-inspector').classList.remove('open');
    $('api-inspector').setAttribute('aria-hidden', 'true');
    $('inspector-toggle').setAttribute('aria-pressed', 'false');
    document.body.classList.remove('inspector-open');
    if (state.trace.live) { window.clearInterval(state.trace.live); state.trace.live = null; }
  }

  // ---------------------------------------------------------------------------
  // Global controls & wiring
  // ---------------------------------------------------------------------------
  function rerenderAll() {
    if (state.overview) { renderOverview(); renderUsers(); }
    if (state.costs) renderCosts();
    if (state.models) renderModels();
    if (state.projects) renderPolicies();
    if (state.audit) renderAudit();
    if (state.drawerData && $('user-drawer').open) renderDrawer();
    renderTrackerCard();
    renderInspector(false);
  }
  function onFilterChange() {
    state.loaded = {};
    loadTab(state.tab, true);
  }
  function bind() {
    $('login-form').addEventListener('submit', onLogin);
    $('setup-form').addEventListener('submit', onSetup);
    $('logout-btn').addEventListener('click', onLogout);
    for (const btn of document.querySelectorAll('.nav-item[data-tab]')) btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    $('overview-goto-users').addEventListener('click', () => switchTab('users'));

    $('refresh-btn').addEventListener('click', async () => {
      const b = $('refresh-btn');
      b.classList.add('spinning');
      state.loaded = {};
      if (state.tab === 'policies') state.projects = null;
      if (state.tab === 'audit') state.audit = null;
      await loadTab(state.tab, true);
      b.classList.remove('spinning');
      toast('Caps API에서 최신 데이터를 불러왔습니다.', 'success', 2200);
    });
    $('theme-toggle').addEventListener('click', () => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    });
    $('mask-toggle').addEventListener('click', () => {
      state.mask = !state.mask;
      $('mask-toggle').setAttribute('aria-pressed', state.mask ? 'true' : 'false');
      rerenderAll();
      toast(state.mask ? '이메일 마스킹 켜짐' : '이메일 마스킹 꺼짐', 'info', 1800);
    });
    $('inspector-toggle').addEventListener('click', () => (state.trace.open ? closeInspector() : openInspector()));
    $('inspector-close-btn').addEventListener('click', closeInspector);
    $('inspector-clear-btn').addEventListener('click', () => {
      state.trace.calls = [];
      state.trace.expanded.clear();
      renderInspector(true);
    });

    for (const btn of document.querySelectorAll('#filter-bar .seg-btn')) {
      btn.addEventListener('click', () => {
        for (const b of document.querySelectorAll('#filter-bar .seg-btn')) b.classList.toggle('active', b === btn);
        state.project = btn.id === 'proj-all' ? 'all' : btn.dataset.project;
        onFilterChange();
      });
    }
    $('filter-start').addEventListener('change', (e) => { if (e.target.value) { state.start = e.target.value; onFilterChange(); } });
    $('filter-end').addEventListener('change', (e) => { if (e.target.value) { state.end = e.target.value; onFilterChange(); } });
    $('fresh-toggle').addEventListener('change', (e) => { state.fresh = e.target.checked; onFilterChange(); });

    $('users-tbody').addEventListener('click', onUsersTableClick);
    $('user-search').addEventListener('input', (e) => { state.userSearch = e.target.value; renderUsers(); });
    for (const btn of document.querySelectorAll('#user-status-filter .seg-btn')) {
      btn.addEventListener('click', () => {
        for (const b of document.querySelectorAll('#user-status-filter .seg-btn')) b.classList.toggle('active', b === btn);
        state.userStatus = btn.dataset.status;
        renderUsers();
      });
    }

    for (const id of ['cost-view-users', 'cost-view-models']) {
      $(id).addEventListener('click', () => {
        state.costView = $(id).dataset.view;
        $('cost-view-users').classList.toggle('active', state.costView === 'users');
        $('cost-view-models').classList.toggle('active', state.costView === 'models');
        renderCosts();
      });
    }
    $('cost-search').addEventListener('input', (e) => { state.costSearch = e.target.value; renderCosts(); });
    $('cost-users-table').querySelector('thead').addEventListener('click', onCostSort);
    $('cost-models-table').querySelector('thead').addEventListener('click', onCostSort);

    $('ma-action-restrict').addEventListener('click', () => setMaAction('restrict'));
    $('ma-action-allow').addEventListener('click', () => setMaAction('allow'));
    $('ma-project-select').addEventListener('change', invalidateMaDry);
    $('ma-model-select').addEventListener('input', invalidateMaDry);
    $('ma-dryrun-btn').addEventListener('click', runMaDry);
    $('ma-apply-btn').addEventListener('click', runMaApply);
    $('ma-form').addEventListener('submit', (e) => { e.preventDefault(); runMaDry(); });
    $('rule-eval-dryrun-btn').addEventListener('click', () => runRuleEval(true));
    $('rule-eval-apply-btn').addEventListener('click', () => runRuleEval(false));
    $('catalog-search').addEventListener('input', renderCatalog);
    $('catalog-publisher').addEventListener('change', renderCatalog);

    $('gates-dryrun-btn').addEventListener('click', () => runGates(true));
    $('gates-apply-btn').addEventListener('click', () => runGates(false));
    $('policy-form').addEventListener('submit', savePolicy);

    $('viol-search').addEventListener('input', renderAudit);
    $('viol-type-filter').addEventListener('change', renderAudit);
    $('audit-search').addEventListener('input', renderAudit);
    $('audit-action-filter').addEventListener('change', renderAudit);
    $('audit-hide-scheduler').addEventListener('change', renderAudit);

    // Drawer
    $('drawer-close-btn').addEventListener('click', () => $('user-drawer').close());
    $('drawer-refresh-btn').addEventListener('click', () => loadDrawer(true));
    $('drawer-cap-btn').addEventListener('click', () => state.drawerEmail && openCapModal(state.drawerEmail));
    $('drawer-block-btn').addEventListener('click', () => state.drawerEmail && openBlockModal(state.drawerEmail));
    $('drawer-unblock-btn').addEventListener('click', () => state.drawerEmail && openUnblockModal(state.drawerEmail));
    $('drawer-rule-btn').addEventListener('click', () => state.drawerEmail && openRuleModal(state.drawerEmail));
    $('user-drawer').addEventListener('close', () => { state.drawerEmail = null; state.drawerData = null; });

    // Modals
    for (const id of ['cap-modal', 'block-modal', 'unblock-modal', 'rule-modal']) bindModalClose($(id));
    $('cap-form').addEventListener('submit', submitCap);
    $('cap-delete-btn').addEventListener('click', deleteCap);
    $('block-form').addEventListener('submit', submitBlock);
    $('unblock-form').addEventListener('submit', submitUnblock);
    $('rule-form').addEventListener('submit', submitRule);
    $('rule-add-limit-btn').addEventListener('click', () => $('rule-limits').appendChild(limitRow({})));
    $('rule-delete-btn').addEventListener('click', () => deleteRule(state.ruleScope));
    $('json-close-btn').addEventListener('click', () => $('json-dialog').close());

    // Light-dismiss for drawer / json viewer (click on backdrop).
    for (const id of ['user-drawer', 'json-dialog']) {
      $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).close(); });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.trace.open && !document.querySelector('dialog[open]')) closeInspector();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    checkAuthStatus();
  });
})();
