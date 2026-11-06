'use strict';

const ASSESSMENT_VERSION = 'gemini-assessment-v1';
const VALID_LABELS = new Set(['BUY', 'WAIT', 'SKIP']);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

function text(value, max = 600) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function list(value, maxItems = 5) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, 240)).filter(Boolean).slice(0, maxItems);
}

function extractJsonCandidate(raw) {
  if (typeof raw !== 'string') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : raw.trim();
  try { return JSON.parse(candidate); } catch (_) { return null; }
}

function normalizePacket(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const signalLabel = String(candidate.signalLabel || candidate.signal || candidate.verdict || '').toUpperCase();
  if (!VALID_LABELS.has(signalLabel)) return null;
  const confidence = String(candidate.confidence || '').toLowerCase();
  const packet = {
    assessmentVersion: ASSESSMENT_VERSION,
    signalLabel,
    confidence: VALID_CONFIDENCE.has(confidence) ? confidence : 'low',
    momentum: text(candidate.momentum || candidate.momentumSummary),
    exitRange: text(candidate.exitRange || candidate.realisticExitRange, 120),
    rationale: text(candidate.rationale || candidate.justification),
    risks: list(candidate.risks || candidate.keyRisks),
    invalidation: text(candidate.invalidation || candidate.invalidationCondition),
    evidence: list(candidate.evidence, 8),
  };
  return packet;
}

function packetFromSignal(raw) {
  const packet = normalizePacket(extractJsonCandidate(raw));
  if (packet) return packet;
  return {
    assessmentVersion: ASSESSMENT_VERSION,
    signalLabel: null,
    confidence: 'low',
    momentum: null,
    exitRange: null,
    rationale: text(raw),
    risks: [],
    invalidation: null,
    evidence: [],
    parseStatus: 'legacy_text',
  };
}

function renderAssessment(packet) {
  if (!packet) return '';
  const lines = [];
  if (packet.momentum) lines.push(packet.momentum);
  if (packet.exitRange) lines.push(`Realistic range: ${packet.exitRange}`);
  if (packet.rationale) lines.push(packet.rationale);
  // Found while enabling the DB integration suite: persisted ai_decision_json
  // rows are immutable and span prompt versions, so a stored packet may lack a
  // `risks` array. An unguarded `.length` here made getAlertDecision() throw,
  // which blocks delivery of that alert entirely.
  if (Array.isArray(packet.risks) && packet.risks.length) lines.push(`Key risks: ${packet.risks.join('; ')}`);
  if (packet.invalidation) lines.push(`Invalidation: ${packet.invalidation}`);
  if (packet.signalLabel) lines.push(`${packet.signalLabel} — ${packet.confidence} confidence`);
  return lines.join('\n');
}

module.exports = { ASSESSMENT_VERSION, extractJsonCandidate, normalizePacket, packetFromSignal, renderAssessment };
