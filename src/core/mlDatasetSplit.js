'use strict';

const crypto = require('crypto');

const DEFAULT_SPLIT = Object.freeze({ train: 0.70, validation: 0.15, test: 0.15 });
const DEFAULT_EMBARGO_MS = 72 * 60 * 60 * 1000;

function time(row) { const value = row.qualifiedAt || row.qualified_at; const parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? parsed : null; }
function entity(row) { return row.mintAddress || row.mint_address || row.pairAddress || row.pair_address || null; }
function stableId(row) { return row.exampleId || row.example_id || row.alertId || row.alert_id; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function validateRatios(ratios) {
  const result = { ...DEFAULT_SPLIT, ...ratios };
  for (const key of ['train', 'validation', 'test']) if (!Number.isFinite(Number(result[key])) || Number(result[key]) <= 0) throw new Error(`Invalid split ratio: ${key}`);
  const total = result.train + result.validation + result.test;
  if (Math.abs(total - 1) > 1e-9) throw new Error('Split ratios must sum to 1');
  return result;
}

function chronologicalGroupedSplit(rows, { ratios = DEFAULT_SPLIT, embargoMs = DEFAULT_EMBARGO_MS, labelEndTime = time } = {}) {
  const splitRatios = validateRatios(ratios);
  if (!Number.isFinite(embargoMs) || embargoMs < 0) throw new Error('embargoMs must be non-negative');
  const valid = rows.filter((row) => time(row) !== null && stableId(row));
  const invalid = rows.filter((row) => time(row) === null || !stableId(row));
  const groups = new Map();
  for (const row of valid) {
    const key = entity(row) || `example:${stableId(row)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const orderedGroups = [...groups.entries()].map(([key, members]) => ({ key, members: members.sort((a, b) => time(a) - time(b) || stableId(a).localeCompare(stableId(b))), firstAt: time(members[0]), lastAt: time(members[members.length - 1]) })).sort((a, b) => a.firstAt - b.firstAt || a.key.localeCompare(b.key));
  const total = valid.length;
  const trainTarget = total * splitRatios.train;
  const validationTarget = total * (splitRatios.train + splitRatios.validation);
  const buckets = { train: [], validation: [], test: [] };
  let assigned = 0;
  for (const group of orderedGroups) {
    const destination = assigned < trainTarget ? 'train' : assigned < validationTarget ? 'validation' : 'test';
    buckets[destination].push(...group.members);
    assigned += group.members.length;
  }
  buckets.train.sort((a, b) => time(a) - time(b) || stableId(a).localeCompare(stableId(b)));
  buckets.validation.sort((a, b) => time(a) - time(b) || stableId(a).localeCompare(stableId(b)));
  buckets.test.sort((a, b) => time(a) - time(b) || stableId(a).localeCompare(stableId(b)));
  const ranges = {};
  for (const [name, items] of Object.entries(buckets)) ranges[name] = { count: items.length, firstAt: items.length ? new Date(time(items[0])).toISOString() : null, lastAt: items.length ? new Date(time(items[items.length - 1])).toISOString() : null };
  // Embargo is applied at split boundaries. Rows in the temporal gap are
  // excluded rather than reassigned, preserving a strict future holdout.
  // Two directions are checked at each boundary: right-side rows too close
  // to the boundary by their own qualifiedAt (unconditional, always was
  // here), and left-side rows whose labelEndTime extends past the boundary
  // (opt-in via the labelEndTime option — see below).
  const boundaries = [];
  if (buckets.train.length && buckets.validation.length) boundaries.push({ from: time(buckets.train[buckets.train.length - 1]), to: time(buckets.validation[0]), left: 'train', right: 'validation' });
  if (buckets.validation.length && buckets.test.length) boundaries.push({ from: time(buckets.validation[buckets.validation.length - 1]), to: time(buckets.test[0]), left: 'validation', right: 'test' });
  const excluded = [];
  for (const boundary of boundaries) {
    const lower = boundary.from;
    const upper = lower + embargoMs;
    for (const bucket of [boundary.right]) {
      const kept = buckets[bucket].filter((row) => time(row) >= upper);
      excluded.push(...buckets[bucket].filter((row) => time(row) < upper).map((row) => ({ row, reason: 'embargo', boundary: bucket })));
      buckets[bucket] = kept;
    }
    // Purge: a row on the EARLIER side of this boundary whose own label
    // didn't finish resolving (labelEndTime) until after the embargo
    // threshold is excluded too, even though its qualifiedAt correctly
    // placed it before the boundary. Without this, a boundary drawn purely
    // on qualifiedAt can still let a left-side row's own outcome-formation
    // window extend into the right-side split's territory.
    // For the default labelEndTime (= time), labelEndTime(row) === time(row)
    // for every row, and every left-bucket row's time(row) is <= boundary.from
    // < upper by construction of the boundary itself — so this can never
    // purge anything and callers that don't pass labelEndTime see
    // byte-identical output to before this parameter existed.
    for (const bucket of [boundary.left]) {
      const endOf = (row) => { const end = labelEndTime(row); return Number.isFinite(end) ? end : time(row); };
      const kept = buckets[bucket].filter((row) => endOf(row) <= upper);
      excluded.push(...buckets[bucket].filter((row) => endOf(row) > upper).map((row) => ({ row, reason: 'embargo_resolution_overlap', boundary: bucket })));
      buckets[bucket] = kept;
    }
  }
  const entitySets = Object.fromEntries(Object.entries(buckets).map(([name, items]) => [name, new Set(items.map(entity).filter(Boolean))]));
  const overlaps = [];
  for (const left of ['train', 'validation', 'test']) for (const right of ['train', 'validation', 'test']) if (left < right) for (const key of entitySets[left]) if (entitySets[right].has(key)) overlaps.push({ entity: key, splits: [left, right] });
  if (overlaps.length) throw new Error(`Entity leakage detected: ${overlaps[0].entity}`);
  const allExcluded = [...invalid.map((row) => ({ row, reason: 'invalid_identity_or_timestamp' })), ...excluded];
  const provenance = {
    train: buckets.train.map(stableId),
    validation: buckets.validation.map(stableId),
    test: buckets.test.map(stableId),
    excluded: allExcluded.map(({ row, reason, boundary }) => ({ id: stableId(row) || null, entity: entity(row) || null, qualifiedAt: row.qualifiedAt || row.qualified_at || null, reason, boundary: boundary || null })),
  };
  return { splits: buckets, excluded: allExcluded, ranges, ratios: splitRatios, embargoMs, entityCounts: Object.fromEntries(Object.entries(entitySets).map(([key, set]) => [key, set.size])), entityOverlapCount: overlaps.length, splitHash: hash(JSON.stringify(provenance)), splitProvenance: provenance };
}

module.exports = { DEFAULT_SPLIT, DEFAULT_EMBARGO_MS, chronologicalGroupedSplit, time, entity, stableId };
