import test from 'node:test';
import assert from 'node:assert/strict';
import { KazumiCoreClient } from '../reference/core-client.js';

test('core adapter delegates captcha URL generation and disposes the native session', async () => {
  const calls = [];
  let searchCount = 0;
  const client = new KazumiCoreClient({
    fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ path: url.pathname, body });
      if (url.pathname === '/search' && !searchCount++)
        return Response.json({ code: 'CAPTCHA_REQUIRED', error: 'verify' }, { status: 423 });
      if (url.pathname === '/captcha/start')
        return Response.json({ id: 'native', url: 'https://source.example/original-search' });
      if (url.pathname === '/search')
        return Response.json({ items: [{ name: 'done', url: 'opaque' }] });
      return Response.json({ status: 'completed' });
    },
  });
  const items = await client.search({ name: 'Fixture' }, 'a b', {
    sessionOwner: 'alice',
    onVerification: async (challenge) => {
      assert.equal(challenge.originalUrl, 'https://source.example/original-search');
      await challenge.snapshot();
      await challenge.action({ type: 'answer', text: '1234' });
    },
  });
  assert.equal(items[0].url, 'opaque');
  assert.equal(calls.find((c) => c.path === '/captcha/start').body.keyword, 'a b');
  assert.equal(calls.at(-1).path, '/captcha/cancel');
  assert.equal(calls.filter((c) => c.path === '/search').length, 2);
});
