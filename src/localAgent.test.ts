import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalAgentClient } from './localAgent';
const environment = { LOCAL_AGENT_URL: 'https://synthetic-agent.example', LOCAL_AGENT_TOKEN: 'synthetic-server-token-12345678901234567890' };
test('missing configuration fails closed without a network call', async () => {
  const client = createLocalAgentClient({}, (() => { throw new Error('unexpected fetch'); }) as typeof fetch);
  assert.equal((await client('ready')).ok, false);
});
test('credentials are sent only to the configured HTTPS origin; redirects are forbidden', async () => {
  const client = createLocalAgentClient(environment, (async (url, options) => {
    assert.equal(String(url), 'https://synthetic-agent.example/intake');
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${environment.LOCAL_AGENT_TOKEN}`);
    assert.equal(options?.redirect, 'error');
    return new Response(JSON.stringify({ questionId: 'onset', text: 'Synthetic question' }));
  }) as typeof fetch);
  assert.equal((await client('intake', { messages: [] })).ok, true);
});
test('unsafe server URLs are rejected', async () => {
  for (const url of ['http://remote.example', 'https://user:secret@example.test', 'https://example.test?token=bad', 'https://example.test/other']) {
    assert.equal((await createLocalAgentClient({ ...environment, LOCAL_AGENT_URL: url })('ready')).ok, false);
  }
});
test('upstream errors and malformed replies do not leak credentials or errors', async () => {
  for (const reply of [new Response('sensitive upstream details', { status: 500 }), new Response('[]')]) {
    const result = await createLocalAgentClient(environment, (async () => reply) as typeof fetch)('ready');
    assert.equal(result.ok, false);
    assert(!JSON.stringify(result).includes('sensitive'));
  }
});
