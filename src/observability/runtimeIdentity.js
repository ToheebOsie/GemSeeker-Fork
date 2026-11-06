'use strict';

const os = require('os');

const startedAt = new Date().toISOString();
const pid = process.pid;
const host = os.hostname();

function runtimeTag() {
  return `pid=${pid} host=${host} started=${startedAt}`;
}

function logRuntimeIdentity() {
  console.log(`[runtime] ${runtimeTag()}`);
}

module.exports = {
  pid,
  host,
  startedAt,
  runtimeTag,
  logRuntimeIdentity,
};
