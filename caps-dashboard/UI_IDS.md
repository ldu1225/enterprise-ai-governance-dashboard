# UI element ids for automated filming (Playwright)

Every id below is stable. `<slug>` is the email lowercased with each run of
non-alphanumeric characters replaced by `-` (example: `dulee@gcp.altostrat.com`
becomes `dulee-gcp-altostrat-com`). Row buttons also carry
`data-action` and `data-email`, so you can write
`#users-tbody button[data-action="block"][data-email="x@y.com"]`.

## Login and header
| Element | Selector |
|---|---|
| Login password / submit | `#login-password`, `#login-submit` |
| Integration chip (Google Gemini) | `#vendor-strip`, `#vendor-google` |
| Hub / Spoke chips, API health | `#hub-chip`, `#spoke-chip`, `#health-badge` |
| Refresh / email mask / theme / logout | `#refresh-btn`, `#mask-toggle`, `#theme-toggle`, `#logout-btn` |
| Global filters | `#proj-all`, `#proj-hub`, `#proj-spoke`, `#filter-start`, `#filter-end`, `#fresh-toggle` |

## Tabs (panels are `#panel-<name>`)
`#tab-overview`, `#tab-users`, `#tab-costs`, `#tab-models`, `#tab-policies`, `#tab-audit`

## Users tab
| Element | Selector |
|---|---|
| Table / body / row | `#users-table`, `#users-tbody`, `#user-row-<slug>` (`tr[data-email]`) |
| Search / status filter | `#user-search`, `#ufilter-all`, `#ufilter-active`, `#ufilter-over_cap`, `#ufilter-blocked`, `#ufilter-propagating` |
| Row: detail / cap / model rule | `#user-detail-btn-<slug>`, `#user-cap-btn-<slug>`, `#user-rule-btn-<slug>` |
| Row: block (when not blocked) / unblock (when blocked) | `#user-block-btn-<slug>`, `#user-unblock-btn-<slug>` |
| Status cell | `#status-cell-<slug>` |
| **Enforcement status cell** | `#enf-status-<slug>`. It carries `data-enforcement="none\|propagating\|enforced"`, and its badge is `.enf-propagating` or `.enf-enforced` |
| Floating enforcement tracker | `#enforce-tracker`, `#enforce-tracker-elapsed`, `#enforce-tracker-state` |

## User drill-down drawer
`#user-drawer`, `#drawer-title`, `#drawer-status`, `#drawer-enf`, `#drawer-cap-btn`,
`#drawer-rule-btn`, `#drawer-block-btn`, `#drawer-unblock-btn`, `#drawer-refresh-btn`,
`#drawer-close-btn`, `#drawer-gauge`, `#drawer-enforcement` (stepper + elapsed `#drawer-enf-elapsed`),
`#drawer-timeline`, `#drawer-chart`, `#drawer-projects-table`, `#drawer-models-table`

## Block modal
`#block-modal`, services `#block-svc-gemini_platform`, `#block-svc-antigravity`,
`#block-svc-gemini_enterprise`, projects `#block-proj-<projectId>` (e.g. `#block-proj-duleetest`,
`#block-proj-dulee-ai-test`), `#block-reason-input`, `#block-until-input`, **submit `#block-submit-btn`**

## Unblock modal
`#unblock-modal`, `#unblock-svc-<service>`, `#unblock-proj-<projectId>`, `#unblock-reason-input`,
**submit `#unblock-submit-btn`**

## Cap modal
`#cap-modal`, `#cap-cost-input`, `#cap-token-input`, `#cap-request-input`, `#cap-scope-select`,
per-project `#cap-project-cost-<projectId>`, `#cap-note-input`, **submit `#cap-submit-btn`**,
`#cap-delete-btn`

## Model rule modal (default or per-user)
`#rule-modal`, `#rule-mode-select`, `#rule-models-input`, limit rows `#rule-limit-model-<i>`,
`#rule-limit-monthly_cost-<i>`, `#rule-limit-monthly_tokens-<i>`, `#rule-limit-daily_requests-<i>`,
`#rule-limit-rpm-<i>`, `#rule-add-limit-btn`, `#rule-violation-select`, `#rule-block-minutes`,
`#rule-note-input`, **submit `#rule-submit-btn`**, `#rule-delete-btn`

## Model governance tab
| Element | Selector |
|---|---|
| Org Policy status cards | `#ma-status`, `#ma-card-<scopeId>` |
| Model-access controls | `#ma-project-select`, `#ma-model-select` (input with datalist), `#ma-action-restrict`, `#ma-action-allow`, `#ma-reason-input` |
| **Dry-run / apply** | `#ma-dryrun-btn`, `#ma-apply-btn` (enabled only after a dry-run with the same inputs), result `#ma-impact` |
| Catalog quick actions | `#catalog-restrict-btn-<modelSlug>`, `#catalog-allow-btn-<modelSlug>` (fill the form and run a dry-run) |
| Default rule | `#rule-default-edit-btn`, `#rule-default-delete-btn` |
| Per-user rules | `#rule-user-edit-btn-<slug>`, `#rule-user-delete-btn-<slug>` |
| **Model-rule eval** | `#rule-eval-dryrun-btn`, `#rule-eval-apply-btn`, result `#rule-eval-result` |
| Catalog | `#catalog-table`, `#catalog-search`, `#catalog-publisher` |

## Policies tab
| Element | Selector |
|---|---|
| **G1–G7 dry-run** / real run | `#gates-dryrun-btn`, `#gates-apply-btn` |
| Gate cards / plan | `#gate-g1` … `#gate-g7` (`data-status="pass\|fail\|checking"`), `#gates-plan` |
| Global policy | `#policy-cost`, `#policy-token`, `#policy-request`, `#policy-period`, `#policy-mode`, `#policy-scope`, `#policy-svc-<service>`, `#policy-pd-<projectId>`, `#policy-save-btn` |
| Billing sync banner | `#billing-sync-banner` |
| Project hard caps | `#pcap-input-<projectId>`, `#pcap-action-<projectId>`, `#pcap-dryrun-<projectId>`, `#pcap-save-<projectId>`, `#pcap-lift-<projectId>`, `#pcap-result-<projectId>` |
| Inference logging | `#logging-row-<projectId>`, `#logging-enable-<projectId>` |

## Cost explorer tab
`#cost-summary`, `#cost-view-users`, `#cost-view-models`, `#cost-search`,
`#cost-users-table` / `#cost-models-table` (click a `th[data-sort]` to sort). The date range and the Hub/Spoke filter use the global filters.

## Audit tab
`#violations-table`, `#viol-search`, `#viol-type-filter`, **`#audit-table`**, `#audit-tbody`,
`#audit-search`, `#audit-action-filter`, `#audit-hide-scheduler` (checked by default and hides scheduler
`caps.enforce` rows), `#audit-detail-btn-<id>`, JSON viewer `#json-dialog`

## API Call Inspector
| Element | Selector |
|---|---|
| **Toggle** (header) / counter | `#inspector-toggle` (`aria-pressed`), `#inspector-count` |
| Panel / **list** / rows | `#api-inspector` (`.open` when visible), **`#inspector-list`**, `li.insp-row#insp-<seq>` (`data-method`, `data-status`) |
| Expand a row | click `#insp-<seq> .insp-main` and the details appear in `#insp-detail-<seq>` |
| Stats / host / clear / close | `#inspector-stats`, `#inspector-host`, `#inspector-clear-btn`, `#inspector-close-btn` |
| Confirm dialog (apply actions) | `#confirm-dialog`, `#confirm-ok-btn`, `#confirm-cancel-btn` |
