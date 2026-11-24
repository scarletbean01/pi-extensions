/* Read-only Factory Web Viewer client (ticket 08).
   Renders exclusively via safe DOM nodes, textContent, and allowlisted attributes. */
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_VERSION = /^v[1-9][0-9]*$/;
const VALID_VIEWS = new Set(["factories", "live", "inspect", "queue", "receipts", "requests", "proposals"]);

const VIEW_LABELS = {
  factories: "Factories",
  live: "Live Graph",
  inspect: "Inspect",
  queue: "Queue",
  receipts: "Receipts",
  requests: "Requests",
  proposals: "Proposals",
};

const SAFE_HTML_ATTRS = new Set([
  "class",
  "id",
  "href",
  "type",
  "name",
  "value",
  "required",
  "disabled",
  "open",
  "for",
  "scope",
  "role",
  "tabindex",
  "aria-label",
  "aria-labelledby",
  "aria-current",
  "aria-pressed",
  "aria-expanded",
  "aria-controls",
  "aria-live",
  "aria-busy",
  "data-view",
  "data-factory-id",
  "data-node-id",
  "data-focus-key",
]);

const SAFE_SVG_ATTRS = new Set([
  "class",
  "id",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "markerUnits",
  "marker-end",
  "fill",
  "stroke",
  "stroke-width",
  "role",
  "tabindex",
  "aria-label",
  "aria-pressed",
  "aria-hidden",
  "focusable",
  "data-node-id",
  "data-focus-key",
]);

const STATUS_META = {
  running: { symbol: "●", label: "Running", tone: "tone-info" },
  ended: { symbol: "■", label: "Ended", tone: "tone-muted" },
  idle: { symbol: "○", label: "Idle", tone: "tone-muted" },
  waiting: { symbol: "◷", label: "Waiting", tone: "tone-warn" },
  blocked: { symbol: "⊘", label: "Blocked", tone: "tone-error" },
  uncertain: { symbol: "?", label: "Uncertain", tone: "tone-warn" },
  pending: { symbol: "◦", label: "Pending", tone: "tone-muted" },
  succeeded: { symbol: "✓", label: "Succeeded", tone: "tone-ok" },
  partial: { symbol: "◐", label: "Partial", tone: "tone-warn" },
  failed: { symbol: "✕", label: "Failed", tone: "tone-error" },
  skipped: { symbol: "↷", label: "Skipped", tone: "tone-muted" },
  cancelled: { symbol: "⊗", label: "Cancelled", tone: "tone-muted" },
  needs_attention: { symbol: "?", label: "Uncertain", tone: "tone-warn" },
  available: { symbol: "✓", label: "Available", tone: "tone-ok" },
  unavailable: { symbol: "!", label: "Unavailable", tone: "tone-error" },
  managed: { symbol: "●", label: "Managed", tone: "tone-ok" },
  unmanaged: { symbol: "○", label: "Unmanaged", tone: "tone-muted" },
  active: { symbol: "●", label: "Active", tone: "tone-ok" },
  stopped: { symbol: "⊘", label: "Stopped", tone: "tone-warn" },
  free: { symbol: "○", label: "Free", tone: "tone-ok" },
  held: { symbol: "■", label: "Held", tone: "tone-warn" },
  settled: { symbol: "✓", label: "Settled", tone: "tone-ok" },
  unsettled: { symbol: "◷", label: "Unsettled", tone: "tone-warn" },
  released: { symbol: "✓", label: "Released", tone: "tone-ok" },
  cleared: { symbol: "◈", label: "Cleared", tone: "tone-warn" },
  discarded: { symbol: "⊗", label: "Discarded", tone: "tone-muted" },
  queued: { symbol: "◷", label: "Queued", tone: "tone-info" },
  retryable: { symbol: "↻", label: "Retryable", tone: "tone-warn" },
  launching: { symbol: "●", label: "Launching", tone: "tone-info" },
  responded: { symbol: "✓", label: "Responded", tone: "tone-ok" },
  closed: { symbol: "■", label: "Closed", tone: "tone-muted" },
  unknown: { symbol: "?", label: "Unknown", tone: "tone-warn" },
  confirmed: { symbol: "✓", label: "Confirmed", tone: "tone-ok" },
  rejected: { symbol: "✕", label: "Rejected", tone: "tone-muted" },
  dropped_duplicate: { symbol: "⊘", label: "Dropped duplicate", tone: "tone-muted" },
  synced: { symbol: "✓", label: "Synced", tone: "tone-ok" },
  pending_write: { symbol: "◷", label: "Pending write", tone: "tone-warn" },
  conflict: { symbol: "!", label: "Conflict", tone: "tone-error" },
  abandoned: { symbol: "⊗", label: "Abandoned", tone: "tone-muted" },
  resolved: { symbol: "✓", label: "Resolved", tone: "tone-ok" },
  continuing: { symbol: "●", label: "Continuing", tone: "tone-info" },
  incomplete: { symbol: "◔", label: "Incomplete", tone: "tone-info" },
  passed: { symbol: "✓", label: "Passed", tone: "tone-ok" },
};

const ABSENCE_META = {
  "no records": { symbol: "○", label: "No records", tone: "tone-muted" },
  "not applicable": { symbol: "—", label: "Not applicable", tone: "tone-muted" },
  "evidence unavailable": { symbol: "!", label: "Evidence unavailable", tone: "tone-error" },
};

const state = {
  factories: [],
  factoriesError: null,
  selectedFactoryId: "",
  activeView: "factories",
  inspectVersion: "",
  inspectNode: "",
  queueFilter: "open",
  receiptReference: "",
  selectedGraphNodeId: "",
  requestSeq: 0,
  controller: null,
};

const dom = {
  menuToggle: document.getElementById("menu-toggle"),
  drawerClose: document.getElementById("drawer-close"),
  drawerBackdrop: document.getElementById("drawer-backdrop"),
  sidebar: document.getElementById("sidebar"),
  factoriesList: document.getElementById("factories-list"),
  viewHeading: document.getElementById("view-heading"),
  factorySubtitle: document.getElementById("factory-subtitle"),
  headerScope: document.getElementById("header-scope"),
  content: document.getElementById("content"),
  viewTabs: Array.from(document.querySelectorAll("[data-view]")),
};

function setAttrs(node, attrs, allowlist) {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (!allowlist.has(key)) continue;
    if (key === "href") {
      const checked = safeHref(String(value));
      if (!checked) continue;
      node.setAttribute("href", checked);
      continue;
    }
    node.setAttribute(key, value === true ? "" : String(value));
  }
}

function el(tag, text, attrs) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  setAttrs(node, attrs, SAFE_HTML_ATTRS);
  return node;
}

function svgEl(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  setAttrs(node, attrs, SAFE_SVG_ATTRS);
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function safeHref(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(trimmed)) return null;
  if (!trimmed.startsWith("/") && !trimmed.startsWith("?")) return null;
  try {
    const origin = window.location.origin;
    const parsed = new URL(trimmed, origin);
    if (parsed.origin !== origin) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function pageUrl(params) {
  const sp = new URLSearchParams();
  if (params.factory && VALID_ID.test(params.factory)) sp.set("factory", params.factory);
  const view = VALID_VIEWS.has(params.view) ? params.view : (params.factory ? "live" : "factories");
  sp.set("view", view);
  if (view === "inspect") {
    if (params.version && VALID_VERSION.test(params.version)) sp.set("version", params.version);
    if (params.node && VALID_ID.test(params.node)) sp.set("node", params.node);
  } else if (view === "queue") {
    sp.set("filter", params.filter === "all" ? "all" : "open");
  } else if (view === "receipts" && typeof params.reference === "string" && params.reference.trim()) {
    sp.set("reference", params.reference.trim());
  }
  return `/?${sp.toString()}`;
}

function pageUrlFromApiOrHref(rawUrl) {
  const checked = safeHref(rawUrl);
  if (!checked) return null;
  try {
    const parsed = new URL(checked, window.location.origin);
    if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    const apiMatch = /^\/api\/factories\/([^/]+)\/(live|inspect|queue|receipts|requests|proposals)$/.exec(parsed.pathname);
    if (!apiMatch) return null;
    const factory = decodeURIComponent(apiMatch[1]);
    const view = apiMatch[2];
    return pageUrl({
      factory,
      view,
      version: parsed.searchParams.get("version") || "",
      node: parsed.searchParams.get("node") || "",
      filter: parsed.searchParams.get("filter") || "",
      reference: parsed.searchParams.get("reference") || "",
    });
  } catch {
    return null;
  }
}

function isAbsenceObject(value) {
  return Boolean(value && typeof value === "object" && typeof value.absence === "string");
}

function statusPill(value, labelOverride) {
  const key = typeof value === "string" ? value.toLowerCase() : "";
  const meta = STATUS_META[key] || { symbol: "•", label: labelOverride || (value ? String(value) : "Unknown"), tone: "tone-muted" };
  return el("span", `${meta.symbol} ${labelOverride || meta.label}`, { class: `status-pill ${meta.tone}` });
}

function absenceNode(value) {
  const key = typeof value?.absence === "string" ? value.absence : "evidence unavailable";
  const meta = ABSENCE_META[key] || ABSENCE_META["evidence unavailable"];
  const wrap = el("span", undefined, { class: "absence-tag" });
  wrap.append(el("span", `${meta.symbol} ${meta.label}`, { class: `status-pill ${meta.tone}` }));
  if (typeof value?.explanation === "string" && value.explanation) {
    wrap.append(el("span", value.explanation, { class: "absence-explain" }));
  }
  return wrap;
}

function renderValue(value, fallbackLabel) {
  if (isAbsenceObject(value)) return absenceNode(value);
  if (value === null || value === undefined) {
    return el("span", fallbackLabel || "Not recorded", { class: "absence-explain" });
  }
  if (typeof value === "boolean") return document.createTextNode(value ? "Yes" : "No");
  if (typeof value === "string" || typeof value === "number") return document.createTextNode(String(value));
  return document.createTextNode(String(value));
}

function factItem(label, valueNodeOrText) {
  const box = el("div", undefined, { class: "fact-item" });
  box.append(el("dt", label));
  const dd = el("dd");
  if (valueNodeOrText instanceof Node) dd.append(valueNodeOrText);
  else dd.append(renderValue(valueNodeOrText));
  box.append(dd);
  return box;
}

function buildTable(captionText, headers, rows) {
  const wrap = el("div", undefined, { class: "table-wrap" });
  const tbl = el("table", undefined, { class: "fv-table striped" });
  if (captionText) tbl.append(el("caption", captionText));
  const thead = el("thead");
  const headRow = el("tr");
  for (const h of headers) headRow.append(el("th", h, { scope: "col" }));
  thead.append(headRow);
  const tbody = el("tbody");
  for (const cells of rows) {
    const tr = el("tr");
    cells.forEach((cell, idx) => {
      const tag = idx === 0 && cell && cell.asRowHeader ? "th" : "td";
      const attrs = tag === "th" ? { scope: "row" } : undefined;
      const td = el(tag, undefined, attrs);
      const val = cell && cell.asRowHeader ? cell.content : cell;
      if (val instanceof Node) td.append(val);
      else td.append(renderValue(val));
      tr.append(td);
    });
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  wrap.append(tbl);
  return wrap;
}

function buildLink(label, rawHref, cls) {
  const href = pageUrlFromApiOrHref(rawHref);
  if (!href) return el("span", `${label} (link unavailable)`, { class: "absence-explain" });
  const a = el("a", label, { href, ...(cls ? { class: cls } : {}) });
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigateToUrl(href, true);
  });
  return a;
}

function banner(pillKey, pillLabel, titleText, reasonText, extraNode) {
  const meta = STATUS_META[pillKey] || ABSENCE_META[pillKey] || { symbol: "!", label: pillLabel || "Notice", tone: "tone-muted" };
  const box = el("div", undefined, { class: `status-banner ${meta.tone}` });
  const head = el("div", undefined, { class: "status-banner-head" });
  head.append(el("span", `${meta.symbol} ${pillLabel || meta.label}`, { class: `status-pill ${meta.tone}` }));
  if (titleText) head.append(el("strong", titleText));
  box.append(head);
  if (reasonText) box.append(el("p", reasonText, { class: "status-banner-reason" }));
  if (extraNode) box.append(extraNode);
  return box;
}

function errorBanner(status, message, detail) {
  const box = el("div", undefined, { class: "status-banner tone-error", role: "alert" });
  const head = el("div", undefined, { class: "status-banner-head" });
  head.append(el("span", status ? `! HTTP ${status}` : "! Error", { class: "status-pill tone-error" }));
  head.append(el("strong", message || "Request failed"));
  box.append(head);
  if (detail) box.append(el("p", detail, { class: "status-banner-reason" }));
  return box;
}

function isNarrowViewport() {
  return window.matchMedia && window.matchMedia("(max-width: 992px)").matches;
}

function setDrawerOpen(open, returnFocusToToggle) {
  if (!dom.sidebar) return;
  dom.sidebar.classList.toggle("open", open);
  if (dom.menuToggle) dom.menuToggle.setAttribute("aria-expanded", String(open));
  if (dom.drawerBackdrop) {
    if (open && isNarrowViewport()) dom.drawerBackdrop.removeAttribute("hidden");
    else dom.drawerBackdrop.setAttribute("hidden", "");
  }
  if (open && isNarrowViewport()) {
    const target = dom.drawerClose || dom.factoriesList?.querySelector("a");
    target?.focus();
  } else if (!open && returnFocusToToggle) {
    dom.menuToggle?.focus();
  }
}

function selectedFactoryRecord() {
  return state.factories.find((f) => f && f.factory_id === state.selectedFactoryId) || null;
}

function updateChrome() {
  const fac = selectedFactoryRecord();
  const facLabel = fac ? `${fac.name || fac.factory_id} (${fac.current_version || "?"})` : (state.selectedFactoryId || "");
  if (dom.viewHeading) dom.viewHeading.textContent = VIEW_LABELS[state.activeView] || "Factory Viewer";
  if (dom.factorySubtitle) {
    dom.factorySubtitle.textContent = fac
      ? `Factory: ${fac.name || fac.factory_id} · ID: ${fac.factory_id} · Current version: ${fac.current_version || "unknown"} · Management: ${fac.management || "unknown"}`
      : (state.selectedFactoryId
        ? `Factory ID: ${state.selectedFactoryId}`
        : "Select a factory from the sidebar or list to inspect its live graph and records.");
  }
  if (dom.headerScope) {
    dom.headerScope.textContent = facLabel ? `${facLabel} · Read-only` : "Read-only local dashboard";
  }
  for (const tab of dom.viewTabs) {
    const view = tab.dataset.view;
    const isCurrent = view === state.activeView;
    tab.setAttribute("aria-current", isCurrent ? "page" : "false");
    tab.disabled = view !== "factories" && !state.selectedFactoryId;
  }
}

function renderSidebarFactories() {
  if (!dom.factoriesList) return;
  dom.factoriesList.replaceChildren();
  if (state.factoriesError) {
    const li = el("li", undefined, { class: "collection-item" });
    li.append(el("div", state.factoriesError, { class: "status-banner tone-error" }));
    dom.factoriesList.append(li);
    return;
  }
  if (!state.factories.length) {
    const li = el("li", undefined, { class: "collection-item" });
    li.append(el("div", undefined, { class: "factory-link" }));
    li.firstChild.append(absenceNode({ absence: "no records", explanation: "No published factories." }));
    dom.factoriesList.append(li);
    return;
  }
  for (const f of state.factories) {
    if (!f || typeof f.factory_id !== "string") continue;
    const li = el("li", undefined, { class: "collection-item" });
    const href = pageUrl({ factory: f.factory_id, view: "live" });
    const a = el("a", undefined, {
      href,
      class: "factory-link",
      ...(f.factory_id === state.selectedFactoryId ? { "aria-current": "page" } : {}),
    });
    a.append(el("span", f.name || f.factory_id, { class: "factory-link-name" }));
    const meta = el("span", undefined, { class: "factory-link-meta" });
    const mgmt = f.management === "managed" ? "● Managed" : "○ Unmanaged";
    meta.textContent = `${f.current_version || "v?"} · ${mgmt} · ${f.factory_id}`;
    a.append(meta);
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      if (isNarrowViewport()) setDrawerOpen(false, false);
      navigateToUrl(href, true);
    });
    li.append(a);
    dom.factoriesList.append(li);
  }
}

/* ---------- Pure DOM View Renderers ---------- */

function renderFactoriesView(container) {
  if (state.factoriesError) {
    container.append(errorBanner(null, "Unable to load factories list", state.factoriesError));
    return;
  }
  if (!state.factories.length) {
    container.append(banner("no records", "No records", "No published factories", "No factories are published in this configured state directory."));
    return;
  }
  const rows = state.factories.map((f) => {
    const href = pageUrl({ factory: f.factory_id, view: "live" });
    return [
      { asRowHeader: true, content: el("strong", f.name || f.factory_id) },
      el("code", f.factory_id),
      f.current_version || "Unknown",
      statusPill(f.management),
      buildLink(`Open Live Graph for ${f.name || f.factory_id}`, href, "btn-fv"),
    ];
  });
  container.append(buildTable("Published factories in the configured state directory", ["Factory", "Factory ID", "Current version", "Management", "Live Graph"], rows));
}

function renderHeadStatusBlock(head) {
  if (!head || typeof head !== "object") return null;
  const wrap = el("section", undefined, { class: "card-panel-fv" });
  wrap.append(el("h3", "Queue head eligibility"));
  const facts = el("dl", undefined, { class: "facts-grid" });
  facts.append(
    factItem("Eligible to launch", head.eligible ? statusPill("available", "Eligible") : statusPill("blocked", "Not eligible")),
    factItem("Blocking kind", head.blocking_kind ? statusPill(head.blocking_kind === "empty" ? "idle" : "blocked", head.blocking_kind) : "None"),
    factItem("Head input", isAbsenceObject(head.input) ? absenceNode(head.input) : (head.input ? `${head.input.reference || head.input.input_id} (${head.input.bound_version || "?"})` : "None")),
  );
  wrap.append(facts);
  if (head.explanation) wrap.append(el("p", head.explanation));
  if (head.without_control_fence && typeof head.without_control_fence === "object") {
    wrap.append(el("p", `Without stop fence: ${head.without_control_fence.explanation || head.without_control_fence.blocking_kind || "See details"}`, { class: "absence-explain" }));
  }
  return wrap;
}

function renderNodeLinkOrAbsence(linkObj, labelPrefix) {
  if (!linkObj || typeof linkObj !== "object") return renderValue(linkObj);
  if (isAbsenceObject(linkObj)) return absenceNode(linkObj);
  if (typeof linkObj.href === "string" && typeof linkObj.node_id === "string") {
    const label = labelPrefix ? `${labelPrefix} (${linkObj.node_id} in ${linkObj.version || "bound"})` : linkObj.node_id;
    return buildLink(label, linkObj.href);
  }
  return renderValue(linkObj);
}

function renderLiveNodeDetail(detailEl, node, boundVersion) {
  detailEl.replaceChildren();
  detailEl.append(el("h3", "Selected node"));
  if (!node) {
    detailEl.append(el("p", "Select a node in the graph (click or press Enter/Space on a focused node) to inspect its current attempt and version-bound configuration."));
    return;
  }
  const header = el("div", undefined, { class: "status-banner-head" });
  header.append(el("strong", node.id, { class: "mono" }), statusPill(node.status, node.status_text || node.status));
  if (node.kind) header.append(el("span", node.kind, { class: "status-pill tone-muted" }));
  if (node.parked) header.append(el("span", "◷ Parked", { class: "status-pill tone-warn" }));
  detailEl.append(header);
  if (node.reason) detailEl.append(el("p", node.reason));

  const att = node.current_attempt && typeof node.current_attempt === "object" ? node.current_attempt : null;
  const facts = el("dl", undefined, { class: "facts-grid" });
  if (att) {
    facts.append(
      factItem("Attempt ID", isAbsenceObject(att.attempt_id) ? absenceNode(att.attempt_id) : el("code", att.attempt_id)),
      factItem("Attempt count", `${att.attempt_number ?? "?"} of ${att.max_attempts ?? "?"}`),
      factItem("Instance ID", el("code", att.instance_id)),
      factItem("Process state", att.process_state),
      factItem("Resource state", att.resource_state),
    );
    if (att.result_status) facts.append(factItem("Result status", att.result_status));
    if (att.summary) facts.append(factItem("Summary", att.summary));
    if (att.command) {
      facts.append(factItem("Command outcome", `exit=${att.command.exit_code ?? "null"}, signal=${att.command.signal ?? "none"}, duration=${att.command.duration_ms}ms`));
    }
    if (Array.isArray(att.waiting_on) && att.waiting_on.length) {
      facts.append(factItem("Waiting on", att.waiting_on.join(", ")));
    }
    if (att.loop) {
      facts.append(factItem("Review loop", `attempt ${att.loop.attempt}/${att.loop.max_attempts} · ${att.loop.finalized ? "finalized" : "not finalized"}${att.loop.last_verdict ? ` · last verdict: ${att.loop.last_verdict}` : ""}`));
    }
  }
  if (node.join) {
    facts.append(factItem("Join policy", `${node.join.policy} (${(node.join.sources || []).join(", ")})`));
  }
  detailEl.append(facts);

  if (att && Array.isArray(att.causes) && att.causes.length) {
    detailEl.append(buildTable("Node blocker/failure causes", ["Source node", "State", "Reason", "Check"], att.causes.map((c) => [
      el("code", c.node_id),
      statusPill(c.state),
      c.reason,
      c.check ? `${c.check.name} (${c.check.evidence})` : "—",
    ])));
  }

  const actions = el("div", undefined, { class: "toolbar-row" });
  const cfgLink = node.configuration_link || (node.configuration_url ? { href: node.configuration_url, node_id: node.id, version: boundVersion } : null);
  if (cfgLink && isAbsenceObject(cfgLink)) {
    actions.append(absenceNode(cfgLink));
  } else if (cfgLink && typeof cfgLink.href === "string") {
    actions.append(buildLink(`View configuration for ${node.id} in ${cfgLink.version || boundVersion || "bound version"}`, cfgLink.href, "btn-fv"));
  }
  detailEl.append(actions);

  if (att && (att.started_at || att.updated_at || att.completed_at || att.waiting_for_human_since)) {
    const opt = el("details", undefined, { class: "fv-accordion" });
    opt.append(el("summary", "Optional attempt timestamps"));
    const tf = el("dl", undefined, { class: "facts-grid" });
    if (att.started_at) tf.append(factItem("Started at", att.started_at));
    if (att.updated_at) tf.append(factItem("Updated at", att.updated_at));
    if (att.completed_at) tf.append(factItem("Completed at", att.completed_at));
    if (att.waiting_for_human_since) tf.append(factItem("Waiting for human since", att.waiting_for_human_since));
    opt.append(tf);
    detailEl.append(opt);
  }
}

function layoutGraphNodes(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inbound = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.kind !== "feedback" && byId.has(e.from) && byId.has(e.to)) {
      inbound.get(e.to).push(e.from);
    }
  }
  const rankMemo = new Map();
  const visiting = new Set();
  function rankOf(id) {
    if (rankMemo.has(id)) return rankMemo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let r = 0;
    for (const src of inbound.get(id) || []) {
      r = Math.max(r, rankOf(src) + 1);
    }
    visiting.delete(id);
    rankMemo.set(id, r);
    return r;
  }
  const columns = new Map();
  for (const n of nodes) {
    const r = rankOf(n.id);
    if (!columns.has(r)) columns.set(r, []);
    columns.get(r).push(n.id);
  }
  const maxRows = Math.max(1, ...Array.from(columns.values()).map((c) => c.length));
  const colCount = Math.max(1, columns.size);
  const nodeW = 220;
  const nodeH = 74;
  const colGap = 350;
  const rowGap = 132;
  const padX = 48;
  const padY = 48;
  const positions = new Map();
  const sortedCols = Array.from(columns.keys()).sort((a, b) => a - b);
  sortedCols.forEach((colKey, colIdx) => {
    const ids = columns.get(colKey);
    ids.forEach((id, rowIdx) => {
      positions.set(id, {
        x: padX + colIdx * colGap,
        y: padY + rowIdx * rowGap,
        w: nodeW,
        h: nodeH,
      });
    });
  });
  return {
    positions,
    width: Math.max(540, padX * 2 + (colCount - 1) * colGap + nodeW),
    height: Math.max(260, padY * 2 + (maxRows - 1) * rowGap + nodeH + 70),
  };
}

function buildGraphSvg(graph, detailEl, boundVersion) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const layout = layoutGraphNodes(nodes, edges);
  const initialBox = { x: 0, y: 0, width: layout.width, height: layout.height };
  let viewBox = { ...initialBox };

  const wrapper = el("section", undefined, { class: "card-panel-fv" });
  wrapper.append(el("h3", `Run graph topology (${graph.topology || "graph"}, bound ${graph.bound_version || boundVersion || "?"})`));

  const legend = el("div", undefined, { class: "graph-legend" });
  legend.append(
    el("span", "Dependency (require_success): solid line + filled arrow"),
    el("span", "Dependency (allow_partial): dashed line + hollow arrow"),
    el("span", "Feedback edge: dotted-dashed loop arc + diamond arrow"),
    el("span", "Join node: [JOIN] badge + multiple inbound edges"),
  );
  wrapper.append(legend);

  const stage = el("div", undefined, { class: "graph-stage" });
  const svg = svgEl("svg", {
    class: "graph-svg",
    viewBox: `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`,
    role: "group",
    "aria-label": "Run graph diagram. Use +, -, 0, and arrow keys to zoom and pan. Tab to nodes and press Enter or Space to select.",
    tabindex: "0",
  });

  function applyBox() {
    svg.setAttribute("viewBox", `${Math.round(viewBox.x)} ${Math.round(viewBox.y)} ${Math.max(120, Math.round(viewBox.width))} ${Math.max(80, Math.round(viewBox.height))}`);
  }
  function zoomBy(factor) {
    const cx = viewBox.x + viewBox.width / 2;
    const cy = viewBox.y + viewBox.height / 2;
    viewBox.width = Math.max(180, Math.min(initialBox.width * 4, viewBox.width * factor));
    viewBox.height = Math.max(120, Math.min(initialBox.height * 4, viewBox.height * factor));
    viewBox.x = cx - viewBox.width / 2;
    viewBox.y = cy - viewBox.height / 2;
    applyBox();
  }
  function panBy(dx, dy) {
    viewBox.x += dx;
    viewBox.y += dy;
    applyBox();
  }
  function resetBox() {
    viewBox = { ...initialBox };
    applyBox();
  }

  const toolbar = el("div", undefined, { class: "toolbar-row", role: "toolbar", "aria-label": "Graph zoom and pan controls" });
  const btnIn = el("button", "Zoom in (+)", { type: "button", class: "btn-fv-secondary" });
  const btnOut = el("button", "Zoom out (-)", { type: "button", class: "btn-fv-secondary" });
  const btnReset = el("button", "Reset (0)", { type: "button", class: "btn-fv-secondary" });
  const btnLeft = el("button", "Pan left", { type: "button", class: "btn-fv-secondary" });
  const btnRight = el("button", "Pan right", { type: "button", class: "btn-fv-secondary" });
  const btnUp = el("button", "Pan up", { type: "button", class: "btn-fv-secondary" });
  const btnDown = el("button", "Pan down", { type: "button", class: "btn-fv-secondary" });
  btnIn.addEventListener("click", () => zoomBy(0.8));
  btnOut.addEventListener("click", () => zoomBy(1.25));
  btnReset.addEventListener("click", resetBox);
  btnLeft.addEventListener("click", () => panBy(-60, 0));
  btnRight.addEventListener("click", () => panBy(60, 0));
  btnUp.addEventListener("click", () => panBy(0, -60));
  btnDown.addEventListener("click", () => panBy(0, 60));
  toolbar.append(btnIn, btnOut, btnReset, btnLeft, btnUp, btnDown, btnRight);
  wrapper.append(toolbar);

  const defs = svgEl("defs");
  const mSolid = svgEl("marker", { id: "arrow-solid", markerWidth: "10", markerHeight: "10", refX: "9", refY: "5", orient: "auto", markerUnits: "userSpaceOnUse" });
  mSolid.append(svgEl("path", { d: "M0,1 L9,5 L0,9 Z", fill: "#3f5868" }));
  const mPartial = svgEl("marker", { id: "arrow-partial", markerWidth: "10", markerHeight: "10", refX: "9", refY: "5", orient: "auto", markerUnits: "userSpaceOnUse" });
  mPartial.append(svgEl("path", { d: "M1,1 L9,5 L1,9 Z", fill: "#ffffff", stroke: "#3f5868", "stroke-width": "1.5" }));
  const mFeedback = svgEl("marker", { id: "arrow-feedback", markerWidth: "10", markerHeight: "10", refX: "9", refY: "5", orient: "auto", markerUnits: "userSpaceOnUse" });
  mFeedback.append(svgEl("path", { d: "M0,5 L5,1 L10,5 L5,9 Z", fill: "#8a3800" }));
  defs.append(mSolid, mPartial, mFeedback);
  svg.append(defs);

  edges.forEach((edge, idx) => {
    const a = layout.positions.get(edge.from);
    const b = layout.positions.get(edge.to);
    if (!a || !b) return;
    if (edge.kind === "feedback") {
      const startX = a.x + a.w / 2;
      const startY = a.y + a.h;
      const endX = b.x + b.w / 2;
      const endY = b.y + b.h;
      const arcY = Math.max(startY, endY) + 46 + (idx % 2) * 18;
      const path = svgEl("path", {
        class: "edge-feedback",
        d: `M ${startX} ${startY} C ${startX} ${arcY}, ${endX} ${arcY}, ${endX} ${endY}`,
        "marker-end": "url(#arrow-feedback)",
      });
      const mx = (startX + endX) / 2;
      const my = arcY - 6;
      const lblText = `feedback (${edge.reject || "reject"} -> ${edge.to}, max ${edge.max_revisions ?? "?"})`;
      const lblW = Math.min(260, lblText.length * 6.5 + 14);
      svg.append(
        path,
        svgEl("rect", { class: "edge-label-bg", x: mx - lblW / 2, y: my - 11, width: lblW, height: 16, rx: 3 }),
        svgEl("text", { class: "edge-label-text", x: mx, y: my + 1 }, lblText),
      );
    } else {
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const cx1 = x1 + (x2 - x1) * 0.45;
      const cx2 = x2 - (x2 - x1) * 0.45;
      const pol = edge.dependency_policy === "require_success" ? "require" : "partial";
      const st = edge.state || "pending";
      const cls = `edge-dep ${pol === "partial" ? "edge-allow-partial" : ""} edge-${st}`;
      const marker = pol === "partial" ? "url(#arrow-partial)" : "url(#arrow-solid)";
      const path = svgEl("path", {
        class: cls,
        d: `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`,
        "marker-end": marker,
      });
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2 - 8;
      const lblText = `${st} (${pol})`;
      const lblW = lblText.length * 6.2 + 12;
      svg.append(
        path,
        svgEl("rect", { class: "edge-label-bg", x: mx - lblW / 2, y: my - 11, width: lblW, height: 15, rx: 3 }),
        svgEl("text", { class: "edge-label-text", x: mx, y: my }, lblText),
      );
    }
  });

  const nodeGroups = [];
  for (const n of nodes) {
    const pos = layout.positions.get(n.id);
    if (!pos) continue;
    const meta = STATUS_META[n.status] || { symbol: "?", label: n.status_text || n.status || "Unknown" };
    const statusLabel = n.status_text || meta.label;
    const isSelected = state.selectedGraphNodeId === n.id;
    const g = svgEl("g", {
      class: `graph-node status-${n.status || "unknown"}${isSelected ? " selected" : ""}`,
      tabindex: "0",
      role: "button",
      "aria-pressed": isSelected ? "true" : "false",
      "aria-label": `${n.id}${n.join ? " (join)" : ""}: ${statusLabel}${n.reason ? `. ${n.reason}` : ""}`,
      "data-node-id": n.id,
      "data-focus-key": `graph-node:${n.id}`,
    });
    g.append(svgEl("rect", { class: "node-box", x: pos.x, y: pos.y, width: pos.w, height: pos.h, rx: 6 }));
    if (n.join) {
      g.append(svgEl("polygon", {
        points: `${pos.x - 7},${pos.y + pos.h / 2} ${pos.x},${pos.y + pos.h / 2 - 7} ${pos.x + 7},${pos.y + pos.h / 2} ${pos.x},${pos.y + pos.h / 2 + 7}`,
        fill: "#174a67",
      }));
    }
    const headerTitle = n.join ? `${n.id} [JOIN]` : n.id;
    g.append(svgEl("text", { class: "node-title", x: pos.x + 12, y: pos.y + 22 }, headerTitle));
    g.append(svgEl("text", { class: "node-status-line", x: pos.x + 12, y: pos.y + 43 }, `${meta.symbol} ${statusLabel}`));
    const metaLine = n.current_attempt?.loop
      ? `${n.kind || "agent"} · attempt ${n.current_attempt.loop.attempt}/${n.current_attempt.loop.max_attempts}`
      : `${n.kind || "agent"}`;
    g.append(svgEl("text", { class: "node-meta-line", x: pos.x + 12, y: pos.y + 61 }, metaLine));

    const selectThisNode = () => {
      state.selectedGraphNodeId = n.id;
      for (const item of nodeGroups) {
        const active = item.getAttribute("data-node-id") === n.id;
        item.classList.toggle("selected", active);
        item.setAttribute("aria-pressed", active ? "true" : "false");
      }
      renderLiveNodeDetail(detailEl, n, graph.bound_version || boundVersion);
    };
    g.addEventListener("click", selectThisNode);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectThisNode();
      }
    });
    nodeGroups.push(g);
    svg.append(g);
  }

  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(".graph-node")) return;
    drag = { x: e.clientX, y: e.clientY };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const scale = viewBox.width / Math.max(1, svg.clientWidth);
    viewBox.x -= (e.clientX - drag.x) * scale;
    viewBox.y -= (e.clientY - drag.y) * scale;
    drag.x = e.clientX;
    drag.y = e.clientY;
    applyBox();
  });
  svg.addEventListener("pointerup", () => { drag = null; });
  svg.addEventListener("pointercancel", () => { drag = null; });
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomBy(e.deltaY > 0 ? 1.12 : 0.88);
  }, { passive: false });
  svg.addEventListener("keydown", (e) => {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(0.8); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1.25); }
    else if (e.key === "0") { e.preventDefault(); resetBox(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); panBy(-60, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); panBy(60, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); panBy(0, -60); }
    else if (e.key === "ArrowDown") { e.preventDefault(); panBy(0, 60); }
  });

  stage.append(svg);
  wrapper.append(stage);

  const selected = nodes.find((n) => n.id === state.selectedGraphNodeId) || null;
  renderLiveNodeDetail(detailEl, selected, graph.bound_version || boundVersion);
  return wrapper;
}

function renderLiveView(container, data) {
  const run = data?.run || null;
  const boundVersion = run?.bound_version || data?.graph?.bound_version;
  const stateVal = data?.state || "uncertain";
  const bannerTitle = stateVal === "ended"
    ? "Ended run (not active)"
    : stateVal === "running"
      ? "Verified released run"
      : `Factory live state: ${stateVal}`;
  container.append(banner(stateVal, undefined, bannerTitle, data?.reason));

  if (data?.launch_blocker && typeof data.launch_blocker === "object") {
    container.append(banner("blocked", "Launch blocker", `Queue head blocked (${data.launch_blocker.kind})`, data.launch_blocker.explanation));
  }

  const facts = el("dl", undefined, { class: "facts-grid" });
  facts.append(
    factItem("Live state", statusPill(stateVal)),
    factItem("Bound version", boundVersion
      ? (boundVersion !== data.current_version
        ? `${boundVersion} (differs from current ${data.current_version})`
        : `${boundVersion} (matches current)`)
      : absenceNode({ absence: "not applicable", explanation: "No released run is mounted." })),
    factItem("Current version", data?.current_version),
    factItem("Run identity", run ? `${run.run_id} (attempt ${run.attempt_id})` : absenceNode({ absence: "no records", explanation: "No active or retained run identity." })),
    factItem("Checked at", data?.checked_at),
  );
  if (run) {
    facts.append(
      factItem("Run outcome", statusPill(data.outcome || "unknown")),
      factItem("Execution settlement", statusPill(data.settlement || "unknown")),
      factItem("Capacity release", statusPill(data.capacity_release || "unknown")),
    );
  }
  container.append(facts);

  const headBlock = renderHeadStatusBlock(data?.head_status);
  if (headBlock) container.append(headBlock);

  const graph = data?.graph;
  if (graph && graph.evidence === "available" && Array.isArray(graph.nodes) && graph.nodes.length) {
    const detailPanel = el("section", undefined, { class: "card-panel-fv", "aria-live": "polite" });
    container.append(buildGraphSvg(graph, detailPanel, boundVersion), detailPanel);
  } else if (graph) {
    container.append(banner(
      graph.absence || (graph.evidence === "unavailable" ? "unavailable" : "not applicable"),
      undefined,
      "Run graph",
      graph.explanation || "No verified released run graph is available.",
    ));
  }
}

function renderInspectNodeCard(node, isTarget) {
  const card = el("article", undefined, {
    id: node.anchor || `node-${node.id}`,
    tabindex: "-1",
    class: `card node-config-card${isTarget ? " target-highlight" : ""}`,
  });
  const title = el("h4");
  title.append(el("span", node.id, { class: "mono" }), document.createTextNode(" "), statusPill(node.kind === "command" ? "active" : "running", node.kind));
  card.append(title);
  if (node.kind_explanation) card.append(el("p", node.kind_explanation, { class: "absence-explain" }));

  const facts = el("dl", undefined, { class: "facts-grid" });
  facts.append(
    factItem("Persona", isAbsenceObject(node.persona) ? absenceNode(node.persona) : `${node.persona?.name || "?"}`),
    factItem("Model", isAbsenceObject(node.model) ? absenceNode(node.model) : `${node.model?.id || "?"} (thinking: ${node.model?.thinking || "?"})`),
    factItem("Command", isAbsenceObject(node.command) ? absenceNode(node.command) : el("code", `${node.command?.executable || ""} ${(node.command?.args || []).join(" ")}`.trim())),
  );

  const depsNode = isAbsenceObject(node.dependencies)
    ? absenceNode(node.dependencies)
    : (() => {
      const ul = el("ul", undefined, { class: "link-list" });
      for (const item of node.dependencies?.items || []) {
        const li = el("li");
        li.append(renderNodeLinkOrAbsence(item));
        ul.append(li);
      }
      return ul;
    })();
  facts.append(factItem("Dependencies", depsNode));

  const joinNode = isAbsenceObject(node.join)
    ? absenceNode(node.join)
    : (() => {
      const wrap = el("div");
      wrap.append(el("span", `policy: ${node.join?.policy || "?"} — `));
      const ul = el("ul", undefined, { class: "link-list" });
      for (const src of node.join?.sources || []) {
        const li = el("li");
        li.append(renderNodeLinkOrAbsence(src));
        ul.append(li);
      }
      wrap.append(ul);
      return wrap;
    })();
  facts.append(factItem("Join", joinNode));

  const decNode = isAbsenceObject(node.decision)
    ? absenceNode(node.decision)
    : (() => {
      const wrap = el("div");
      wrap.append(el("p", node.decision.explanation || `${node.decision.field}: approve=${node.decision.approve}, reject=${node.decision.reject}`));
      const meta = el("div");
      meta.append(document.createTextNode("Feedback target: "), renderNodeLinkOrAbsence(node.decision.feedback_target_link || node.decision.feedback_target));
      wrap.append(meta);
      if (Array.isArray(node.decision.loop_body_links) && node.decision.loop_body_links.length) {
        const lb = el("div");
        lb.append(document.createTextNode("Loop body: "));
        node.decision.loop_body_links.forEach((lnk, idx) => {
          if (idx > 0) lb.append(document.createTextNode(", "));
          lb.append(renderNodeLinkOrAbsence(lnk));
        });
        wrap.append(lb);
      }
      wrap.append(el("div", `Max revisions: ${node.decision.max_revisions} (${node.decision.max_revisions_source || "default"}) · On exhausted: ${node.decision.on_exhausted}`));
      return wrap;
    })();
  facts.append(factItem("Decision", decNode));

  facts.append(factItem("Feedback target", renderNodeLinkOrAbsence(node.feedback_target)));
  facts.append(factItem("Required checks", isAbsenceObject(node.required_checks)
    ? absenceNode(node.required_checks)
    : (node.required_checks?.items || []).join(", ")));
  card.append(facts);

  const opt = el("details", undefined, { class: "fv-accordion", ...(isTarget ? { open: true } : {}) });
  opt.append(el("summary", "Optional node policies & limits"));
  const pf = el("dl", undefined, { class: "facts-grid" });
  const pol = node.policies || {};
  pf.append(
    factItem("Tools policy", pol.tools?.explanation || renderValue(pol.tools)),
    factItem("Skills policy", pol.skills?.explanation || renderValue(pol.skills)),
    factItem("Extensions policy", pol.extensions?.explanation || renderValue(pol.extensions)),
    factItem("Dependency policy", isAbsenceObject(pol.dependency) ? absenceNode(pol.dependency) : `${pol.dependency?.policy} — ${pol.dependency?.explanation || ""}`),
    factItem("Intervention policy", isAbsenceObject(pol.intervention) ? absenceNode(pol.intervention) : `${pol.intervention?.explanation || ""} Choices: ${(pol.intervention?.choices || []).map((c) => `${c.choice_id} (${c.label})`).join(", ")}`),
    factItem("Task timeout", isAbsenceObject(node.limits?.task_timeout_ms) ? absenceNode(node.limits.task_timeout_ms) : `${node.limits?.task_timeout_ms?.value} ms (${node.limits?.task_timeout_ms?.inherited ? "inherited" : "node"})`),
    factItem("Dependency wait timeout", isAbsenceObject(node.limits?.dependency_wait_timeout_ms) ? absenceNode(node.limits.dependency_wait_timeout_ms) : `${node.limits?.dependency_wait_timeout_ms?.value} ms (${node.limits?.dependency_wait_timeout_ms?.inherited ? "inherited" : "node"})`),
  );
  opt.append(pf);
  card.append(opt);
  return card;
}

function renderInspectView(container, data) {
  if (data?.evidence === "unavailable" && !data?.attention_summary) {
    container.append(banner("unavailable", "Evidence unavailable", "Factory inspection unavailable", data.explanation));
    return;
  }

  const summary = data.attention_summary || {};
  const mgmt = summary.management || data.management;
  const stop = summary.stop_state || data.stopped;
  const curVer = summary.current_version || { version: data.current_version };
  const cap = summary.capacity || data.capacity;
  const head = summary.queue_head || data.queue_head;
  const attn = summary.attention || data.attention;

  /* 1. What needs my attention? (never in an accordion) */
  const attnSec = el("section", undefined, { class: "card-panel-fv" });
  attnSec.append(el("h3", "What needs my attention?"));
  const topFacts = el("dl", undefined, { class: "facts-grid" });
  topFacts.append(
    factItem("Factory name", summary.name || data.name),
    factItem("Management state", mgmt ? statusPill(mgmt.state) : "Unknown"),
    factItem("Stop state", isAbsenceObject(stop) ? absenceNode(stop) : statusPill(stop?.state || (stop?.stopped ? "stopped" : "active"))),
    factItem("Current version", curVer?.evidence === "unavailable" ? absenceNode(curVer) : `${curVer?.version || data.current_version}`),
    factItem("Inspected version", data.inspected_version),
    factItem("Overall evidence", statusPill(data.evidence || "available")),
  );
  attnSec.append(topFacts);
  if (mgmt?.explanation) attnSec.append(el("p", mgmt.explanation));
  if (stop?.explanation && !isAbsenceObject(stop)) attnSec.append(el("p", stop.explanation));

  if (cap && !isAbsenceObject(cap)) {
    const capFacts = el("dl", undefined, { class: "facts-grid" });
    capFacts.append(
      factItem("Queue capacity", isAbsenceObject(cap.queue) ? absenceNode(cap.queue) : `${cap.queue_used} of ${cap.queue_limit}`),
      factItem("Factory run slot", statusPill(cap.factory_slot?.state || "uncertain")),
      factItem("Checkout slot", statusPill(cap.checkout_slot?.state || "uncertain")),
      factItem("Blocking hold", isAbsenceObject(cap.blocking_hold) ? absenceNode(cap.blocking_hold) : cap.blocking_hold.explanation),
    );
    attnSec.append(capFacts);
  } else if (cap) {
    attnSec.append(absenceNode(cap));
  }

  if (head) {
    attnSec.append(el("h4", "Queue head"));
    attnSec.append(el("p", head.explanation || "No explanation."));
  }

  attnSec.append(el("h4", "Outstanding attention"));
  if (attn && Array.isArray(attn.items) && attn.items.length) {
    attnSec.append(buildTable("Outstanding attention items requiring operator review in Pi", ["Item", "Explanation", "View"], attn.items.map((item) => [
      { asRowHeader: true, content: statusPill(item.kind === "uncertain" ? "uncertain" : "blocked", item.label) },
      item.explanation,
      buildLink(`Open ${VIEW_LABELS[item.detail_view] || item.detail_view}`, item.detail_url),
    ])));
  } else if (attn && isAbsenceObject(attn)) {
    attnSec.append(absenceNode(attn));
  } else {
    attnSec.append(el("p", attn?.explanation || "No outstanding attention items."));
  }
  container.append(attnSec);

  /* Target node banner if query targeted a specific node/factory */
  let focusAnchor = "";
  if (data.target_node) {
    if (data.target_node.verified === false) {
      container.append(banner("unavailable", "Unverifiable link target", `Target could not be verified in ${data.target_node.version || data.inspected_version}`, data.target_node.explanation));
    } else if (data.target_node.verified && data.target_node.node) {
      focusAnchor = data.target_node.node.anchor || `node-${data.target_node.node.id}`;
      container.append(banner("available", "Target resolved", `Showing ${data.target_node.node.id} in ${data.target_node.version}`, data.target_node.explanation));
    }
  }

  /* 2. Damaged records (always visible when present) */
  if (data.damaged_records && data.damaged_records.count > 0) {
    const dmg = el("section", undefined, { class: "status-banner tone-error" });
    dmg.append(el("h3", "Damaged or unavailable records"));
    dmg.append(el("p", data.damaged_records.explanation));
    dmg.append(buildTable("Damaged or unavailable record areas", ["Scope", "Target", "Absence", "Explanation"], data.damaged_records.items.map((item) => [
      { asRowHeader: true, content: el("code", item.scope) },
      item.version || item.attempt_id || "—",
      absenceNode(item),
      item.explanation,
    ])));
    container.append(dmg);
  }

  /* 3. Version selector and retained version history */
  const verSec = el("section", undefined, { class: "card-panel-fv" });
  verSec.append(el("h3", "Definition versions & selector"));
  verSec.append(el("p", "Selecting a retained version inspects that definition only; current version, queue, and capacity remain live.", { class: "absence-explain" }));
  if (Array.isArray(data.versions) && data.versions.length) {
    const form = el("form", undefined, { class: "inline-form" });
    const label = el("label", "Inspected definition version", { for: "inspect-version-select" });
    const select = el("select", undefined, { id: "inspect-version-select", name: "version", class: "browser-default" });
    for (const v of data.versions) {
      const opt = el("option", `${v.version}${v.current ? " (current)" : ""}${v.evidence === "unavailable" ? " [damaged]" : ""}`, { value: v.version });
      if (v.version === data.inspected_version) opt.selected = true;
      select.append(opt);
    }
    label.append(select);
    const submit = el("button", "Inspect version", { type: "submit", class: "btn-fv" });
    form.append(label, submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      navigateToUrl(pageUrl({ factory: state.selectedFactoryId, view: "inspect", version: select.value }), true);
    });
    verSec.append(form);

    verSec.append(buildTable("Retained definition versions", ["Version", "Flags", "Restore provenance", "Digest", "Created at", "Evidence"], data.versions.map((v) => {
      const flags = [];
      if (v.current) flags.push("current");
      if (v.inspected) flags.push("inspected");
      return [
        { asRowHeader: true, content: buildLink(v.version, pageUrl({ factory: state.selectedFactoryId, view: "inspect", version: v.version })) },
        flags.length ? flags.join(", ") : "retained",
        isAbsenceObject(v.restored_from) ? absenceNode(v.restored_from) : v.restored_from.explanation,
        isAbsenceObject(v.digest) ? absenceNode(v.digest) : el("code", String(v.digest).slice(0, 16) + "…"),
        isAbsenceObject(v.created_at) ? absenceNode(v.created_at) : v.created_at,
        v.evidence === "unavailable" ? absenceNode(v) : statusPill("available"),
      ];
    })));
  }
  container.append(verSec);

  /* 4. Inspected definition nodes */
  const defSec = el("section", undefined, { class: "card-panel-fv" });
  defSec.append(el("h3", `Inspected definition (${data.inspected_version})`));
  const def = data.definition;
  if (!def || def.evidence === "unavailable" || isAbsenceObject(def)) {
    defSec.append(banner("unavailable", "Definition unavailable", `Definition ${data.inspected_version} is unavailable`, def?.explanation || "The selected retained definition could not be verified."));
  } else {
    const defFacts = el("dl", undefined, { class: "facts-grid" });
    defFacts.append(
      factItem("Version", def.version),
      factItem("Topology", def.topology),
      factItem("Restore provenance", isAbsenceObject(def.restored_from) ? absenceNode(def.restored_from) : def.restored_from.explanation),
    );
    defSec.append(defFacts);
    if (Array.isArray(def.nodes)) {
      const targetId = data.target_node?.verified && data.target_node?.node ? data.target_node.node.id : "";
      for (const n of def.nodes) {
        defSec.append(renderInspectNodeCard(n, n.id === targetId));
      }
    }
    const limOpt = el("details", undefined, { class: "fv-accordion" });
    limOpt.append(el("summary", "Definition limits & runtime assumptions (what is not frozen)"));
    if (def.limits) {
      const lf = el("dl", undefined, { class: "facts-grid" });
      lf.append(
        factItem("Max total attempts", `${def.limits.max_total_attempts} (${def.limits.max_total_attempts_source})`),
        factItem("Ready timeout", `${def.limits.ready_timeout_ms} ms`),
        factItem("Default task timeout", isAbsenceObject(def.limits.task_timeout_ms) ? absenceNode(def.limits.task_timeout_ms) : `${def.limits.task_timeout_ms} ms`),
        factItem("Dependency wait timeout", `${def.limits.dependency_wait_timeout_ms} ms`),
        factItem("Liveness timeout", `${def.limits.liveness_timeout_ms} ms`),
        factItem("Cancel grace", `${def.limits.cancel_grace_ms} ms`),
      );
      limOpt.append(lf);
    }
    const nf = def.not_frozen || data.runtime_assumptions;
    if (nf && Array.isArray(nf.not_frozen)) {
      if (nf.note) limOpt.append(el("p", nf.note));
      limOpt.append(buildTable("Inputs not frozen by the definition", ["Input", "Explanation"], nf.not_frozen.map((r) => [
        { asRowHeader: true, content: r.label },
        r.explanation,
      ])));
    }
    defSec.append(limOpt);
  }
  container.append(defSec);

  /* 5. Operation & evidence summary */
  if (data.operation_evidence) {
    const oe = data.operation_evidence;
    const oeSec = el("section", undefined, { class: "card-panel-fv" });
    oeSec.append(el("h3", "Operation & evidence summary"));
    const rows = [
      ["Launch attempts", oe.attempts],
      ["Input admission", oe.admission],
      ["Bound versions", oe.bound_versions],
      ["Capacity", oe.capacity],
      ["Requests", oe.requests],
      ["Proposals", oe.proposals],
      ["Attention", oe.attention],
    ].map(([label, area]) => [
      { asRowHeader: true, content: label },
      isAbsenceObject(area) ? absenceNode(area) : (area?.explanation || "Recorded"),
      area?.detail_url ? buildLink(`Open ${VIEW_LABELS[area.detail_view] || area.detail_view}`, area.detail_url) : "—",
    ]);
    oeSec.append(buildTable("Operation and evidence summary links", ["Evidence area", "Summary", "Detail view"], rows));
    container.append(oeSec);
  }

  if (focusAnchor) {
    const targetEl = document.getElementById(focusAnchor);
    if (targetEl) {
      targetEl.scrollIntoView({ block: "nearest" });
      targetEl.focus();
    }
  }
}

function renderQueueView(container, data) {
  const activeFilter = data?.filter === "all" ? "all" : state.queueFilter;
  const filterBar = el("div", undefined, { class: "toolbar-row", role: "group", "aria-label": "Queue filter" });
  const btnOpen = el("button", "Open (unfinished & uncertain)", { type: "button", class: "btn-fv-secondary", "aria-pressed": activeFilter === "open" ? "true" : "false" });
  const btnAll = el("button", "All (include finished)", { type: "button", class: "btn-fv-secondary", "aria-pressed": activeFilter === "all" ? "true" : "false" });
  btnOpen.addEventListener("click", () => navigateToUrl(pageUrl({ factory: state.selectedFactoryId, view: "queue", filter: "open" }), true));
  btnAll.addEventListener("click", () => navigateToUrl(pageUrl({ factory: state.selectedFactoryId, view: "queue", filter: "all" }), true));
  filterBar.append(btnOpen, btnAll);
  container.append(filterBar);

  const ev = data?.evidence || "unavailable";
  container.append(banner(ev === "unavailable" ? "unavailable" : ev, undefined, `Queue (${activeFilter} filter)`, data?.explanation));

  const headBlock = renderHeadStatusBlock(data?.head_status);
  if (headBlock) container.append(headBlock);

  const rows = Array.isArray(data?.entries) ? data.entries : [];
  if (!rows.length) {
    container.append(banner(data?.absence || "no records", undefined, "Queue entries", data?.explanation || "No queue entries."));
    return;
  }

  container.append(buildTable(
    `FIFO queue entries (${activeFilter} filter, total admitted: ${data.total_count ?? rows.length})`,
    ["Position", "Submission reference", "Bound version", "Disposition", "Uncertainty", "Accepted at", "Head", "Receipt"],
    rows.map((r) => {
      const verNode = el("span");
      verNode.append(el("code", r.bound_version || "?"));
      if (r.bound_version_evidence === "unavailable") {
        verNode.append(document.createTextNode(" "), statusPill("unavailable", "Version damaged"));
      }
      const dispNode = el("div");
      dispNode.append(statusPill(r.disposition), el("div", r.disposition_explanation, { class: "absence-explain" }));
      return [
        { asRowHeader: true, content: String(r.queue_position ?? "?") },
        el("code", r.reference || r.input_id),
        verNode,
        dispNode,
        r.uncertain ? statusPill("uncertain", "Uncertain") : statusPill("available", "Verified"),
        r.accepted_at,
        r.is_head ? statusPill("queued", "Queue head") : "—",
        buildLink(`Receipt for ${r.reference}`, r.receipt_url),
      ];
    }),
  ));
}

function renderReceiptsView(container, data, errorInfo) {
  container.append(banner("info", "Read-only receipt", "Receipt evidence is not a run report.", "Receipts document input admission, bound version, disposition, and launch attempt state only."));

  const form = el("form", undefined, { class: "inline-form" });
  const label = el("label", "Submission reference", { for: "receipt-ref-input" });
  const input = el("input", undefined, { id: "receipt-ref-input", name: "reference", type: "text", required: true, value: state.receiptReference || "" });
  label.append(input);
  const submit = el("button", "Look up receipt", { type: "submit", class: "btn-fv" });
  form.append(label, submit);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ref = input.value.trim();
    if (!ref) return;
    navigateToUrl(pageUrl({ factory: state.selectedFactoryId, view: "receipts", reference: ref }), true);
  });
  container.append(form);

  if (errorInfo) {
    container.append(errorBanner(errorInfo.status, errorInfo.title, errorInfo.detail));
    return;
  }
  if (!state.receiptReference) {
    container.append(el("p", "Enter a submission reference above or follow a receipt link from the Queue view."));
    return;
  }
  if (!data || data.type !== "receipt") return;

  const facts = el("dl", undefined, { class: "facts-grid" });
  facts.append(
    factItem("Submission reference", el("code", data.reference)),
    factItem("Input ID", el("code", data.input_id)),
    factItem("Queue position", data.queue_position),
    factItem("Accepted at", data.accepted_at),
    factItem("Bound version", el("code", data.bound_version)),
    factItem("Current version", isAbsenceObject(data.current_version) ? absenceNode(data.current_version) : el("code", data.current_version)),
    factItem("Disposition", statusPill(data.disposition)),
    factItem("Disposition details", data.disposition_explanation),
  );
  container.append(facts);

  const attSec = el("section", undefined, { class: "card-panel-fv" });
  attSec.append(el("h3", "Recorded launch attempt"));
  const att = data.attempt;
  if (!att || isAbsenceObject(att)) {
    attSec.append(absenceNode(att || { absence: "evidence unavailable", explanation: "Attempt evidence unavailable." }));
  } else {
    if (att.uncertain) {
      attSec.append(banner("uncertain", "Uncertain", "Attempt evidence is uncertain", att.state_explanation));
    }
    const af = el("dl", undefined, { class: "facts-grid" });
    af.append(
      factItem("Attempt ID", el("code", att.attempt_id)),
      factItem("Attempt state", statusPill(att.state)),
      factItem("State explanation", att.state_explanation),
      factItem("Bound version", el("code", att.bound_version)),
      factItem("Task ID", el("code", att.task_id)),
      factItem("Request ID", el("code", att.request_id)),
      factItem("Release authorized", att.release_authorized ? "Yes" : "No"),
      factItem("Release authorized at", isAbsenceObject(att.release_authorized_at) ? absenceNode(att.release_authorized_at) : att.release_authorized_at),
      factItem("Created at", att.created_at),
      factItem("Updated at", att.updated_at),
    );
    attSec.append(af);
  }
  container.append(attSec);
}

function renderRequestsView(container, data) {
  container.append(banner(
    data?.evidence === "unavailable" ? "unavailable" : (data?.evidence || "available"),
    undefined,
    "Direction & exhaustion requests (read-only observation)",
    `${data?.explanation || ""} Answering or waking requests stays in Pi.`,
  ));

  const recs = Array.isArray(data?.records) ? data.records : [];
  if (!recs.length) {
    container.append(banner(data?.absence || "no records", undefined, "Request records", data?.explanation || "No requests recorded."));
    return;
  }

  for (const r of recs) {
    const card = el("article", undefined, { class: "card" });
    const head = el("div", undefined, { class: "status-banner-head" });
    head.append(el("strong", r.request_id, { class: "mono" }), statusPill(r.state), el("span", r.kind, { class: "status-pill tone-muted" }));
    if (r.uncertain) head.append(statusPill("uncertain", "Uncertain"));
    card.append(head);

    if (r.uncertain && r.uncertainty) {
      card.append(banner("uncertain", "Uncertain", "Request evidence uncertainty", r.uncertainty));
    }

    const qWrap = el("p");
    qWrap.append(el("strong", "Question: "), isAbsenceObject(r.question) ? absenceNode(r.question) : document.createTextNode(r.question));
    card.append(qWrap);

    const facts = el("dl", undefined, { class: "facts-grid" });
    facts.append(
      factItem("Node", isAbsenceObject(r.node_id) ? absenceNode(r.node_id) : el("code", r.node_id)),
      factItem("Node attempt", isAbsenceObject(r.node_attempt_id) ? absenceNode(r.node_attempt_id) : el("code", r.node_attempt_id)),
      factItem("Response recorded", isAbsenceObject(r.response_recorded)
        ? absenceNode(r.response_recorded)
        : (r.response_recorded
          ? `Yes (${r.recorded_response?.kind || "recorded"}${r.recorded_response?.choice_id ? `: ${r.recorded_response.choice_id}` : ""}${r.responded_at ? ` at ${r.responded_at}` : ""})`
          : "No")),
      factItem("Response consumed", isAbsenceObject(r.response_consumed)
        ? absenceNode(r.response_consumed)
        : `${r.response_consumed ? "Yes" : "No"} — ${r.consumption_explanation || r.consumption || ""}${r.consumed_at ? ` (${r.consumed_at})` : ""}`),
      factItem("Reconciliation", `${r.reconciliation} — ${r.reconciliation_explanation || ""}`),
    );
    card.append(facts);

    const choicesDiv = el("div");
    choicesDiv.append(el("strong", "Choices: "));
    if (isAbsenceObject(r.choices)) {
      choicesDiv.append(absenceNode(r.choices));
    } else if (Array.isArray(r.choices)) {
      const ul = el("ul", undefined, { class: "link-list" });
      for (const c of r.choices) {
        ul.append(el("li", `${c.label} [${c.choice_id}]${c.route ? ` -> route: ${c.route}` : ""}`));
      }
      choicesDiv.append(ul);
    }
    card.append(choicesDiv);

    const opt = el("details", undefined, { class: "fv-accordion" });
    opt.append(el("summary", "Optional request provenance, verdict, admissions & risk lane"));
    const of = el("dl", undefined, { class: "facts-grid" });
    of.append(
      factItem("State explanation", r.state_explanation),
      factItem("Input ID", renderValue(r.input_id)),
      factItem("Attempt ID", renderValue(r.attempt_id)),
      factItem("Run task ID", renderValue(r.task_id)),
      factItem("Created at", renderValue(r.created_at)),
    );
    if (r.exhaustion) of.append(factItem("Exhaustion", `blocked by: ${r.exhaustion.blocked_by}; on_exhausted: ${r.exhaustion.on_exhausted}`));
    if (r.terminated) of.append(factItem("Terminated", `${r.terminated.reason} at ${r.terminated.at}`));
    if (r.verdict) of.append(factItem("Decision verdict", `${r.verdict.state}${r.verdict.value ? `: ${r.verdict.value}` : ""}`));
    if (r.admissions !== undefined) {
      of.append(factItem("Downstream admissions", isAbsenceObject(r.admissions)
        ? absenceNode(r.admissions)
        : (Array.isArray(r.admissions) ? r.admissions.map((a) => `${a.node_id} (${a.kind}): ${a.state}`).join("; ") : renderValue(r.admissions))));
    }
    if (r.risk_lane) {
      of.append(factItem("Risk lane", isAbsenceObject(r.risk_lane.scope)
        ? (() => {
          const s = el("span", `${r.risk_lane.lane} (${r.risk_lane.requirement}) — `);
          s.append(absenceNode(r.risk_lane.scope));
          return s;
        })()
        : `${r.risk_lane.lane} (${r.risk_lane.requirement}, scope: ${r.risk_lane.scope})`));
    }
    opt.append(of);
    card.append(opt);
    container.append(card);
  }
}

function renderProposalsView(container, data) {
  container.append(banner("info", "Not active constraints", data?.note || "Proposals are not the active constraints file.", "Reviewing, confirming, retiring, or resolving proposal conflicts stays in Pi."));
  container.append(banner(
    data?.evidence === "unavailable" ? "unavailable" : (data?.evidence || "available"),
    undefined,
    "Constraint proposals",
    data?.explanation,
  ));

  const recs = Array.isArray(data?.records) ? data.records : [];
  if (!recs.length) {
    container.append(banner(data?.absence || "no records", undefined, "Proposal records", data?.explanation || "No proposals recorded."));
    return;
  }

  container.append(buildTable(
    "Learned constraint proposals (not the active constraints file)",
    ["Proposal", "Action & IDs", "Text", "Provenance", "Outcome", "File sync state", "Uncertainty"],
    recs.map((p) => {
      const prov = p.provenance || {};
      const provCell = el("div");
      provCell.append(
        el("div", `Source: ${prov.source || p.source || "?"}`),
        el("div", undefined, { class: "absence-explain" }),
      );
      provCell.lastChild.append(document.createTextNode("Run: "), renderValue(prov.run_id), document.createTextNode(" · Attempt: "), renderValue(prov.attempt_id));
      const evDiv = el("div", undefined, { class: "absence-explain" });
      evDiv.append(document.createTextNode("Evidence: "), renderValue(prov.evidence_ref));
      provCell.append(evDiv);

      const outCell = el("div");
      outCell.append(statusPill(p.outcome), el("div", p.outcome_explanation, { class: "absence-explain" }));
      if (p.rejection_reason) outCell.append(el("div", `Rejection reason: ${p.rejection_reason}`, { class: "absence-explain" }));
      if (Array.isArray(p.conflicting_ids) && p.conflicting_ids.length) outCell.append(el("div", `Conflicts: ${p.conflicting_ids.join(", ")}`));

      const syncCell = el("div");
      syncCell.append(isAbsenceObject(p.file_sync_state) ? absenceNode(p.file_sync_state) : statusPill(p.file_sync_state));
      if (p.file_sync_state_explanation && !isAbsenceObject(p.file_sync_state)) {
        syncCell.append(el("div", p.file_sync_state_explanation, { class: "absence-explain" }));
      }

      const idInfo = el("div");
      idInfo.append(el("div", p.action), el("div", `Ref: ${p.reference || "—"}`, { class: "absence-explain" }));
      if (p.target_constraint_id) idInfo.append(el("div", `Target: ${p.target_constraint_id}`, { class: "absence-explain" }));
      if (p.assigned_constraint_id) idInfo.append(el("div", `Assigned: ${p.assigned_constraint_id}`, { class: "absence-explain" }));

      return [
        { asRowHeader: true, content: el("code", p.proposal_id) },
        idInfo,
        el("span", p.text),
        provCell,
        outCell,
        syncCell,
        p.uncertain ? statusPill("uncertain", p.uncertainty || "Uncertain") : statusPill("available", "Verified"),
      ];
    }),
  ));
}

function render(view, data, errorInfo) {
  dom.content.replaceChildren();
  if (view === "factories") {
    renderFactoriesView(dom.content);
    return;
  }
  if (!state.selectedFactoryId) {
    dom.content.append(el("p", "Select a factory from the Factories sidebar or Factories view first."));
    return;
  }
  if (view === "receipts") {
    renderReceiptsView(dom.content, data, errorInfo);
    return;
  }
  if (errorInfo) {
    dom.content.append(errorBanner(errorInfo.status, errorInfo.title, errorInfo.detail));
    return;
  }
  if (view === "live") renderLiveView(dom.content, data);
  else if (view === "inspect") renderInspectView(dom.content, data);
  else if (view === "queue") renderQueueView(dom.content, data);
  else if (view === "requests") renderRequestsView(dom.content, data);
  else if (view === "proposals") renderProposalsView(dom.content, data);
}

/* ---------- Fetching & Routing ---------- */

async function fetchJsonStrict(url, signal) {
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const rawText = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    if (!res.ok) throw { status: res.status, message: `HTTP ${res.status}`, detail: rawText.slice(0, 200) };
    throw { status: res.status, message: "Invalid JSON response", detail: "The viewer received a non-JSON response from the snapshot API." };
  }
  if (!res.ok) {
    const errMsg = parsed && typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    throw { status: res.status, message: errMsg, detail: `Request to ${url} failed with HTTP ${res.status}.` };
  }
  return parsed;
}

async function loadFactoriesList() {
  try {
    const rows = await fetchJsonStrict("/api/factories");
    if (!Array.isArray(rows)) throw { status: null, message: "Invalid factories list", detail: "Expected JSON array from /api/factories." };
    state.factories = rows;
    state.factoriesError = null;
  } catch (err) {
    state.factories = [];
    state.factoriesError = err?.message || "Failed to load factories list.";
  }
  renderSidebarFactories();
  updateChrome();
  if (state.activeView === "factories") render("factories", null, null);
}

function buildApiUrlForCurrentState() {
  const f = encodeURIComponent(state.selectedFactoryId);
  if (state.activeView === "live") return `/api/factories/${f}/live`;
  if (state.activeView === "inspect") {
    const sp = new URLSearchParams();
    if (state.inspectVersion) sp.set("version", state.inspectVersion);
    if (state.inspectNode) sp.set("node", state.inspectNode);
    const qs = sp.toString();
    return `/api/factories/${f}/inspect${qs ? `?${qs}` : ""}`;
  }
  if (state.activeView === "queue") {
    return `/api/factories/${f}/queue?filter=${encodeURIComponent(state.queueFilter)}`;
  }
  if (state.activeView === "receipts") {
    if (!state.receiptReference) return null;
    return `/api/factories/${f}/receipts?${new URLSearchParams({ reference: state.receiptReference })}`;
  }
  if (state.activeView === "requests") return `/api/factories/${f}/requests`;
  if (state.activeView === "proposals") return `/api/factories/${f}/proposals`;
  return null;
}

async function loadCurrentView() {
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  const seq = ++state.requestSeq;
  const reqFactory = state.selectedFactoryId;
  const reqView = state.activeView;

  updateChrome();
  renderSidebarFactories();

  if (reqView === "factories") {
    dom.content.setAttribute("aria-busy", "false");
    render("factories", null, null);
    return;
  }
  if (!reqFactory) {
    dom.content.setAttribute("aria-busy", "false");
    render(reqView, null, null);
    return;
  }

  const url = buildApiUrlForCurrentState();
  if (!url) {
    dom.content.setAttribute("aria-busy", "false");
    render(reqView, null, null);
    return;
  }

  /* Clear previous factory/view DOM immediately before fetching */
  dom.content.replaceChildren(el("p", `Loading ${VIEW_LABELS[reqView] || reqView}…`));
  dom.content.setAttribute("aria-busy", "true");

  const controller = new AbortController();
  state.controller = controller;
  try {
    const data = await fetchJsonStrict(url, controller.signal);
    if (seq !== state.requestSeq || reqFactory !== state.selectedFactoryId || reqView !== state.activeView) return;
    if (data && typeof data.factory_id === "string" && data.factory_id !== state.selectedFactoryId) return;
    render(reqView, data, null);
  } catch (err) {
    if (err && err.name === "AbortError") return;
    if (seq !== state.requestSeq || reqFactory !== state.selectedFactoryId || reqView !== state.activeView) return;
    render(reqView, null, {
      status: err?.status || null,
      title: err?.message || "Snapshot request failed",
      detail: err?.detail || "Unable to fetch snapshot evidence from the local viewer.",
    });
  } finally {
    if (seq === state.requestSeq) {
      dom.content.setAttribute("aria-busy", "false");
      if (state.controller === controller) state.controller = null;
    }
  }
}

function applyUrlParams(search) {
  const sp = new URLSearchParams(search);
  const facParam = sp.get("factory") || "";
  const prevFactory = state.selectedFactoryId;
  state.selectedFactoryId = VALID_ID.test(facParam) ? facParam : "";
  if (state.selectedFactoryId !== prevFactory) state.selectedGraphNodeId = "";

  const viewParam = sp.get("view") || "";
  if (VALID_VIEWS.has(viewParam)) {
    state.activeView = viewParam;
  } else {
    state.activeView = state.selectedFactoryId ? "live" : "factories";
  }

  const verParam = sp.get("version") || "";
  state.inspectVersion = VALID_VERSION.test(verParam) ? verParam : "";

  const nodeParam = sp.get("node") || "";
  state.inspectNode = VALID_ID.test(nodeParam) ? nodeParam : "";

  state.queueFilter = sp.get("filter") === "all" ? "all" : "open";
  state.receiptReference = (sp.get("reference") || "").trim();
}

function navigateToUrl(rawUrl, push) {
  const checked = pageUrlFromApiOrHref(rawUrl);
  if (!checked) return;
  const parsed = new URL(checked, window.location.origin);
  if (push && `${window.location.pathname}${window.location.search}` !== `${parsed.pathname}${parsed.search}`) {
    window.history.pushState(null, "", `${parsed.pathname}${parsed.search}`);
  }
  applyUrlParams(parsed.search);
  loadCurrentView();
}

function initEventHandlers() {
  for (const tab of dom.viewTabs) {
    tab.addEventListener("click", () => {
      const targetView = tab.dataset.view;
      if (!targetView || !VALID_VIEWS.has(targetView)) return;
      if (targetView !== "factories" && !state.selectedFactoryId) return;
      const next = pageUrl({
        factory: targetView === "factories" ? state.selectedFactoryId : state.selectedFactoryId,
        view: targetView,
        filter: targetView === "queue" ? state.queueFilter : "",
        reference: targetView === "receipts" ? state.receiptReference : "",
      });
      navigateToUrl(next, true);
    });
  }

  dom.menuToggle?.addEventListener("click", () => {
    const isOpen = dom.sidebar?.classList.contains("open");
    setDrawerOpen(!isOpen, isOpen);
  });
  dom.drawerClose?.addEventListener("click", () => setDrawerOpen(false, true));
  dom.drawerBackdrop?.addEventListener("click", () => setDrawerOpen(false, true));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dom.sidebar?.classList.contains("open")) {
      e.preventDefault();
      setDrawerOpen(false, true);
    }
  });

  window.addEventListener("popstate", () => {
    applyUrlParams(window.location.search);
    loadCurrentView();
  });
}

initEventHandlers();
applyUrlParams(window.location.search);
loadCurrentView();
loadFactoriesList();
