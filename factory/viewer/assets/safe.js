/* Pure safety, label-mapping, absence-resolution, and validation helpers for the Factory Web Viewer.
   Loaded before app.js in the browser and also executable directly in node:vm unit tests. */
(function (root) {
  "use strict";

  function freezeSet(values) {
    const set = new Set(values);
    const blocked = () => { throw new TypeError("Cannot mutate frozen Set"); };
    Object.defineProperties(set, {
      add: { value: blocked, enumerable: false },
      delete: { value: blocked, enumerable: false },
      clear: { value: blocked, enumerable: false },
    });
    return Object.freeze(set);
  }

  function freezeNullProtoMap(entries) {
    const map = Object.create(null);
    for (const [k, v] of Object.entries(entries)) {
      map[k] = v && typeof v === "object" ? Object.freeze({ ...v }) : v;
    }
    return Object.freeze(map);
  }

  const VALID_ID = Object.freeze(/^[A-Za-z0-9_-]{1,128}$/);
  const VALID_VERSION = Object.freeze(/^v[1-9][0-9]*$/);
  const VALID_VIEWS = freezeSet(["factories", "live", "inspect", "queue", "receipts", "requests", "proposals"]);

  const PAGE_OWNED_IDS = freezeSet([
    "menu-toggle",
    "drawer-close",
    "drawer-backdrop",
    "sidebar",
    "factories-list",
    "main-content",
    "view-heading",
    "factory-subtitle",
    "header-scope",
    "content",
    "inspect-version-select",
    "receipt-ref-input",
    "arrow-solid",
    "arrow-partial",
    "arrow-feedback",
  ]);

  const VIEW_LABELS = freezeNullProtoMap({
    factories: "Factories",
    live: "Live Graph",
    inspect: "Inspect",
    queue: "Queue",
    receipts: "Receipts",
    requests: "Requests",
    proposals: "Proposals",
  });

  const STATUS_META = freezeNullProtoMap({
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
  });

  const ABSENCE_META = freezeNullProtoMap({
    "no records": { symbol: "○", label: "No records", tone: "tone-muted" },
    "not applicable": { symbol: "—", label: "Not applicable", tone: "tone-muted" },
    "evidence unavailable": { symbol: "!", label: "Evidence unavailable", tone: "tone-error" },
  });

  const BANNER_EXTRA_META = freezeNullProtoMap({
    info: { symbol: "ℹ", label: "Info", tone: "tone-info" },
  });

  function resolveOrigin(baseOrigin) {
    if (typeof baseOrigin === "string" && baseOrigin && baseOrigin !== "null") {
      return baseOrigin;
    }
    if (root && root.location && typeof root.location.origin === "string" && root.location.origin && root.location.origin !== "null") {
      return root.location.origin;
    }
    return "";
  }

  function validateRelativeHrefOnce(raw, origin) {
    if (typeof raw !== "string") return null;
    if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//")) return null;
    if (!trimmed.startsWith("/") && !trimmed.startsWith("?")) return null;
    try {
      const parsed = new URL(trimmed, origin);
      if (parsed.origin !== origin) return null;
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      if (parsed.pathname.startsWith("//")) return null;
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return null;
    }
  }

  function safeHref(raw, baseOrigin) {
    const origin = resolveOrigin(baseOrigin);
    if (!origin) return null;
    const normalized = validateRelativeHrefOnce(raw, origin);
    if (!normalized) return null;
    const revalidated = validateRelativeHrefOnce(normalized, origin);
    if (!revalidated || revalidated !== normalized) return null;
    return revalidated;
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

  function pageUrlFromApiOrHref(rawUrl, baseOrigin) {
    const checked = safeHref(rawUrl, baseOrigin);
    if (!checked) return null;
    const origin = resolveOrigin(baseOrigin);
    if (!origin) return null;
    try {
      const parsed = new URL(checked, origin);
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

  function getViewLabel(view, fallback) {
    if (typeof view === "string" && Object.hasOwn(VIEW_LABELS, view)) {
      return VIEW_LABELS[view];
    }
    if (typeof view === "string" && view.trim()) {
      return fallback || `Unknown: ${view}`;
    }
    return fallback || "Unknown (not provided)";
  }

  function resolveStatusMeta(value, labelOverride) {
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      return { symbol: "?", label: "Unknown (not provided)", tone: "tone-warn", isKnown: false };
    }
    const raw = String(value);
    const key = raw.toLowerCase();
    if (Object.hasOwn(STATUS_META, key)) {
      const meta = STATUS_META[key];
      return {
        symbol: meta.symbol,
        label: labelOverride || meta.label,
        tone: meta.tone,
        isKnown: true,
      };
    }
    return {
      symbol: "?",
      label: `Unknown: ${raw}`,
      tone: "tone-warn",
      isKnown: false,
    };
  }

  function resolveAbsenceMeta(value) {
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      const fallback = ABSENCE_META["evidence unavailable"];
      return { symbol: fallback.symbol, label: fallback.label, tone: fallback.tone, isKnown: true };
    }
    const raw = String(value);
    if (Object.hasOwn(ABSENCE_META, raw)) {
      const meta = ABSENCE_META[raw];
      return { symbol: meta.symbol, label: meta.label, tone: meta.tone, isKnown: true };
    }
    return { symbol: "?", label: `Unknown: ${raw}`, tone: "tone-warn", isKnown: false };
  }

  function resolveBannerMeta(pillKey, pillLabel) {
    if (pillKey === null || pillKey === undefined || (typeof pillKey === "string" && pillKey.trim() === "")) {
      return { symbol: "?", label: pillLabel || "Unknown (not provided)", tone: "tone-warn", isKnown: false };
    }
    const raw = String(pillKey);
    const key = raw.toLowerCase();
    if (Object.hasOwn(STATUS_META, key)) {
      const meta = STATUS_META[key];
      return { symbol: meta.symbol, label: pillLabel || meta.label, tone: meta.tone, isKnown: true };
    }
    if (Object.hasOwn(ABSENCE_META, raw)) {
      const meta = ABSENCE_META[raw];
      return { symbol: meta.symbol, label: pillLabel || meta.label, tone: meta.tone, isKnown: true };
    }
    if (Object.hasOwn(BANNER_EXTRA_META, key)) {
      const meta = BANNER_EXTRA_META[key];
      return { symbol: meta.symbol, label: pillLabel || meta.label, tone: meta.tone, isKnown: true };
    }
    return { symbol: "?", label: pillLabel || `Unknown: ${raw}`, tone: "tone-warn", isKnown: false };
  }

  function resolveLiveAbsence(data) {
    const stateVal = typeof data?.state === "string" && data.state.trim() ? data.state : "uncertain";
    const runAbsence = typeof data?.run?.absence === "string" && data.run.absence.trim() ? data.run.absence : null;
    if (runAbsence) return runAbsence;
    const graphAbsence = typeof data?.graph?.absence === "string" && data.graph.absence.trim() ? data.graph.absence : null;
    if (graphAbsence) return graphAbsence;
    const topAbsence = typeof data?.absence === "string" && data.absence.trim() ? data.absence : null;
    if (topAbsence) return topAbsence;
    if (stateVal === "uncertain" || data?.graph?.evidence === "unavailable" || data?.evidence === "unavailable") {
      return "evidence unavailable";
    }
    return "evidence unavailable";
  }

  function resolveLiveRunIdentityAbsence(data) {
    if (isAbsenceObject(data?.run)) {
      return {
        absence: data.run.absence,
        explanation: typeof data.run.explanation === "string" ? data.run.explanation : undefined,
      };
    }
    const absence = resolveLiveAbsence(data);
    const defaultExplanation = absence === "evidence unavailable"
      ? "Run identity evidence is unavailable."
      : absence === "not applicable"
        ? "No released run applies."
        : "No active or retained run identity.";
    return {
      absence,
      explanation: (typeof data?.run?.explanation === "string" && data.run.explanation)
        || (typeof data?.graph?.explanation === "string" && data.graph.explanation)
        || defaultExplanation,
    };
  }

  function resolveLiveBoundVersionAbsence(data) {
    if (isAbsenceObject(data?.run?.bound_version)) {
      return {
        absence: data.run.bound_version.absence,
        explanation: typeof data.run.bound_version.explanation === "string" ? data.run.bound_version.explanation : undefined,
      };
    }
    if (isAbsenceObject(data?.graph?.bound_version)) {
      return {
        absence: data.graph.bound_version.absence,
        explanation: typeof data.graph.bound_version.explanation === "string" ? data.graph.bound_version.explanation : undefined,
      };
    }
    const absence = resolveLiveAbsence(data);
    const defaultExplanation = absence === "evidence unavailable"
      ? "Bound version evidence is unavailable."
      : absence === "not applicable"
        ? "No released run is mounted."
        : "No bound version is recorded.";
    return {
      absence,
      explanation: (typeof data?.run?.explanation === "string" && data.run.explanation)
        || (typeof data?.graph?.explanation === "string" && data.graph.explanation)
        || defaultExplanation,
    };
  }

  function safeNodeDomId(anchor, nodeId) {
    const raw = (typeof anchor === "string" && anchor.trim())
      ? anchor.trim()
      : ((typeof nodeId === "string" && nodeId.trim()) ? nodeId.trim() : "");
    if (!raw) return "n-_";
    let encoded = "";
    for (const ch of raw) {
      if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-") {
        encoded += ch;
      } else {
        encoded += `_${ch.codePointAt(0).toString(16)}_`;
      }
    }
    return `n-${encoded}`;
  }

  function matchesSelectedFactory(data, selectedFactoryId) {
    return Boolean(
      selectedFactoryId
      && data
      && typeof data === "object"
      && typeof data.factory_id === "string"
      && data.factory_id === selectedFactoryId
    );
  }

  function resolveStopStateValue(stop) {
    if (isAbsenceObject(stop)) {
      return { kind: "absence", value: stop };
    }
    if (stop && typeof stop === "object") {
      if (typeof stop.state === "string" && stop.state.trim()) {
        return { kind: "status", value: stop.state };
      }
      if (typeof stop.stopped === "boolean") {
        return { kind: "status", value: stop.stopped ? "stopped" : "active" };
      }
    }
    return { kind: "status", value: undefined };
  }

  function resolveInspectOverallEvidence(data) {
    if (data && typeof data === "object" && typeof data.evidence === "string" && data.evidence.trim()) {
      return data.evidence;
    }
    return undefined;
  }

  function resolveBooleanVerification(uncertain) {
    if (typeof uncertain === "boolean") {
      return uncertain
        ? { status: "uncertain", label: "Uncertain" }
        : { status: "available", label: "Verified" };
    }
    return { status: undefined, label: undefined };
  }

  function resolveSnapshotEvidence(data) {
    if (data && typeof data === "object" && typeof data.evidence === "string" && data.evidence.trim()) {
      return data.evidence === "unavailable" ? "unavailable" : data.evidence;
    }
    return undefined;
  }

  function resolveSidebarManagementLabel(management) {
    if (management === "managed") return "● Managed";
    if (management === "unmanaged") return "○ Unmanaged";
    if (typeof management === "string" && management.trim()) return `? Unknown: ${management}`;
    return "? Unknown (not provided)";
  }

  function resolveRestoredFromDisplay(restoredFrom) {
    if (isAbsenceObject(restoredFrom)) {
      return { kind: "absence", value: restoredFrom };
    }
    if (restoredFrom && typeof restoredFrom === "object") {
      const text = (typeof restoredFrom.explanation === "string" && restoredFrom.explanation)
        || (typeof restoredFrom.version === "string" && restoredFrom.version);
      if (text) return { kind: "text", text };
    }
    return {
      kind: "absence",
      value: { absence: "evidence unavailable", explanation: "Restore provenance was not provided." },
    };
  }

  function resolveBlockingHoldDisplay(blockingHold) {
    if (isAbsenceObject(blockingHold)) {
      return { kind: "absence", value: blockingHold };
    }
    if (blockingHold && typeof blockingHold === "object" && typeof blockingHold.explanation === "string" && blockingHold.explanation) {
      return { kind: "text", text: blockingHold.explanation };
    }
    return {
      kind: "absence",
      value: { absence: "evidence unavailable", explanation: "Blocking hold details were not provided." },
    };
  }

  function resolveHeadEligibility(head) {
    const eligibleKnown = typeof head?.eligible === "boolean";
    const eligibleStatus = eligibleKnown ? (head.eligible ? "available" : "blocked") : undefined;
    const eligibleLabel = eligibleKnown ? (head.eligible ? "Eligible" : "Not eligible") : undefined;
    let blockingKind = "status";
    let blockingStatus;
    let blockingLabel;
    let blockingText = null;
    if (typeof head?.blocking_kind === "string" && head.blocking_kind.trim()) {
      blockingStatus = head.blocking_kind === "empty" ? "idle" : "blocked";
      blockingLabel = head.blocking_kind;
    } else if (head?.eligible === true) {
      blockingKind = "text";
      blockingText = "None";
    } else {
      blockingStatus = undefined;
      blockingLabel = undefined;
    }
    return { eligibleStatus, eligibleLabel, blockingKind, blockingStatus, blockingLabel, blockingText };
  }

  function resolveEmptyCollectionBanner(data, evidence, noRecordsText) {
    const absence = typeof data?.absence === "string" && data.absence.trim() ? data.absence.trim() : null;
    const exp = typeof data?.explanation === "string" && data.explanation.trim() ? data.explanation : null;
    if (absence) {
      const defaultText = absence === "no records"
        ? (noRecordsText || "No records.")
        : (absence === "not applicable" ? "Not applicable." : "Evidence unavailable.");
      return Object.freeze({ pillKey: absence, reason: exp || defaultText });
    }
    if (evidence === "unavailable" || data?.evidence === "unavailable") {
      return Object.freeze({ pillKey: "evidence unavailable", reason: exp || "Evidence unavailable." });
    }
    return Object.freeze({ pillKey: undefined, reason: exp || "Unknown (not provided)" });
  }

  function resolveLiveGraphBanner(data, stateVal) {
    const graph = data?.graph && typeof data.graph === "object" ? data.graph : null;
    const effectiveState = typeof stateVal === "string" && stateVal.trim() ? stateVal : "uncertain";
    if (graph) {
      const abs = typeof graph.absence === "string" && graph.absence.trim() ? graph.absence.trim() : null;
      const exp = typeof graph.explanation === "string" && graph.explanation.trim() ? graph.explanation : null;
      if (abs) {
        const defaultExp = abs === "no records"
          ? "No records."
          : (abs === "not applicable" ? "Run graph is not applicable." : "Run graph evidence is unavailable.");
        return Object.freeze({ pillKey: abs, reason: exp || defaultExp });
      }
      if (graph.evidence === "unavailable" || effectiveState === "uncertain" || data?.evidence === "unavailable") {
        return Object.freeze({ pillKey: "evidence unavailable", reason: exp || "Run graph evidence is unavailable." });
      }
      return Object.freeze({ pillKey: undefined, reason: exp || "Unknown (not provided)" });
    }
    const topReason = typeof data?.reason === "string" && data.reason.trim() ? data.reason : null;
    if (effectiveState === "uncertain" || data?.evidence === "unavailable") {
      return Object.freeze({ pillKey: "evidence unavailable", reason: topReason || "Run graph evidence is unavailable." });
    }
    if (typeof data?.absence === "string" && data.absence.trim()) {
      return Object.freeze({ pillKey: data.absence.trim(), reason: topReason || "Unknown (not provided)" });
    }
    return Object.freeze({ pillKey: undefined, reason: "Unknown (not provided)" });
  }

  function resolveUnexpectedReceiptBanner(data) {
    const exp = typeof data?.explanation === "string" && data.explanation.trim() ? data.explanation : null;
    if (data && isAbsenceObject(data)) {
      return Object.freeze({ pillKey: data.absence, reason: exp || "Receipt evidence is unavailable." });
    }
    if (data && data.evidence === "unavailable") {
      return Object.freeze({ pillKey: "evidence unavailable", reason: exp || "Receipt evidence is unavailable." });
    }
    return Object.freeze({ pillKey: undefined, reason: exp || "Unknown (not provided)" });
  }

  root.FactoryViewerSafe = Object.freeze({
    VALID_ID,
    VALID_VERSION,
    VALID_VIEWS,
    PAGE_OWNED_IDS,
    VIEW_LABELS,
    STATUS_META,
    ABSENCE_META,
    safeHref,
    pageUrl,
    pageUrlFromApiOrHref,
    isAbsenceObject,
    getViewLabel,
    resolveStatusMeta,
    resolveAbsenceMeta,
    resolveBannerMeta,
    resolveLiveAbsence,
    resolveLiveRunIdentityAbsence,
    resolveLiveBoundVersionAbsence,
    safeNodeDomId,
    matchesSelectedFactory,
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
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
