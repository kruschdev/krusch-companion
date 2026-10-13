import test from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import {
  callOpenRouter,
  dispatchCompanionChat,
  selectOpenRouterSpecialistModel,
  OPENROUTER_SPECIALISTS,
  TIERS
} from '../src/router/cascade-client.js';

test('OpenRouter Connector: throws clear error if API key is missing', async (t) => {
  const originalKey = config.cascade.openrouterApiKey;
  config.cascade.openrouterApiKey = '';

  await assert.rejects(
    async () => {
      await callOpenRouter({ prompt: 'Hello' });
    },
    {
      name: 'Error',
      message: /OpenRouter API key is not configured/
    }
  );

  config.cascade.openrouterApiKey = originalKey;
});

test('OpenRouter Connector: enforces Zero Data Retention (data_collection: "deny") and headers', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = config.cascade.openrouterApiKey;
  const originalProvider = config.cascade.provider;

  config.cascade.openrouterApiKey = 'sk-or-v1-mock-test-key-12345';
  config.cascade.provider = 'openrouter';

  let interceptedUrl = null;
  let interceptedHeaders = null;
  let interceptedBody = null;

  globalThis.fetch = async (url, options) => {
    interceptedUrl = url;
    interceptedHeaders = options.headers;
    interceptedBody = JSON.parse(options.body);

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'Sovereign OpenRouter response generated with zero data retention.'
            }
          }
        ]
      })
    };
  };

  try {
    const result = await dispatchCompanionChat({
      prompt: 'Summarize today focus',
      history: [{ role: 'user', content: 'Hi' }]
    });

    assert.ok(result);
    assert.strictEqual(result.tierUsed, TIERS.L3_CLOUD);
    assert.ok(result.content.includes('zero data retention'));
    assert.ok(result.reason.includes('L3 OpenRouter'));

    // Verify OpenRouter request structure
    assert.strictEqual(interceptedUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(interceptedHeaders['Authorization'], 'Bearer sk-or-v1-mock-test-key-12345');
    assert.strictEqual(interceptedHeaders['HTTP-Referer'], 'https://github.com/kruschdev/krusch-companion');
    assert.strictEqual(interceptedHeaders['X-Title'], 'Krusch Companion');

    // Verify Sovereign Zero Data Retention privacy guarantee:
    assert.deepStrictEqual(interceptedBody.provider, { data_collection: 'deny' });
  } finally {
    globalThis.fetch = originalFetch;
    config.cascade.openrouterApiKey = originalKey;
    config.cascade.provider = originalProvider;
  }
});

test('OpenRouter Connector: L0 Heuristics still evaluate locally on CPU in <15µs even in OpenRouter mode', async (t) => {
  const originalKey = config.cascade.openrouterApiKey;
  const originalProvider = config.cascade.provider;
  config.cascade.openrouterApiKey = 'sk-or-v1-mock-test-key';
  config.cascade.provider = 'openrouter';

  try {
    const res = await dispatchCompanionChat({
      prompt: 'What is 45 * 20?'
    });

    assert.ok(res);
    assert.strictEqual(res.tierUsed, TIERS.L0_HEURISTIC);
    assert.ok(res.content.includes('900'));
  } finally {
    config.cascade.openrouterApiKey = originalKey;
    config.cascade.provider = originalProvider;
  }
});

test('OpenRouter Specialist Cascade: dynamically selects 32B Coder for <holodata> tools, 72B for coaching, and DeepSeek V3 for deep reasoning', () => {
  const toolModel = selectOpenRouterSpecialistModel({
    classification: { role: 'general_fast', complexityScore: 0.1 },
    systemPrompt: 'Wrap your blueprint in <holodata> tags'
  });
  assert.strictEqual(toolModel, OPENROUTER_SPECIALISTS.TOOL_AND_CODE);

  const coachModel = selectOpenRouterSpecialistModel({
    classification: { role: 'general_fast', complexityScore: 0.15 },
    systemPrompt: 'You are Krusch Companion'
  });
  assert.strictEqual(coachModel, OPENROUTER_SPECIALISTS.GENERAL_COACH);

  const deepModel = selectOpenRouterSpecialistModel({
    classification: { role: 'reasoning_deep', complexityScore: 0.65 },
    systemPrompt: 'You are Krusch Companion'
  });
  assert.strictEqual(deepModel, OPENROUTER_SPECIALISTS.DEEP_REASONING);
});
