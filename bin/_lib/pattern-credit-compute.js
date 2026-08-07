'use strict';

/**
 * pattern-credit-compute.js — pure join over offer/ack ledger slices that
 * implements the §5 structural bounds (design:
 * pattern-application-evidence-design.md §4.3, §5, §11).
 *
 * No I/O. bin/commit-pattern-applications.js is the only caller; it does the
 * ledger reads, event-slice read, and the frontmatter/journal writes. Kept
 * separate from bin/_lib/pattern-evidence-ledger.js per that module's own
 * header note: computeCredits is Phase-3 business logic, not a read/write
 * primitive, and belongs beside the committer.
 *
 * Row shapes consumed (see bin/record-pattern-offers.js and
 * bin/validate-pattern-ack.js for the producers):
 *   offer row: { orchestration_id, spawn_id, agent_role, task_id,
 *                offers: [{ slug, offer_kind: 'curated'|'ambient', confidence }] }
 *   ack row:   { orchestration_id, spawn_id, agent_role, task_id,
 *                source: 'structured_result'|'self_report',
 *                used: [{ slug, how_len }], rejected: [{ slug, why_len }],
 *                agent_status }
 *   orch event: any row from events.jsonl already filtered to this
 *                orchestration_id — only `type`, `agent_type`/`agent_role`,
 *                `task_id`, `tasks_invalidated` are read.
 *
 * `spawn_id` is load-bearing: §5.1's closed set, §5.3's used_and_rejected and
 * §5.4's ambient gate are all per-spawn rules. Rows without one are treated as
 * unattributed — they still count as offers, but earn no `observed` credit.
 */

const DEFAULT_CONFIG = {
  max_credits_per_orchestration: 5,
  max_self_report_per_orchestration: 2,
  min_how_length: 10,
  ambient_promotion: { enabled: true, min_how_length: 40, max_per_spawn: 1 },
};

function mergeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const ap = c.ambient_promotion && typeof c.ambient_promotion === 'object' ? c.ambient_promotion : {};
  return {
    max_credits_per_orchestration: numOr(c.max_credits_per_orchestration, DEFAULT_CONFIG.max_credits_per_orchestration),
    max_self_report_per_orchestration: numOr(c.max_self_report_per_orchestration, DEFAULT_CONFIG.max_self_report_per_orchestration),
    min_how_length: numOr(c.min_how_length, DEFAULT_CONFIG.min_how_length),
    ambient_promotion: {
      enabled: ap.enabled !== undefined ? !!ap.enabled : DEFAULT_CONFIG.ambient_promotion.enabled,
      min_how_length: numOr(ap.min_how_length, DEFAULT_CONFIG.ambient_promotion.min_how_length),
      max_per_spawn: numOr(ap.max_per_spawn, DEFAULT_CONFIG.ambient_promotion.max_per_spawn),
    },
  };
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Non-empty string spawn ids only — anything else is "unattributed". */
function normSpawnId(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Offer indexing
// ---------------------------------------------------------------------------

function indexOffers(offers) {
  const offersBySpawn = new Map();       // spawn_id -> Map<slug, {offer_kind, confidence}>
  const offeredSpawnsBySlug = new Map(); // slug -> Set<spawn_id>
  const offerKindBySlug = new Map();     // slug -> 'curated'|'ambient' (curated wins)

  for (const row of Array.isArray(offers) ? offers : []) {
    if (!row || !Array.isArray(row.offers)) continue;
    const spawnId = normSpawnId(row.spawn_id);
    // §5.1 — an offer row with no spawn_id cannot be attributed to a spawn, so
    // it is NOT joinable for observed credit; bucketing them all under one
    // `null` key made every slug offered anywhere creditable from anywhere
    // (RV-1 E4). It still counts as an offer (times_offered / no_ack).
    let spawnMap = null;
    if (spawnId) {
      if (!offersBySpawn.has(spawnId)) offersBySpawn.set(spawnId, new Map());
      spawnMap = offersBySpawn.get(spawnId);
    }
    for (const o of row.offers) {
      if (!o || typeof o.slug !== 'string') continue;
      if (spawnMap) spawnMap.set(o.slug, { offer_kind: o.offer_kind, confidence: o.confidence });

      if (!offeredSpawnsBySlug.has(o.slug)) offeredSpawnsBySlug.set(o.slug, new Set());
      offeredSpawnsBySlug.get(o.slug).add(spawnId);

      const existingKind = offerKindBySlug.get(o.slug);
      if (existingKind !== 'curated') offerKindBySlug.set(o.slug, o.offer_kind);
    }
  }
  return { offersBySpawn, offeredSpawnsBySlug, offerKindBySlug };
}

// ---------------------------------------------------------------------------
// Event-slice indexing (E3/E4)
// ---------------------------------------------------------------------------

function indexOrchEvents(orchEvents) {
  const routingAgentTypes = new Set();
  const invalidatedTaskIds = new Set();
  const failedTaskIds = new Set();

  for (const ev of Array.isArray(orchEvents) ? orchEvents : []) {
    if (!ev || typeof ev !== 'object') continue;
    const t = ev.type || ev.event_type;
    if (t === 'routing_outcome') {
      if (typeof ev.agent_type === 'string') routingAgentTypes.add(ev.agent_type);
    } else if (t === 'replan') {
      if (Array.isArray(ev.tasks_invalidated)) {
        for (const tid of ev.tasks_invalidated) if (typeof tid === 'string') invalidatedTaskIds.add(tid);
      }
    } else if (t === 'verify_fix_fail' || t === 'verify_fix_oscillation') {
      if (typeof ev.task_id === 'string') failedTaskIds.add(ev.task_id);
    }
  }
  return { routingAgentTypes, invalidatedTaskIds, failedTaskIds };
}

// ---------------------------------------------------------------------------
// Candidate collection from ack rows
// ---------------------------------------------------------------------------

/**
 * @returns {{ candidates: object[], earlyWithheld: object[], usedSlugsGlobal: Set<string>,
 *             rejectedSlugsGlobal: Set<string> }}
 */
function collectCandidates(acks, offersBySpawn, cfg) {
  const candidates = [];
  const earlyWithheld = [];
  const usedSlugsGlobal = new Set();
  const rejectedSlugsGlobal = new Set();

  // §5.3 and §5.4 are per-SPAWN rules, so the rows of one spawn are evaluated
  // together — evaluating them row-by-row let a claim split across two ack
  // rows earn credit the same claim in one row is denied (RV-1 E2/E3).
  for (const group of groupAcksBySpawn(acks)) {
    const { spawnId, rows } = group;
    const spawnOfferMap = (spawnId && offersBySpawn.get(spawnId)) || new Map();

    // Union of everything this spawn rejected, across all of its ack rows.
    const rejectedSlugs = new Set();
    for (const row of rows) {
      for (const r of Array.isArray(row.rejected) ? row.rejected : []) {
        if (r && typeof r.slug === 'string') {
          rejectedSlugs.add(r.slug);
          rejectedSlugsGlobal.add(r.slug);
        }
      }
    }

    // §5.4's "only one ambient slug so named" gate — distinct ambient slugs
    // this spawn named with sufficient prose, across all of its ack rows.
    const ambientNamed = new Set();
    for (const row of rows) {
      if (row.source === 'self_report') continue;
      for (const u of Array.isArray(row.used) ? row.used : []) {
        if (!u || typeof u.slug !== 'string') continue;
        const offerInfo = spawnOfferMap.get(u.slug);
        if (offerInfo && offerInfo.offer_kind === 'ambient' &&
            (u.how_len || 0) >= cfg.ambient_promotion.min_how_length) {
          ambientNamed.add(u.slug);
        }
      }
    }

    for (const row of rows) {
      const isSelfReport = row.source === 'self_report';
      const used = Array.isArray(row.used) ? row.used : [];

      for (const u of used) {
        if (!u || typeof u.slug !== 'string') continue;
        const slug = u.slug;
        usedSlugsGlobal.add(slug);
        const howLen = typeof u.how_len === 'number' ? u.how_len : 0;

        // §5.3 malformed: same spawn names it in both used and rejected.
        if (rejectedSlugs.has(slug)) {
          earlyWithheld.push({ slug, reason: 'used_and_rejected', offer_kind: offerKindOf(spawnOfferMap, slug), spawn_ids: spawnId ? [spawnId] : [] });
          continue;
        }

        if (isSelfReport) {
          candidates.push({
            slug, spawn_id: null, agent_role: null, task_id: row.task_id || null,
            how_len: howLen, offer_kind: null, evidence_grade: 'self_report',
            agent_status: row.agent_status || null,
          });
          continue;
        }

        // E1 — closed-set matching.
        const offerInfo = spawnOfferMap.get(slug);
        if (!offerInfo) {
          earlyWithheld.push({ slug, reason: 'not_offered', offer_kind: null, spawn_ids: spawnId ? [spawnId] : [] });
          continue;
        }

        // E2 — minimum prose length (Structured Result contract already
        // enforces 10-300; re-checked here defensively).
        if (howLen < cfg.min_how_length) {
          earlyWithheld.push({ slug, reason: 'how_too_short', offer_kind: offerInfo.offer_kind, spawn_ids: spawnId ? [spawnId] : [] });
          continue;
        }

        // §5.4 — ambient offers are not application-eligible by default.
        if (offerInfo.offer_kind === 'ambient') {
          const promoted = cfg.ambient_promotion.enabled &&
            howLen >= cfg.ambient_promotion.min_how_length &&
            ambientNamed.size <= cfg.ambient_promotion.max_per_spawn;
          if (!promoted) {
            earlyWithheld.push({ slug, reason: 'ambient_not_promoted', offer_kind: 'ambient', spawn_ids: spawnId ? [spawnId] : [] });
            continue;
          }
        }

        candidates.push({
          slug, spawn_id: spawnId, agent_role: row.agent_role || null, task_id: row.task_id || null,
          how_len: howLen, offer_kind: offerInfo.offer_kind, evidence_grade: 'observed',
          agent_status: row.agent_status || null,
        });
      }
    }
  }

  return { candidates, earlyWithheld, usedSlugsGlobal, rejectedSlugsGlobal };
}

/**
 * Ack rows bucketed by spawn, in first-appearance order. A row with no
 * spawn_id is unattributed: it becomes its own group rather than merging with
 * unrelated rows (and cannot reach a spawn's offer map — see indexOffers).
 *
 * @returns {Array<{spawnId: string|null, rows: object[]}>}
 */
function groupAcksBySpawn(acks) {
  const groups = new Map();
  const rows = Array.isArray(acks) ? acks : [];
  rows.forEach((row, i) => {
    if (!row) return;
    const spawnId = normSpawnId(row.spawn_id);
    const key = spawnId !== null ? 'spawn:' + spawnId : 'row:' + i;
    if (!groups.has(key)) groups.set(key, { spawnId, rows: [] });
    groups.get(key).rows.push(row);
  });
  return Array.from(groups.values());
}

function offerKindOf(spawnOfferMap, slug) {
  const info = spawnOfferMap.get(slug);
  return info ? info.offer_kind : null;
}

// ---------------------------------------------------------------------------
// Outcome gate (E3/E4)
// ---------------------------------------------------------------------------

function applyOutcomeGates(candidates, eventIdx) {
  const passed = [];
  const withheld = [];

  for (const c of candidates) {
    // E3a — spawn-level failure (ack's own agent_status).
    if (c.agent_status === 'failure') {
      withheld.push(mkWithheld(c, 'spawn_failed'));
      continue;
    }
    // E3b — routing evidence for this role exists in the orchestration.
    // Self-report has no spawn to correlate against — exempt (§7.1: the
    // legitimate use case is work that never went through an Agent() spawn).
    if (c.evidence_grade === 'observed' && c.agent_role &&
        eventIdx.routingAgentTypes.size > 0 && !eventIdx.routingAgentTypes.has(c.agent_role)) {
      withheld.push(mkWithheld(c, 'spawn_failed'));
      continue;
    }
    // E4 — task not invalidated by a replan and not verify-fix-escalated.
    if (c.task_id && (eventIdx.invalidatedTaskIds.has(c.task_id) || eventIdx.failedTaskIds.has(c.task_id))) {
      withheld.push(mkWithheld(c, 'verify_fix_escalated'));
      continue;
    }
    passed.push(c);
  }

  return { passed, withheld };
}

function mkWithheld(c, reason) {
  return { slug: c.slug, reason, offer_kind: c.offer_kind, spawn_ids: c.spawn_id ? [c.spawn_id] : [] };
}

// ---------------------------------------------------------------------------
// Collapse to distinct slugs + caps (§5.2, §5.5, self-report cap)
// ---------------------------------------------------------------------------

function collapseAndCap(passed, cfg) {
  const withheld = [];

  // Self-report cap applies BEFORE merging with observed evidence — only
  // among slugs whose ONLY passing evidence is self-report.
  const observedSlugs = new Set(passed.filter((c) => c.evidence_grade === 'observed').map((c) => c.slug));
  const selfReportOnly = passed.filter((c) => c.evidence_grade === 'self_report' && !observedSlugs.has(c.slug));
  const bySelfReportSlug = groupBy(selfReportOnly, (c) => c.slug);
  const selfReportSlugsRanked = Array.from(bySelfReportSlug.entries())
    .map(([slug, entries]) => ({ slug, entries, bestHow: Math.max(...entries.map((e) => e.how_len)) }))
    .sort((a, b) => b.bestHow - a.bestHow);

  const selfReportKeep = new Set();
  selfReportSlugsRanked.forEach((s, i) => {
    if (i < cfg.max_self_report_per_orchestration) selfReportKeep.add(s.slug);
    else withheld.push({ slug: s.slug, reason: 'self_report_cap', offer_kind: null, spawn_ids: [] });
  });

  const eligible = passed.filter((c) => c.evidence_grade === 'observed' || observedSlugs.has(c.slug) || selfReportKeep.has(c.slug));

  // §5.2 — collapse to one credit per (slug, orchestration).
  const bySlug = new Map();
  for (const c of eligible) {
    if (!bySlug.has(c.slug)) {
      bySlug.set(c.slug, {
        slug: c.slug,
        offer_kind: c.offer_kind || null,
        spawn_ids: new Set(),
        agent_roles: new Set(),
        evidence_grade: c.evidence_grade,
        best_how: c.how_len,
      });
    }
    const agg = bySlug.get(c.slug);
    if (c.spawn_id) agg.spawn_ids.add(c.spawn_id);
    if (c.agent_role) agg.agent_roles.add(c.agent_role);
    if (c.evidence_grade === 'observed') agg.evidence_grade = 'observed'; // observed wins on mix
    if (c.offer_kind && !agg.offer_kind) agg.offer_kind = c.offer_kind;
    agg.best_how = Math.max(agg.best_how, c.how_len);
  }

  const distinct = Array.from(bySlug.values());

  // §5.5 — per-orchestration cap, keep highest how_len.
  distinct.sort((a, b) => b.best_how - a.best_how);
  const credited = [];
  distinct.forEach((agg, i) => {
    if (i < cfg.max_credits_per_orchestration) {
      credited.push({
        slug: agg.slug,
        offer_kind: agg.offer_kind,
        spawn_ids: Array.from(agg.spawn_ids),
        agent_roles: Array.from(agg.agent_roles),
        evidence_grade: agg.evidence_grade,
      });
    } else {
      withheld.push({ slug: agg.slug, reason: 'orch_cap', offer_kind: agg.offer_kind, spawn_ids: Array.from(agg.spawn_ids) });
    }
  });

  return { credited, withheld };
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

// ---------------------------------------------------------------------------
// no_ack — offered slugs with zero ack coverage anywhere in the orchestration
// ---------------------------------------------------------------------------

function collectNoAck(offeredSpawnsBySlug, offerKindBySlug, usedSlugsGlobal, rejectedSlugsGlobal) {
  const withheld = [];
  for (const slug of offeredSpawnsBySlug.keys()) {
    if (!usedSlugsGlobal.has(slug) && !rejectedSlugsGlobal.has(slug)) {
      withheld.push({ slug, reason: 'no_ack', offer_kind: offerKindBySlug.get(slug) || null, spawn_ids: Array.from(offeredSpawnsBySlug.get(slug)).filter(Boolean) });
    }
  }
  return withheld;
}

// ---------------------------------------------------------------------------
// Contradiction (§5.3) — slug named ONLY in rejected across the whole orch.
// ---------------------------------------------------------------------------

function collectContradicted(usedSlugsGlobal, rejectedSlugsGlobal) {
  const out = [];
  for (const slug of rejectedSlugsGlobal) {
    if (!usedSlugsGlobal.has(slug)) out.push(slug);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * @param {object[]} offers
 * @param {object[]} acks
 * @param {object[]} orchEvents
 * @param {object} config
 * @returns {{ credited: object[], withheld: object[], offered_counts: Object<string,number>,
 *             contradicted: string[] }}
 */
function computeCredits(offers, acks, orchEvents, config) {
  const cfg = mergeConfig(config);
  const { offersBySpawn, offeredSpawnsBySlug, offerKindBySlug } = indexOffers(offers);
  const eventIdx = indexOrchEvents(orchEvents);

  const { candidates, earlyWithheld, usedSlugsGlobal, rejectedSlugsGlobal } =
    collectCandidates(acks, offersBySpawn, cfg);

  const { passed, withheld: outcomeWithheld } = applyOutcomeGates(candidates, eventIdx);
  const { credited, withheld: capWithheld } = collapseAndCap(passed, cfg);
  const noAckWithheld = collectNoAck(offeredSpawnsBySlug, offerKindBySlug, usedSlugsGlobal, rejectedSlugsGlobal);

  const offered_counts = {};
  for (const [slug, spawns] of offeredSpawnsBySlug) {
    offered_counts[slug] = spawns.size;
  }

  const contradicted = collectContradicted(usedSlugsGlobal, rejectedSlugsGlobal);

  return {
    credited,
    withheld: [...earlyWithheld, ...outcomeWithheld, ...capWithheld, ...noAckWithheld],
    offered_counts,
    contradicted,
  };
}

module.exports = {
  computeCredits,
  // Internals exported for unit tests — not a stable contract.
  _internal: { mergeConfig, indexOffers, indexOrchEvents, collectCandidates, groupAcksBySpawn, applyOutcomeGates, collapseAndCap },
};
