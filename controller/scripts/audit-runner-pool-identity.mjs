#!/usr/bin/env node
/**
 * Reproduce the shared Runner-token / pool-identity finding with synthetic data.
 * Run from controller/: node --import tsx scripts/audit-runner-pool-identity.mjs
 *
 * This invokes the real RunnerControlServer stream authentication, registration,
 * and reconciliation code with in-memory service stubs. No live database,
 * cluster, production credentials, or user data is used. The stubs model two
 * already registered pools with different endpoint verifiers. The result does
 * not prove exploitation of any live deployment or compromise of a real token.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.ts';
import { RunnerControlServer } from '../server/control-channel/control-server.ts';

const config = loadConfig({
  NODE_ENV: 'test',
  CONTROLLER_DATABASE_URL: 'postgresql://unused:unused@localhost/unused',
  CONTROLLER_RUNNER_TOKEN: 'synthetic-test-runner-token-for-all-pools',
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: '/tmp/synthetic-test-key.pem',
  CONTROLLER_PROTO_PATH: fileURLToPath(new URL('../../proto/tasklattice/guard/control/v1/runner_control.proto', import.meta.url)),
  BETTER_AUTH_SECRET: 'synthetic-test-auth-secret-at-least-32-chars',
});

const registrations = [];
const service = {
  async registerRunner(registration) {
    assert(['pool-a', 'pool-c'].includes(registration.poolId), 'Fixture only accepts the two pre-existing pools');
    registrations.push(registration);
    return 7;
  },
  async desiredStateForPool(poolId) {
    return {
      generation: 7, groupId: poolId, artifacts: [], disabledGuardrailIds: [], disabledEndpointIds: [],
      routerRevisions: [], guardrailLoggingLevels: {},
      endpoints: [{
        endpointId: `endpoint-${poolId}`, adapter: 'litellm-generic-guardrail', trafficRouterId: `router-${poolId}`,
        verification: { credentials: [{ id: `credential-${poolId}`, sha256: `hash-${poolId}`,
          keyHint: 'synthetic-fixture', createdAt: '2026-01-01T00:00:00Z' }] },
      }],
    };
  },
  async disconnectRunner() {},
};
const metrics = Object.fromEntries([
  'observeControlMessage', 'controlConnection', 'observeReconcile', 'observeArtifactResult', 'observeJob', 'observeHeartbeat',
].map(name => [name, () => {}]));
const server = new RunnerControlServer(config, service, metrics, { activeConfiguration: async () => null });

async function claimPool(poolId, runnerId) {
  const stream = Object.assign(new EventEmitter(), {
    metadata: { get: () => [`Bearer ${config.runnerToken}`] },
    end() {},
    write(message) { if (message.desiredState) this.emit('audit-state', message.desiredState); },
  });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No desired state was delivered within 3 seconds.')), 3000);
    stream.once('audit-state', state => { clearTimeout(timer); resolve(state); });
    stream.once('error', error => { clearTimeout(timer); reject(error); });
  });
  server.connect(stream);
  stream.emit('data', { registration: {
    runnerId, bootId: `boot-${runnerId}`, poolId, runnerVersion: 'test', nemoVersion: 'test',
    maxConcurrency: 4, compilerCapable: false, labels: {}, appliedGeneration: '0',
  } });
  return result;
}

const legitimate = await claimPool('pool-a', 'synthetic-runner-a');
const impersonator = await claimPool('pool-c', 'synthetic-runner-a-impersonator');
assert.equal(legitimate.endpoints[0].endpointId, 'endpoint-pool-a');
assert.equal(impersonator.endpoints[0].endpointId, 'endpoint-pool-c');
assert.equal(impersonator.endpoints[0].verification.credentials[0].sha256, 'hash-pool-c');
assert.deepEqual(registrations.map(item => item.poolId), ['pool-a', 'pool-c']);
console.log('FINDING REPRODUCED: one synthetic shared bearer claimed both pools and received the second pool’s synthetic endpoint verifier.');
console.log('Real control-server logic; mocked pool registration and desired-state storage. No live system or real secrets were accessed.');
