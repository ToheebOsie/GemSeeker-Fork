const { escapeMarkdown } = require('./alertFormatter');
const { narrativeLabel } = require('../core/narrativeLabels');

function fmtPct(value) {
  return typeof value === 'number' ? `${value.toFixed(0)}%` : 'n/a';
}

function fmtRoi(multiple) {
  return typeof multiple === 'number' ? `${multiple.toFixed(1)}x` : 'n/a';
}

/**
 * /insights — the first command to actually read market_state_daily,
 * which core/marketStateEngine.js has been computing hourly since Tier 2
 * Phase 13. Renders one UTC date's per-narrative rows, the two slices
 * kept independent (same reasoning as marketStateEngine.js's own doc
 * comment):
 *
 *   - "Tracked" — currently-tracked tokens in that narrative, rolled up
 *     into % accumulating/distributing top-holder concentration and %
 *     buy-accelerating/decelerating. A narrative can have tracked tokens
 *     with no trend percentages yet (fmtPct -> 'n/a') if none of them
 *     have enough snapshot history for featureExtraction.js to compute a
 *     trend — that's a real, honest "not enough data yet", not a bug.
 *   - "Archived today" — pattern_archive rows that resolved (rugged or
 *     survived) today, with average peak ROI and the BUY/WAIT/SKIP
 *     breakdown of what the bot originally signaled on them.
 *
 * Sorted by total activity (tracked + archived) so the narratives with
 * something actually happening lead, not an arbitrary/alphabetical
 * order — same "most relevant first" precedent as narrativeFormatter.js.
 *
 * Same scope note as self-assessment reports and the market state engine
 * itself: both slices only ever cover the tracked subset (Low-risk, or
 * any WAIT/BUY-labeled token — see tokenScanner.js's shouldTrack), never
 * every alert ever sent.
 */
function formatMarketInsights(rows, date) {
  if (rows.length === 0) {
    return [
      `📊 *Market Insights — ${date}*`,
      '',
      'Nothing computed for today yet. The market state engine runs hourly ',
      '(MARKET_STATE_INTERVAL_MS) and only produces a row for a narrative once ',
      'it has at least one currently-tracked or today-archived token — check ',
      'back after its next tick, or once some tokens have qualified today.',
    ].join('\n');
  }

  const sorted = [...rows].sort(
    (a, b) => (b.trackedCount + b.archivedCount) - (a.trackedCount + a.archivedCount),
  );

  const lines = [`📊 *Market Insights — ${date}*`, ''];
  for (const row of sorted.slice(0, 10)) {
    lines.push(`*${escapeMarkdown(narrativeLabel(row.narrativeTag))}*`);

    if (row.trackedCount === 0) {
      lines.push('  Tracked: none right now');
    } else {
      lines.push(
        `  Tracked: ${row.trackedCount}  `
        + `_(holders ${fmtPct(row.accumulatingPct)} accumulating / ${fmtPct(row.distributingPct)} distributing, `
        + `buys ${fmtPct(row.buyAcceleratingPct)} accelerating / ${fmtPct(row.buyDeceleratingPct)} decelerating)_`,
      );
    }

    if (row.archivedCount === 0) {
      lines.push('  Archived today: none yet');
    } else {
      lines.push(
        `  Archived today: ${row.archivedCount} (${row.ruggedCount} rugged, ${row.survivedCount} survived)  `
        + `avg peak ${fmtRoi(row.avgPeakRoiMultiple)}  `
        + `_(${row.buyCount} BUY / ${row.waitCount} WAIT / ${row.skipCount} SKIP)_`,
      );
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

const DEFAULT_HISTORY_DAYS = 14;

/**
 * /insightshistory <narrative> — full history for one narrative from
 * market_state_daily (marketStateStore.getStateForNarrative), oldest-first
 * same as the store returns it. This is the trend view flagged as a
 * natural follow-up in earlier handoffs: /insights only ever shows today;
 * this shows how a narrative's tracked/archived state has moved day over
 * day. Per-day shape mirrors formatMarketInsights' two-slice layout
 * exactly (same fmtPct/fmtRoi, same "none" honesty fallback) so the two
 * commands read consistently — the only addition is a day-over-day arrow
 * on tracked count and average peak ROI, since a trend view's whole point
 * is showing *change*, not just repeating each day's static numbers.
 *
 * Caps rendering to the most recent `days` entries (default 14) — Telegram
 * has a ~4096-char message limit, and this table is deliberately not
 * paginated (out of scope for a first cut); a truncation note says how
 * many earlier days exist rather than silently dropping them.
 */
function formatMarketInsightsHistory(rows, narrativeTag, days = DEFAULT_HISTORY_DAYS) {
  const label = escapeMarkdown(narrativeLabel(narrativeTag));

  if (rows.length === 0) {
    return [
      `📈 *Insights History — ${label}*`,
      '',
      'No market_state_daily rows for this narrative yet. The market state ',
      'engine only writes a row once at least one token in this narrative ',
      'is currently tracked or archives on a given day — check back once ',
      'that has happened at least once.',
    ].join('\n');
  }

  const shown = rows.slice(-days);
  const omitted = rows.length - shown.length;

  const lines = [`📈 *Insights History — ${label}*`, ''];
  if (omitted > 0) {
    lines.push(`_Showing the most recent ${shown.length} of ${rows.length} day(s) on record._`, '');
  }

  let prevTracked = null;
  let prevRoi = null;
  for (const row of shown) {
    lines.push(`*${row.date}*`);

    const trackedArrow = prevTracked === null ? ''
      : row.trackedCount > prevTracked ? ' 🟢▲'
        : row.trackedCount < prevTracked ? ' 🔴▼' : ' ▬';
    if (row.trackedCount === 0) {
      lines.push(`  Tracked: none${trackedArrow}`);
    } else {
      lines.push(
        `  Tracked: ${row.trackedCount}${trackedArrow}  `
        + `_(holders ${fmtPct(row.accumulatingPct)} accumulating / ${fmtPct(row.distributingPct)} distributing, `
        + `buys ${fmtPct(row.buyAcceleratingPct)} accelerating / ${fmtPct(row.buyDeceleratingPct)} decelerating)_`,
      );
    }
    prevTracked = row.trackedCount;

    if (row.archivedCount === 0) {
      lines.push('  Archived: none');
    } else {
      const roiArrow = typeof row.avgPeakRoiMultiple !== 'number' || typeof prevRoi !== 'number' ? ''
        : row.avgPeakRoiMultiple > prevRoi ? ' 🟢▲'
          : row.avgPeakRoiMultiple < prevRoi ? ' 🔴▼' : ' ▬';
      lines.push(
        `  Archived: ${row.archivedCount} (${row.ruggedCount} rugged, ${row.survivedCount} survived)  `
        + `avg peak ${fmtRoi(row.avgPeakRoiMultiple)}${roiArrow}  `
        + `_(${row.buyCount} BUY / ${row.waitCount} WAIT / ${row.skipCount} SKIP)_`,
      );
    }
    if (typeof row.avgPeakRoiMultiple === 'number') prevRoi = row.avgPeakRoiMultiple;
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

module.exports = { formatMarketInsights, formatMarketInsightsHistory };
