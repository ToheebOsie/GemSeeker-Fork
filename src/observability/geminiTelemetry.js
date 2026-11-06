'use strict';

const counters = {
  requests_total: 0,
  request_errors_total: 0,
  structured_valid_total: 0,
  structured_invalid_total: 0,
  legacy_text_total: 0,
  empty_response_total: 0,
};

function increment(name) {
  if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
}

function snapshot() {
  return { ...counters };
}

function prometheus() {
  return Object.entries(counters)
    .map(([name, value]) => `gemseeker_gemini_${name} ${value}`)
    .join('\n') + '\n';
}

module.exports = { increment, snapshot, prometheus };
