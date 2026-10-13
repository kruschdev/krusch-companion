import test from 'node:test';
import assert from 'node:assert';

const { evaluateL0Heuristic, classifyCompanionPrompt, dispatchCompanionChat, TIERS } = await import('../src/router/cascade-client.js');
const { initCompanionDb } = await import('../src/db/index.js');

initCompanionDb(':memory:');

test('Cascade Router: evaluates L0 Heuristic math in <15µs', (t) => {
  const start = performance.now();
  const res = evaluateL0Heuristic('What is 125 * 8?');
  const elapsed = performance.now() - start;

  assert.ok(res);
  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.tier, TIERS.L0_HEURISTIC);
  assert.ok(res.content.includes('1000'));
  console.log(`⏱️ L0 Heuristic evaluated in ${elapsed.toFixed(3)}ms`);
});

test('Cascade Router: classifies direct memory note as L0 Heuristic', (t) => {
  const res = evaluateL0Heuristic('Remember that I take my vitamins with breakfast');
  assert.ok(res);
  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.tier, TIERS.L0_HEURISTIC);
  assert.ok(res.content.includes('sovereign working memory'));
});

test('Cascade Router: escalates complex reasoning prompts to L2 Swarm', (t) => {
  const simpleClassification = classifyCompanionPrompt('Good morning! How are you today?');
  assert.strictEqual(simpleClassification.tier, TIERS.L1_EDGE);

  const complexClassification = classifyCompanionPrompt(`
    Perform a comprehensive multi-criteria decision analysis comparing whether I should refactor my production microservices into an event-driven Kafka architecture versus a transactional outbox with PostgreSQL CDC, including failure modes and operational risk analysis.
  `);
  assert.strictEqual(complexClassification.tier, TIERS.L2_SWARM);
});

test('Cascade Router: live dispatch to local Ollama edge model', async (t) => {
  const result = await dispatchCompanionChat({
    prompt: 'Reply with the word "SOVEREIGN" only.'
  });

  assert.ok(result);
  assert.ok(result.content);
  assert.strictEqual(result.tierUsed, TIERS.L1_EDGE);
  assert.ok(result.latencyMs > 0);
  console.log(`✅ Local Ollama response in ${result.latencyMs}ms: "${result.content.trim()}"`);
});
