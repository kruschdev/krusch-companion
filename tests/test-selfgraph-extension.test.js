import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-selfgraph-test-'));
process.env.DB_PATH = path.join(tmpDir, 'companion-sg.db');
process.env.SELFGRAPH_KUZU_PATH = path.join(tmpDir, 'companion-sg.kuzu');
process.env.MOCK_LLM = '1';
process.env.DISABLE_SENTINEL_DAEMON = 'true';
process.env.KRUSCH_NO_LISTEN = '1';

const { initCompanionDb } = await import('../src/db/index.js');
const { COMPANION_TOOLS } = await import('../src/agent/tools.js');
const { detectAgenticIntent } = await import('../src/agent/agentic-proxy.js');
const { ensureAllExtensionsLoaded, setExtensionEnabled } = await import('../src/extensions/extension-registry.js');
const { executeCompanionSelfGraph, closeCompanionSelfGraph } = await import('../src/extensions/selfgraph-extension.js');
const { app } = await import('../src/server.js');

describe('Krusch Companion: SelfGraph Bi-Temporal Knowledge Graph Extension (Embedded KuzuStore)', () => {
  let server = null;
  let baseUrl = '';

  before(async () => {
    initCompanionDb();
    await ensureAllExtensionsLoaded();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await closeCompanionSelfGraph();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves 20 core tools and routes knowledge-graph intents when enabled', () => {
    assert.equal(COMPANION_TOOLS.length, 20);
    const toggled = setExtensionEnabled('selfgraph-knowledge-graph', true);
    assert.equal(toggled.enabled, true);

    const intent = detectAgenticIntent('Query my knowledge graph for Maya Chen');
    assert.equal(intent.shouldUseAgenticProxy, true);
    assert.ok(intent.matchedCategories.includes('knowledge_graph'));
    assert.ok(intent.tools.some((t) => t.name === 'selfgraph_knowledge'));
  });

  it('supports max_count:1 supersession, asOf time-travel, certification, and reversible merge/unmerge', async () => {
    const t1 = await executeCompanionSelfGraph({
      action: 'upsert_facts',
      eventTime: '2025-01-15T00:00:00Z',
      facts: {
        entities: [
          { type: 'Person', name: 'Maya Chen' },
          { type: 'Organization', name: 'Stripe' },
          { type: 'Organization', name: 'HydraDB' }
        ],
        relations: [
          { from_entity: 'person:maya-chen', type: 'WORKS_AT', to_entity: 'organization:stripe' }
        ]
      }
    });
    assert.equal(t1.ok, true);
    assert.equal(t1.data.relations.length, 1);

    const t2 = await executeCompanionSelfGraph({
      action: 'upsert_facts',
      eventTime: '2026-06-01T00:00:00Z',
      facts: {
        relations: [
          { from_entity: 'person:maya-chen', type: 'WORKS_AT', to_entity: 'organization:hydradb' }
        ]
      }
    });
    assert.equal(t2.ok, true);
    assert.ok(t2.data.warnings.some((w) => w.code === 'relation_superseded'));

    // Current retrieve sees HydraDB, while asOf 2025-06-01 sees Stripe
    const nowRes = await executeCompanionSelfGraph({ action: 'retrieve', query: 'Maya Chen' });
    assert.equal(nowRes.ok, true);
    assert.equal(nowRes.data.subgraph.relations.length, 1);
    assert.equal(nowRes.data.subgraph.relations[0].to_entity, 'organization:hydradb');

    const pastRes = await executeCompanionSelfGraph({
      action: 'retrieve',
      query: 'Maya Chen',
      asOf: '2025-06-01T00:00:00Z'
    });
    assert.equal(pastRes.ok, true);
    assert.equal(pastRes.data.subgraph.relations.length, 1);
    assert.equal(pastRes.data.subgraph.relations[0].to_entity, 'organization:stripe');

    // Certify active relation and test reversible entity merge + unmerge
    const activeRelId = nowRes.data.subgraph.relations[0].id;
    const cert = await executeCompanionSelfGraph({
      action: 'certify_relation',
      relationId: activeRelId,
      certifiedBy: 'krusch'
    });
    assert.equal(cert.ok, true);
    assert.equal(cert.data.certified_by, 'krusch');

    await executeCompanionSelfGraph({
      action: 'upsert_facts',
      facts: {
        entities: [{ type: 'Person', name: 'M. Chen' }]
      }
    });
    const mergeRes = await executeCompanionSelfGraph({
      action: 'merge_entities',
      survivorId: 'person:maya-chen',
      duplicateIds: ['person:m-chen']
    });
    assert.equal(mergeRes.ok, true);
    const mergeId = mergeRes.data.merges[0].id;

    const unmergeRes = await executeCompanionSelfGraph({
      action: 'unmerge',
      mergeId
    });
    assert.equal(unmergeRes.ok, true);
    assert.equal(unmergeRes.data.entity.id, 'person:m-chen');
  });

  it('serves GET and POST /api/companion/knowledge-graph including known-time diff', async () => {
    const statusResp = await fetch(`${baseUrl}/api/companion/knowledge-graph`);
    assert.equal(statusResp.status, 200);
    const statusJson = await statusResp.json();
    assert.equal(statusJson.ok, true);
    assert.ok(statusJson.data.entityCount >= 3);

    const diffResp = await fetch(`${baseUrl}/api/companion/knowledge-graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'diff',
        since: new Date(Date.now() - 60_000).toISOString()
      })
    });
    assert.equal(diffResp.status, 200);
    const diffJson = await diffResp.json();
    assert.equal(diffJson.ok, true);
    assert.ok(Array.isArray(diffJson.data.relations_added));
  });
});
