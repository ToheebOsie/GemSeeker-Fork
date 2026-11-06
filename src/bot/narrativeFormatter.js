const { escapeMarkdown } = require('./alertFormatter');
const { narrativeLabel } = require('../core/narrativeLabels');

const BAR_WIDTH = 10;

function renderBar(value0to10) {
  const filled = Math.round(Math.max(0, Math.min(10, value0to10)));
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

/**
 * /narratives — narrative heat (right now) + rotation (vs the prior
 * window), both computed by narrativeIntelligence.js from this bot's own
 * archive/tracked-token data. Returns a plain "nothing to show yet"
 * message rather than an empty/misleading chart when there isn't enough
 * history — a brand-new deployment (or one freshly migrated from `live`,
 * before enough qualifications accumulate) shouldn't render a chart
 * implying more data than actually exists.
 */
function formatNarrativeIntelligence(heatRows, rotationRows, windowDays) {
  if (heatRows.length === 0) {
    return `🔥 *Narrative Heat*\n\nNot enough qualifications in the last ${windowDays} days yet to show narrative heat. Check back once a few more tokens have qualified.`;
  }

  const lines = ['🔥 *Narrative Heat*', ''];
  for (const row of heatRows.slice(0, 10)) {
    lines.push(`${escapeMarkdown(narrativeLabel(row.narrativeTag))}`);
    lines.push(`${renderBar(row.heat)} ${row.heat.toFixed(1)}  _(${row.qualificationCount} qualified, median hype ${row.medianHypeScore?.toFixed(1) ?? 'n/a'})_`);
  }

  lines.push('', `📈 *Narrative Rotation (Last ${windowDays} Days vs prior ${windowDays})*`, '');
  const rotationToShow = rotationRows.slice(0, 10);
  if (rotationToShow.length === 0) {
    lines.push('_Not enough history yet for a rotation comparison._');
  } else {
    for (const row of rotationToShow) {
      const arrow = row.isNew ? '🆕' : (row.pctChange >= 0 ? '🟢 ▲' : '🔴 ▼');
      const changeLabel = row.isNew ? 'new this window' : `${row.pctChange >= 0 ? '+' : ''}${row.pctChange}%`;
      lines.push(`${arrow} ${escapeMarkdown(narrativeLabel(row.narrativeTag))} ${changeLabel} _(${row.currentCount} qualified)_`);
    }
  }

  return lines.join('\n');
}

function fmtRoi(multiple) {
  if (typeof multiple !== 'number') return 'n/a';
  return `${multiple.toFixed(1)}x`;
}

/**
 * /narrativeevolution — average peak ROI per narrative, week by week, for
 * the trailing `weeks` weeks, plus a monthly top-10 leaderboard. Archive-
 * only (see narrativeIntelligence.js's getNarrativeEvolution comment) —
 * weeks with zero resolved (archived) tokens for a narrative simply don't
 * list it, rather than showing a fabricated 0x.
 */
function formatNarrativeEvolution(evolutionWeeks, monthlyAssessment) {
  const lines = ['📈 *Narrative Evolution*', ''];

  evolutionWeeks.forEach((week, idx) => {
    lines.push(`*Week ${idx + 1}*`);
    if (week.narratives.length === 0) {
      lines.push('_No resolved tokens this week._', '');
      return;
    }
    for (const n of week.narratives.slice(0, 5)) {
      lines.push(`${escapeMarkdown(narrativeLabel(n.narrativeTag))} — Average ROI: *${fmtRoi(n.avgPeakRoiMultiple)}* _(n=${n.sampleSize})_`);
    }
    lines.push('');
  });

  lines.push('🏆 *Top Narratives This Month*', '');
  if (monthlyAssessment.length === 0) {
    lines.push('_Not enough resolved tokens in any single narrative this month yet (need at least a few per narrative before ranking it)._');
  } else {
    monthlyAssessment.forEach((row, idx) => {
      lines.push(
        `${idx + 1}. *${escapeMarkdown(narrativeLabel(row.narrativeTag))}* — `
        + `median peak ${fmtRoi(row.medianPeakRoiMultiple)}, `
        + `rug rate ${row.rugRate}%, `
        + `${row.tokensTracked} tracked`,
      );
    });
  }

  return lines.join('\n');
}

module.exports = { formatNarrativeIntelligence, formatNarrativeEvolution, narrativeLabel, renderBar };
