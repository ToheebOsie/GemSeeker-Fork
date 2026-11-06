'use strict';

const MAX_MESSAGE_LENGTH = 3800;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value) {
  const n = finite(value);
  if (n === null) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(n < 1 ? 6 : 2)}`;
}

function multiple(value) {
  const n = finite(value);
  return n === null ? 'n/a' : `${n.toFixed(2)}x`;
}

function pct(value) {
  const n = finite(value);
  return n === null ? 'n/a' : `${((n - 1) * 100).toFixed(1)}%`;
}

function valueAt(object, paths) {
  for (const path of paths) {
    let current = object;
    for (const key of path.split('.')) current = current && current[key];
    if (current !== null && current !== undefined && current !== '') return current;
  }
  return null;
}

function tokenText(row) {
  const base = row.base_token || {};
  const feature = row.feature_snapshot || row.ai_input_sanitized || {};
  const featureToken = feature.token || {};
  const market = feature.market || {};
  const symbol = base.symbol || featureToken.symbol || 'UNKNOWN';
  const name = base.name || featureToken.name || '';
  const lore = valueAt(feature, [
    'token.description', 'token.lore', 'context.description', 'context.lore',
  ]) || 'not captured';
  const initialMc = valueAt(feature, ['market.marketCap', 'market.market_cap', 'market.mcap']);
  const firstPrice = finite(row.first_price_usd);
  const ath = finite(row.ath_price_usd);
  const last = finite(row.last_price_usd);
  const athMultiple = firstPrice && firstPrice > 0 && ath !== null ? ath / firstPrice : null;
  const currentMultiple = firstPrice && firstPrice > 0 && last !== null ? last / firstPrice : null;
  const qualified = row.qualified_at ? new Date(Number(row.qualified_at)).toISOString() : 'n/a';
  const narrative = row.narrative_tag || 'uncategorized';
  const verdict = row.signal_label || row.signal_status || 'unlabeled';
  const risk = row.risk_level_at_qualification || 'unknown';
  const displayName = name ? ` — ${name}` : '';
  return [
    `${symbol}${displayName}`,
    `Narrative: ${narrative} | Verdict: ${verdict} | Risk: ${risk}`,
    `Discovered: ${qualified} | Initial MC: ${money(initialMc)}`,
    `ATH: ${money(ath)} | ATH ROI: ${multiple(athMultiple)} (${pct(athMultiple)}) | Current ROI: ${multiple(currentMultiple)} (${pct(currentMultiple)})`,
    `Lore: ${String(lore).replace(/\s+/g, ' ').slice(0, 420)}`,
  ].join('\n');
}

function chunkLines(lines, maxLength = MAX_MESSAGE_LENGTH) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n\n${line}` : line;
    if (current && next.length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatTrackedTokenReport(rows, { period, fromMs, toMs }) {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const header = `Tracked-token ${period} update\nWindow: ${from} to ${to}\nTokens: ${rows.length}`;
  if (rows.length === 0) return [header, 'No tracked tokens were qualified in this UTC window.'];
  return chunkLines([header, ...rows.map(tokenText)]);
}

module.exports = { formatTrackedTokenReport, chunkLines, tokenText };
