import test from 'node:test';
import assert from 'node:assert/strict';
import { VerificationTasks } from '../../server/modules/verification/tasks.js';
import { KazumiCoreClient } from '../../server/modules/core/client.js';

test('native captcha completion resumes its task and stays bound to its browser owner', async () => {
  const tasks = new VerificationTasks();
  let completed = false;
  const initial = await tasks.start('alice', async ({ onVerification }) => {
    await onVerification({
      ruleName: 'Fixture',
      originalUrl: 'https://example.com/search',
      snapshot: async () => ({
        status: completed ? 'completed' : 'waiting',
        image: 'data:image/png;base64,AA==',
      }),
      action: async (action) => {
        assert.equal(action.text, '1234');
        completed = true;
        return { status: 'completed' };
      },
    });
    return { items: ['resumed'] };
  });
  try {
    await assert.rejects(tasks.snapshot('bob', initial.verificationId), { status: 404 });
    const state = await tasks.snapshot('alice', initial.verificationId);
    assert.equal(state.challenge.mode, 'image');
    await assert.rejects(
      tasks.action('alice', initial.verificationId, {
        challengeId: 'stale',
        action: { type: 'answer', text: '1234' },
      }),
      { status: 409 },
    );
    await tasks.action('alice', initial.verificationId, {
      challengeId: state.challenge.id,
      action: { type: 'answer', text: '1234' },
    });
    await tasks.get('alice', initial.verificationId).done;
    assert.deepEqual((await tasks.snapshot('alice', initial.verificationId)).result, {
      items: ['resumed'],
    });
  } finally {
    tasks.close();
  }
});

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
