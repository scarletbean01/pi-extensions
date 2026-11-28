/* Read-only Factory Web Viewer client (ticket 08).
   Renders exclusively via safe DOM nodes, textContent, and allowlisted attributes. */
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const Safe = window.FactoryViewerSafe;
const {
  VALID_ID,
  VALID_VERSION,
  VALID_VIEWS,
  LIVE_POLL_INTERVAL_MS,
  safeHref,
  pageUrl,
  pageUrlFromApiOrHref,
  isAbsenceObject,
  getViewLabel,
  resolveStatusMeta,
  resolveAbsenceMeta,
  resolveBannerMeta,
  resolveLiveRunIdentityAbsence,
  resolveLiveBoundVersionAbsence,
  safeNodeDomId,
  matchesSelectedFactory,
  outputApiUrl,
  matchesSelectedOutputTarget,
  resolveStopStateValue,
  resolveInspectOverallEvidence,
  resolveBooleanVerification,
  resolveSnapshotEvidence,
  resolveSidebarManagementLabel,
  resolveRestoredFromDisplay,
  resolveBlockingHoldDisplay,
  resolveHeadEligibility,
  resolveEmptyCollectionBanner,
  resolveLiveGraphBanner,
  resolveUnexpectedReceiptBanner,
  hasVerifiedRunIdentity,
  getLiveRunKey,
  hasRenderableGraph,
  createLiveSessionState,
  reduceLiveFetchOutcome,
  computeNextPollAction,
  planKeyedDiff,
  shouldRefetchNodeOutput,
} = Safe;

const FETCH_TIMEOUT_MS = 15000;

const TONE_PALETTE_CLASSES = Object.freeze({
  __proto__: null,
  ok: "green lighten-5 green-text text-darken-4",
  warn: "amber lighten-5 brown-text text-darken-3",
  error: "red lighten-5 red-text text-darken-4",
  info: "blue lighten-5 blue-text text-darken-4",
  muted: "grey lighten-3 grey-text text-darken-3",
  stale: "blue-grey lighten-4 blue-grey-text text-darken-4",
});

function toneClasses(tone) {
  const raw = typeof tone === "string" ? tone.trim().toLowerCase() : "";
  const key = raw.startsWith("tone-") ? raw.slice(5) : raw;
  return Object.hasOwn(TONE_PALETTE_CLASSES, key)
    ? TONE_PALETTE_CLASSES[key]
    : TONE_PALETTE_CLASSES.warn;
}

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
  "data-edge-key",
  "data-focus-key",
]);

const state = {
  factories: [],
  deletedFactories: [],
  damagedFactories: [],
  deletedSectionOpen: false,
  factoriesStatus: "loading",
  factoriesAbsence: null,
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
  outputRequestSeq: 0,
  outputController: null,
  liveSession: createLiveSessionState(""),
  liveDom: null,
  liveInFlight: false,
  livePollTimer: null,
};

const dom = {
  skipLink: document.querySelector(".skip-link"),
  header: document.querySelector("header"),
  mainContent: document.getElementById("main-content"),
  menuToggle: document.getElementById("menu-toggle"),
  drawerClose: document.getElementById("drawer-close"),
  drawerBackdrop: document.getElementById("drawer-backdrop"),
  sidebar: document.getElementById("sidebar"),
  factoriesList: document.getElementById("factories-list"),
  viewHeading: document.getElementById("view-heading"),
  factorySubtitle: document.getElementById("factory-subtitle"),
  headerScope: document.getElementById("header-scope"),
  content: document.getElementById("content"),
  tabIndicator: document.querySelector(".indicator"),
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

function statusPill(value, labelOverride) {
  const meta = resolveStatusMeta(value, labelOverride);
  return el("span", `${meta.symbol} ${meta.label}`, { class: `chip ${toneClasses(meta.tone)}` });
}

function symbolChipWithText(meta, text) {
  const wrap = el("div");
  wrap.append(
    el("span", meta.symbol, { class: `chip ${toneClasses(meta.tone)}` }),
    document.createTextNode(` ${text}`),
  );
  return wrap;
}

function absenceNode(value) {
  const meta = resolveAbsenceMeta(value?.absence);
  const wrap = el("span");
  wrap.append(el("span", `${meta.symbol} ${meta.label}`, { class: `chip ${toneClasses(meta.tone)}` }));
  if (typeof value?.explanation === "string" && value.explanation) {
    wrap.append(document.createTextNode(" "), el("span", value.explanation, { class: "grey-text text-darken-3" }));
  }
  return wrap;
}

function renderValue(value, fallbackLabel) {
  if (isAbsenceObject(value)) return absenceNode(value);
  if (value === null || value === undefined) {
    return el("span", fallbackLabel || "Unknown (not provided)", { class: "grey-text text-darken-3" });
  }
  if (typeof value === "boolean") return document.createTextNode(value ? "Yes" : "No");
  if (typeof value === "string" || typeof value === "number") return document.createTextNode(String(value));
  return document.createTextNode(String(value));
}

function factItem(label, valueNodeOrText) {
  const box = el("div", undefined, { class: "col s12 m6 l4" });
  box.append(el("dt", label, { class: "grey-text text-darken-3" }));
  const dd = el("dd");
  if (valueNodeOrText instanceof Node) dd.append(valueNodeOrText);
  else dd.append(renderValue(valueNodeOrText));
  box.append(dd);
  return box;
}

function buildTable(captionText, headers, rows) {
  const wrap = el("div", undefined, { class: "table-wrap" });
  const tbl = el("table", undefined, { class: "striped highlight" });
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
  if (!href) {
    const unavailableCls = cls && cls.includes("mono") ? "grey-text text-darken-3 mono" : "grey-text text-darken-3";
    return el("span", `${label} (link unavailable)`, { class: unavailableCls });
  }
  const a = el("a", label, { href, class: cls || "blue-text text-darken-3" });
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigateToUrl(href, true);
  });
  return a;
}

function banner(pillKey, pillLabel, titleText, reasonText, extraNode) {
  const meta = resolveBannerMeta(pillKey, pillLabel);
  const box = el("div", undefined, { class: `card-panel ${toneClasses(meta.tone)}` });
  const head = el("div");
  head.append(el("span", `${meta.symbol} ${meta.label}`, { class: `chip ${toneClasses(meta.tone)}` }));
  if (titleText) head.append(el("strong", titleText));
  box.append(head);
  if (reasonText) box.append(el("p", reasonText));
  if (extraNode) box.append(extraNode);
  return box;
}

function errorBanner(status, message, detail) {
  const box = el("div", undefined, { class: `card-panel ${toneClasses("error")}`, role: "alert" });
  const head = el("div");
  head.append(el("span", status ? `! HTTP ${status}` : "! Error", { class: `chip ${toneClasses("error")}` }));
  head.append(el("strong", message || "Request failed"));
  box.append(head);
  if (detail) box.append(el("p", detail));
  return box;
}

function isNarrowViewport() {
  return window.matchMedia && window.matchMedia("(max-width: 992px)").matches;
}

function setBackgroundInert(isInert) {
  for (const landmark of [dom.skipLink, dom.header, dom.mainContent]) {
    if (!landmark) continue;
    if ("inert" in landmark) landmark.inert = Boolean(isInert);
    if (isInert) landmark.setAttribute("inert", "");
    else landmark.removeAttribute("inert");
  }
}

function getSidebarFocusables() {
  if (!dom.sidebar) return [];
  return Array.from(
    dom.sidebar.querySelectorAll('button:not([disabled]), a[href], summary, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ).filter((node) => {
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function setSidebarInert(isInert) {
  if (!dom.sidebar) return;
  if ("inert" in dom.sidebar) dom.sidebar.inert = Boolean(isInert);
  if (isInert) dom.sidebar.setAttribute("inert", "");
  else dom.sidebar.removeAttribute("inert");
}

function setDrawerOpen(open, focusTarget) {
  if (!dom.sidebar) return;
  const narrow = isNarrowViewport();
  const shouldOpen = Boolean(open && narrow);
  dom.sidebar.classList.toggle("open", shouldOpen);
  setSidebarInert(narrow && !shouldOpen);
  if (dom.menuToggle) dom.menuToggle.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    dom.sidebar.setAttribute("role", "dialog");
    dom.sidebar.setAttribute("aria-modal", "true");
    dom.drawerBackdrop?.removeAttribute("hidden");
    setBackgroundInert(true);
    const target = dom.drawerClose || dom.factoriesList?.querySelector("a");
    target?.focus();
    return;
  }
  dom.sidebar.removeAttribute("role");
  dom.sidebar.removeAttribute("aria-modal");
  dom.drawerBackdrop?.setAttribute("hidden", "");
  setBackgroundInert(false);
  if (focusTarget === true || focusTarget === "toggle") {
    dom.menuToggle?.focus();
  } else if (focusTarget === "main") {
    dom.mainContent?.focus();
  }
}

function syncDrawerForViewport() {
  if (!isNarrowViewport()) {
    const wasOpen = dom.sidebar?.classList.contains("open") || dom.menuToggle?.getAttribute("aria-expanded") === "true";
    const activeEl = document.activeElement;
    const focusOnHiddenControl = activeEl === dom.menuToggle || activeEl === dom.drawerClose;
    const focusDroppedToBody = !activeEl || activeEl === document.body || activeEl === document.documentElement;
    setSidebarInert(false);
    if (wasOpen) {
      setDrawerOpen(false, (focusOnHiddenControl || focusDroppedToBody) ? "main" : "none");
    } else if (focusOnHiddenControl) {
      dom.mainContent?.focus();
    }
    return;
  }
  const isOpen = Boolean(dom.sidebar?.classList.contains("open"));
  setSidebarInert(!isOpen);
  if (!isOpen && dom.sidebar?.contains(document.activeElement)) {
    dom.menuToggle?.focus();
  }
}

function selectedFactoryRecord() {
  return (
    state.factories.find((f) => f && f.factory_id === state.selectedFactoryId)
    || state.deletedFactories.find((f) => f && f.factory_id === state.selectedFactoryId)
    || state.damagedFactories.find((f) => f && f.factory_id === state.selectedFactoryId)
    || null
  );
}

function tabHrefForView(view) {
  if (!VALID_VIEWS.has(view)) return null;
  if (view !== "factories" && !state.selectedFactoryId) return null;
  return pageUrl({
    factory: state.selectedFactoryId,
    view,
    filter: view === "queue" ? state.queueFilter : "",
    reference: view === "receipts" ? state.receiptReference : "",
  });
}

function updateTabIndicator() {
  const indicator = dom.tabIndicator;
  if (!indicator || !indicator.style) return;
  const activeTab = dom.viewTabs.find((tab) => tab.dataset.view === state.activeView);
  const tabLi = activeTab?.parentNode && activeTab.parentNode.nodeType === 1 ? activeTab.parentNode : null;
  if (!activeTab || !tabLi) {
    indicator.style.left = "0px";
    indicator.style.width = "0px";
    return;
  }
  const left = typeof tabLi.offsetLeft === "number" ? tabLi.offsetLeft : 0;
  const width = typeof tabLi.offsetWidth === "number" ? tabLi.offsetWidth : 0;
  indicator.style.left = `${left}px`;
  indicator.style.width = `${width}px`;
}

function updateChrome() {
  const fac = selectedFactoryRecord();
  const facLabel = fac ? `${fac.name || fac.factory_id} (${fac.current_version || "Unknown (not provided)"})` : (state.selectedFactoryId || "");
  if (dom.viewHeading) dom.viewHeading.textContent = getViewLabel(state.activeView, "Factory Viewer");
  if (dom.factorySubtitle) {
    if (fac && fac.damaged) {
      dom.factorySubtitle.textContent = `Factory: ${fac.name || fac.factory_id} · ID: ${fac.factory_id} · Status: Damaged / uncertain`;
    } else if (fac && fac.deleted) {
      const deletedAt = fac.deletion?.deleted_at || "Unknown (not provided)";
      dom.factorySubtitle.textContent = `Factory: ${fac.name || fac.factory_id} · ID: ${fac.factory_id} · Current version: ${fac.current_version || "Unknown (not provided)"} · Deleted at ${deletedAt}`;
    } else {
      dom.factorySubtitle.textContent = fac
        ? `Factory: ${fac.name || fac.factory_id} · ID: ${fac.factory_id} · Current version: ${fac.current_version || "Unknown (not provided)"} · Management: ${fac.management || "Unknown (not provided)"}`
        : (state.selectedFactoryId
          ? `Factory ID: ${state.selectedFactoryId}`
          : "Select a factory from the sidebar or list to inspect its live graph and records.");
    }
  }
  if (dom.headerScope) {
    const scopeSuffix = fac?.damaged ? " · Damaged · Read-only" : (fac?.deleted ? " · Deleted · Read-only" : " · Read-only");
    dom.headerScope.textContent = facLabel ? `${facLabel}${scopeSuffix}` : "Read-only local dashboard";
  }
  for (const tab of dom.viewTabs) {
    const view = tab.dataset.view;
    const isCurrent = view === state.activeView;
    const rawHref = tabHrefForView(view);
    const href = rawHref ? safeHref(rawHref) : null;
    const available = Boolean(href);
    const parentLi = tab.parentNode && tab.parentNode.nodeType === 1 ? tab.parentNode : null;
    tab.classList.toggle("active", isCurrent);
    tab.classList.toggle("blue-grey-text", !available);
    tab.classList.toggle("text-lighten-2", !available);
    if (parentLi) parentLi.classList.toggle("disabled", !available);
    if (isCurrent) {
      tab.setAttribute("aria-current", "page");
    } else {
      tab.removeAttribute("aria-current");
    }
    if (available) {
      setAttrs(tab, { href }, SAFE_HTML_ATTRS);
      tab.removeAttribute("aria-disabled");
    } else {
      tab.removeAttribute("href");
      tab.setAttribute("aria-disabled", "true");
    }
  }
  updateTabIndicator();
}

let sidebarSecondaryBox = null;

function ensureSidebarSecondaryContainer() {
  const parent = dom.factoriesList?.parentNode;
  if (!parent) return null;
  if (!sidebarSecondaryBox || sidebarSecondaryBox.parentNode !== parent) {
    sidebarSecondaryBox = el("div", undefined, { class: "section" });
    parent.append(sidebarSecondaryBox);
  }
  return sidebarSecondaryBox;
}

function createSidebarFactoryItem(f, metaText, targetView) {
  const canLink = typeof f.factory_id === "string" && VALID_ID.test(f.factory_id);
  if (!canLink) {
    const box = el("div", undefined, { class: "collection-item grey-text text-darken-4" });
    const nameEl = el("div");
    nameEl.append(el("strong", f.name || f.factory_id || "Unknown factory"));
    box.append(nameEl);
    box.append(el("div", metaText, { class: "grey-text text-darken-3" }));
    return box;
  }
  const href = pageUrl({ factory: f.factory_id, view: targetView || "live" });
  const isSelected = f.factory_id === state.selectedFactoryId;
  const a = el("a", undefined, {
    href,
    class: isSelected
      ? "collection-item active teal darken-3 white-text"
      : "collection-item grey-text text-darken-4",
    ...(isSelected ? { "aria-current": "page" } : {}),
  });
  const nameEl = el("div");
  nameEl.append(el("strong", f.name || f.factory_id));
  a.append(nameEl);
  a.append(el("div", metaText, { class: isSelected ? "white-text" : "grey-text text-darken-3" }));
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (isNarrowViewport()) setDrawerOpen(false, "main");
    navigateToUrl(href, true);
  });
  return a;
}

function renderSidebarFactories() {
  if (!dom.factoriesList) return;
  dom.factoriesList.replaceChildren();
  const secondary = ensureSidebarSecondaryContainer();
  if (secondary) secondary.replaceChildren();
  if (state.factoriesStatus === "loading") {
    dom.factoriesList.setAttribute("aria-busy", "true");
    dom.factoriesList.append(el("div", "Loading factories...", { class: `collection-item ${toneClasses("muted")}` }));
    return;
  }
  dom.factoriesList.setAttribute("aria-busy", "false");
  if (state.factoriesStatus === "error" || state.factoriesError) {
    const err = state.factoriesError || { status: null, message: "Failed to load factories list.", detail: "" };
    const errBox = el("div", undefined, { class: `collection-item ${toneClasses("error")}`, role: "alert" });
    const head = el("div");
    head.append(el("span", err.status ? `! HTTP ${err.status}` : "! Error", { class: `chip ${toneClasses("error")}` }));
    head.append(el("strong", err.message || "Request failed"));
    errBox.append(head);
    if (err.detail) errBox.append(el("p", err.detail));
    dom.factoriesList.append(errBox);
    return;
  }
  const hasAny = state.factories.length > 0 || state.deletedFactories.length > 0 || state.damagedFactories.length > 0;
  if (!hasAny) {
    const item = el("div", undefined, { class: "collection-item" });
    item.append(absenceNode(state.factoriesAbsence || { absence: "no records", explanation: "No published factories." }));
    dom.factoriesList.append(item);
  } else if (!state.factories.length) {
    const item = el("div", undefined, { class: "collection-item" });
    item.append(absenceNode({ absence: "no records", explanation: "No active factories." }));
    dom.factoriesList.append(item);
  } else {
    for (const f of state.factories) {
      if (!f || typeof f.factory_id !== "string") continue;
      const mgmt = resolveSidebarManagementLabel(f.management);
      dom.factoriesList.append(createSidebarFactoryItem(f, `${f.current_version || "v?"} · ${mgmt} · ${f.factory_id}`, "live"));
    }
  }

  if (!secondary) return;
  if (state.damagedFactories.length > 0) {
    const dmgSec = el("section", undefined, { class: "section" });
    dmgSec.append(el("h3", `Damaged / uncertain (${state.damagedFactories.length})`, { class: "red-text text-darken-4" }));
    const dmgList = el("div", undefined, { class: "collection" });
    for (const f of state.damagedFactories) {
      if (!f || typeof f.factory_id !== "string") continue;
      dmgList.append(createSidebarFactoryItem(f, `! Damaged · ? Uncertain · ${f.factory_id}`, "inspect"));
    }
    dmgSec.append(dmgList);
    secondary.append(dmgSec);
  }

  const deletedDetails = el("details", undefined, {
    class: "collapsible",
    ...(state.deletedSectionOpen ? { open: true } : {}),
  });
  deletedDetails.addEventListener("toggle", () => {
    state.deletedSectionOpen = Boolean(deletedDetails.open);
  });
  deletedDetails.append(el("summary", `Deleted (${state.deletedFactories.length})`, { class: "collapsible-header grey-text text-darken-3" }));
  const delBody = el("div", undefined, { class: "collapsible-body" });
  if (!state.deletedFactories.length) {
    delBody.append(el("p", "No deleted factories.", { class: "grey-text text-darken-3" }));
  } else {
    const delList = el("div", undefined, { class: "collection" });
    for (const f of state.deletedFactories) {
      if (!f || typeof f.factory_id !== "string") continue;
      const deletedAt = f.deletion?.deleted_at || "Unknown time";
      delList.append(createSidebarFactoryItem(f, `${f.current_version || "v?"} · ⊗ Deleted (${deletedAt}) · ${f.factory_id}`, "live"));
    }
    delBody.append(delList);
  }
  deletedDetails.append(delBody);
  secondary.append(deletedDetails);
}

function formatDeletionBannerText(source) {
  const del = source?.deletion;
  const deletedAt = del?.deleted_at || source?.deleted_at || "Unknown (not provided)";
  const actor = del?.deleted_by?.pi_session_id
    ? ` by ${del.deleted_by.pi_session_id} (${del.deleted_by.incarnation_id})`
    : (del?.deleted_by?.incarnation_id ? ` by ${del.deleted_by.incarnation_id}` : "");
  return `Deleted at ${deletedAt}${actor}. History and retained versions remain readable; no mutations or new launches are permitted.`;
}

function renderDeletedBanner(source) {
  return banner("deleted", "Deleted", "This factory is permanently deleted", formatDeletionBannerText(source));
}

function appendDeletedBannerIfPresent(container, data, fallback) {
  const source = data?.deleted ? data : (fallback?.deleted ? fallback : null);
  if (source) container.append(renderDeletedBanner(source));
}

/* ---------- Pure DOM View Renderers ---------- */

function renderFactoriesView(container) {
  if (state.factoriesStatus === "loading") {
    container.append(el("p", "Loading factories..."));
    return;
  }
  if (state.factoriesStatus === "error" || state.factoriesError) {
    const err = state.factoriesError || { status: null, message: "Unable to load factories list", detail: "" };
    container.append(errorBanner(err.status, err.message || "Unable to load factories list", err.detail));
    return;
  }
  const hasAny = state.factories.length > 0 || state.deletedFactories.length > 0 || state.damagedFactories.length > 0;
  if (!hasAny) {
    if (state.factoriesAbsence) {
      container.append(banner(state.factoriesAbsence.absence, undefined, "No published factories", state.factoriesAbsence.explanation || "No factories are published in this configured state directory."));
    } else {
      container.append(banner("no records", "No records", "No published factories", "No factories are published in this configured state directory."));
    }
    return;
  }
  if (state.factories.length > 0) {
    const rows = state.factories.map((f) => {
      const href = pageUrl({ factory: f.factory_id, view: "live" });
      return [
        { asRowHeader: true, content: el("strong", f.name || f.factory_id) },
        el("code", f.factory_id),
        f.current_version || "Unknown (not provided)",
        statusPill(f.management),
        buildLink(`Open Live Graph for ${f.name || f.factory_id}`, href, "btn teal darken-3 white-text"),
      ];
    });
    container.append(buildTable("Published active factories in the configured state directory", ["Factory", "Factory ID", "Current version", "Management", "Live Graph"], rows));
  } else {
    container.append(banner("no records", "No active factories", "No active factories", "No active factories remain; see Damaged or Deleted sections below."));
  }

  if (state.damagedFactories.length > 0) {
    const dmgSec = el("section", undefined, { class: "card" });
    const dmgBody = el("div", undefined, { class: "card-content" });
    dmgBody.append(el("h3", "Damaged / uncertain factories", { class: "card-title" }));
    dmgBody.append(banner("unavailable", "Damaged", "Deletion evidence could not be verified for one or more factories", "Affected factories fail closed and are never shown as active."));
    const dmgRows = state.damagedFactories.map((f) => {
      const canOpen = typeof f.factory_id === "string" && VALID_ID.test(f.factory_id);
      return [
        { asRowHeader: true, content: el("strong", f.name || f.factory_id) },
        el("code", f.factory_id),
        statusPill("uncertain", "Damaged / uncertain"),
        f.explanation || "Deletion evidence is damaged.",
        canOpen
          ? buildLink(`Inspect ${f.name || f.factory_id}`, pageUrl({ factory: f.factory_id, view: "inspect" }), "btn-flat teal-text text-darken-3")
          : "—",
      ];
    });
    dmgBody.append(buildTable("Factories with damaged deletion evidence", ["Factory", "Factory ID", "Status", "Explanation", "Inspect"], dmgRows));
    dmgSec.append(dmgBody);
    container.append(dmgSec);
  }

  if (state.deletedFactories.length > 0) {
    const delSec = el("section", undefined, { class: "card" });
    const delBody = el("div", undefined, { class: "card-content" });
    delBody.append(el("h3", "Deleted factories", { class: "card-title" }));
    const delRows = state.deletedFactories.map((f) => {
      const href = pageUrl({ factory: f.factory_id, view: "live" });
      return [
        { asRowHeader: true, content: el("strong", f.name || f.factory_id) },
        el("code", f.factory_id),
        f.current_version || "Unknown (not provided)",
        statusPill("deleted"),
        f.deletion?.deleted_at || "Unknown (not provided)",
        buildLink(`Open deleted factory ${f.name || f.factory_id}`, href, "btn-flat teal-text text-darken-3"),
      ];
    });
    delBody.append(buildTable("Permanently retired (deleted) factories", ["Factory", "Factory ID", "Current version", "Status", "Deleted at", "Open"], delRows));
    delSec.append(delBody);
    container.append(delSec);
  }
}

function renderHeadStatusBlock(head) {
  if (!head || typeof head !== "object") return null;
  const wrap = el("section", undefined, { class: "card" });
  const body = el("div", undefined, { class: "card-content" });
  body.append(el("h3", "Queue head eligibility", { class: "card-title" }));
  const elig = resolveHeadEligibility(head);
  const facts = el("dl", undefined, { class: "row" });
  facts.append(
    factItem("Eligible to launch", statusPill(elig.eligibleStatus, elig.eligibleLabel)),
    factItem("Blocking kind", elig.blockingKind === "text" ? elig.blockingText : statusPill(elig.blockingStatus, elig.blockingLabel)),
    factItem("Head input", isAbsenceObject(head.input) ? absenceNode(head.input) : (head.input ? `${head.input.reference || head.input.input_id || "Unknown (not provided)"} (${head.input.bound_version || "Unknown (not provided)"})` : statusPill(undefined))),
  );
  body.append(facts);
  if (head.explanation) body.append(el("p", head.explanation));
  if (head.without_control_fence && typeof head.without_control_fence === "object") {
    body.append(el("p", `Without stop fence: ${head.without_control_fence.explanation || head.without_control_fence.blocking_kind || "Unknown (not provided)"}`, { class: "grey-text text-darken-3" }));
  }
  wrap.append(body);
  return wrap;
}

function renderNodeLinkOrAbsence(linkObj, labelPrefix) {
  if (!linkObj || typeof linkObj !== "object") return renderValue(linkObj);
  if (isAbsenceObject(linkObj)) return absenceNode(linkObj);
  if (typeof linkObj.href === "string" && typeof linkObj.node_id === "string") {
    const label = labelPrefix ? `${labelPrefix} (${linkObj.node_id} in ${linkObj.version || "bound"})` : linkObj.node_id;
    return buildLink(label, linkObj.href, "blue-text text-darken-3 mono");
  }
  return renderValue(linkObj);
}

function setAttrIfChanged(node, key, value) {
  if (key === "href" || (!SAFE_SVG_ATTRS.has(key) && !SAFE_HTML_ATTRS.has(key))) return;
  const str = value === true ? "" : String(value);
  if (node.getAttribute(key) !== str) {
    node.setAttribute(key, str);
  }
}

function setTextIfChanged(node, text) {
  const str = text === undefined || text === null ? "" : String(text);
  if (node.textContent !== str) {
    node.textContent = str;
  }
}

function createDetailState() {
  return {
    mode: null,
    nodeId: null,
    sigs: Object.create(null),
    headingEl: null,
    bodyPlaceholder: null,
    headerEl: null,
    reasonEl: null,
    factsDl: null,
    causesWrap: null,
    outputSec: null,
    outputBody: null,
    outputLoadedKey: "",
    outputFactoryId: "",
    outputNodeSnapshot: null,
    outputHasRendered: false,
    outputDisclosureOpen: new Map(),
    outputAttemptEntries: new Map(),
    outputTrackedDisclosures: new Map(),
    outputFocusTargets: new Map(),
    actionsEl: null,
    detailsEl: null,
    detailsDl: null,
  };
}

function resetDetailOutputState(ds) {
  ds.outputLoadedKey = "";
  ds.outputFactoryId = "";
  ds.outputNodeSnapshot = null;
  ds.outputHasRendered = false;
  ds.outputDisclosureOpen = new Map();
  ds.outputAttemptEntries = new Map();
  ds.outputTrackedDisclosures = new Map();
  ds.outputFocusTargets = new Map();
}

function abortOutputRequest() {
  state.outputRequestSeq++;
  if (state.outputController) {
    state.outputController.abort();
    state.outputController = null;
  }
}

function renderCommandOutputSection(cmd) {
  const cmdSec = el("div", undefined, { class: "section" });
  cmdSec.append(el("h6", "Command output"));
  const metaDl = el("dl", undefined, { class: "row" });
  metaDl.append(
    factItem("Exit code", cmd.exit_code === null || cmd.exit_code === undefined ? "null" : String(cmd.exit_code)),
    factItem("Signal", cmd.signal || "none"),
    factItem("Duration", cmd.duration_ms !== undefined ? `${cmd.duration_ms} ms` : "Unknown (not provided)"),
    factItem("Output bytes", `stdout ${cmd.stdout_bytes ?? 0} B, stderr ${cmd.stderr_bytes ?? 0} B`),
  );
  cmdSec.append(metaDl);
  if (cmd.spawn_error) {
    const errDiv = el("div", undefined, { class: "section" });
    errDiv.append(el("strong", "Spawn error"), el("div", cmd.spawn_error, { class: "output-text" }));
    cmdSec.append(errDiv);
  }
  if (cmd.termination_error) {
    const errDiv = el("div", undefined, { class: "section" });
    errDiv.append(el("strong", "Termination error"), el("div", cmd.termination_error, { class: "output-text" }));
    cmdSec.append(errDiv);
  }
  const streamsRow = el("div", undefined, { class: "row" });
  const outCol = el("div", undefined, { class: "col s12 m6" });
  outCol.append(el("strong", "Standard output"));
  outCol.append(typeof cmd.stdout_excerpt === "string" && cmd.stdout_excerpt.length > 0
    ? el("div", cmd.stdout_excerpt, { class: "output-text mono" })
    : el("p", "No standard output excerpt recorded.", { class: "grey-text text-darken-3" }));
  const errCol = el("div", undefined, { class: "col s12 m6" });
  errCol.append(el("strong", "Standard error"));
  errCol.append(typeof cmd.stderr_excerpt === "string" && cmd.stderr_excerpt.length > 0
    ? el("div", cmd.stderr_excerpt, { class: "output-text mono" })
    : el("p", "No standard error excerpt recorded.", { class: "grey-text text-darken-3" }));
  streamsRow.append(outCol, errCol);
  cmdSec.append(streamsRow);
  return cmdSec;
}

function renderBoundedTextListSection(title, listObj) {
  if (!listObj || !Array.isArray(listObj.items) || listObj.items.length === 0) return null;
  const sec = el("div", undefined, { class: "section" });
  sec.append(el("h6", title));
  const ul = el("ul", undefined, { class: "collection" });
  for (const item of listObj.items) {
    ul.append(el("li", item, { class: "collection-item output-text" }));
  }
  sec.append(ul);
  if (listObj.omitted_count > 0) {
    sec.append(el("p", listObj.omitted_marker || `… [truncated, ${listObj.omitted_count} items omitted]`, { class: "grey-text text-darken-3" }));
  }
  return sec;
}

function setDetailsOpen(detailsEl, shouldOpen) {
  if (!detailsEl) return;
  if (shouldOpen) {
    if (!detailsEl.hasAttribute("open")) detailsEl.setAttribute("open", "");
    if (!detailsEl.open) detailsEl.open = true;
  } else {
    if (detailsEl.hasAttribute("open")) detailsEl.removeAttribute("open");
    if (detailsEl.open) detailsEl.open = false;
  }
}

function getAttemptDisclosureKey(att, idx, seenKeys) {
  let baseKey;
  if (typeof att.attempt_id === "string" && att.attempt_id) {
    baseKey = `id:${att.attempt_id}`;
  } else if (typeof att.attempt_number === "number" && Number.isFinite(att.attempt_number)) {
    baseKey = `num:${att.attempt_number}`;
  } else {
    baseKey = `unverified:${idx}`;
  }
  let key = baseKey;
  if (seenKeys) {
    let dup = 1;
    while (seenKeys.has(key)) {
      key = `${baseKey}#${dup++}`;
    }
    seenKeys.add(key);
  }
  return key;
}

function syncOpenDisclosuresFromDom(ds) {
  if (!ds || !(ds.outputTrackedDisclosures instanceof Map)) return;
  for (const [key, detailsEl] of ds.outputTrackedDisclosures.entries()) {
    ds.outputDisclosureOpen.set(key, Boolean(detailsEl.open));
  }
}

function getFocusedOutputKey(slot, ds) {
  if (!slot || !ds || !(ds.outputFocusTargets instanceof Map)) return null;
  const active = document.activeElement;
  if (!active || !slot.contains(active)) return null;
  for (const [focusKey, targetEl] of ds.outputFocusTargets.entries()) {
    if (targetEl === active) return focusKey;
  }
  return typeof active.getAttribute === "function" ? active.getAttribute("data-focus-key") : null;
}

function upsertSubDisclosure(existingSub, subKey, focusKey, headingText, isOpen, bodySig, buildBodyNodes, nextTrackedDisclosures, nextFocusTargets) {
  let entry = existingSub;
  if (!entry) {
    const details = el("details", undefined, { class: "collapsible" });
    const headingEl = el("h6", headingText, { class: "inline" });
    const summaryEl = el("summary", undefined, { class: "collapsible-header", "data-focus-key": focusKey });
    summaryEl.append(headingEl);
    const body = el("div", undefined, { class: "collapsible-body" });
    body.append(...buildBodyNodes());
    details.append(summaryEl, body);
    entry = { details, summaryEl, headingEl, body, bodySig };
  } else {
    setTextIfChanged(entry.headingEl, headingText);
    if (entry.bodySig !== bodySig) {
      entry.body.replaceChildren(...buildBodyNodes());
      entry.bodySig = bodySig;
    }
  }
  setDetailsOpen(entry.details, isOpen);
  nextTrackedDisclosures.set(subKey, entry.details);
  nextFocusTargets.set(focusKey, entry.summaryEl);
  return entry;
}

function buildAttemptBodyNodes(att, attKey, ds, existingEntry, nextTrackedDisclosures, nextFocusTargets) {
  const nodes = [];
  let outputsEntry = null;
  let artifactsEntry = null;

  if (att.evidence === "available") {
    const facts = el("dl", undefined, { class: "row" });
    facts.append(
      factItem("Attempt ID", isAbsenceObject(att.attempt_id) ? absenceNode(att.attempt_id) : el("code", att.attempt_id)),
    );
    if (isAbsenceObject(att.attempt_number)) {
      facts.append(factItem("Attempt number", absenceNode(att.attempt_number)));
    }
    if (att.completed_at) facts.append(factItem("Completed at", att.completed_at));
    nodes.push(facts);

    const sumSec = el("div", undefined, { class: "section" });
    sumSec.append(el("h6", "Summary"));
    sumSec.append(att.summary
      ? el("div", att.summary, { class: "output-text" })
      : el("p", "No summary recorded.", { class: "grey-text text-darken-3" }));
    nodes.push(sumSec);

    const detSec = el("div", undefined, { class: "section" });
    detSec.append(el("h6", "Detail"));
    detSec.append(att.detail
      ? el("div", att.detail, { class: "output-text" })
      : el("p", "No detail recorded.", { class: "grey-text text-darken-3" }));
    nodes.push(detSec);

    if (att.command && typeof att.command === "object") {
      nodes.push(renderCommandOutputSection(att.command));
    }

    if (att.verification && Array.isArray(att.verification.items) && att.verification.items.length > 0) {
      const verSec = el("div", undefined, { class: "section" });
      verSec.append(el("h6", "Verification"));
      const verList = el("ul", undefined, { class: "collection" });
      for (const item of att.verification.items) {
        const li = el("li", undefined, { class: "collection-item" });
        const head = el("div");
        head.append(
          statusPill(item.result, item.result),
          document.createTextNode(" "),
          el("code", item.check_id || "unknown"),
          document.createTextNode(` · ${item.applicability || "unknown"} · ${item.scope_kind || "unknown"}`),
        );
        if (item.completed_at) head.append(document.createTextNode(` · ${item.completed_at}`));
        li.append(head);
        if (item.reason) li.append(el("div", item.reason, { class: "output-text" }));
        verList.append(li);
      }
      verSec.append(verList);
      if (att.verification.omitted_count > 0) {
        verSec.append(el("p", att.verification.omitted_marker || `… [truncated, ${att.verification.omitted_count} items omitted]`, { class: "grey-text text-darken-3" }));
      }
      nodes.push(verSec);
    }

    const warnSec = renderBoundedTextListSection("Warnings", att.warnings);
    if (warnSec) nodes.push(warnSec);

    const nextSec = renderBoundedTextListSection("Next steps", att.next_steps);
    if (nextSec) nodes.push(nextSec);

    if (typeof att.outputs_text === "string") {
      const outKey = `${attKey}:outputs`;
      const outFocusKey = `output:${outKey}`;
      const outOpen = ds?.outputDisclosureOpen?.has(outKey) ? Boolean(ds.outputDisclosureOpen.get(outKey)) : false;
      ds?.outputDisclosureOpen?.set(outKey, outOpen);
      outputsEntry = upsertSubDisclosure(
        existingEntry?.outputsEntry || null,
        outKey,
        outFocusKey,
        "Structured outputs",
        outOpen,
        att.outputs_text,
        () => [el("div", att.outputs_text, { class: "output-text mono" })],
        nextTrackedDisclosures,
        nextFocusTargets,
      );
      nodes.push(outputsEntry.details);
    }

    if (att.artifacts && Array.isArray(att.artifacts.items) && att.artifacts.items.length > 0) {
      const artKey = `${attKey}:artifacts`;
      const artFocusKey = `output:${artKey}`;
      const artOpen = ds?.outputDisclosureOpen?.has(artKey) ? Boolean(ds.outputDisclosureOpen.get(artKey)) : false;
      ds?.outputDisclosureOpen?.set(artKey, artOpen);
      const artCount = att.artifacts.total_count ?? att.artifacts.items.length;
      const artSig = JSON.stringify(att.artifacts);
      artifactsEntry = upsertSubDisclosure(
        existingEntry?.artifactsEntry || null,
        artKey,
        artFocusKey,
        `Artifacts (${artCount})`,
        artOpen,
        artSig,
        () => {
          const artList = el("ul", undefined, { class: "collection" });
          for (const art of att.artifacts.items) {
            const li = el("li", undefined, { class: "collection-item" });
            const head = el("div");
            const label = art.action ? `${art.type || "artifact"} (${art.action})` : (art.type || "artifact");
            head.append(el("strong", label));
            if (art.missing) {
              head.append(document.createTextNode(" "), statusPill("unavailable", "Missing"));
            }
            li.append(head);
            li.append(art.description
              ? el("div", art.description, { class: "output-text" })
              : el("p", "No description recorded.", { class: "grey-text text-darken-3" }));
            artList.append(li);
          }
          const bodyNodes = [artList];
          if (att.artifacts.omitted_count > 0) {
            bodyNodes.push(el("p", att.artifacts.omitted_marker || `… [truncated, ${att.artifacts.omitted_count} items omitted]`, { class: "grey-text text-darken-3" }));
          }
          return bodyNodes;
        },
        nextTrackedDisclosures,
        nextFocusTargets,
      );
      nodes.push(artifactsEntry.details);
    }

    if (typeof att.omitted_characters === "number" && att.omitted_characters > 0) {
      nodes.push(el("p", `… [truncated, ${att.omitted_characters} character${att.omitted_characters === 1 ? "" : "s"} omitted]`, { class: "grey-text text-darken-3" }));
    }
  } else {
    nodes.push(absenceNode(att));
    if (isAbsenceObject(att.attempt_number)) {
      const facts = el("dl", undefined, { class: "row" });
      facts.append(factItem("Attempt number", absenceNode(att.attempt_number)));
      nodes.push(facts);
    }
    if (att.disposition_reason) {
      const dispSec = el("div", undefined, { class: "section" });
      dispSec.append(el("h6", "Disposition reason"));
      dispSec.append(el("div", att.disposition_reason, { class: "output-text" }));
      nodes.push(dispSec);
    }
    if (att.error_message) {
      const errSec = el("div", undefined, { class: "section" });
      errSec.append(el("h6", "Recorded error"));
      errSec.append(el("div", att.error_message, { class: "output-text" }));
      nodes.push(errSec);
    }
    if (att.causes && Array.isArray(att.causes.items) && att.causes.items.length > 0) {
      const causesSec = el("div", undefined, { class: "section" });
      causesSec.append(el("h6", "Causes"));
      causesSec.append(buildTable(
        "Attempt causes",
        ["Source node", "State", "Reason", "Check"],
        att.causes.items.map((c) => [
          el("code", c.node_id),
          statusPill(c.state),
          el("div", c.reason, { class: "output-text" }),
          c.check ? `${c.check.name} (${c.check.evidence})` : "—",
        ]),
      ));
      if (att.causes.omitted_count > 0) {
        causesSec.append(el("p", att.causes.omitted_marker || `… [truncated, ${att.causes.omitted_count} items omitted]`, { class: "grey-text text-darken-3" }));
      }
      nodes.push(causesSec);
    }
    if (att.command && typeof att.command === "object") {
      nodes.push(renderCommandOutputSection(att.command));
    }
    if (typeof att.omitted_characters === "number" && att.omitted_characters > 0) {
      nodes.push(el("p", `… [truncated, ${att.omitted_characters} character${att.omitted_characters === 1 ? "" : "s"} omitted]`, { class: "grey-text text-darken-3" }));
    }
  }
  return { nodes, outputsEntry, artifactsEntry };
}

function upsertAttemptDisclosure(att, attKey, isOpen, ds, existingEntry, nextTrackedDisclosures, nextFocusTargets) {
  const attemptHeading = typeof att.attempt_number === "number"
    ? `Attempt ${att.attempt_number} of ${att.max_attempts ?? "?"}`
    : `Attempt (number unverified) of ${att.max_attempts ?? "?"}`;
  const statusLabel = att.status_text || att.status;
  const summarySig = JSON.stringify([attemptHeading, att.status, statusLabel]);
  const bodySig = JSON.stringify(att);
  const focusKey = `output:${attKey}`;

  let entry = existingEntry;
  if (!entry) {
    const details = el("details", undefined, { class: "collapsible" });
    const summaryEl = el("summary", undefined, { class: "collapsible-header", "data-focus-key": focusKey });
    summaryEl.append(
      el("h5", attemptHeading, { class: "inline" }),
      document.createTextNode(" "),
      statusPill(att.status, statusLabel),
    );
    const body = el("div", undefined, { class: "collapsible-body" });
    const built = buildAttemptBodyNodes(att, attKey, ds, null, nextTrackedDisclosures, nextFocusTargets);
    body.append(...built.nodes);
    details.append(summaryEl, body);
    entry = {
      details,
      summaryEl,
      body,
      summarySig,
      bodySig,
      outputsEntry: built.outputsEntry,
      artifactsEntry: built.artifactsEntry,
    };
  } else {
    if (entry.summarySig !== summarySig) {
      entry.summaryEl.replaceChildren(
        el("h5", attemptHeading, { class: "inline" }),
        document.createTextNode(" "),
        statusPill(att.status, statusLabel),
      );
      entry.summarySig = summarySig;
    }
    if (entry.bodySig !== bodySig) {
      const built = buildAttemptBodyNodes(att, attKey, ds, entry, nextTrackedDisclosures, nextFocusTargets);
      entry.body.replaceChildren(...built.nodes);
      entry.bodySig = bodySig;
      entry.outputsEntry = built.outputsEntry;
      entry.artifactsEntry = built.artifactsEntry;
    } else {
      if (entry.outputsEntry) {
        const outKey = `${attKey}:outputs`;
        const outFocusKey = `output:${outKey}`;
        const outOpen = ds?.outputDisclosureOpen?.has(outKey) ? Boolean(ds.outputDisclosureOpen.get(outKey)) : false;
        setDetailsOpen(entry.outputsEntry.details, outOpen);
        nextTrackedDisclosures.set(outKey, entry.outputsEntry.details);
        nextFocusTargets.set(outFocusKey, entry.outputsEntry.summaryEl);
      }
      if (entry.artifactsEntry) {
        const artKey = `${attKey}:artifacts`;
        const artFocusKey = `output:${artKey}`;
        const artOpen = ds?.outputDisclosureOpen?.has(artKey) ? Boolean(ds.outputDisclosureOpen.get(artKey)) : false;
        setDetailsOpen(entry.artifactsEntry.details, artOpen);
        nextTrackedDisclosures.set(artKey, entry.artifactsEntry.details);
        nextFocusTargets.set(artFocusKey, entry.artifactsEntry.summaryEl);
      }
    }
  }
  setDetailsOpen(entry.details, isOpen);
  nextTrackedDisclosures.set(attKey, entry.details);
  nextFocusTargets.set(focusKey, entry.summaryEl);
  return entry;
}

function reconcileSlotChildren(slot, targetNodes) {
  const targetSet = new Set(targetNodes);
  for (const child of Array.from(slot.children)) {
    if (!targetSet.has(child)) {
      child.remove();
    }
  }
  for (let i = 0; i < targetNodes.length; i++) {
    const want = targetNodes[i];
    const cur = slot.children[i] || null;
    if (cur !== want) {
      slot.insertBefore(want, cur);
    }
  }
}

function renderAttemptOutputBody(slot, data, errorInfo, ds) {
  syncOpenDisclosuresFromDom(ds);
  const focusedKey = getFocusedOutputKey(slot, ds);
  slot.setAttribute("aria-busy", "false");
  if (ds) ds.outputHasRendered = true;

  const clearRenderedEntries = () => {
    if (!ds) return;
    ds.outputAttemptEntries = new Map();
    ds.outputTrackedDisclosures = new Map();
    ds.outputFocusTargets = new Map();
  };

  if (errorInfo) {
    clearRenderedEntries();
    slot.replaceChildren(errorBanner(errorInfo.status, errorInfo.message, errorInfo.detail));
    return;
  }
  if (!data || typeof data !== "object") {
    clearRenderedEntries();
    slot.replaceChildren(absenceNode({ absence: "evidence unavailable", explanation: "Attempt output response was empty or invalid." }));
    return;
  }
  const attempts = Array.isArray(data.attempts)
    ? data.attempts.filter((a) => a && typeof a === "object")
    : (data.latest_attempt && typeof data.latest_attempt === "object" ? [data.latest_attempt] : []);
  if (attempts.length === 0) {
    clearRenderedEntries();
    slot.replaceChildren(absenceNode(isAbsenceObject(data)
      ? data
      : { absence: "evidence unavailable", explanation: data.explanation || "Attempt output evidence is unavailable." }));
    return;
  }

  const seenKeys = new Set();
  const nextAttemptEntries = new Map();
  const nextTrackedDisclosures = new Map();
  const nextFocusTargets = new Map();
  const nodes = [];

  attempts.forEach((att, idx) => {
    const attKey = getAttemptDisclosureKey(att, idx, seenKeys);
    const isOpen = ds?.outputDisclosureOpen?.has(attKey)
      ? Boolean(ds.outputDisclosureOpen.get(attKey))
      : idx === 0;
    ds?.outputDisclosureOpen?.set(attKey, isOpen);
    const existingEntry = ds?.outputAttemptEntries?.get(attKey) || null;
    const entry = upsertAttemptDisclosure(att, attKey, isOpen, ds, existingEntry, nextTrackedDisclosures, nextFocusTargets);
    nextAttemptEntries.set(attKey, entry);
    nodes.push(entry.details);
  });

  if (isAbsenceObject(data.total_attempts)) {
    const totalWrap = el("p");
    totalWrap.append(absenceNode(data.total_attempts));
    nodes.push(totalWrap);
  }
  if (typeof data.omitted_attempts === "number" && data.omitted_attempts > 0) {
    nodes.push(el("p", data.omitted_marker || `… [truncated, ${data.omitted_attempts} attempt${data.omitted_attempts === 1 ? "" : "s"} omitted]`, { class: "grey-text text-darken-3" }));
  }

  if (ds) {
    ds.outputAttemptEntries = nextAttemptEntries;
    ds.outputTrackedDisclosures = nextTrackedDisclosures;
    ds.outputFocusTargets = nextFocusTargets;
  }
  reconcileSlotChildren(slot, nodes);

  if (focusedKey && ds?.outputFocusTargets?.has(focusedKey)) {
    const focusTarget = ds.outputFocusTargets.get(focusedKey);
    if (focusTarget && document.activeElement !== focusTarget) {
      focusTarget.focus();
    }
  }
}

async function requestNodeOutput(factoryId, nodeId, ds, nodeSnapshot) {
  abortOutputRequest();
  const slot = ds.outputBody;
  if (!slot) return;
  const outputKey = `${factoryId}\u0000${nodeId}`;
  ds.outputLoadedKey = "";
  ds.outputFactoryId = factoryId;
  ds.outputNodeSnapshot = nodeSnapshot || null;
  const url = outputApiUrl(factoryId, nodeId);
  if (!url) {
    renderAttemptOutputBody(slot, null, {
      status: null,
      message: "Invalid factory or node identifier",
      detail: "Unable to request attempt output without valid identifiers.",
    }, ds);
    ds.outputLoadedKey = outputKey;
    return;
  }
  const seq = ++state.outputRequestSeq;
  const controller = new AbortController();
  state.outputController = controller;
  slot.setAttribute("aria-busy", "true");
  if (!ds.outputHasRendered) {
    slot.replaceChildren(el("p", "Loading attempt output…"));
  }
  try {
    const data = await fetchJsonStrict(url, controller.signal);
    if (seq !== state.outputRequestSeq || factoryId !== state.selectedFactoryId || nodeId !== state.selectedGraphNodeId || state.activeView !== "live") return;
    if (!matchesSelectedOutputTarget(data, factoryId, nodeId)) {
      const gotFactory = data && typeof data === "object" && typeof data.factory_id === "string" ? data.factory_id : "missing";
      const gotNode = data && typeof data === "object" && typeof data.node_id === "string" ? data.node_id : "missing";
      renderAttemptOutputBody(slot, null, {
        status: null,
        message: "Output response did not match the selected node",
        detail: `Expected factory "${factoryId}" node "${nodeId}" but received "${gotFactory}" / "${gotNode}".`,
      }, ds);
      ds.outputLoadedKey = outputKey;
      return;
    }
    renderAttemptOutputBody(slot, data, null, ds);
    ds.outputLoadedKey = outputKey;
  } catch (err) {
    if (err && err.name === "AbortError") return;
    if (seq !== state.outputRequestSeq || factoryId !== state.selectedFactoryId || nodeId !== state.selectedGraphNodeId || state.activeView !== "live") return;
    renderAttemptOutputBody(slot, null, {
      status: err?.status || null,
      message: err?.message || "Failed to load attempt output",
      detail: err?.detail || "Unable to fetch attempt output from the local viewer.",
    }, ds);
    ds.outputLoadedKey = outputKey;
  } finally {
    if (seq === state.outputRequestSeq && state.outputController === controller) {
      state.outputController = null;
    }
  }
}

function buildDetailHeaderNodes(node) {
  const nodes = [
    el("strong", node.id, { class: "mono" }),
    statusPill(node.status, node.status_text || node.status),
  ];
  if (node.kind) nodes.push(el("span", node.kind, { class: `chip ${toneClasses("muted")}` }));
  if (node.parked) nodes.push(el("span", "◷ Parked", { class: `chip ${toneClasses("warn")}` }));
  return nodes;
}

function buildDetailFactNodes(node, att) {
  const items = [];
  if (att) {
    items.push(
      factItem("Attempt ID", isAbsenceObject(att.attempt_id) ? absenceNode(att.attempt_id) : el("code", att.attempt_id)),
      factItem("Attempt count", `${att.attempt_number ?? "?"} of ${att.max_attempts ?? "?"}`),
      factItem("Instance ID", el("code", att.instance_id)),
      factItem("Process state", att.process_state),
      factItem("Resource state", att.resource_state),
    );
    if (att.result_status) items.push(factItem("Result status", att.result_status));
    if (att.summary) items.push(factItem("Summary", att.summary));
    if (att.command) {
      items.push(factItem("Command outcome", `exit=${att.command.exit_code ?? "null"}, signal=${att.command.signal ?? "none"}, duration=${att.command.duration_ms}ms`));
    }
    if (Array.isArray(att.waiting_on) && att.waiting_on.length) {
      items.push(factItem("Waiting on", att.waiting_on.join(", ")));
    }
    if (att.loop) {
      items.push(factItem("Review loop", `attempt ${att.loop.attempt}/${att.loop.max_attempts} · ${att.loop.finalized ? "finalized" : "not finalized"}${att.loop.last_verdict ? ` · last verdict: ${att.loop.last_verdict}` : ""}`));
    }
  }
  if (node.join) {
    items.push(factItem("Join policy", `${node.join.policy} (${(node.join.sources || []).join(", ")})`));
  }
  return items;
}

function buildTimestampFactNodes(att) {
  const items = [];
  if (att.started_at) items.push(factItem("Started at", att.started_at));
  if (att.updated_at) items.push(factItem("Updated at", att.updated_at));
  if (att.completed_at) items.push(factItem("Completed at", att.completed_at));
  if (att.waiting_for_human_since) items.push(factItem("Waiting for human since", att.waiting_for_human_since));
  return items;
}

function patchLiveNodeDetail(detailEl, node, boundVersion, detailState) {
  const ds = detailState || createDetailState();
  if (!ds.headingEl) {
    ds.headingEl = el("h3", "Selected node", { class: "card-title" });
    detailEl.replaceChildren(ds.headingEl);
  }
  if (!node) {
    if (ds.mode !== "empty") {
      abortOutputRequest();
      detailEl.replaceChildren(ds.headingEl);
      ds.bodyPlaceholder = el("p", "Select a node in the graph (click or press Enter/Space on a focused node) to inspect its current attempt and version-bound configuration.");
      detailEl.append(ds.bodyPlaceholder);
      ds.mode = "empty";
      ds.nodeId = null;
      ds.sigs = Object.create(null);
      ds.headerEl = null;
      ds.reasonEl = null;
      ds.factsDl = null;
      ds.causesWrap = null;
      ds.outputSec = null;
      ds.outputBody = null;
      resetDetailOutputState(ds);
      ds.actionsEl = null;
      ds.detailsEl = null;
      ds.detailsDl = null;
    }
    return ds;
  }

  const att = node.current_attempt && typeof node.current_attempt === "object" ? node.current_attempt : null;
  const cfgLink = node.configuration_link || (node.configuration_url ? { href: node.configuration_url, node_id: node.id, version: boundVersion } : null);
  const hasTimestamps = Boolean(att && (att.started_at || att.updated_at || att.completed_at || att.waiting_for_human_since));
  const nextSigs = {
    header: JSON.stringify([node.id, node.status, node.status_text, node.kind, Boolean(node.parked)]),
    reason: typeof node.reason === "string" ? node.reason : "",
    facts: JSON.stringify({
      att: att ? {
        id: att.attempt_id,
        n: att.attempt_number,
        max: att.max_attempts,
        inst: att.instance_id,
        ps: att.process_state,
        rs: att.resource_state,
        res: att.result_status,
        sum: att.summary,
        cmd: att.command,
        wo: att.waiting_on,
        loop: att.loop,
      } : null,
      join: node.join || null,
    }),
    causes: att && Array.isArray(att.causes) && att.causes.length ? JSON.stringify(att.causes) : "",
    actions: JSON.stringify(cfgLink ? { cfgLink, bv: boundVersion } : null),
    timestamps: hasTimestamps ? JSON.stringify([att.started_at, att.updated_at, att.completed_at, att.waiting_for_human_since]) : "",
  };

  if (ds.mode !== "node" || ds.nodeId !== node.id) {
    ds.mode = "node";
    ds.nodeId = node.id;
    ds.sigs = nextSigs;
    ds.bodyPlaceholder = null;
    ds.headerEl = el("div");
    ds.headerEl.append(...buildDetailHeaderNodes(node));
    ds.reasonEl = nextSigs.reason ? el("p", nextSigs.reason) : null;
    ds.factsDl = el("dl", undefined, { class: "row" });
    ds.factsDl.append(...buildDetailFactNodes(node, att));
    ds.causesWrap = nextSigs.causes
      ? buildTable("Node blocker/failure causes", ["Source node", "State", "Reason", "Check"], att.causes.map((c) => [
        el("code", c.node_id),
        statusPill(c.state),
        c.reason,
        c.check ? `${c.check.name} (${c.check.evidence})` : "—",
      ]))
      : null;
    ds.outputSec = el("section", undefined, { class: "card" });
    const outputCardBody = el("div", undefined, { class: "card-content" });
    outputCardBody.append(el("h4", "Attempt output", { class: "card-title" }));
    ds.outputBody = el("div", undefined, { "aria-busy": "false" });
    outputCardBody.append(ds.outputBody);
    ds.outputSec.append(outputCardBody);
    resetDetailOutputState(ds);
    ds.actionsEl = el("div", undefined, { class: "section" });
    if (cfgLink && isAbsenceObject(cfgLink)) {
      ds.actionsEl.append(absenceNode(cfgLink));
    } else if (cfgLink && typeof cfgLink.href === "string") {
      ds.actionsEl.append(buildLink(`View configuration for ${node.id} in ${cfgLink.version || boundVersion || "bound version"}`, cfgLink.href, "btn teal darken-3 white-text"));
    }
    if (hasTimestamps) {
      ds.detailsEl = el("details", undefined, { class: "collapsible" });
      ds.detailsEl.append(el("summary", "Optional attempt timestamps", { class: "collapsible-header" }));
      const tsBody = el("div", undefined, { class: "collapsible-body" });
      ds.detailsDl = el("dl", undefined, { class: "row" });
      ds.detailsDl.append(...buildTimestampFactNodes(att));
      tsBody.append(ds.detailsDl);
      ds.detailsEl.append(tsBody);
    } else {
      ds.detailsEl = null;
      ds.detailsDl = null;
    }
    const children = [ds.headingEl, ds.headerEl];
    if (ds.reasonEl) children.push(ds.reasonEl);
    children.push(ds.factsDl);
    if (ds.causesWrap) children.push(ds.causesWrap);
    children.push(ds.outputSec);
    children.push(ds.actionsEl);
    if (ds.detailsEl) children.push(ds.detailsEl);
    detailEl.replaceChildren(...children);
    void requestNodeOutput(state.selectedFactoryId, node.id, ds, node);
    return ds;
  }

  if (nextSigs.header !== ds.sigs.header) {
    ds.headerEl.replaceChildren(...buildDetailHeaderNodes(node));
  }
  if (nextSigs.reason !== ds.sigs.reason) {
    if (nextSigs.reason) {
      if (ds.reasonEl) {
        setTextIfChanged(ds.reasonEl, nextSigs.reason);
      } else {
        ds.reasonEl = el("p", nextSigs.reason);
        detailEl.insertBefore(ds.reasonEl, ds.factsDl);
      }
    } else if (ds.reasonEl) {
      ds.reasonEl.remove();
      ds.reasonEl = null;
    }
  }
  if (nextSigs.facts !== ds.sigs.facts) {
    ds.factsDl.replaceChildren(...buildDetailFactNodes(node, att));
  }
  if (nextSigs.causes !== ds.sigs.causes) {
    if (ds.causesWrap) {
      ds.causesWrap.remove();
      ds.causesWrap = null;
    }
    if (nextSigs.causes) {
      ds.causesWrap = buildTable("Node blocker/failure causes", ["Source node", "State", "Reason", "Check"], att.causes.map((c) => [
        el("code", c.node_id),
        statusPill(c.state),
        c.reason,
        c.check ? `${c.check.name} (${c.check.evidence})` : "—",
      ]));
      detailEl.insertBefore(ds.causesWrap, ds.outputSec || ds.actionsEl);
    }
  }
  if (nextSigs.actions !== ds.sigs.actions) {
    ds.actionsEl.replaceChildren();
    if (cfgLink && isAbsenceObject(cfgLink)) {
      ds.actionsEl.append(absenceNode(cfgLink));
    } else if (cfgLink && typeof cfgLink.href === "string") {
      ds.actionsEl.append(buildLink(`View configuration for ${node.id} in ${cfgLink.version || boundVersion || "bound version"}`, cfgLink.href, "btn teal darken-3 white-text"));
    }
  }
  if (nextSigs.timestamps !== ds.sigs.timestamps) {
    if (hasTimestamps) {
      if (ds.detailsEl && ds.detailsDl) {
        ds.detailsDl.replaceChildren(...buildTimestampFactNodes(att));
      } else {
        if (ds.detailsEl) ds.detailsEl.remove();
        ds.detailsEl = el("details", undefined, { class: "collapsible" });
        ds.detailsEl.append(el("summary", "Optional attempt timestamps", { class: "collapsible-header" }));
        const tsBody = el("div", undefined, { class: "collapsible-body" });
        ds.detailsDl = el("dl", undefined, { class: "row" });
        ds.detailsDl.append(...buildTimestampFactNodes(att));
        tsBody.append(ds.detailsDl);
        ds.detailsEl.append(tsBody);
        detailEl.append(ds.detailsEl);
      }
    } else if (ds.detailsEl) {
      ds.detailsEl.remove();
      ds.detailsEl = null;
      ds.detailsDl = null;
    }
  }
  ds.sigs = nextSigs;
  const outputKey = `${state.selectedFactoryId}\u0000${node.id}`;
  const needsRefetch = shouldRefetchNodeOutput(ds.outputNodeSnapshot, node, {
    prevFactoryId: ds.outputFactoryId,
    nextFactoryId: state.selectedFactoryId,
  });
  if (needsRefetch || (ds.outputLoadedKey !== outputKey && !state.outputController)) {
    void requestNodeOutput(state.selectedFactoryId, node.id, ds, node);
  }
  return ds;
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

function buildKeyedEdges(edges) {
  const seen = new Map();
  return edges.map((edge) => {
    const base = edge.kind === "feedback"
      ? `fb:${edge.from}\u0000${edge.to}\u0000${edge.field ?? ""}`
      : `dep:${edge.from}\u0000${edge.to}\u0000${edge.dependency_policy ?? ""}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}#${count}`, edge };
  });
}

function computeEdgeRenderData(edge, idx, positions) {
  const a = positions.get(edge.from);
  const b = positions.get(edge.to);
  if (!a || !b) return null;
  if (edge.kind === "feedback") {
    const startX = a.x + a.w / 2;
    const startY = a.y + a.h;
    const endX = b.x + b.w / 2;
    const endY = b.y + b.h;
    const arcY = Math.max(startY, endY) + 46 + (idx % 2) * 18;
    const mx = (startX + endX) / 2;
    const my = arcY - 6;
    const lblText = `feedback (${edge.reject || "reject"} -> ${edge.to}, max ${edge.max_revisions ?? "?"})`;
    const lblW = Math.min(260, lblText.length * 6.5 + 14);
    return {
      pathClass: "edge-feedback",
      d: `M ${startX} ${startY} C ${startX} ${arcY}, ${endX} ${arcY}, ${endX} ${endY}`,
      markerEnd: "url(#arrow-feedback)",
      bgX: mx - lblW / 2,
      bgY: my - 11,
      bgW: lblW,
      bgH: 16,
      textX: mx,
      textY: my + 1,
      lblText,
    };
  }
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const cx1 = x1 + (x2 - x1) * 0.45;
  const cx2 = x2 - (x2 - x1) * 0.45;
  const pol = edge.dependency_policy === "require_success"
    ? "require"
    : (edge.dependency_policy === "allow_partial" ? "partial" : "unknown");
  const st = edge.state || "unknown";
  const lblText = `${st} (${pol})`;
  const lblW = lblText.length * 6.2 + 12;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 - 8;
  return {
    pathClass: `edge-dep ${pol === "partial" ? "edge-allow-partial" : ""} edge-${st}`,
    d: `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`,
    markerEnd: pol === "partial" ? "url(#arrow-partial)" : "url(#arrow-solid)",
    bgX: mx - lblW / 2,
    bgY: my - 11,
    bgW: lblW,
    bgH: 15,
    textX: mx,
    textY: my,
    lblText,
  };
}

function createGraphController(initialGraph, detailEl, initialBoundVersion) {
  let currentBoundVersion = initialGraph.bound_version || initialBoundVersion;
  let initialLayout = layoutGraphNodes(
    Array.isArray(initialGraph.nodes) ? initialGraph.nodes : [],
    Array.isArray(initialGraph.edges) ? initialGraph.edges : [],
  );
  let initialBox = { x: 0, y: 0, width: initialLayout.width, height: initialLayout.height };
  let viewBox = { ...initialBox };
  const detailState = createDetailState();

  const wrapper = el("section", undefined, { class: "card" });
  const cardBody = el("div", undefined, { class: "card-content" });
  const heading = el("h3", `Run graph topology (${initialGraph.topology || "unknown"}, bound ${currentBoundVersion || "unknown"})`, { class: "card-title" });
  cardBody.append(heading);

  const legend = el("div", undefined, { class: "row grey-text text-darken-3" });
  legend.append(
    el("div", "Dependency (require_success): solid line + filled arrow", { class: "col s12 m6" }),
    el("div", "Dependency (allow_partial): dashed line + hollow arrow", { class: "col s12 m6" }),
    el("div", "Feedback edge: dotted-dashed loop arc + diamond arrow", { class: "col s12 m6" }),
    el("div", "Join node: [JOIN] badge + multiple inbound edges", { class: "col s12 m6" }),
  );
  cardBody.append(legend);

  const stage = el("div", undefined, { class: "section" });
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

  const toolbar = el("div", undefined, { class: "section", role: "toolbar", "aria-label": "Graph zoom and pan controls" });
  const btnIn = el("button", "Zoom in (+)", { type: "button", class: "btn-flat teal-text text-darken-3" });
  const btnOut = el("button", "Zoom out (-)", { type: "button", class: "btn-flat teal-text text-darken-3" });
  const btnReset = el("button", "Reset (0)", { type: "button", class: "btn-flat teal-text text-darken-3" });
  const btnLeft = el("button", "Pan left", { type: "button", class: "btn-flat teal-text text-darken-3" });
  const btnRight = el("button", "Pan right", { type: "button", class: "btn-flat teal-text text-darken-3" });
  const btnUp = el("button", "Pan up", { type: "button", class: "btn-flat teal-text text-darken-3" });
  const btnDown = el("button", "Pan down", { type: "button", class: "btn-flat teal-text text-darken-3" });
  btnIn.addEventListener("click", () => zoomBy(0.8));
  btnOut.addEventListener("click", () => zoomBy(1.25));
  btnReset.addEventListener("click", resetBox);
  btnLeft.addEventListener("click", () => panBy(-60, 0));
  btnRight.addEventListener("click", () => panBy(60, 0));
  btnUp.addEventListener("click", () => panBy(0, -60));
  btnDown.addEventListener("click", () => panBy(0, 60));
  toolbar.append(
    btnIn,
    document.createTextNode(" "),
    btnOut,
    document.createTextNode(" "),
    btnReset,
    document.createTextNode(" "),
    btnLeft,
    document.createTextNode(" "),
    btnUp,
    document.createTextNode(" "),
    btnDown,
    document.createTextNode(" "),
    btnRight,
  );
  cardBody.append(toolbar);

  const defs = svgEl("defs");
  const mSolid = svgEl("marker", { id: "arrow-solid", markerWidth: "10", markerHeight: "10", refX: "9", refY: "5", orient: "auto", markerUnits: "userSpaceOnUse" });
  mSolid.append(svgEl("path", { d: "M0,1 L9,5 L0,9 Z", fill: "#455a64" }));
  const mPartial = svgEl("marker", { id: "arrow-partial", markerWidth: "10", markerHeight: "10", refX: "9", refY: "5", orient: "auto", markerUnits: "userSpaceOnUse" });
  mPartial.append(svgEl("path", { d: "M1,1 L9,5 L1,9 Z", fill: "#ffffff", stroke: "#455a64", "stroke-width": "1.5" }));
  const mFeedback = svgEl("marker", { id: "arrow-feedback", markerWidth: "10", markerHeight: "10", refX: "9", refY: "5", orient: "auto", markerUnits: "userSpaceOnUse" });
  mFeedback.append(svgEl("path", { d: "M0,5 L5,1 L10,5 L5,9 Z", fill: "#bf360c" }));
  defs.append(mSolid, mPartial, mFeedback);

  const edgesLayer = svgEl("g", { class: "graph-edges-layer" });
  const nodesLayer = svgEl("g", { class: "graph-nodes-layer" });
  svg.append(defs, edgesLayer, nodesLayer);

  const edgeEntries = new Map();
  const nodeEntries = new Map();
  let edgeOrder = [];
  let nodeOrder = [];

  function selectNodeById(nodeId) {
    state.selectedGraphNodeId = nodeId;
    for (const [id, entry] of nodeEntries.entries()) {
      const active = id === nodeId;
      entry.g.classList.toggle("selected", active);
      setAttrIfChanged(entry.g, "aria-pressed", active ? "true" : "false");
    }
    const target = nodeEntries.get(nodeId)?.nodeData || null;
    patchLiveNodeDetail(detailEl, target, currentBoundVersion, detailState);
  }

  function createEdgeEntry(key, renderData) {
    const g = svgEl("g", { "data-edge-key": key });
    const path = svgEl("path", {
      class: renderData.pathClass,
      d: renderData.d,
      "marker-end": renderData.markerEnd,
    });
    const bg = svgEl("rect", {
      class: "edge-label-bg",
      x: renderData.bgX,
      y: renderData.bgY,
      width: renderData.bgW,
      height: renderData.bgH,
      rx: 3,
    });
    const text = svgEl("text", {
      class: "edge-label-text",
      x: renderData.textX,
      y: renderData.textY,
    }, renderData.lblText);
    g.append(path, bg, text);
    return { g, path, bg, text };
  }

  function updateEdgeEntry(entry, renderData) {
    setAttrIfChanged(entry.path, "class", renderData.pathClass);
    setAttrIfChanged(entry.path, "d", renderData.d);
    setAttrIfChanged(entry.path, "marker-end", renderData.markerEnd);
    setAttrIfChanged(entry.bg, "x", renderData.bgX);
    setAttrIfChanged(entry.bg, "y", renderData.bgY);
    setAttrIfChanged(entry.bg, "width", renderData.bgW);
    setAttrIfChanged(entry.bg, "height", renderData.bgH);
    setAttrIfChanged(entry.text, "x", renderData.textX);
    setAttrIfChanged(entry.text, "y", renderData.textY);
    setTextIfChanged(entry.text, renderData.lblText);
  }

  function buildNodeAttrsAndText(n, pos) {
    const meta = resolveStatusMeta(n.status, n.status_text || undefined);
    const statusLabel = meta.label;
    const isSelected = state.selectedGraphNodeId === n.id;
    return {
      gClass: `graph-node status-${n.status || "unknown"}${isSelected ? " selected" : ""}`,
      ariaPressed: isSelected ? "true" : "false",
      ariaLabel: `${n.id}${n.join ? " (join)" : ""}: ${statusLabel}${n.reason ? `. ${n.reason}` : ""}`,
      rectX: pos.x,
      rectY: pos.y,
      rectW: pos.w,
      rectH: pos.h,
      hasJoin: Boolean(n.join),
      joinPoints: `${pos.x - 7},${pos.y + pos.h / 2} ${pos.x},${pos.y + pos.h / 2 - 7} ${pos.x + 7},${pos.y + pos.h / 2} ${pos.x},${pos.y + pos.h / 2 + 7}`,
      titleX: pos.x + 12,
      titleY: pos.y + 22,
      titleText: n.join ? `${n.id} [JOIN]` : n.id,
      statusX: pos.x + 12,
      statusY: pos.y + 43,
      statusText: `${meta.symbol} ${statusLabel}`,
      metaX: pos.x + 12,
      metaY: pos.y + 61,
      metaText: n.current_attempt?.loop
        ? `${n.kind || "unknown"} · attempt ${n.current_attempt.loop.attempt}/${n.current_attempt.loop.max_attempts}`
        : `${n.kind || "unknown"}`,
    };
  }

  function createNodeEntry(n, pos) {
    const d = buildNodeAttrsAndText(n, pos);
    const g = svgEl("g", {
      class: d.gClass,
      tabindex: "0",
      role: "button",
      "aria-pressed": d.ariaPressed,
      "aria-label": d.ariaLabel,
      "data-node-id": n.id,
      "data-focus-key": `graph-node:${n.id}`,
    });
    const rect = svgEl("rect", { class: "node-box", x: d.rectX, y: d.rectY, width: d.rectW, height: d.rectH, rx: 6 });
    g.append(rect);
    let joinPoly = null;
    if (d.hasJoin) {
      joinPoly = svgEl("polygon", { points: d.joinPoints, fill: "#37474f" });
      g.append(joinPoly);
    }
    const titleEl = svgEl("text", { class: "node-title", x: d.titleX, y: d.titleY }, d.titleText);
    const statusEl = svgEl("text", { class: "node-status-line", x: d.statusX, y: d.statusY }, d.statusText);
    const metaEl = svgEl("text", { class: "node-meta-line", x: d.metaX, y: d.metaY }, d.metaText);
    g.append(titleEl, statusEl, metaEl);

    const entry = { g, rect, joinPoly, titleEl, statusEl, metaEl, nodeData: n };
    g.addEventListener("click", () => selectNodeById(entry.nodeData.id));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectNodeById(entry.nodeData.id);
      }
    });
    return entry;
  }

  function updateNodeEntry(entry, n, pos) {
    entry.nodeData = n;
    const d = buildNodeAttrsAndText(n, pos);
    setAttrIfChanged(entry.g, "class", d.gClass);
    setAttrIfChanged(entry.g, "aria-pressed", d.ariaPressed);
    setAttrIfChanged(entry.g, "aria-label", d.ariaLabel);
    setAttrIfChanged(entry.rect, "x", d.rectX);
    setAttrIfChanged(entry.rect, "y", d.rectY);
    setAttrIfChanged(entry.rect, "width", d.rectW);
    setAttrIfChanged(entry.rect, "height", d.rectH);
    if (d.hasJoin) {
      if (entry.joinPoly) {
        setAttrIfChanged(entry.joinPoly, "points", d.joinPoints);
      } else {
        entry.joinPoly = svgEl("polygon", { points: d.joinPoints, fill: "#37474f" });
        entry.g.insertBefore(entry.joinPoly, entry.titleEl);
      }
    } else if (entry.joinPoly) {
      entry.joinPoly.remove();
      entry.joinPoly = null;
    }
    setAttrIfChanged(entry.titleEl, "x", d.titleX);
    setAttrIfChanged(entry.titleEl, "y", d.titleY);
    setTextIfChanged(entry.titleEl, d.titleText);
    setAttrIfChanged(entry.statusEl, "x", d.statusX);
    setAttrIfChanged(entry.statusEl, "y", d.statusY);
    setTextIfChanged(entry.statusEl, d.statusText);
    setAttrIfChanged(entry.metaEl, "x", d.metaX);
    setAttrIfChanged(entry.metaEl, "y", d.metaY);
    setTextIfChanged(entry.metaEl, d.metaText);
  }

  function reconcileLayerOrder(layer, orderedElements) {
    for (let i = 0; i < orderedElements.length; i++) {
      const want = orderedElements[i];
      const cur = layer.children[i] || null;
      if (cur !== want) {
        layer.insertBefore(want, cur);
      }
    }
  }

  function applyGraph(graph, boundVersion) {
    currentBoundVersion = graph.bound_version || boundVersion;
    setTextIfChanged(heading, `Run graph topology (${graph.topology || "unknown"}, bound ${currentBoundVersion || "unknown"})`);
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const layout = layoutGraphNodes(nodes, edges);
    initialBox = { x: 0, y: 0, width: layout.width, height: layout.height };

    const keyedEdges = buildKeyedEdges(edges)
      .map((item, idx) => ({ ...item, renderData: computeEdgeRenderData(item.edge, idx, layout.positions) }))
      .filter((item) => item.renderData !== null);
    const edgeDiff = planKeyedDiff(edgeOrder, keyedEdges, (item) => item.key);
    for (const k of edgeDiff.removedKeys) {
      const entry = edgeEntries.get(k);
      if (entry) {
        entry.g.remove();
        edgeEntries.delete(k);
      }
    }
    for (const kept of edgeDiff.kept) {
      const entry = edgeEntries.get(kept.key);
      if (entry) updateEdgeEntry(entry, kept.item.renderData);
    }
    const newEdgeEntries = [];
    for (const added of edgeDiff.added) {
      const entry = createEdgeEntry(added.key, added.item.renderData);
      edgeEntries.set(added.key, entry);
      newEdgeEntries.push(entry.g);
    }
    if (edgeDiff.orderChanged) {
      reconcileLayerOrder(edgesLayer, keyedEdges.map((k) => edgeEntries.get(k.key).g));
    } else if (newEdgeEntries.length) {
      edgesLayer.append(...newEdgeEntries);
    }
    edgeOrder = keyedEdges.map((k) => k.key);

    const visibleNodes = nodes.filter((n) => layout.positions.has(n.id));
    const nodeDiff = planKeyedDiff(nodeOrder, visibleNodes, (n) => n.id);
    for (const k of nodeDiff.removedKeys) {
      const entry = nodeEntries.get(k);
      if (entry) {
        entry.g.remove();
        nodeEntries.delete(k);
      }
    }
    for (const kept of nodeDiff.kept) {
      const entry = nodeEntries.get(kept.key);
      const pos = layout.positions.get(kept.key);
      if (entry && pos) updateNodeEntry(entry, kept.item, pos);
    }
    const newNodeElements = [];
    for (const added of nodeDiff.added) {
      const pos = layout.positions.get(added.key);
      if (!pos) continue;
      const entry = createNodeEntry(added.item, pos);
      nodeEntries.set(added.key, entry);
      newNodeElements.push(entry.g);
    }
    if (nodeDiff.orderChanged) {
      reconcileLayerOrder(nodesLayer, visibleNodes.map((n) => nodeEntries.get(n.id).g));
    } else if (newNodeElements.length) {
      nodesLayer.append(...newNodeElements);
    }
    nodeOrder = visibleNodes.map((n) => n.id);

    const selected = visibleNodes.find((n) => n.id === state.selectedGraphNodeId) || null;
    if (state.selectedGraphNodeId && !selected) state.selectedGraphNodeId = "";
    patchLiveNodeDetail(detailEl, selected, currentBoundVersion, detailState);
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
  cardBody.append(stage);
  wrapper.append(cardBody);
  applyGraph(initialGraph, initialBoundVersion);
  return {
    wrapper,
    patch: applyGraph,
  };
}

function buildLiveFactsList(data) {
  const run = data?.run || null;
  const hasRun = hasVerifiedRunIdentity(data);
  const boundVersion = (hasRun && typeof run.bound_version === "string" && run.bound_version)
    ? run.bound_version
    : (typeof data?.graph?.bound_version === "string" && data.graph.bound_version ? data.graph.bound_version : null);
  const stateVal = typeof data?.state === "string" && data.state.trim() ? data.state : "uncertain";
  const list = [
    {
      key: "live-state",
      label: "Live state",
      sig: stateVal,
      build: () => statusPill(stateVal),
    },
    {
      key: "bound-version",
      label: "Bound version",
      sig: JSON.stringify(boundVersion ? [boundVersion, data?.current_version] : resolveLiveBoundVersionAbsence(data)),
      build: () => (boundVersion
        ? (boundVersion !== data?.current_version
          ? `${boundVersion} (differs from current ${data?.current_version || "unknown"})`
          : `${boundVersion} (matches current)`)
        : absenceNode(resolveLiveBoundVersionAbsence(data))),
    },
    {
      key: "current-version",
      label: "Current version",
      sig: String(data?.current_version ?? ""),
      build: () => data?.current_version,
    },
    {
      key: "run-identity",
      label: "Run identity",
      sig: JSON.stringify(hasRun ? [run.run_id, run.attempt_id] : resolveLiveRunIdentityAbsence(data)),
      build: () => (hasRun
        ? `${run.run_id} (attempt ${run.attempt_id ?? "unknown"})`
        : absenceNode(resolveLiveRunIdentityAbsence(data))),
    },
    {
      key: "checked-at",
      label: "Checked at",
      sig: String(data?.checked_at ?? ""),
      build: () => data?.checked_at,
    },
  ];
  if (data?.deleted) {
    list.push({
      key: "deleted-at",
      label: "Deleted at",
      sig: String(data?.deletion?.deleted_at ?? ""),
      build: () => data?.deletion?.deleted_at || "Unknown (not provided)",
    });
  }
  if (hasRun) {
    list.push(
      { key: "run-outcome", label: "Run outcome", sig: String(data.outcome ?? ""), build: () => statusPill(data.outcome) },
      { key: "execution-settlement", label: "Execution settlement", sig: String(data.settlement ?? ""), build: () => statusPill(data.settlement) },
      { key: "capacity-release", label: "Capacity release", sig: String(data.capacity_release ?? ""), build: () => statusPill(data.capacity_release) },
    );
  }
  return list;
}

function liveBannerTitle(stateVal, hasRun) {
  if (stateVal === "deleted") return "Deleted factory (permanently retired)";
  if (stateVal === "ended") return hasRun ? "Ended run (not active)" : "Factory live state: ended";
  if (stateVal === "running" && hasRun) return "Verified released run";
  return `Factory live state: ${stateVal}`;
}

function updateLiveStateBannerEl(bannerEl, stateVal, hasRun, reasonText) {
  const meta = resolveBannerMeta(stateVal, undefined);
  setAttrIfChanged(bannerEl, "class", `card-panel ${toneClasses(meta.tone)}`);
  const head = bannerEl.firstChild;
  const pill = head.children[0];
  setAttrIfChanged(pill, "class", `chip ${toneClasses(meta.tone)}`);
  setTextIfChanged(pill, `${meta.symbol} ${meta.label}`);
  const titleText = liveBannerTitle(stateVal, hasRun);
  let titleEl = head.children[1] || null;
  if (titleText) {
    if (!titleEl) {
      titleEl = el("strong", titleText);
      head.append(titleEl);
    } else {
      setTextIfChanged(titleEl, titleText);
    }
  } else if (titleEl) {
    titleEl.remove();
  }
  let reasonEl = bannerEl.children[1] || null;
  if (reasonText) {
    if (!reasonEl) {
      reasonEl = el("p", reasonText);
      bannerEl.append(reasonEl);
    } else {
      setTextIfChanged(reasonEl, reasonText);
    }
  } else if (reasonEl) {
    reasonEl.remove();
  }
}

function syncStaleSlot(staleSlot, stale, prevStaleSig) {
  const nextSig = stale ? JSON.stringify(stale) : "";
  if (nextSig === prevStaleSig) return nextSig;
  if (!stale) {
    staleSlot.replaceChildren();
    return "";
  }
  const reasonLine = `Last successful check: ${stale.lastCheckedAt || "Unknown (not provided)"} · Failure: ${stale.reason || "Refresh failed"}${stale.detail ? ` — ${stale.detail}` : ""}`;
  const staleBanner = banner("stale", "Stale", "Showing last good snapshot (refresh failed)", reasonLine);
  staleSlot.replaceChildren(staleBanner);
  return nextSig;
}

function syncBlockerSlot(blockerSlot, launchBlocker, prevSig) {
  const nextSig = launchBlocker && typeof launchBlocker === "object" ? JSON.stringify(launchBlocker) : "";
  if (nextSig === prevSig) return nextSig;
  if (!nextSig) {
    blockerSlot.replaceChildren();
    return "";
  }
  blockerSlot.replaceChildren(
    banner("blocked", "Launch blocker", `Queue head blocked (${launchBlocker.kind || "unknown"})`, launchBlocker.explanation),
  );
  return nextSig;
}

function syncHeadSlot(headSlot, headStatus, prevSig) {
  const nextSig = headStatus && typeof headStatus === "object" ? JSON.stringify(headStatus) : "";
  if (nextSig === prevSig) return nextSig;
  const block = renderHeadStatusBlock(headStatus);
  if (block) headSlot.replaceChildren(block);
  else headSlot.replaceChildren();
  return nextSig;
}

function syncFactsGrid(factsEl, factNodesMap, factOrderRef, data) {
  const nextFacts = buildLiveFactsList(data);
  const diff = planKeyedDiff(factOrderRef.order, nextFacts, (f) => f.key);
  for (const k of diff.removedKeys) {
    const entry = factNodesMap.get(k);
    if (entry) {
      entry.box.remove();
      factNodesMap.delete(k);
    }
  }
  for (const kept of diff.kept) {
    const entry = factNodesMap.get(kept.key);
    if (entry && entry.sig !== kept.item.sig) {
      const val = kept.item.build();
      entry.dd.replaceChildren(val instanceof Node ? val : renderValue(val));
      entry.sig = kept.item.sig;
    }
  }
  const newBoxes = [];
  for (const added of diff.added) {
    const box = factItem(added.item.label, added.item.build());
    const dd = box.querySelector("dd") || box.children[1];
    factNodesMap.set(added.key, { box, dd, sig: added.item.sig });
    newBoxes.push(box);
  }
  if (diff.orderChanged) {
    nextFacts.forEach((f, i) => {
      const box = factNodesMap.get(f.key).box;
      const cur = factsEl.children[i] || null;
      if (cur !== box) factsEl.insertBefore(box, cur);
    });
  } else if (newBoxes.length) {
    factsEl.append(...newBoxes);
  }
  factOrderRef.order = nextFacts.map((f) => f.key);
}

function mountOrPatchLiveView(data, transition, stale) {
  dom.content.setAttribute("aria-live", "off");
  const hasRun = hasVerifiedRunIdentity(data);
  const stateVal = typeof data?.state === "string" && data.state.trim() ? data.state : "uncertain";
  const boundVersion = (hasRun && typeof data.run.bound_version === "string" && data.run.bound_version)
    ? data.run.bound_version
    : (typeof data?.graph?.bound_version === "string" && data.graph.bound_version ? data.graph.bound_version : null);
  const runKey = getLiveRunKey(data);
  const canPatch = Boolean(
    state.liveDom
    && state.liveDom.factoryId === state.selectedFactoryId
    && transition?.mode !== "next-run"
    && transition?.mode !== "replace",
  );

  if (!canPatch) {
    abortOutputRequest();
    if (transition?.clearSelection) state.selectedGraphNodeId = "";
    const staleSlot = el("div");
    const announcer = el("div", undefined, { class: "sr-only", "aria-live": "polite" });
    const stateBanner = banner(stateVal, undefined, liveBannerTitle(stateVal, hasRun), data?.reason);
    const blockerSlot = el("div");
    const factsEl = el("dl", undefined, { class: "row" });
    const factNodesMap = new Map();
    const factOrderRef = { order: [] };
    const headSlot = el("div");
    const graphSlot = el("div");

    const staleSig = syncStaleSlot(staleSlot, stale, null);
    const blockerSig = syncBlockerSlot(blockerSlot, data?.launch_blocker, null);
    syncFactsGrid(factsEl, factNodesMap, factOrderRef, data);
    const headSig = syncHeadSlot(headSlot, data?.head_status, null);

    let graphCtrl = null;
    let fallbackGraphSig = "";
    if (hasRenderableGraph(data)) {
      const detailPanel = el("section", undefined, { class: "card", "aria-live": "polite" });
      const detailBody = el("div", undefined, { class: "card-content" });
      detailPanel.append(detailBody);
      graphCtrl = createGraphController(data.graph, detailBody, boundVersion);
      graphSlot.append(graphCtrl.wrapper, detailPanel);
    } else {
      const graphFallback = resolveLiveGraphBanner(data, stateVal);
      fallbackGraphSig = JSON.stringify(graphFallback);
      graphSlot.append(banner(graphFallback.pillKey, undefined, "Run graph", graphFallback.reason));
    }

    dom.content.replaceChildren(staleSlot, announcer, stateBanner, blockerSlot, factsEl, headSlot, graphSlot);
    if (transition?.mode === "next-run") {
      setTextIfChanged(announcer, `Switched to run ${data.run?.run_id || "unknown"} (${stateVal}).`);
    }
    state.liveDom = {
      factoryId: state.selectedFactoryId,
      runKey,
      staleSlot,
      staleSig,
      hadStale: Boolean(stale),
      announcer,
      lastAnnouncedState: stateVal,
      stateBanner,
      blockerSlot,
      blockerSig,
      factsEl,
      factNodesMap,
      factOrderRef,
      headSlot,
      headSig,
      graphSlot,
      graphCtrl,
      fallbackGraphSig,
    };
    return;
  }

  const ld = state.liveDom;
  ld.runKey = runKey;
  ld.staleSig = syncStaleSlot(ld.staleSlot, stale, ld.staleSig);
  updateLiveStateBannerEl(ld.stateBanner, stateVal, hasRun, data?.reason);
  ld.blockerSig = syncBlockerSlot(ld.blockerSlot, data?.launch_blocker, ld.blockerSig);
  syncFactsGrid(ld.factsEl, ld.factNodesMap, ld.factOrderRef, data);
  ld.headSig = syncHeadSlot(ld.headSlot, data?.head_status, ld.headSig);

  if (hasRenderableGraph(data)) {
    ld.fallbackGraphSig = "";
    if (ld.graphCtrl) {
      ld.graphCtrl.patch(data.graph, boundVersion);
    } else {
      const detailPanel = el("section", undefined, { class: "card", "aria-live": "polite" });
      const detailBody = el("div", undefined, { class: "card-content" });
      detailPanel.append(detailBody);
      ld.graphCtrl = createGraphController(data.graph, detailBody, boundVersion);
      ld.graphSlot.replaceChildren(ld.graphCtrl.wrapper, detailPanel);
    }
  } else {
    if (ld.graphCtrl) {
      abortOutputRequest();
      ld.graphCtrl = null;
    }
    const graphFallback = resolveLiveGraphBanner(data, stateVal);
    const nextFallbackSig = JSON.stringify(graphFallback);
    if (nextFallbackSig !== ld.fallbackGraphSig) {
      ld.fallbackGraphSig = nextFallbackSig;
      ld.graphSlot.replaceChildren(banner(graphFallback.pillKey, undefined, "Run graph", graphFallback.reason));
    }
  }

  const hasStaleNow = Boolean(stale);
  if (hasStaleNow && !ld.hadStale) {
    setTextIfChanged(ld.announcer, `Live graph is stale: ${stale.reason}. Last check: ${stale.lastCheckedAt || "unknown"}.`);
  } else if (!hasStaleNow && ld.hadStale) {
    setTextIfChanged(ld.announcer, `Live connection recovered. State: ${stateVal}.`);
  } else if (stateVal !== ld.lastAnnouncedState) {
    setTextIfChanged(ld.announcer, `Factory live state changed to ${stateVal}.`);
  }
  ld.hadStale = hasStaleNow;
  ld.lastAnnouncedState = stateVal;
}

function renderLiveView(container, data) {
  if (container === dom.content) {
    mountOrPatchLiveView(data, null, null);
    return;
  }
  const hasRun = hasVerifiedRunIdentity(data);
  const boundVersion = (hasRun && typeof data.run.bound_version === "string" && data.run.bound_version)
    ? data.run.bound_version
    : (typeof data?.graph?.bound_version === "string" && data.graph.bound_version ? data.graph.bound_version : null);
  const stateVal = typeof data?.state === "string" && data.state.trim() ? data.state : "uncertain";
  container.append(banner(stateVal, undefined, liveBannerTitle(stateVal, hasRun), data?.reason));
  if (data?.launch_blocker && typeof data.launch_blocker === "object") {
    container.append(banner("blocked", "Launch blocker", `Queue head blocked (${data.launch_blocker.kind || "unknown"})`, data.launch_blocker.explanation));
  }
  const facts = el("dl", undefined, { class: "row" });
  for (const f of buildLiveFactsList(data)) {
    facts.append(factItem(f.label, f.build()));
  }
  container.append(facts);
  const headBlock = renderHeadStatusBlock(data?.head_status);
  if (headBlock) container.append(headBlock);
  if (hasRenderableGraph(data)) {
    const detailPanel = el("section", undefined, { class: "card", "aria-live": "polite" });
    const detailBody = el("div", undefined, { class: "card-content" });
    detailPanel.append(detailBody);
    container.append(createGraphController(data.graph, detailBody, boundVersion).wrapper, detailPanel);
  } else {
    const graphFallback = resolveLiveGraphBanner(data, stateVal);
    container.append(banner(graphFallback.pillKey, undefined, "Run graph", graphFallback.reason));
  }
}

function renderInspectNodeCard(node, isTarget) {
  const card = el("article", undefined, {
    id: safeNodeDomId(node.anchor, node.id),
    tabindex: "-1",
    class: isTarget ? "card blue-grey lighten-5 z-depth-3" : "card",
  });
  const cardBody = el("div", undefined, { class: "card-content" });
  const title = el("h4", undefined, { class: "card-title" });
  const kindPill = node.kind === "command"
    ? statusPill("active", "command")
    : (node.kind === "agent" ? statusPill("running", "agent") : statusPill(node.kind));
  title.append(el("span", node.id, { class: "mono" }), document.createTextNode(" "), kindPill);
  cardBody.append(title);
  if (node.kind_explanation) cardBody.append(el("p", node.kind_explanation, { class: "grey-text text-darken-3" }));

  const facts = el("dl", undefined, { class: "row" });
  facts.append(
    factItem("Persona", isAbsenceObject(node.persona)
      ? absenceNode(node.persona)
      : (node.persona && typeof node.persona === "object" && node.persona.name ? String(node.persona.name) : statusPill(undefined))),
    factItem("Model", isAbsenceObject(node.model)
      ? absenceNode(node.model)
      : (node.model && typeof node.model === "object" && node.model.id ? `${node.model.id} (thinking: ${node.model.thinking || "Unknown (not provided)"})` : statusPill(undefined))),
    factItem("Command", isAbsenceObject(node.command)
      ? absenceNode(node.command)
      : (node.command && typeof node.command === "object" && node.command.executable
        ? el("code", `${node.command.executable} ${(Array.isArray(node.command.args) ? node.command.args : []).join(" ")}`.trim())
        : statusPill(undefined))),
  );

  const depsNode = isAbsenceObject(node.dependencies)
    ? absenceNode(node.dependencies)
    : (node.dependencies && typeof node.dependencies === "object"
      ? (() => {
        const items = Array.isArray(node.dependencies.items) ? node.dependencies.items : [];
        if (!items.length) return el("span");
        const ul = el("ul", undefined, { class: "collection" });
        for (const item of items) {
          const li = el("li", undefined, { class: "collection-item" });
          li.append(renderNodeLinkOrAbsence(item));
          ul.append(li);
        }
        return ul;
      })()
      : absenceNode({ absence: "evidence unavailable", explanation: "Dependency list was not provided." }));
  facts.append(factItem("Dependencies", depsNode));

  const joinNode = isAbsenceObject(node.join)
    ? absenceNode(node.join)
    : (node.join && typeof node.join === "object"
      ? (() => {
        const wrap = el("div");
        wrap.append(el("span", `policy: ${node.join.policy || "Unknown (not provided)"} — `));
        const sources = Array.isArray(node.join.sources) ? node.join.sources : [];
        if (sources.length) {
          const ul = el("ul", undefined, { class: "collection" });
          for (const src of sources) {
            const li = el("li", undefined, { class: "collection-item" });
            li.append(renderNodeLinkOrAbsence(src));
            ul.append(li);
          }
          wrap.append(ul);
        }
        return wrap;
      })()
      : absenceNode({ absence: "evidence unavailable", explanation: "Join policy was not provided." }));
  facts.append(factItem("Join", joinNode));

  const decNode = isAbsenceObject(node.decision)
    ? absenceNode(node.decision)
    : (node.decision && typeof node.decision === "object"
      ? (() => {
        const wrap = el("div");
        wrap.append(el("p", node.decision.explanation || `${node.decision.field || "Unknown"}: approve=${node.decision.approve ?? "?"}, reject=${node.decision.reject ?? "?"}`));
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
        wrap.append(el("div", `Max revisions: ${node.decision.max_revisions ?? "Unknown (not provided)"} (${node.decision.max_revisions_source || "Unknown (not provided)"}) · On exhausted: ${node.decision.on_exhausted || "Unknown (not provided)"}`));
        return wrap;
      })()
      : absenceNode({ absence: "evidence unavailable", explanation: "Decision configuration was not provided." }));
  facts.append(factItem("Decision", decNode));

  facts.append(factItem("Feedback target", renderNodeLinkOrAbsence(node.feedback_target)));
  facts.append(factItem("Required checks", isAbsenceObject(node.required_checks)
    ? absenceNode(node.required_checks)
    : (node.required_checks && Array.isArray(node.required_checks.items) ? node.required_checks.items.join(", ") : statusPill(undefined))));
  cardBody.append(facts);

  const opt = el("details", undefined, { class: "collapsible", ...(isTarget ? { open: true } : {}) });
  opt.append(el("summary", "Optional node policies & limits", { class: "collapsible-header" }));
  const optBody = el("div", undefined, { class: "collapsible-body" });
  const pf = el("dl", undefined, { class: "row" });
  const pol = node.policies && typeof node.policies === "object" ? node.policies : {};
  pf.append(
    factItem("Tools policy", pol.tools?.explanation || renderValue(pol.tools)),
    factItem("Skills policy", pol.skills?.explanation || renderValue(pol.skills)),
    factItem("Extensions policy", pol.extensions?.explanation || renderValue(pol.extensions)),
    factItem("Dependency policy", isAbsenceObject(pol.dependency)
      ? absenceNode(pol.dependency)
      : (pol.dependency && typeof pol.dependency === "object"
        ? `${pol.dependency.policy || "Unknown (not provided)"} — ${pol.dependency.explanation || ""}`
        : absenceNode({ absence: "evidence unavailable", explanation: "Dependency policy was not provided." }))),
    factItem("Intervention policy", isAbsenceObject(pol.intervention)
      ? absenceNode(pol.intervention)
      : (pol.intervention && typeof pol.intervention === "object"
        ? `${pol.intervention.explanation || ""} Choices: ${(Array.isArray(pol.intervention.choices) ? pol.intervention.choices : []).map((c) => `${c.choice_id} (${c.label})`).join(", ")}`
        : absenceNode({ absence: "evidence unavailable", explanation: "Intervention policy was not provided." }))),
    factItem("Task timeout", isAbsenceObject(node.limits?.task_timeout_ms)
      ? absenceNode(node.limits.task_timeout_ms)
      : (node.limits?.task_timeout_ms && typeof node.limits.task_timeout_ms === "object"
        ? `${node.limits.task_timeout_ms.value ?? "Unknown"} ms (${node.limits.task_timeout_ms.inherited ? "inherited" : "node"})`
        : absenceNode({ absence: "evidence unavailable", explanation: "Task timeout was not provided." }))),
    factItem("Dependency wait timeout", isAbsenceObject(node.limits?.dependency_wait_timeout_ms)
      ? absenceNode(node.limits.dependency_wait_timeout_ms)
      : (node.limits?.dependency_wait_timeout_ms && typeof node.limits.dependency_wait_timeout_ms === "object"
        ? `${node.limits.dependency_wait_timeout_ms.value ?? "Unknown"} ms (${node.limits.dependency_wait_timeout_ms.inherited ? "inherited" : "node"})`
        : absenceNode({ absence: "evidence unavailable", explanation: "Dependency wait timeout was not provided." }))),
  );
  optBody.append(pf);
  opt.append(optBody);
  cardBody.append(opt);
  card.append(cardBody);
  return card;
}

function renderInspectView(container, data) {
  if (data?.evidence === "unavailable" && !data?.attention_summary) {
    container.append(banner("unavailable", "Evidence unavailable", "Factory inspection unavailable", data.explanation));
    return;
  }
  appendDeletedBannerIfPresent(container, data);

  const summary = data.attention_summary || {};
  const mgmt = summary.management || data.management;
  const stop = summary.stop_state || data.stopped;
  const curVer = summary.current_version || { version: data.current_version };
  const cap = summary.capacity || data.capacity;
  const head = summary.queue_head || data.queue_head;
  const attn = summary.attention || data.attention;

  /* 1. What needs my attention? (never in an accordion) */
  const attnSec = el("section", undefined, { class: "card" });
  const attnBody = el("div", undefined, { class: "card-content" });
  attnBody.append(el("h3", "What needs my attention?", { class: "card-title" }));
  const stopVal = resolveStopStateValue(stop);
  const topFacts = el("dl", undefined, { class: "row" });
  topFacts.append(
    factItem("Factory name", summary.name || data.name),
    factItem("Management state", statusPill(mgmt?.state)),
    factItem("Stop state", stopVal.kind === "absence" ? absenceNode(stopVal.value) : statusPill(stopVal.value)),
    factItem("Current version", curVer?.evidence === "unavailable" ? absenceNode(curVer) : (curVer?.version || data.current_version)),
    factItem("Inspected version", data.inspected_version),
    factItem("Overall evidence", statusPill(resolveInspectOverallEvidence(data))),
  );
  attnBody.append(topFacts);
  if (mgmt?.explanation) attnBody.append(el("p", mgmt.explanation));
  if (stop?.explanation && !isAbsenceObject(stop)) attnBody.append(el("p", stop.explanation));

  if (cap && !isAbsenceObject(cap)) {
    const holdDisplay = resolveBlockingHoldDisplay(cap.blocking_hold);
    const capFacts = el("dl", undefined, { class: "row" });
    capFacts.append(
      factItem("Queue capacity", isAbsenceObject(cap.queue) ? absenceNode(cap.queue) : `${cap.queue_used ?? "Unknown"} of ${cap.queue_limit ?? "Unknown"}`),
      factItem("Factory run slot", statusPill(cap.factory_slot?.state)),
      factItem("Checkout slot", statusPill(cap.checkout_slot?.state)),
      factItem("Blocking hold", holdDisplay.kind === "absence" ? absenceNode(holdDisplay.value) : holdDisplay.text),
    );
    attnBody.append(capFacts);
  } else if (cap) {
    attnBody.append(absenceNode(cap));
  }

  if (head) {
    attnBody.append(el("h4", "Queue head"));
    attnBody.append(el("p", head.explanation || "Unknown (not provided)"));
  }

  attnBody.append(el("h4", "Outstanding attention"));
  if (attn && Array.isArray(attn.items) && attn.items.length) {
    attnBody.append(buildTable("Outstanding attention items requiring operator review in Pi", ["Item", "Explanation", "View"], attn.items.map((item) => {
      let itemNode;
      if (!item.kind) {
        itemNode = statusPill(undefined);
      } else {
        const pillKey = item.kind === "uncertain" ? "uncertain" : "blocked";
        itemNode = item.label
          ? symbolChipWithText(resolveStatusMeta(pillKey, item.label), item.label)
          : statusPill(pillKey);
      }
      return [
        { asRowHeader: true, content: itemNode },
        item.explanation,
        buildLink(`Open ${getViewLabel(item.detail_view)}`, item.detail_url),
      ];
    })));
  } else if (attn && isAbsenceObject(attn)) {
    attnBody.append(absenceNode(attn));
  } else {
    attnBody.append(el("p", attn?.explanation || "Unknown (not provided)"));
  }
  attnSec.append(attnBody);
  container.append(attnSec);

  /* Target node banner if query targeted a specific node/factory */
  let focusAnchor = "";
  if (data.target_node) {
    if (data.target_node.verified === false) {
      container.append(banner("unavailable", "Unverifiable link target", `Target could not be verified in ${data.target_node.version || data.inspected_version}`, data.target_node.explanation));
    } else if (data.target_node.verified && data.target_node.node) {
      focusAnchor = safeNodeDomId(data.target_node.node.anchor, data.target_node.node.id);
      container.append(banner("available", "Target resolved", `Showing ${data.target_node.node.id} in ${data.target_node.version}`, data.target_node.explanation));
    }
  }

  /* 2. Damaged records (always visible when present) */
  if (data.damaged_records && data.damaged_records.count > 0) {
    const dmg = el("section", undefined, { class: `card-panel ${toneClasses("error")}` });
    dmg.append(el("h3", "Damaged or unavailable records"));
    dmg.append(el("p", data.damaged_records.explanation));
    if (Array.isArray(data.damaged_records.items)) {
      dmg.append(buildTable("Damaged or unavailable record areas", ["Scope", "Target", "Absence", "Explanation"], data.damaged_records.items.map((item) => [
        { asRowHeader: true, content: el("code", item?.scope ?? "unknown") },
        item?.version || item?.attempt_id || "—",
        absenceNode(item),
        item?.explanation,
      ])));
    } else {
      dmg.append(absenceNode({ absence: "evidence unavailable", explanation: "Damaged record item details were not provided." }));
    }
    container.append(dmg);
  }

  /* 3. Version selector and retained version history */
  const verSec = el("section", undefined, { class: "card" });
  const verBody = el("div", undefined, { class: "card-content" });
  verBody.append(el("h3", "Definition versions & selector", { class: "card-title" }));
  verBody.append(el("p", "Selecting a retained version inspects that definition only; current version, queue, and capacity remain live.", { class: "grey-text text-darken-3" }));
  if (Array.isArray(data.versions) && data.versions.length) {
    const form = el("form", undefined, { class: "row" });
    const field = el("div", undefined, { class: "input-field col s12 m8" });
    const select = el("select", undefined, { id: "inspect-version-select", name: "version", class: "browser-default" });
    for (const v of data.versions) {
      const opt = el("option", `${v.version}${v.current ? " (current)" : ""}${v.evidence === "unavailable" ? " [damaged]" : ""}`, { value: v.version });
      if (v.version === data.inspected_version) opt.selected = true;
      select.append(opt);
    }
    const label = el("label", "Inspected definition version", { for: "inspect-version-select", class: "active grey-text text-darken-3" });
    field.append(select, label);
    const btnCol = el("div", undefined, { class: "input-field col s12 m4" });
    const submit = el("button", "Inspect version", { type: "submit", class: "btn teal darken-3 white-text" });
    btnCol.append(submit);
    form.append(field, btnCol);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      navigateToUrl(pageUrl({ factory: state.selectedFactoryId, view: "inspect", version: select.value }), true);
    });
    verBody.append(form);

    verBody.append(buildTable("Retained definition versions", ["Version", "Flags", "Restore provenance", "Digest", "Created at", "Evidence"], data.versions.map((v) => {
      const flags = [];
      if (v.current) flags.push("current");
      if (v.inspected) flags.push("inspected");
      const restored = resolveRestoredFromDisplay(v.restored_from);
      return [
        { asRowHeader: true, content: buildLink(v.version, pageUrl({ factory: state.selectedFactoryId, view: "inspect", version: v.version })) },
        flags.length ? flags.join(", ") : "retained",
        restored.kind === "absence" ? absenceNode(restored.value) : restored.text,
        isAbsenceObject(v.digest) ? absenceNode(v.digest) : (v.digest ? el("code", String(v.digest).slice(0, 16) + "…") : statusPill(undefined)),
        isAbsenceObject(v.created_at) ? absenceNode(v.created_at) : v.created_at,
        v.evidence === "unavailable" ? absenceNode(v) : statusPill(v.evidence),
      ];
    })));
  }
  verSec.append(verBody);
  container.append(verSec);

  /* 4. Inspected definition nodes */
  const defSec = el("section", undefined, { class: "card" });
  const defBody = el("div", undefined, { class: "card-content" });
  defBody.append(el("h3", `Inspected definition (${data.inspected_version || "unknown"})`, { class: "card-title" }));
  const def = data.definition;
  if (!def || def.evidence === "unavailable" || isAbsenceObject(def)) {
    defBody.append(banner("unavailable", "Definition unavailable", `Definition ${data.inspected_version || "unknown"} is unavailable`, def?.explanation || "The selected retained definition could not be verified."));
  } else {
    const defRestored = resolveRestoredFromDisplay(def.restored_from);
    const defFacts = el("dl", undefined, { class: "row" });
    defFacts.append(
      factItem("Version", def.version),
      factItem("Topology", def.topology),
      factItem("Restore provenance", defRestored.kind === "absence" ? absenceNode(defRestored.value) : defRestored.text),
    );
    defBody.append(defFacts);
    if (Array.isArray(def.nodes)) {
      const targetId = data.target_node?.verified && data.target_node?.node ? data.target_node.node.id : "";
      for (const n of def.nodes) {
        defBody.append(renderInspectNodeCard(n, n.id === targetId));
      }
    }
    const limOpt = el("details", undefined, { class: "collapsible" });
    limOpt.append(el("summary", "Definition limits & runtime assumptions (what is not frozen)", { class: "collapsible-header" }));
    const limBody = el("div", undefined, { class: "collapsible-body" });
    if (def.limits && typeof def.limits === "object") {
      const lf = el("dl", undefined, { class: "row" });
      lf.append(
        factItem("Max total attempts", `${def.limits.max_total_attempts ?? "Unknown (not provided)"} (${def.limits.max_total_attempts_source || "Unknown (not provided)"})`),
        factItem("Ready timeout", def.limits.ready_timeout_ms !== undefined ? `${def.limits.ready_timeout_ms} ms` : statusPill(undefined)),
        factItem("Default task timeout", isAbsenceObject(def.limits.task_timeout_ms) ? absenceNode(def.limits.task_timeout_ms) : (def.limits.task_timeout_ms !== undefined ? `${def.limits.task_timeout_ms} ms` : statusPill(undefined))),
        factItem("Dependency wait timeout", def.limits.dependency_wait_timeout_ms !== undefined ? `${def.limits.dependency_wait_timeout_ms} ms` : statusPill(undefined)),
        factItem("Liveness timeout", def.limits.liveness_timeout_ms !== undefined ? `${def.limits.liveness_timeout_ms} ms` : statusPill(undefined)),
        factItem("Cancel grace", def.limits.cancel_grace_ms !== undefined ? `${def.limits.cancel_grace_ms} ms` : statusPill(undefined)),
      );
      limBody.append(lf);
    }
    const nf = def.not_frozen || data.runtime_assumptions;
    if (nf && Array.isArray(nf.not_frozen)) {
      if (nf.note) limBody.append(el("p", nf.note));
      limBody.append(buildTable("Inputs not frozen by the definition", ["Input", "Explanation"], nf.not_frozen.map((r) => [
        { asRowHeader: true, content: r.label },
        r.explanation,
      ])));
    }
    limOpt.append(limBody);
    defBody.append(limOpt);
  }
  defSec.append(defBody);
  container.append(defSec);

  /* 5. Operation & evidence summary */
  if (data.operation_evidence) {
    const oe = data.operation_evidence;
    const oeSec = el("section", undefined, { class: "card" });
    const oeBody = el("div", undefined, { class: "card-content" });
    oeBody.append(el("h3", "Operation & evidence summary", { class: "card-title" }));
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
      isAbsenceObject(area) ? absenceNode(area) : (area?.explanation || statusPill(undefined)),
      area?.detail_url ? buildLink(`Open ${getViewLabel(area.detail_view)}`, area.detail_url) : "—",
    ]);
    oeBody.append(buildTable("Operation and evidence summary links", ["Evidence area", "Summary", "Detail view"], rows));
    oeSec.append(oeBody);
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
  appendDeletedBannerIfPresent(container, data);
  const activeFilter = data?.filter === "all" ? "all" : state.queueFilter;
  const filterBar = el("div", undefined, { class: "section", role: "group", "aria-label": "Queue filter" });
  const btnOpen = el("button", "Open (unfinished & uncertain)", { type: "button", class: activeFilter === "open" ? "btn teal darken-3 white-text" : "btn-flat teal-text text-darken-3", "aria-pressed": activeFilter === "open" ? "true" : "false" });
  const btnAll = el("button", "All (include finished)", { type: "button", class: activeFilter === "all" ? "btn teal darken-3 white-text" : "btn-flat teal-text text-darken-3", "aria-pressed": activeFilter === "all" ? "true" : "false" });
  btnOpen.addEventListener("click", () => navigateToUrl(pageUrl({ factory: state.selectedFactoryId, view: "queue", filter: "open" }), true));
  btnAll.addEventListener("click", () => navigateToUrl(pageUrl({ factory: state.selectedFactoryId, view: "queue", filter: "all" }), true));
  filterBar.append(btnOpen, document.createTextNode(" "), btnAll);
  container.append(filterBar);

  const ev = resolveSnapshotEvidence(data);
  container.append(banner(ev, undefined, `Queue (${activeFilter} filter)`, data?.explanation));

  const headBlock = renderHeadStatusBlock(data?.head_status);
  if (headBlock) container.append(headBlock);

  const rows = Array.isArray(data?.entries) ? data.entries : [];
  if (!rows.length) {
    const emptyInfo = resolveEmptyCollectionBanner(data, ev, "No queue entries.");
    container.append(banner(emptyInfo.pillKey, undefined, "Queue entries", emptyInfo.reason));
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
      dispNode.append(statusPill(r.disposition), el("div", r.disposition_explanation, { class: "grey-text text-darken-3" }));
      const verif = resolveBooleanVerification(r.uncertain);
      return [
        { asRowHeader: true, content: String(r.queue_position ?? "?") },
        el("code", r.reference || r.input_id),
        verNode,
        dispNode,
        statusPill(verif.status, verif.label),
        r.accepted_at,
        r.is_head ? statusPill("queued", "Queue head") : "—",
        buildLink(`Receipt for ${r.reference}`, r.receipt_url),
      ];
    }),
  ));
}

function renderReceiptsView(container, data, errorInfo) {
  appendDeletedBannerIfPresent(container, data, selectedFactoryRecord());
  container.append(banner("info", "Read-only receipt", "Receipt evidence is not a run report.", "Receipts document input admission, bound version, disposition, and launch attempt state only."));

  const form = el("form", undefined, { class: "row" });
  const field = el("div", undefined, { class: "input-field col s12 m8" });
  const input = el("input", undefined, { id: "receipt-ref-input", name: "reference", type: "text", required: true, value: state.receiptReference || "" });
  const label = el("label", "Submission reference", { for: "receipt-ref-input", class: "active grey-text text-darken-3" });
  field.append(input, label);
  const btnCol = el("div", undefined, { class: "input-field col s12 m4" });
  const submit = el("button", "Look up receipt", { type: "submit", class: "btn teal darken-3 white-text" });
  btnCol.append(submit);
  form.append(field, btnCol);
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
  if (!data || data.type !== "receipt") {
    const unexpected = resolveUnexpectedReceiptBanner(data);
    container.append(banner(unexpected.pillKey, undefined, "Receipt unavailable", unexpected.reason));
    return;
  }

  const facts = el("dl", undefined, { class: "row" });
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

  const attSec = el("section", undefined, { class: "card" });
  const attBody = el("div", undefined, { class: "card-content" });
  attBody.append(el("h3", "Recorded launch attempt", { class: "card-title" }));
  const att = data.attempt;
  if (!att || isAbsenceObject(att)) {
    attBody.append(absenceNode(att || { absence: "evidence unavailable", explanation: "Attempt evidence unavailable." }));
  } else {
    if (att.uncertain) {
      attBody.append(banner("uncertain", "Uncertain", "Attempt evidence is uncertain", att.state_explanation));
    }
    const af = el("dl", undefined, { class: "row" });
    af.append(
      factItem("Attempt ID", el("code", att.attempt_id)),
      factItem("Attempt state", statusPill(att.state)),
      factItem("State explanation", att.state_explanation),
      factItem("Bound version", el("code", att.bound_version)),
      factItem("Task ID", el("code", att.task_id)),
      factItem("Request ID", el("code", att.request_id)),
      factItem("Release authorized", typeof att.release_authorized === "boolean" ? (att.release_authorized ? "Yes" : "No") : statusPill(undefined)),
      factItem("Release authorized at", isAbsenceObject(att.release_authorized_at) ? absenceNode(att.release_authorized_at) : att.release_authorized_at),
      factItem("Created at", att.created_at),
      factItem("Updated at", att.updated_at),
    );
    attBody.append(af);
  }
  attSec.append(attBody);
  container.append(attSec);
}

function renderRequestsView(container, data) {
  appendDeletedBannerIfPresent(container, data);
  const reqEv = resolveSnapshotEvidence(data);
  container.append(banner(
    reqEv,
    undefined,
    "Direction & exhaustion requests (read-only observation)",
    `${data?.explanation || ""} Answering or waking requests stays in Pi.`,
  ));

  const recs = Array.isArray(data?.records) ? data.records : [];
  if (!recs.length) {
    const emptyInfo = resolveEmptyCollectionBanner(data, reqEv, "No requests recorded.");
    container.append(banner(emptyInfo.pillKey, undefined, "Request records", emptyInfo.reason));
    return;
  }

  for (const r of recs) {
    const card = el("article", undefined, { class: "card" });
    const cardBody = el("div", undefined, { class: "card-content" });
    const head = el("div", undefined, { class: "card-title" });
    head.append(el("strong", r.request_id, { class: "mono" }), document.createTextNode(" "), statusPill(r.state), el("span", r.kind || "unknown", { class: `chip ${toneClasses("muted")}` }));
    if (r.uncertain) head.append(statusPill("uncertain", "Uncertain"));
    cardBody.append(head);

    if (r.uncertain && r.uncertainty) {
      cardBody.append(banner("uncertain", "Uncertain", "Request evidence uncertainty", r.uncertainty));
    }

    const qWrap = el("p");
    qWrap.append(el("strong", "Question: "), isAbsenceObject(r.question) ? absenceNode(r.question) : renderValue(r.question));
    cardBody.append(qWrap);

    const facts = el("dl", undefined, { class: "row" });
    facts.append(
      factItem("Node", isAbsenceObject(r.node_id) ? absenceNode(r.node_id) : (r.node_id ? el("code", r.node_id) : statusPill(undefined))),
      factItem("Node attempt", isAbsenceObject(r.node_attempt_id) ? absenceNode(r.node_attempt_id) : (r.node_attempt_id ? el("code", r.node_attempt_id) : statusPill(undefined))),
      factItem("Response recorded", isAbsenceObject(r.response_recorded)
        ? absenceNode(r.response_recorded)
        : (typeof r.response_recorded === "boolean"
          ? (r.response_recorded
            ? `Yes (${r.recorded_response?.kind || "recorded"}${r.recorded_response?.choice_id ? `: ${r.recorded_response.choice_id}` : ""}${r.responded_at ? ` at ${r.responded_at}` : ""})`
            : "No")
          : statusPill(undefined))),
      factItem("Response consumed", isAbsenceObject(r.response_consumed)
        ? absenceNode(r.response_consumed)
        : (typeof r.response_consumed === "boolean"
          ? `${r.response_consumed ? "Yes" : "No"} — ${r.consumption_explanation || r.consumption || ""}${r.consumed_at ? ` (${r.consumed_at})` : ""}`
          : statusPill(undefined))),
      factItem("Reconciliation", r.reconciliation
        ? `${r.reconciliation}${r.reconciliation_explanation ? ` — ${r.reconciliation_explanation}` : ""}`
        : statusPill(undefined)),
    );
    cardBody.append(facts);

    const choicesDiv = el("div", undefined, { class: "section" });
    choicesDiv.append(el("strong", "Choices: "));
    if (isAbsenceObject(r.choices)) {
      choicesDiv.append(absenceNode(r.choices));
    } else if (Array.isArray(r.choices)) {
      if (r.choices.length) {
        const ul = el("ul", undefined, { class: "collection" });
        for (const c of r.choices) {
          ul.append(el("li", `${c.label} [${c.choice_id}]${c.route ? ` -> route: ${c.route}` : ""}`, { class: "collection-item" }));
        }
        choicesDiv.append(ul);
      }
    } else {
      choicesDiv.append(absenceNode({ absence: "evidence unavailable", explanation: "Choices were not provided." }));
    }
    cardBody.append(choicesDiv);

    const opt = el("details", undefined, { class: "collapsible" });
    opt.append(el("summary", "Optional request provenance, verdict, admissions & risk lane", { class: "collapsible-header" }));
    const optBody = el("div", undefined, { class: "collapsible-body" });
    const of = el("dl", undefined, { class: "row" });
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
    optBody.append(of);
    opt.append(optBody);
    cardBody.append(opt);
    card.append(cardBody);
    container.append(card);
  }
}

function renderProposalsView(container, data) {
  appendDeletedBannerIfPresent(container, data);
  const propEv = resolveSnapshotEvidence(data);
  container.append(banner("info", "Not active constraints", data?.note || "Proposals are not the active constraints file.", "Reviewing, confirming, retiring, or resolving proposal conflicts stays in Pi."));
  container.append(banner(
    propEv,
    undefined,
    "Constraint proposals",
    data?.explanation,
  ));

  const recs = Array.isArray(data?.records) ? data.records : [];
  if (!recs.length) {
    const emptyInfo = resolveEmptyCollectionBanner(data, propEv, "No proposals recorded.");
    container.append(banner(emptyInfo.pillKey, undefined, "Proposal records", emptyInfo.reason));
    return;
  }

  container.append(buildTable(
    "Learned constraint proposals (not the active constraints file)",
    ["Proposal", "Action & IDs", "Text", "Provenance", "Outcome", "File sync state", "Uncertainty"],
    recs.map((p) => {
      const prov = p.provenance || {};
      const provCell = el("div");
      provCell.append(
        el("div", `Source: ${prov.source || p.source || "Unknown (not provided)"}`),
        el("div", undefined, { class: "grey-text text-darken-3" }),
      );
      provCell.lastChild.append(document.createTextNode("Run: "), renderValue(prov.run_id), document.createTextNode(" · Attempt: "), renderValue(prov.attempt_id));
      const evDiv = el("div", undefined, { class: "grey-text text-darken-3" });
      evDiv.append(document.createTextNode("Evidence: "), renderValue(prov.evidence_ref));
      provCell.append(evDiv);

      const outCell = el("div");
      outCell.append(statusPill(p.outcome), el("div", p.outcome_explanation, { class: "grey-text text-darken-3" }));
      if (p.rejection_reason) outCell.append(el("div", `Rejection reason: ${p.rejection_reason}`, { class: "grey-text text-darken-3" }));
      if (Array.isArray(p.conflicting_ids) && p.conflicting_ids.length) outCell.append(el("div", `Conflicts: ${p.conflicting_ids.join(", ")}`));

      const syncCell = el("div");
      syncCell.append(isAbsenceObject(p.file_sync_state) ? absenceNode(p.file_sync_state) : statusPill(p.file_sync_state));
      if (p.file_sync_state_explanation && !isAbsenceObject(p.file_sync_state)) {
        syncCell.append(el("div", p.file_sync_state_explanation, { class: "grey-text text-darken-3" }));
      }

      const idInfo = el("div");
      idInfo.append(el("div", p.action), el("div", `Ref: ${p.reference || "—"}`, { class: "grey-text text-darken-3" }));
      if (p.target_constraint_id) idInfo.append(el("div", `Target: ${p.target_constraint_id}`, { class: "grey-text text-darken-3" }));
      if (p.assigned_constraint_id) idInfo.append(el("div", `Assigned: ${p.assigned_constraint_id}`, { class: "grey-text text-darken-3" }));

      const verif = resolveBooleanVerification(p.uncertain);
      const uncCell = p.uncertain === true && p.uncertainty
        ? symbolChipWithText(resolveStatusMeta(verif.status, verif.label), p.uncertainty)
        : statusPill(verif.status, verif.label);
      return [
        { asRowHeader: true, content: el("code", p.proposal_id) },
        idInfo,
        el("span", p.text),
        provCell,
        outCell,
        syncCell,
        uncCell,
      ];
    }),
  ));
}

function render(view, data, errorInfo) {
  if (view !== "live" || errorInfo || !state.selectedFactoryId) {
    state.liveDom = null;
    dom.content.setAttribute("aria-live", "polite");
    dom.content.replaceChildren();
  }
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

async function fetchJsonStrict(url, externalSignal, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const effectiveTimeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : FETCH_TIMEOUT_MS;
  let timedOut = false;
  const handleExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      const abortErr = new Error("Request aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    externalSignal.addEventListener("abort", handleExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeout);

  let res;
  let rawText;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    rawText = await res.text();
  } catch (err) {
    if (timedOut) {
      throw {
        status: null,
        timedOut: true,
        message: "Request timed out",
        detail: `Request to ${url} timed out after ${Math.round(effectiveTimeout / 1000)}s.`,
      };
    }
    if (err && err.name === "AbortError") throw err;
    throw {
      status: null,
      message: err?.message || "Network error",
      detail: `Unable to fetch ${url} from the local viewer.`,
    };
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", handleExternalAbort);
  }

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
  state.factoriesStatus = "loading";
  state.factoriesAbsence = null;
  state.factoriesError = null;
  renderSidebarFactories();
  try {
    const payload = await fetchJsonStrict("/api/factories");
    if (Array.isArray(payload)) {
      state.factories = payload;
      state.deletedFactories = [];
      state.damagedFactories = [];
      state.factoriesAbsence = null;
    } else if (payload && typeof payload === "object" && isAbsenceObject(payload)) {
      state.factories = Array.isArray(payload.factories)
        ? payload.factories
        : (Array.isArray(payload.records) ? payload.records : []);
      state.deletedFactories = Array.isArray(payload.deleted) ? payload.deleted : [];
      state.damagedFactories = Array.isArray(payload.damaged) ? payload.damaged : [];
      state.factoriesAbsence = payload;
    } else if (
      payload
      && typeof payload === "object"
      && Array.isArray(payload.factories)
      && (payload.deleted === undefined || Array.isArray(payload.deleted))
      && (payload.damaged === undefined || Array.isArray(payload.damaged))
    ) {
      state.factories = payload.factories;
      state.deletedFactories = Array.isArray(payload.deleted) ? payload.deleted : [];
      state.damagedFactories = Array.isArray(payload.damaged) ? payload.damaged : [];
      state.factoriesAbsence = null;
    } else {
      throw { status: null, message: "Invalid factories list", detail: "Expected factories list object or JSON array from /api/factories." };
    }
    state.factoriesStatus = "loaded";
    state.factoriesError = null;
  } catch (err) {
    state.factories = [];
    state.deletedFactories = [];
    state.damagedFactories = [];
    state.factoriesAbsence = null;
    state.factoriesStatus = "error";
    state.factoriesError = {
      status: err?.status ?? null,
      timedOut: Boolean(err?.timedOut),
      message: err?.message || "Failed to load factories list.",
      detail: err?.detail || "",
    };
  }
  renderSidebarFactories();
  updateChrome();
  if (state.activeView === "factories") {
    dom.content.setAttribute("aria-busy", "false");
    render("factories", null, null);
  } else if (state.activeView === "receipts" && !state.receiptReference && state.selectedFactoryId) {
    render("receipts", null, null);
  }
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

function clearPollTimer() {
  if (state.livePollTimer !== null) {
    clearTimeout(state.livePollTimer);
    state.livePollTimer = null;
  }
}

function getPollStateSnapshot() {
  return {
    activeView: state.activeView,
    selectedFactoryId: state.selectedFactoryId,
    hidden: Boolean(document.hidden),
    inFlight: state.liveInFlight,
    hasPendingTimer: state.livePollTimer !== null,
  };
}

function applyLivePollAction(action) {
  if (!action) return;
  if (action.cancelTimer) clearPollTimer();
  if (action.action === "cancel-timer") {
    clearPollTimer();
    return;
  }
  if (action.action === "schedule-timer") {
    clearPollTimer();
    state.livePollTimer = setTimeout(() => {
      state.livePollTimer = null;
      const next = computeNextPollAction(getPollStateSnapshot(), { type: "timer-fired" });
      applyLivePollAction(next);
    }, action.delayMs || LIVE_POLL_INTERVAL_MS);
    return;
  }
  if (action.action === "fetch-now") {
    void fetchLiveView({ isPoll: true });
  }
}

async function fetchLiveView({ isPoll }) {
  if (isPoll && state.liveInFlight) return;
  if (state.activeView !== "live" || !state.selectedFactoryId) return;
  const url = buildApiUrlForCurrentState();
  if (!url) return;

  if (!isPoll && state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  const seq = ++state.requestSeq;
  const reqFactory = state.selectedFactoryId;
  const reqView = state.activeView;

  if (state.liveSession.factoryId !== reqFactory) {
    state.liveSession = createLiveSessionState(reqFactory);
    state.liveDom = null;
  }
  if (!isPoll && !state.liveSession.lastGood) {
    state.liveDom = null;
    dom.content.setAttribute("aria-live", "polite");
    dom.content.replaceChildren(el("p", "Loading Live Graph…"));
    dom.content.setAttribute("aria-busy", "true");
  }

  state.liveInFlight = true;
  applyLivePollAction(computeNextPollAction(getPollStateSnapshot(), { type: "sync" }));

  const controller = new AbortController();
  state.controller = controller;
  try {
    const data = await fetchJsonStrict(url, controller.signal);
    if (seq !== state.requestSeq || reqFactory !== state.selectedFactoryId || reqView !== state.activeView) return;
    const outcome = reduceLiveFetchOutcome(state.liveSession, {
      kind: "success",
      data,
      receivedAt: new Date().toISOString(),
    });
    state.liveSession = outcome.session;
    if (state.liveSession.lastGood) {
      mountOrPatchLiveView(state.liveSession.lastGood, outcome.transition, state.liveSession.stale);
    } else if (state.liveSession.error) {
      render("live", null, state.liveSession.error);
    }
  } catch (err) {
    if (err && err.name === "AbortError") return;
    if (seq !== state.requestSeq || reqFactory !== state.selectedFactoryId || reqView !== state.activeView) return;
    const outcome = reduceLiveFetchOutcome(state.liveSession, {
      kind: "error",
      status: err?.status ?? null,
      timedOut: Boolean(err?.timedOut),
      message: err?.message,
      detail: err?.detail,
      receivedAt: new Date().toISOString(),
    });
    state.liveSession = outcome.session;
    if (state.liveSession.lastGood) {
      mountOrPatchLiveView(state.liveSession.lastGood, outcome.transition, state.liveSession.stale);
    } else if (state.liveSession.error) {
      render("live", null, state.liveSession.error);
    }
  } finally {
    if (seq === state.requestSeq) {
      dom.content.setAttribute("aria-busy", "false");
      if (state.controller === controller) state.controller = null;
      state.liveInFlight = false;
      if (reqFactory === state.selectedFactoryId && reqView === state.activeView) {
        applyLivePollAction(computeNextPollAction(getPollStateSnapshot(), { type: "fetch-finished" }));
      }
    }
  }
}

async function loadCurrentView() {
  clearPollTimer();
  const reqFactory = state.selectedFactoryId;
  const reqView = state.activeView;
  if (reqView !== "live" || !state.liveDom || state.liveDom.factoryId !== reqFactory) {
    abortOutputRequest();
  }
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  state.liveInFlight = false;

  updateChrome();
  renderSidebarFactories();

  if (reqView === "live" && reqFactory) {
    await fetchLiveView({ isPoll: false });
    return;
  }

  state.liveSession = createLiveSessionState("");
  state.liveDom = null;
  const seq = ++state.requestSeq;

  if (reqView === "factories") {
    dom.content.setAttribute("aria-busy", state.factoriesStatus === "loading" ? "true" : "false");
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
  dom.content.setAttribute("aria-live", "polite");
  dom.content.replaceChildren(el("p", `Loading ${getViewLabel(reqView, reqView)}…`));
  dom.content.setAttribute("aria-busy", "true");

  const controller = new AbortController();
  state.controller = controller;
  try {
    const data = await fetchJsonStrict(url, controller.signal);
    if (seq !== state.requestSeq || reqFactory !== state.selectedFactoryId || reqView !== state.activeView) return;
    if (!matchesSelectedFactory(data, reqFactory)) {
      render(reqView, null, {
        status: null,
        title: "Response did not match the selected factory",
        detail: `Expected factory "${reqFactory}" but received "${typeof data?.factory_id === "string" ? data.factory_id : "missing"}".`,
      });
      return;
    }
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
  const prevView = state.activeView;
  state.selectedFactoryId = VALID_ID.test(facParam) ? facParam : "";

  const viewParam = sp.get("view") || "";
  if (VALID_VIEWS.has(viewParam)) {
    state.activeView = viewParam;
  } else {
    state.activeView = state.selectedFactoryId ? "live" : "factories";
  }

  if (state.selectedFactoryId !== prevFactory || state.activeView !== "live" || prevView !== state.activeView) {
    clearPollTimer();
    state.selectedGraphNodeId = state.selectedFactoryId !== prevFactory ? "" : state.selectedGraphNodeId;
    if (state.selectedFactoryId !== prevFactory || state.activeView !== "live") {
      state.liveSession = createLiveSessionState(state.activeView === "live" ? state.selectedFactoryId : "");
      state.liveDom = null;
    }
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
    tab.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const targetView = tab.dataset.view;
      if (!targetView || !VALID_VIEWS.has(targetView)) return;
      const href = tabHrefForView(targetView);
      if (!href) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      navigateToUrl(href, true);
    });
  }

  dom.menuToggle?.addEventListener("click", () => {
    const isOpen = dom.sidebar?.classList.contains("open");
    setDrawerOpen(!isOpen, isOpen ? "toggle" : "none");
  });
  dom.drawerClose?.addEventListener("click", () => setDrawerOpen(false, "toggle"));
  dom.drawerBackdrop?.addEventListener("click", () => setDrawerOpen(false, "toggle"));

  document.addEventListener("keydown", (e) => {
    if (!dom.sidebar?.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setDrawerOpen(false, "toggle");
      return;
    }
    if (e.key === "Tab" && isNarrowViewport()) {
      const focusables = getSidebarFocusables();
      if (!focusables.length) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!dom.sidebar.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  if (window.matchMedia) {
    const mql = window.matchMedia("(max-width: 992px)");
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", () => {
        syncDrawerForViewport();
        updateTabIndicator();
      });
    }
  }
  window.addEventListener("resize", () => {
    syncDrawerForViewport();
    updateTabIndicator();
  });

  window.addEventListener("popstate", () => {
    applyUrlParams(window.location.search);
    loadCurrentView();
  });

  document.addEventListener("visibilitychange", () => {
    const action = computeNextPollAction(getPollStateSnapshot(), {
      type: "visibility-change",
      hidden: Boolean(document.hidden),
    });
    applyLivePollAction(action);
  });
}

initEventHandlers();
syncDrawerForViewport();
applyUrlParams(window.location.search);
loadFactoriesList();
loadCurrentView();
