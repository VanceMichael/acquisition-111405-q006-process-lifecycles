import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';
import {isTypedCell, interpretFragments} from '../src/source.mjs';
import {stableStringify} from '../src/archive.mjs';

// 自带最小来源，测试边界行为，不依赖 fixtures/scenarios.json，也不改动来源服务。
async function startRouteServer(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({method: request.method, path: request.url});
      const route = routes.find(item => item.method === request.method && item.path === request.url);
      if (!route) { response.writeHead(404).end('未声明'); return; }
      const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
      response.writeHead(route.status ?? 200, {'content-type': 'application/json'}).end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => [...requests],
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

const cell = (type, value) => ({type, value});
const event = (eventId, attributes) => ({eventId, attributes});

async function withArchive(run) {
  const directory = await mkdtemp(join(tmpdir(), 'source-edge-'));
  try { await run(directory); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

test('同名活动的开始与完成在缺少 concept:instance 时不按时间就近配对', async () => {
  const server = await startRouteServer([
    {method: 'GET', path: '/log', body: {logId: 'L', globals: {}, classifiers: [], fragments: ['/f1'], closed: true}},
    {method: 'GET', path: '/f1', body: {traces: [{traceId: 'T', events: [
      event('a', {'concept:name': cell('string', 'review'), 'lifecycle:transition': cell('string', 'start'),
        'time:timestamp': cell('date', '2026-01-01T00:00:00Z')}),
      event('b', {'concept:name': cell('string', 'review'), 'lifecycle:transition': cell('string', 'complete'),
        'time:timestamp': cell('date', '2026-01-01T00:05:00Z')})
    ]}]}}
  ]);
  await withArchive(async directory => {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: server.baseUrl, archive, mode: 'source'});
    assert.deepEqual(result.records.map(r => r.association), ['unresolved', 'unresolved']);
    assert.equal(result.records.every(r => r.executionId === null), true);
    assert.deepEqual(result.executions, []);
    assert.equal(result.unlinked.length, 2);
    // 即使来源已闭合，未关联只是缺依据而非缺口：不伪造执行即视为本次解释完整。
    assert.equal(result.complete, true);
    assert.deepEqual(result.issues, []);
  });
  await server.close();
});

test('补送的完成事件没有开始记录：执行保留且报 missing-start，不把缺阶段当零耗时', async () => {
  const server = await startRouteServer([
    {method: 'GET', path: '/log', body: {logId: 'L', globals: {}, classifiers: [], fragments: ['/f1'], closed: true}},
    {method: 'GET', path: '/f1', body: {traces: [{traceId: 'T', events: [
      event('c', {'concept:name': cell('string', 'review'), 'concept:instance': cell('string', 'exec-7'),
        'lifecycle:transition': cell('string', 'complete')})
    ]}]}}
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: server.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.records[0].association, 'explicit');
    assert.equal(result.records[0].executionId, 'exec-7');
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].open, true);
    assert.deepEqual(result.executions[0].reasons.map(r => r.code), ['missing-start']);
    assert.equal(result.complete, false);
    assert.equal(result.issues.some(i => i.kind === 'execution-open' && i.missing.includes('missing-start')), true);
    // 不生成任何推断出的开始事件或耗时字段。
    assert.equal(result.records.length, 1);
    assert.equal('duration' in result.records[0], false);
  });
  await server.close();
});

test('false 与 0 是实际覆盖值：不回退全局默认，且来源与默认可区分', async () => {
  const server = await startRouteServer([
    {method: 'GET', path: '/log', body: {logId: 'L', globals: {
      approved: cell('boolean', true), retries: cell('int', 3), note: cell('string', 'default-note')
    }, classifiers: [], fragments: ['/f1'], closed: true}},
    {method: 'GET', path: '/f1', body: {traces: [{traceId: 'T', events: [
      event('e', {approved: cell('boolean', false), retries: cell('int', 0),
        'lifecycle:transition': cell('string', 'complete')})
    ]}]}}
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: server.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const attributes = result.records[0].attributes;
    assert.deepEqual(attributes.approved, {type: 'boolean', value: false, origin: 'event'});
    assert.deepEqual(attributes.retries, {type: 'int', value: 0, origin: 'event'});
    assert.deepEqual(attributes.note, {type: 'string', value: 'default-note', origin: 'global'});
    assert.deepEqual([...result.records[0].overrideKeys].sort(), ['approved', 'lifecycle:transition', 'retries']);
    assert.deepEqual(result.records[0].inheritedKeys, ['note']);
  });
  await server.close();
});

test('同 eventId 完全一致的重复分片事件去重保留，冲突则不发布且两份候选都留证', async () => {
  const descriptor = {logId: 'L', globals: {}, classifiers: [], fragments: ['/f1', '/f2'], closed: true};
  const repeatedEvent = event('e1', {'lifecycle:transition': cell('string', 'start')});
  const docs = [
    {fragmentIndex: 0, path: '/f1', traces: [{traceId: 'T', events: [repeatedEvent]}]},
    {fragmentIndex: 1, path: '/f2', traces: [{traceId: 'T', events: [
      structuredClone(repeatedEvent),
      event('e1', {'lifecycle:transition': cell('string', 'complete')})
    ]}]}
  ];
  const interpreted = interpretFragments({descriptor, documents: structuredClone(docs)});
  assert.equal(interpreted.records.length, 0);
  const conflict = interpreted.issues.find(i => i.kind === 'event-conflict');
  assert.ok(conflict);
  assert.equal(conflict.candidates.length, 3);
  assert.equal(new Set(conflict.candidates.map(c => c.fragmentIndex)).size, 2);

  // 完全一致则安全去重，并记录重复次数与两处证据。
  const clean = interpretFragments({descriptor, documents: [
    {fragmentIndex: 0, path: '/f1', traces: [{traceId: 'T', events: [repeatedEvent]}]},
    {fragmentIndex: 1, path: '/f2', traces: [{traceId: 'T', events: [structuredClone(repeatedEvent)]}]}
  ]});
  assert.equal(clean.records.length, 1);
  assert.equal(clean.records[0].duplicates, 2);
  assert.deepEqual(clean.records[0].evidence.map(e => e.fragmentIndex), [0, 1]);
  assert.deepEqual(clean.issues, []);
});

test('冲突轨迹中的独立无冲突事件照常发布，来源到达次序与轨迹结构保留', async () => {
  const descriptor = {logId: 'L', globals: {}, classifiers: [{name: 'activity', keys: ['concept:name']}],
    fragments: ['/f1'], closed: true};
  const docs = [{fragmentIndex: 0, path: '/f1', traces: [{traceId: 'T', events: [
    event('ok1', {'lifecycle:transition': cell('string', 'start')}),
    event('dup', {'lifecycle:transition': cell('string', 'start')}),
    event('dup', {'lifecycle:transition': cell('string', 'complete')}),
    event('ok2', {'lifecycle:transition': cell('string', 'resume')})
  ]}]}];
  const interpreted = interpretFragments({descriptor, documents: docs});
  assert.deepEqual(interpreted.records.map(r => r.eventId), ['ok1', 'ok2']);
  assert.deepEqual(interpreted.records.map(r => r.arrivalIndex), [0, 3]);
  assert.deepEqual(interpreted.traces[0].eventIds, ['ok1', 'dup', 'dup', 'ok2']);
  assert.equal(interpreted.issues.some(i => i.kind === 'event-conflict'), true);
});

test('分片领取失败不拖垮其他分片：安全部分落库，缺口带来源位置且 complete=false', async () => {
  const server = await startRouteServer([
    {method: 'GET', path: '/log', body: {logId: 'L', globals: {}, classifiers: [],
      fragments: ['/f1', '/missing', '/f2'], closed: true}},
    {method: 'GET', path: '/f1', body: {traces: [{traceId: 'T', events: [
      event('e1', {'lifecycle:transition': cell('string', 'start'), 'concept:instance': cell('string', 'x')})
    ]}]}},
    {method: 'GET', path: '/missing', status: 410, body: 'gone'},
    {method: 'GET', path: '/f2', body: {traces: [{traceId: 'T', events: [
      event('e2', {'lifecycle:transition': cell('string', 'complete'), 'concept:instance': cell('string', 'x')})
    ]}]}}
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: server.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.deepEqual(result.records.map(r => r.eventId), ['e1', 'e2']);
    const gap = result.issues.find(i => i.kind === 'fragment-unavailable');
    assert.ok(gap);
    assert.equal(gap.location.path, '/missing');
    assert.equal(gap.location.status, 410);
    assert.equal(result.complete, false);
    // 仍能闭合的执行给出确认关联。
    assert.equal(result.executions[0].open, false);
    const persisted = await openArchive(directory);
    assert.ok(persisted.snapshot().evidence.length >= 3);
  });
  await server.close();
});

test('来源声明未闭合时登记 log-not-closed，已确认内容继续保留', async () => {
  const server = await startRouteServer([
    {method: 'GET', path: '/log', body: {logId: 'L', globals: {}, classifiers: [], fragments: ['/f1'], closed: false}},
    {method: 'GET', path: '/f1', body: {traces: [{traceId: 'T', events: [
      event('e', {'concept:instance': cell('string', 'x'), 'lifecycle:transition': cell('string', 'start')})
    ]}]}}
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: server.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.issues.some(i => i.kind === 'log-not-closed'), true);
    assert.equal(result.records.length, 1);
  });
  await server.close();
});

test('重复领取同一来源：索引不膨胀且执行缺口可回查', async () => {
  const server = await startRouteServer([
    {method: 'GET', path: '/log', body: {logId: 'L', globals: {}, classifiers: [], fragments: ['/f1'], closed: true}},
    {method: 'GET', path: '/f1', body: {traces: [{traceId: 'T', events: [
      event('e', {'concept:instance': cell('string', 'x'), 'lifecycle:transition': cell('string', 'start')})
    ]}]}}
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'source-rerun-'));
  try {
    await collect({baseUrl: server.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const second = await collect({baseUrl: server.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const persisted = await openArchive(directory);
    const snapshot = persisted.snapshot();
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.issues.length, 1);
    assert.equal(snapshot.evidence.length, 2);
    assert.equal(snapshot.schema, 2);
    assert.equal(snapshot.meta[0].counts.openExecutions, 1);
    assert.equal(second.complete, false);
    // 原文可按证据摘要回查。
    const raw = JSON.parse((await persisted.raw(snapshot.evidence[1].hash)).toString('utf8'));
    assert.equal(raw.traces[0].events[0].eventId, 'e');
  } finally {
    await rm(directory, {recursive: true, force: true});
    await server.close();
  }
});

test('非法属性单元不解释为业务事实，保留原始形状并留问题', () => {
  assert.equal(isTypedCell(cell('string', 'x')), true);
  assert.equal(isTypedCell({type: 'string'}), false);
  assert.equal(isTypedCell('nope'), false);
  const descriptor = {logId: 'L', globals: {}, classifiers: [], fragments: ['/f1'], closed: true};
  const docs = [{fragmentIndex: 0, path: '/f1', traces: [{traceId: 'T', events: [
    {eventId: 'e', attributes: {'custom': 'bare-string'}}
  ]}]}];
  const interpreted = interpretFragments({descriptor, documents: docs});
  assert.equal(interpreted.records[0].attributes.custom.interpreted, false);
  assert.equal(interpreted.records[0].attributes.custom.origin, 'event');
  assert.equal(interpreted.issues.some(i => i.kind === 'event-attribute-malformed'), true);
});

test('稳定序列化不受键序影响，支撑跨进程冲突判断', () => {
  assert.equal(stableStringify({a: 1, b: [1, {x: 2}]}), stableStringify({b: [1, {x: 2}], a: 1}));
});
