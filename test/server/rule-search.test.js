import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { registerRuleRoutes } from '../../server/modules/rules/routes.js';
import { createInteractive } from '../../server/modules/verification/interactive.js';
import { registerVerificationRoutes } from '../../server/modules/verification/routes.js';
import { VerificationTasks } from '../../server/modules/verification/tasks.js';
import { handleError } from '../../server/middleware/errors.js';

const rules = Array.from({ length: 8 }, (_, index) => ({ name: `Source ${index}` }));
const item = (rule) => ({ name: rule.name, url: `https://example.com/${rule.name}` });
const blocked = (signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

async function fixture(t, search, { timeoutMs = 3000, sources = rules } = {}) {
  const app = express();
  const verification = new VerificationTasks({ timeoutMs });
  app.use(express.json());
  registerVerificationRoutes(app, { verification });
  registerRuleRoutes(app, {
    http: {},
    store: {
      validationOptions: {},
      list: () => sources,
      get: (name) => sources.find((rule) => rule.name === name),
    },
    engine: { search },
    interactive: createInteractive(verification),
  });
  app.use(handleError);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    verification.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    verification,
    search: (stream = false, body = { keyword: '番剧' }) =>
      fetch(`${base}/api/rules/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(stream ? { accept: 'application/x-ndjson' } : {}),
        },
        body: JSON.stringify(body),
      }),
  };
}

async function* events(response) {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      yield JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
}

test(
  'search refills a free slot before slow peers finish and never exceeds four requests',
  { timeout: 5000 },
  async (t) => {
    const started = rules.map(() => Promise.withResolvers());
    const gates = rules.map(() => Promise.withResolvers());
    let active = 0,
      maximum = 0;
    const f = await fixture(t, async (rule) => {
      const index = rules.indexOf(rule);
      maximum = Math.max(maximum, ++active);
      started[index].resolve();
      await gates[index].promise;
      active--;
      return [item(rule)];
    });
    t.after(() => gates.forEach((gate) => gate.resolve()));
    const response = f.search();
    await Promise.all(started.slice(0, 4).map((source) => source.promise));
    gates[0].resolve();
    await started[4].promise;
    assert.equal(active, 4);
    assert.equal(maximum, 4);
    gates.forEach((gate) => gate.resolve());
    const data = await (await response).json();
    assert.equal(data.results.length, rules.length);
    assert.equal(maximum, 4);
    assert.equal(data.results[0].ruleName, rules[0].name);
  },
);

test(
  'a finished source reaches the HTTP stream while another source is still blocked',
  { timeout: 5000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const f = await fixture(
      t,
      async (rule, keyword, { signal }) => {
        if (rule === rules[1]) await Promise.race([gate.promise, blocked(signal)]);
        return [item(rule)];
      },
      { sources: rules.slice(0, 2) },
    );
    const response = await f.search(true);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.match(response.headers.get('cache-control'), /no-store/);
    const stream = events(response);
    const first = (await stream.next()).value;
    assert.deepEqual(first, {
      type: 'result',
      result: { ruleName: rules[0].name, items: [item(rules[0])] },
    });
    gate.resolve();
    const remaining = [];
    for await (const event of stream) remaining.push(event);
    assert.deepEqual(
      remaining.map((event) => event.type),
      ['result', 'complete'],
    );
    assert.equal(remaining.at(-1).result.results.length, 2);
  },
);

for (const stream of [false, true]) {
  test(
    `search timeout preserves completed sources and cancels pending work (${stream ? 'stream' : 'JSON'})`,
    { timeout: 5000 },
    async (t) => {
      const signals = [];
      const f = await fixture(
        t,
        async (rule, keyword, { signal }) => {
          signals.push(signal);
          if (rule !== rules[0]) await blocked(signal);
          return [item(rule)];
        },
        { timeoutMs: 200 },
      );
      const response = await f.search(stream);
      assert.equal(response.status, 200);
      let data;
      if (stream) {
        const received = [];
        for await (const event of events(response)) received.push(event);
        assert.equal(received[0].type, 'result');
        assert.equal(received.at(-1).type, 'complete');
        data = received.at(-1).result;
      } else data = await response.json();
      assert.equal(data.timedOut, true);
      assert.equal(data.results.length, rules.length);
      assert.deepEqual(data.results[0].items, [item(rules[0])]);
      assert.ok(data.results.slice(1).every((group) => /超时/.test(group.error)));
      assert.equal(signals.length, 5);
      assert.ok(signals.every((signal) => signal.aborted));
    },
  );
}

test(
  'closing a streamed search cancels upstream work and stops dispatching sources',
  { timeout: 5000 },
  async (t) => {
    const aborted = Promise.withResolvers();
    let started = 0;
    const f = await fixture(t, async (rule, keyword, { signal }) => {
      started++;
      if (rule !== rules[0]) {
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        await blocked(signal);
      }
      return [item(rule)];
    });
    const response = await f.search(true);
    const task = [...f.verification.tasks.values()][0];
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await aborted.promise;
    await task.done;
    assert.equal(started, 5);
    assert.equal(f.verification.tasks.size, 0);
  },
);

test(
  'captcha verification keeps streaming other sources and resumes through the owned HTTP session',
  { timeout: 5000 },
  async (t) => {
    let verified = false;
    const f = await fixture(
      t,
      async (rule, keyword, { onVerification }) => {
        if (rule === rules[0])
          await onVerification({
            ruleName: rule.name,
            originalUrl: 'https://example.com/search',
            snapshot: async () => ({
              status: verified ? 'completed' : 'waiting',
              image: 'data:image/png;base64,AA==',
            }),
            action: async (action) => {
              assert.deepEqual(action, { type: 'answer', text: '1234' });
              verified = true;
              return { status: 'completed' };
            },
          });
        return [item(rule)];
      },
      { sources: rules.slice(0, 2) },
    );
    const response = await f.search(true);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const iterator = events(response);
    const initial = [(await iterator.next()).value, (await iterator.next()).value];
    const challenge = initial.find((event) => event.type === 'verification');
    assert.equal(initial.find((event) => event.type === 'result').result.ruleName, rules[1].name);
    const url = `${f.base}/api/verification/${challenge.verificationId}`;
    assert.equal((await fetch(url)).status, 404);
    const state = await (await fetch(url, { headers: { cookie } })).json();
    const action = await fetch(`${url}/action`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: state.challenge.id,
        action: { type: 'answer', text: '1234' },
      }),
    });
    assert.equal(action.status, 200);
    const remaining = [];
    for await (const event of iterator) remaining.push(event);
    assert.deepEqual(
      remaining.map((event) => event.type),
      ['result', 'complete'],
    );
    assert.equal(remaining.at(-1).result.results.length, 2);
  },
);

test('source errors stay isolated and empty searches complete without a false timeout', async (t) => {
  const f = await fixture(
    t,
    async (rule) => {
      if (rule === rules[0]) throw new Error('来源故障');
      return [];
    },
    { sources: rules.slice(0, 2) },
  );
  const data = await (await f.search()).json();
  assert.equal(data.results[0].error, '来源故障');
  assert.deepEqual(data.results[1].items, []);
  assert.deepEqual(await (await f.search(false, { keyword: '番剧', ruleNames: [] })).json(), {
    results: [],
  });
  const invalid = await f.search(true, { keyword: '', ruleNames: [] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get('content-type'), /application\/json/);
});

for (const stream of [false, true]) {
  test(
    `a post-verification timeout still preserves completed sources (${stream ? 'stream' : 'JSON'})`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(
        t,
        async (rule, keyword, { signal, onVerification }) => {
          if (rule === rules[0]) {
            await onVerification({
              ruleName: rule.name,
              originalUrl: 'https://example.com/search',
              snapshot: async () => ({ status: 'completed' }),
            });
            await blocked(signal);
          }
          return [item(rule)];
        },
        { timeoutMs: 100, sources: rules.slice(0, 2) },
      );
      const response = await f.search(stream);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      let challenge, iterator;
      if (stream) {
        iterator = events(response);
        while (!challenge) {
          const event = (await iterator.next()).value;
          if (event.type === 'verification') challenge = event;
        }
      } else {
        assert.equal(response.status, 202);
        challenge = await response.json();
      }
      const url = `${f.base}/api/verification/${challenge.verificationId}`;
      const state = await (await fetch(url, { headers: { cookie } })).json();
      assert.ok(['running', 'completed'].includes(state.status));
      const task = f.verification.get(cookie.split('=')[1], challenge.verificationId);
      await task.done;
      const result = (await (await fetch(url, { headers: { cookie } })).json()).result;
      assert.equal(result.timedOut, true);
      assert.deepEqual(result.results[0].items, [item(rules[1])]);
      assert.match(result.results[1].error, /超时/);
      if (iterator) {
        const remaining = [];
        for await (const event of iterator) remaining.push(event);
        assert.deepEqual(remaining.at(-1), { type: 'complete', result });
      }
    },
  );
}

test(
  'disconnecting during captcha cancels the published task and all pending sources',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, async (rule, keyword, { signal, onVerification }) => {
      if (rule === rules[0])
        await onVerification({
          ruleName: rule.name,
          originalUrl: 'https://example.com/search',
          snapshot: async () => ({ status: 'waiting' }),
        });
      else await blocked(signal);
      return [];
    });
    const response = await f.search(true);
    const task = [...f.verification.tasks.values()][0];
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /verificationId/);
    await reader.cancel();
    await task.done;
    assert.equal(task.controller.signal.aborted, true);
    assert.equal(f.verification.tasks.size, 0);
  },
);
