"""Users: per-user activity across surfaces with IAM state."""

from __future__ import annotations

import logging

from .. import timeutil
from ..gcp import GcpError
from ..httpkit import ApiError
from ..schema import quote_ident
from ..security import is_admin_email, uid_for
from .base import (AGY_SINK, ARMOR_OPS, AUDIT_DATA_ACCESS, bucket_sql, human_sql, iso, range_params, to_int)
from .gemini_enterprise import (ACTIVITY_UPLOAD_NOTE, AGENT_NAMES_CTE, act_ctes, activity_upload_sql, agent_label,
                                directory_for, ev_cte, file_items_sql, file_rows_to_items, msg_ctes, prompt_caps)
from .model_armor import armor_ctes, attribution_ctes, events_query
from .notebooklm import audit_fields, nb_ctes
from . import governance

LOG = logging.getLogger("controlplane.users")

METRICS = ("gePrompts", "agentCalls", "notebooklmPrompts", "antigravityRequests", "antigravityTokens",
           "agentPlatformCalls", "armorBlocks", "fileUploads")
ACTIVITY_METRICS = ("geActivity", "notebooklmActivity")
# Long-format metric for scheduled agent runs: summed into agentCalls, ignored for last activity.
AUTO_METRIC = "agentCallsScheduled"
MAX_USERS = 2000
MODEL_CALL_METHODS = r"(GenerateContent|StreamGenerateContent|Predict|RawPredict|StreamRawPredict|ChatCompletions)"


def long_ctes(ctx, start_param="start_ts"):
    """Builds CTEs and the long-format union.

    Returns (ctes, parts, labels, agy_in_sql, available) where `available` is the set of metric
    keys that have a source in this workspace."""
    ctes = []
    parts = []
    labels = []
    available = set()
    from .gemini_enterprise import GE_ACTIVITY, GE_MESSAGE
    msrc = ctx.audit_source(GE_MESSAGE)
    asrc = ctx.audit_source(GE_ACTIVITY)
    dsrc = ctx.audit_source(AUDIT_DATA_ACCESS)
    osrc = ctx.audit_source(ARMOR_OPS)
    agy_src = None
    if ctx.settings["governance"]["antigravity"].get("usage_source") in ("auto", "bigquery"):
        agy_src = ctx.audit_source(AGY_SINK, optional=True)
    act_ok = False
    caps_m = caps_a = None
    if msrc:
        c, caps_m = msg_ctes(msrc, start_param)
        ctes += c
        labels.append(msrc.label)
        parts.append("SELECT email AS email, 'geActivity' AS metric, 1 AS value, ts AS ts FROM msg WHERE NOT is_auto")
        available.add("geActivity")
    if asrc:
        c, caps_a = act_ctes(asrc, start_param)
        ctes += c
        labels.append(asrc.label)
        act_ok = caps_a["user"]
        parts.append("SELECT email AS email, 'geActivity' AS metric, 1 AS value, ts AS ts FROM act WHERE NOT is_auto")
        available.add("geActivity")
        if caps_a["agent"]:
            # Scheduled runs are the owner's agent calls but not activity of the person (AUTO_METRIC, see pivot_sql).
            parts.append("SELECT email AS email, IF(is_auto, '%s', 'agentCalls') AS metric, 1 AS value, ts AS ts "
                         "FROM act WHERE agent_id IS NOT NULL" % AUTO_METRIC)
        if caps_a["method"]:
            # Without the agent id column (no agent call logged yet, see act_ctes) agent calls are 0, not unknown.
            available.add("agentCalls")
    has_prompts, has_uploads = prompt_caps(caps_m, caps_a)
    if has_prompts or has_uploads:
        # Prompts and uploads: message log when populated in the window, otherwise activity log calls.
        ctes.append(ev_cte(bool(msrc), bool(asrc)))
        if has_prompts:
            parts.append("SELECT email AS email, 'gePrompts' AS metric, 1 AS value, ts AS ts FROM ev WHERE prompt = 1")
            available.add("gePrompts")
        if has_uploads:
            parts.append("SELECT email AS email, 'fileUploads' AS metric, 1 AS value, ts AS ts FROM ev WHERE upload = 1")
            available.add("fileUploads")
    if dsrc:
        nb = nb_ctes(dsrc, start_param)
        f = audit_fields(dsrc)
        if nb is not None:
            ctes += nb
            labels.append(dsrc.label)
            parts.append("SELECT email AS email, 'notebooklmActivity' AS metric, 1 AS value, ts AS ts FROM nb")
            parts.append("SELECT email AS email, 'notebooklmPrompts' AS metric, 1 AS value, MIN(ts) AS ts FROM nb "
                         "WHERE prompt_key IS NOT NULL GROUP BY email, prompt_key")
            ctes.append("apc AS (SELECT %s AS ts, LOWER(%s) AS email FROM da_src t WHERE %s = 'aiplatform.googleapis.com' "
                        "AND REGEXP_CONTAINS(%s, r'%s'))" % (f["ts"], f["principal"], f["service"], f["method"],
                                                             MODEL_CALL_METHODS))
            parts.append("SELECT email AS email, 'agentPlatformCalls' AS metric, 1 AS value, ts AS ts FROM apc")
            available.update({"notebooklmActivity", "notebooklmPrompts", "agentPlatformCalls"})
    if osrc and act_ok:
        c, caps = armor_ctes(osrc, start_param)
        if caps["verdict"] and caps["corr"]:
            if caps_a["token"]:
                ctes += c
                ctes.append("act_tok AS (SELECT token, ANY_VALUE(email) AS email FROM act WHERE token IS NOT NULL "
                            "AND email IS NOT NULL GROUP BY token)")
                labels.append(osrc.label)
                parts.append("SELECT t.email AS email, 'armorBlocks' AS metric, 1 AS value, o.ts AS ts "
                             "FROM ops o JOIN act_tok t ON t.token = o.token WHERE o.blocked")
            # Without the assist token column (no assist response logged yet) no block can be attributed: 0 per user.
            available.add("armorBlocks")
    agy_in_sql = False
    if agy_src is not None:
        f = governance.agy_fields(agy_src)
        if f["user"]:
            ctes.append(agy_src.cte("agy_src", start=start_param))
            ctes.append("agy AS (SELECT %s AS ts, LOWER(%s) AS email, IFNULL(%s, 0) AS total FROM agy_src t)"
                        % (f["ts"], f["user"], f["total"] or "0"))
            parts.append("SELECT email AS email, 'antigravityRequests' AS metric, 1 AS value, ts AS ts FROM agy")
            parts.append("SELECT email AS email, 'antigravityTokens' AS metric, total AS value, ts AS ts FROM agy")
            labels.append(agy_src.label)
            agy_in_sql = True
            available.update({"antigravityRequests", "antigravityTokens"})
    return ctes, parts, labels, agy_in_sql, available


def pivot_sql(ctes, parts, email_filter=False, per_bucket=False):
    metrics = METRICS + ACTIVITY_METRICS
    cols = ", ".join(("SUM(IF(metric IN ('%s', '%s'), value, 0)) AS %s" % (m, AUTO_METRIC, m)) if m == "agentCalls"
                     else ("SUM(IF(metric = '%s', value, 0)) AS %s" % (m, m)) for m in metrics)
    last = "MAX(IF(metric != '%s', ts, NULL)) AS last_active" % AUTO_METRIC
    where = "email IS NOT NULL AND %s" % human_sql("email")
    if email_filter:
        where += " AND email = @email"
    long_cte = "long AS (%s)" % "\nUNION ALL ".join(parts)
    if per_bucket:
        return ("WITH %s,\n%s\nSELECT %s AS bucket, %s, %s FROM long WHERE %s GROUP BY bucket"
                % (",\n".join(ctes), long_cte, bucket_sql("ts"), cols, last, where))
    order = " + ".join(m for m in METRICS if m != "antigravityTokens")
    return ("WITH %s,\n%s\nSELECT * FROM (SELECT email, %s, %s FROM long WHERE %s GROUP BY email)\n"
            "ORDER BY (%s + geActivity + notebooklmActivity) DESC, email LIMIT %d"
            % (",\n".join(ctes), long_cte, cols, last, where, order, MAX_USERS))


def surfaces_of(m):
    out = []
    if m.get("gePrompts") or m.get("agentCalls") or m.get("fileUploads") or m.get("geActivity"):
        out.append("gemini_enterprise")
    if m.get("notebooklmPrompts") or m.get("notebooklmActivity"):
        out.append("notebooklm")
    if m.get("antigravityRequests"):
        out.append("antigravity")
    if m.get("agentPlatformCalls"):
        out.append("agent_platform")
    return out


def user_table(ctx, rng):
    """Per-user metrics for a range.

    Returns {"users": {email: metrics}, "available": [metric keys with a readable source],
    "sourced": bool}. `sourced` is False when no contributing source could be read; the
    user list is then unknown (null in responses), never an empty list."""
    ctes, parts, labels, agy_in_sql, available = long_ctes(ctx)
    users = {}
    sourced = False
    if parts:
        try:
            rows = ctx.query(pivot_sql(ctes, parts), range_params(rng, with_prev=False), "users")
        except GcpError as err:
            ctx.warn_error(labels[0] if labels else "bigquery:%s" % ctx.audit_dataset, err, "User activity")
            available = set()
            agy_in_sql = False
        else:
            sourced = True
            for lbl in labels:
                ctx.add_source(lbl)
            for row in rows:
                email = row.get("email")
                if not email:
                    continue
                m = {k: to_int(row.get(k)) for k in METRICS + ACTIVITY_METRICS}
                m["lastActive"] = row.get("last_active")
                users[email] = m
            if len(rows) >= MAX_USERS:
                ctx.warn(labels[0] if labels else "bigquery", "truncated",
                         "Only the %d most active users are listed." % MAX_USERS)
    else:
        available = set()
    if not agy_in_sql and ctx.settings["modules"].get("antigravity", True):
        usage = governance.antigravity_usage(ctx, rng.start_ts(), rng.end_ts())
        if usage.ok:
            sourced = True
            available |= {"antigravityRequests", "antigravityTokens"}
            for email, u in usage.users.items():
                if not email or "@" not in email:
                    continue
                m = users.setdefault(email, {k: 0 for k in METRICS + ACTIVITY_METRICS})
                m.setdefault("lastActive", None)
                m["antigravityRequests"] += u["requests"]
                m["antigravityTokens"] += u["tokens"]
                last = u.get("last")
                if last is not None and (m.get("lastActive") is None or last > m["lastActive"]):
                    m["lastActive"] = last
    if not sourced and not parts and ctx.audit_dataset_ready() and not ctx.has_transient_warning():
        sourced = True
        ctx.add_source("bigquery:%s" % ctx.audit_dataset)
    return {"users": users, "available": sorted(available), "sourced": sourced}


def _metric(m, key, available):
    return m.get(key) if key in available else None


def iam_context(ctx):
    """Governance status (default policy) for IAM states. Returns (payload, internal) or (None, None)."""
    if not ctx.settings["modules"].get("antigravity", True):
        return None, None
    try:
        return ctx.memo("gov_default_status", "default", lambda c: governance.default_status(c), ttl=60)
    except GcpError as err:
        ctx.warn_error("api:cloudresourcemanager.projects.getIamPolicy", err, "The project IAM policy")
        return None, None


CAP_FIELDS = ("exception", "suspension", "restoreAt", "overCap", "overCapReasons", "capUsage", "estimatedCost",
              "caps", "credit")


def _blocked_map(ctx):
    mgr = getattr(ctx.app, "settings", None)
    return mgr.blocked_accounts() if mgr is not None else {}


def _ai_block_status(ctx, email, internal, blocked_map, custom_cache):
    rec = (blocked_map or {}).get(email)
    if not rec:
        return None
    remaining = []
    if internal and internal.get("readable"):
        cfg = internal["cfg"]
        remaining = [role for role, _ in internal["idx"].user_bindings(email)
                     if governance.is_ai_service_role(ctx, role, cfg, custom_cache)]
    return {
        "active": not remaining,
        "dashboardBlocked": True,
        "at": rec.get("at") or None,
        "by": rec.get("by") or None,
        "note": rec.get("note") or None,
        "removedRoles": list(rec.get("removedRoles") or []),
        "restoreRoles": list(rec.get("restoreRoles") or []),
        "remainingRoles": remaining,
    }


def iam_for(email, status_payload, internal, ctx=None, blocked_map=None, custom_cache=None):
    ai_block = _ai_block_status(ctx, email, internal, blocked_map, custom_cache if custom_cache is not None else {}) \
        if ctx is not None else None
    if status_payload is None or internal is None:
        out = {"state": "UNKNOWN", "reason": None}
        if ai_block is not None:
            out["aiBlocked"] = ai_block
        return out
    for u in status_payload["users"] or []:
        if u["email"] == email:
            out = {"state": u["state"], "reason": u["reason"]}
            out.update({k: u.get(k) for k in CAP_FIELDS})
            if ai_block is not None:
                out["aiBlocked"] = ai_block
            return out
    state, reason = governance.classify(email, False, internal["idx"], internal["cfg"])
    out = {"state": state, "reason": reason}
    for row in status_payload.get("exceptions") or []:
        if row.get("email") == email:
            out["exception"] = {k: v for k, v in row.items() if k not in ("email", "uid", "state")}
    if ai_block is not None:
        out["aiBlocked"] = ai_block
    return out


def list_users(ctx):
    rng = ctx.range
    out = {"kpis": {"activeUsers": None, "antigravityUsers": None, "overCap": None, "manualActionRequired": None,
                    "enforceableCoverage": None}, "users": None, "iamAvailable": False}
    res = ctx.run_composite({"rows": lambda: ctx.memo("user_table", rng, lambda c: user_table(c, rng)),
                             "iam": lambda: iam_context(ctx)})
    ok, table = res["rows"]
    if not ok:
        ctx.warn_error("bigquery:%s" % ctx.audit_dataset, table, "User activity")
        table = {"users": {}, "available": [], "sourced": False}
    ok, iam = res["iam"]
    status_payload, internal = iam if ok else (None, None)
    readable = bool(internal and internal.get("readable"))
    usage_ok = bool(status_payload is not None and status_payload.get("usageSource") != "unavailable")
    out["iamAvailable"] = readable
    if status_payload is not None:
        if usage_ok:
            out["kpis"]["overCap"] = sum(1 for u in status_payload["users"] or [] if u["overCap"])
        if usage_ok and readable:
            out["kpis"]["manualActionRequired"] = len(status_payload["manualActions"] or [])
        out["kpis"]["enforceableCoverage"] = status_payload["population"]["enforceableCoverage"]
    if not table["sourced"]:
        return out
    available = set(table["available"])
    blocked_map = _blocked_map(ctx)
    custom_cache = {}
    rows = []
    for email, m in table["users"].items():
        rows.append({"uid": uid_for(email), "email": email, "surfaces": surfaces_of(m),
                     "gePrompts": _metric(m, "gePrompts", available),
                     "agentCalls": _metric(m, "agentCalls", available),
                     "notebooklmPrompts": _metric(m, "notebooklmPrompts", available),
                     "antigravityRequests": _metric(m, "antigravityRequests", available),
                     "antigravityTokens": _metric(m, "antigravityTokens", available),
                     "agentPlatformCalls": _metric(m, "agentPlatformCalls", available),
                     "armorBlocks": _metric(m, "armorBlocks", available),
                     "fileUploads": _metric(m, "fileUploads", available),
                     "lastActive": iso(m.get("lastActive")),
                     "iam": iam_for(email, status_payload, internal, ctx=ctx, blocked_map=blocked_map,
                                    custom_cache=custom_cache)})
    rows.sort(key=lambda r: (-sum(r[k] or 0 for k in ("gePrompts", "agentCalls", "notebooklmPrompts",
                                                      "antigravityRequests", "agentPlatformCalls")), r["email"]))
    out["users"] = rows
    out["kpis"]["activeUsers"] = len(rows)
    if "antigravityRequests" in available:
        out["kpis"]["antigravityUsers"] = sum(1 for r in rows if (r["antigravityRequests"] or 0) > 0)
    return out


def find_email(ctx, uid, rng):
    table = ctx.memo("user_table", rng, lambda c: user_table(c, rng))
    for email in table["users"]:
        if uid_for(email) == uid:
            return email
    for email in _blocked_map(ctx):
        if uid_for(email) == uid:
            return email
    status_payload, internal = iam_context(ctx)
    if status_payload is not None:
        for u in status_payload["users"] or []:
            if u["uid"] == uid:
                return u["email"]
    if internal and internal.get("readable"):
        for binding in internal["idx"].bindings:
            for member in binding.get("members") or []:
                low = str(member).lower()
                if low.startswith("user:") and uid_for(low[5:]) == uid:
                    return low[5:]
    return None


def detail(ctx):
    rng = ctx.range
    uid = (ctx.params.get("uid") or "").strip().lower()
    if len(uid) != 16 or any(c not in "0123456789abcdef" for c in uid):
        raise ApiError("bad_request", "Parameter 'uid' is invalid.")
    email = find_email(ctx, uid, rng)
    if not email:
        raise ApiError("not_found", "User not found.")
    params = dict(range_params(rng, with_prev=False), email=email)
    ctes, parts, labels, agy_in_sql, available = long_ctes(ctx)
    from .gemini_enterprise import GE_ACTIVITY, GE_INFERENCE, GE_MESSAGE
    msrc = ctx.audit_source(GE_MESSAGE)
    asrc = ctx.audit_source(GE_ACTIVITY)
    isrc = ctx.audit_source(GE_INFERENCE, optional=True)
    osrc = ctx.audit_source(ARMOR_OPS)
    tasks = {}
    if parts:
        tasks["buckets"] = lambda: ctx.query(pivot_sql(ctes, parts, email_filter=True, per_bucket=True), params,
                                             "users")
    no_agent_column = False
    if asrc:
        a_ctes, caps = act_ctes(asrc, "start_ts")
        if caps["agent"]:
            sql = ("WITH %s,\n%s\nSELECT c.agent_id, ANY_VALUE(n.agent_name) AS agent_name, COUNT(*) AS calls, "
                   "MAX(c.ts) AS last_used FROM act c LEFT JOIN act_names n ON n.agent_ref = c.agent_id "
                   "WHERE c.email = @email AND c.agent_id IS NOT NULL GROUP BY c.agent_id ORDER BY calls DESC LIMIT 50"
                   % (",\n".join(a_ctes), AGENT_NAMES_CTE))
            tasks["agents"] = lambda: ctx.query(sql, params, "users")
        no_agent_column = caps["method"] and not caps["agent"]
    if msrc:
        fsql = file_items_sql(msrc, asrc, email_filter=True, limit=200)
        if fsql:
            tasks["files"] = lambda: ctx.query(fsql, params, "users")
    if asrc:
        asql = activity_upload_sql(asrc, email_filter=True, limit=200, isrc=isrc)
        if asql:
            tasks["files_act"] = lambda: ctx.query(asql, params, "users")
    if osrc and attribution_ctes(asrc):
        tasks["armor"] = lambda: events_query(ctx, osrc, asrc, rng, verdict="blocked", limit=50, email=email)
    tasks["agy"] = lambda: governance.antigravity_usage(ctx, rng.start_ts(), rng.end_ts(), email=email, rng=rng)
    res = ctx.run_composite(dict(tasks, iam=lambda: iam_context(ctx)))
    metrics = {k: 0 for k in METRICS}
    activity_totals = {k: 0 for k in ACTIVITY_METRICS}
    series = {k: [0] * len(rng.buckets()) for k in ("gePrompts", "agentCalls", "notebooklmPrompts",
                                                     "antigravityRequests")}
    last_active = None
    sql_ok = False
    if "buckets" in res:
        ok, rows = res["buckets"]
        if ok:
            sql_ok = True
            for lbl in labels:
                ctx.add_source(lbl)
            for row in rows:
                idx = rng.bucket_index(row.get("bucket"))
                for k in METRICS:
                    metrics[k] += to_int(row.get(k))
                for k in ACTIVITY_METRICS:
                    activity_totals[k] += to_int(row.get(k))
                if idx is not None:
                    for k in series:
                        series[k][idx] += to_int(row.get(k))
                lr = row.get("last_active")
                if lr is not None and (last_active is None or lr > last_active):
                    last_active = lr
        else:
            ctx.warn_error(labels[0] if labels else "bigquery", rows, "User activity")
    if not sql_ok:
        available = set()
    ok, usage = res["agy"]
    by_model = by_client = None
    if ok and usage.ok:
        if not agy_in_sql or not sql_ok:
            u = usage.users.get(email) or {"requests": 0, "tokens": 0}
            metrics["antigravityRequests"] = u["requests"]
            metrics["antigravityTokens"] = u["tokens"]
            series["antigravityRequests"] = [0] * len(rng.buckets())
            for (mail, bucket), (req_count, _tok) in usage.daily.items():
                idx = rng.bucket_index(bucket)
                if mail == email and idx is not None:
                    series["antigravityRequests"][idx] += req_count
            last = u.get("last")
            if last is not None and (last_active is None or last > last_active):
                last_active = last
        available |= {"antigravityRequests", "antigravityTokens"}
        by_model = sorted(({"model": k, "requests": v["requests"], "tokens": v["tokens"],
                            "promptTokens": v["promptTokens"], "candidateTokens": v["candidateTokens"]}
                           for k, v in usage.by_model.items()), key=lambda x: -x["tokens"])
        by_client = sorted(({"client": k, "requests": v["requests"], "tokens": v["tokens"]}
                            for k, v in usage.by_client.items()), key=lambda x: -x["tokens"])
    # Lists stay null unless their source query succeeded.
    agents = None
    if "agents" in res:
        ok, rows = res["agents"]
        if ok:
            directory = directory_for(ctx, rows)
            agents = [{"agent": agent_label(r.get("agent_id"), r.get("agent_name"), directory),
                       "calls": to_int(r.get("calls")), "lastUsed": iso(r.get("last_used"))} for r in rows]
        else:
            ctx.warn_error(asrc.label, rows, "Gemini Enterprise activity logs")
    elif no_agent_column and sql_ok:
        agents = []  # no agent call logged yet: the agent id column appears with the first one
    files = None
    if "files" in res:
        ok, rows = res["files"]
        if ok:
            files = file_rows_to_items(rows)
        else:
            ctx.warn_error(msrc.label, rows, "Gemini Enterprise file uploads")
    # Activity-log upload calls are listed only when the upload count is based on them (the message log recorded
    # no uploads in the window), so the list and the count shown next to it always agree.
    act_counted = not sql_ok or "fileUploads" not in available or metrics["fileUploads"] > 0
    if not files and "files_act" in res:
        ok, rows = res["files_act"]
        if ok:
            if rows and act_counted:
                files = file_rows_to_items(rows)
            elif files is None:
                files = []
        else:
            ctx.warn_error(asrc.label, rows, "Gemini Enterprise activity logs")
    armor = None
    if "armor" in res:
        ok, value = res["armor"]
        if ok:
            armor = value[0]
        else:
            ctx.warn_error(osrc.label, value, "Model Armor logs")
    ok, iam = res["iam"]
    status_payload, internal = iam if ok else (None, None)
    blocked_map = _blocked_map(ctx)
    iam_state = iam_for(email, status_payload, internal, ctx=ctx, blocked_map=blocked_map, custom_cache={})
    readable = bool(internal and internal.get("readable"))
    bindings = None
    direct_roles = set()
    if readable:
        raw_bindings = internal["idx"].user_bindings(email)
        direct_roles = {role for role, _ in raw_bindings}
        bindings = [{"role": role, "member": "user:%s" % email, "conditional": cond}
                    for role, cond in raw_bindings]
    state = iam_state["state"]
    repairable = (readable and state == "NOT_ENFORCEABLE" and iam_state["reason"] == "CONFLICTING_BINDINGS" and
                  governance._unconditional_marker_conflict(internal["idx"], email, internal["cfg"]))
    enforceable = (state not in ("NOT_ENFORCEABLE", "UNKNOWN") or repairable) and readable
    ai_block = iam_state.get("aiBlocked")
    is_ai_blocked = bool(ai_block and ai_block.get("active"))
    self_or_admin = (email == ctx.identity.email or
                     is_admin_email(email, (ctx.settings.get("security") or {}).get("admins")))
    project_priv = readable and bool(direct_roles & set(governance.PROJECT_WIDE_PRIVILEGED_ROLES))
    combined = dict(metrics, **activity_totals)
    out_metrics = {k: (metrics[k] if k in available else None) for k in METRICS}
    series_names = (("gePrompts", "Gemini Enterprise prompts"), ("agentCalls", "Agent calls"),
                    ("notebooklmPrompts", "NotebookLM prompts"), ("antigravityRequests", "Antigravity requests"))
    activity_series = [timeutil.series(k, name, series[k]) for k, name in series_names if k in available]
    iam_out = {"state": state, "reason": iam_state["reason"], "bindings": bindings,
               "aiBlocked": ai_block,
               "actions": {
                   "allow": enforceable and (state in ("BLOCKED_BY_ADMIN", "CAPPED_BY_TOOL", "NO_ACCESS") or repairable),
                   "disallow": enforceable and (state in ("ENFORCEABLE_ALLOWED", "CAPPED_BY_TOOL") or repairable),
                   "blockAll": readable and not self_or_admin and not project_priv and not is_ai_blocked,
                   "unblockAll": readable and not self_or_admin and bool(ai_block),
               },
               "remediation": governance.REMEDIATION.get(iam_state["reason"]) if (not enforceable and state != "UNKNOWN")
               else None}
    iam_out.update({k: iam_state.get(k) for k in CAP_FIELDS})
    iam_out["currency"] = ((status_payload or {}).get("policy") or {}).get("currency")
    return {"user": {"uid": uid, "email": email, "lastActive": iso(last_active), "surfaces": surfaces_of(combined)},
            "metrics": out_metrics,
            "activity": timeutil.timeline(rng, activity_series) if activity_series else None,
            "antigravity": {"byModel": by_model, "byClient": by_client},
            "agents": agents, "files": files, "armorEvents": armor,
            "iam": iam_out}


def access_action(ctx):
    """POST /api/v1/users/access-action {uid, email?, action: block_all | unblock_all, note?}."""
    uid = ctx.body.get("uid")
    email = ctx.body.get("email")
    action = ctx.body.get("action")
    if action not in ("block_all", "unblock_all"):
        raise ApiError("bad_request", "Field 'action' must be 'block_all' or 'unblock_all'.")
    if uid is not None and (not isinstance(uid, str) or len(uid) != 16 or any(c not in "0123456789abcdef" for c in uid)):
        raise ApiError("bad_request", "Field 'uid' is invalid.")
    if uid is None and not isinstance(email, str):
        raise ApiError("bad_request", "Field 'uid' or 'email' is required.")
    return governance.set_user_ai_access(ctx, action, uid=uid, email=email, note=ctx.body.get("note"))
