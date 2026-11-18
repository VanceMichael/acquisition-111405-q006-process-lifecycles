import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openArchive, digest} from '../src/archive.mjs';
import {collect} from '../src/collector.mjs';

// 每个用例自带来源响应，不与公开夹具耦合。来源只通过本机 HTTP 发送数据。
async function withSource(routes, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({method: request.method, path: request.url});
    const route = routes[request.url];
    if (!route) { response.writeHead(404).end('未声明'); return; }
    const status = route.status ?? 200;
    const bytes = typeof route.body === 'string' ? Buffer.from(route.body) : Buffer.from(JSON.stringify(route.body));
    response.writeHead(status, {'content-type': 'application/json', 'content-length': bytes.length});
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run({baseUrl: `http://127.0.0.1:${server.address().port}`, requests});
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

const attr = (type, value) => ({type, value});
const log = (fragments, extra = {}) => ({
  logId: 'l', globals: {}, classifiers: [], fragments, closed: true, ...extra
});

async function collectOnce(routes, {directory, prepare} = {}) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'edge-'));
  return withSource(routes, async source => {
    if (prepare) await prepare(source);
    const archive = await openArchive(dir);
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    return {result, archive, directory: dir, requests: source.requests, source};
  });
}

test('两个分片按来源记录闭合执行，保留到达次序与来源时间', async () => {
  const routes = {
    '/log': {body: log(['/f/1', '/f/2'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 's', attributes: {
        'concept:instance': attr('string', 'i'), 'lifecycle:transition': attr('string', 'start'),
        'time:timestamp': attr('date', '2026-01-01T00:00:00Z'),
        'concept:name': attr('string', 'review')
      }
    }]}]}},
    '/f/2': {body: {traces: [{traceId: 't', events: [{
      eventId: 'c', attributes: {
        'concept:instance': attr('string', 'i'), 'lifecycle:transition': attr('string', 'complete'),
        'time:timestamp': attr('date', '2026-01-01T00:05:00Z'),
        'concept:name': attr('string', 'review')
      }
    }]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.complete, true);
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records.map(record => record.eventId), ['s', 'c']);
    assert.deepEqual(result.records.map(record => record.arrival), [0, 1]);
    assert.deepEqual(result.records.map(record => record.sourceTime.value),
      ['2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z']);
    assert.equal(result.executions.length, 1);
    const [execution] = result.executions;
    assert.equal(execution.executionId, 'i');
    assert.equal(execution.traceId, 't');
    assert.equal(execution.closure, 'closed');
    assert.deepEqual(execution.missing, []);
    assert.equal(execution.duration, null, '不按时间远近擅自配对成耗时');
    assert.deepEqual(execution.eventIds, ['s', 'c']);
    assert.equal(result.records.every(record => record.association === 'explicit'), true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('补送的完成事件没有开始记录：保留事件，执行未闭合，耗时不记零', async () => {
  const routes = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'c', attributes: {
        'concept:instance': attr('string', 'i'), 'lifecycle:transition': attr('string', 'complete')
      }
    }]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.records.length, 1);
    assert.equal(result.complete, false, '完成事件缺少开始记录是尚未解释的缺口');
    const [execution] = result.executions;
    assert.equal(execution.closure, 'unclosed');
    assert.deepEqual(execution.missing, ['start']);
    assert.equal(execution.duration, null);
    assert.notEqual(execution.duration, 0);
    const issue = result.issues.find(item => item.code === 'execution-not-closed');
    assert.ok(issue, '留下可回查的未闭合说明');
    assert.equal(issue.severity, 'error');
    assert.deepEqual(issue.missing, ['start']);
    assert.ok(issue.evidence.some(item => item.eventId === 'c' && item.rawHash));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('活动名相同但缺少执行标识时保持未关联，不跨轨迹配对', async () => {
  const routes = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [
      {traceId: 't1', events: [{eventId: 'a', attributes: {
        'concept:name': attr('string', 'review'), 'lifecycle:transition': attr('string', 'start')}}]},
      {traceId: 't2', events: [{eventId: 'b', attributes: {
        'concept:name': attr('string', 'review'), 'lifecycle:transition': attr('string', 'complete')}}]}
    ]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.records.length, 2);
    assert.equal(result.records.every(record => record.association === 'unresolved'), true);
    assert.equal(result.records.every(record => record.executionId === null), true);
    assert.deepEqual(result.executions, [], '不按活动名或时间制造执行');
    assert.equal(result.unresolved.count, 2);
    assert.equal(result.issues.some(item => item.code === 'association-unresolved'), true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('全局默认与事件覆盖逐键生效，false 和 0 也是覆盖', async () => {
  const routes = {
    '/log': {body: log(['/f/1'], {globals: {
      approved: attr('boolean', true), retries: attr('int', 3), untouched: attr('string', 'g')
    }, classifiers: [{name: 'activity', keys: ['concept:name', 'lifecycle:transition']}]})},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {
        'concept:name': attr('string', 'review'),
        'lifecycle:transition': attr('string', 'complete'),
        approved: attr('boolean', false),
        retries: attr('int', 0)
      }
    }]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    const [record] = result.records;
    assert.equal(record.attributes.approved.value, false);
    assert.equal(record.attributeOrigins.approved, 'event');
    assert.equal(record.attributes.retries.value, 0);
    assert.equal(record.attributeOrigins.retries, 'event');
    assert.equal(record.attributes.untouched.value, 'g');
    assert.equal(record.attributeOrigins.untouched, 'global');
    assert.equal(record.classification[0].values['concept:name'].value, 'review');
    assert.equal(record.classification[0].valueOrigins['concept:name'], 'event');
    assert.equal(record.classification[0].derived, true, '分类结果是采集端推断，不冒充来源字段');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('同 eventId 内容冲突不发布任一份，独立事件照常发布，两份原文可回查', async () => {
  const routes = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [
      {eventId: 'dup', attributes: {
        'concept:instance': attr('string', 'i'), 'lifecycle:transition': attr('string', 'start'),
        'concept:name': attr('string', 'review')}},
      {eventId: 'dup', attributes: {
        'concept:instance': attr('string', 'i'), 'lifecycle:transition': attr('string', 'start'),
        'concept:name': attr('string', 'approve')}},
      {eventId: 'solo', attributes: {
        'concept:instance': attr('string', 'i'), 'lifecycle:transition': attr('string', 'complete')}}
    ]}]}}
  };
  const {result, directory, archive} = await collectOnce(routes);
  try {
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].eventId, 'solo');
    assert.equal(result.complete, false);
    const issue = result.issues.find(item => item.code === 'event-conflict');
    assert.ok(issue);
    assert.equal(issue.candidates.length, 2);
    assert.deepEqual(result.conflicts[0].candidates.map(item => item.event.attributes['concept:name'].value),
      ['review', 'approve']);
    for (const candidate of result.conflicts[0].candidates) {
      assert.ok(candidate.rawHash);
      const bytes = await archive.raw(candidate.rawHash);
      assert.ok(bytes.toString('utf8').includes(candidate.event.attributes['concept:name'].value));
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('未知生命阶段原样保留但不计入闭合', async () => {
  const routes = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {
        'concept:instance': attr('string', 'i'), 'lifecycle:transition': attr('string', 'reassign')
      }
    }]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    const [record] = result.records;
    assert.equal(record.lifecycle.transition, 'reassign');
    assert.equal(record.lifecycle.recognized, false);
    assert.equal(result.executions[0].closure, 'unknown');
    assert.equal(result.issues.some(item => item.code === 'lifecycle-unknown'), true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('越界分片链接不访问其他站点，日志未关闭不声明完整', async () => {
  const routes = {
    '/log': {body: log(['http://198.51.100.7:9/private', '/f/1'], {closed: false})},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'start')}
    }]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(item => item.code === 'fragment-out-of-origin'));
    assert.ok(result.issues.some(item => item.code === 'log-not-closed'));
    assert.equal(result.records.length, 1, '已收的安全独立部分仍保留');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('分片错误与坏属性不拖累其他分片，但不会声明完整', async () => {
  const routes = {
    '/log': {body: log(['/f/1', '/f/bad', '/f/2'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'ok', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'start')}
    }]}]}},
    '/f/bad': {status: 410, body: {error: 'gone'}},
    '/f/2': {body: {traces: [{traceId: 't', events: [{
      eventId: 'broken', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('bogus', 'complete')}
    }]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 2, '结构完整的事件保留，坏值原样保留');
    assert.ok(result.issues.some(item => item.code === 'fragment-status'));
    assert.ok(result.issues.some(item => item.code === 'event-attribute-invalid'));
    assert.equal(result.issues.find(item => item.code === 'event-attribute-invalid').fragment, '/f/2');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('重复领取同一分片不产生新修订或假冲突，日志声明持久保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edge-repeat-'));
  const routes = {
    '/log': {body: log(['/f/1'], {
      globals: {approved: attr('boolean', true)},
      classifiers: [{name: 'activity', keys: ['concept:name', 'lifecycle:transition']}]
    })},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {'concept:instance': attr('string', 'i'),
        'concept:name': attr('string', 'review'), 'lifecycle:transition': attr('string', 'start')}
    }]}]}}
  };
  try {
    const first = await collectOnce(routes, {directory});
    assert.equal(first.result.complete, true);
    const second = await collectOnce(routes, {directory});
    assert.equal(second.result.complete, true, '相同重送不被误判为冲突');
    assert.equal(second.result.conflicts.length, 0);
    const reopened = await openArchive(directory);
    assert.equal(reopened.snapshot().records.length, 1);
    assert.equal(reopened.snapshot().logs.length, 1);
    assert.deepEqual(reopened.snapshot().logs[0].globals, {approved: attr('boolean', true)});
    assert.deepEqual(reopened.snapshot().logs[0].classifiers,
      [{name: 'activity', keys: ['concept:name', 'lifecycle:transition']}]);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('同一事件重送但内容改变时按冲突处理，不静默覆盖已归档原文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edge-conflict-'));
  const first = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'start'), 'concept:name': attr('string', 'review')}
    }]}]}}
  };
  const second = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'start'), 'concept:name': attr('string', 'approve')}
    }]}]}}
  };
  try {
    const one = await collectOnce(first, {directory});
    assert.equal(one.result.records.length, 1);
    const two = await collectOnce(second, {directory});
    assert.equal(two.result.complete, false);
    assert.equal(two.result.records.length, 0);
    const issue = two.result.issues.find(item => item.code === 'event-conflict');
    assert.ok(issue);
    assert.equal(issue.priorCandidates.length, 1);
    assert.equal(issue.candidates[0].event.attributes['concept:name'].value, 'approve');
    const reopened = await openArchive(directory);
    assert.equal(reopened.snapshot().records.length, 1, '旧修订仍可读，不被覆盖');
    assert.equal(reopened.snapshot().records[0].attributes['concept:name'].value, 'review');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('空日志与不可用日志可区分，且不伪造记录', async () => {
  const empty = {
    '/log': {body: log([])},
  };
  const one = await collectOnce(empty);
  try {
    assert.equal(one.result.records.length, 0);
    assert.equal(one.result.empty, true);
    assert.equal(one.result.complete, false, '空结果不能当作可解释的完整领取');
    const notice = one.result.issues.find(item => item.code === 'no-published-events');
    assert.ok(notice);
    assert.equal(notice.severity, 'notice', '与请求失败的错误区分开');
  } finally { await rm(one.directory, {recursive: true, force: true}); }

  const broken = {'/log': {status: 503, body: {error: 'unavailable'}}};
  const two = await collectOnce(broken);
  try {
    assert.equal(two.result.records.length, 0);
    assert.ok(two.result.issues.some(item => item.code === 'log-status' && item.status === 503));
  } finally { await rm(two.directory, {recursive: true, force: true}); }
});

test('归档原文与记录修订可分别回查', async () => {
  const routes = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'start')}
    }]}]}}
  };
  const {result, directory, archive} = await collectOnce(routes);
  try {
    const snapshot = archive.snapshot();
    assert.equal(snapshot.evidence.length, 2);
    assert.equal(snapshot.records.length, 1);
    assert.match(snapshot.records[0].revision, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.records[0].provenance.origin, 'source');
    assert.match(snapshot.records[0].provenance.rawHash, /^[a-f0-9]{64}$/);
    const raw = await archive.raw(snapshot.records[0].provenance.rawHash);
    assert.equal(digest(raw), snapshot.records[0].provenance.rawHash);
    const fragment = JSON.parse(raw);
    assert.equal(fragment.traces[0].events[0].attributes['concept:instance'].value, 'i');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('分两次领取的 start 与 complete 合并为同一执行，且可回查为何曾未闭合', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edge-across-'));
  const startOnly = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 's', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'start')}
    }]}]}}
  };
  const completeOnly = {
    '/log': {body: log(['/f/2'])},
    '/f/2': {body: {traces: [{traceId: 't', events: [{
      eventId: 'c', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'complete')}
    }]}]}}
  };
  try {
    const first = await collectOnce(startOnly, {directory});
    assert.equal(first.result.executions[0].closure, 'open');
    assert.deepEqual(first.result.executions[0].missing, ['complete']);

    const second = await collectOnce(completeOnly, {directory});
    assert.equal(second.result.executions.length, 1);
    const [execution] = second.result.executions;
    assert.equal(execution.closure, 'closed');
    assert.deepEqual(execution.missing, []);
    assert.deepEqual(execution.runEventIds, ['c']);
    assert.deepEqual(execution.eventIds, ['s', 'c']);
    assert.equal(execution.aggregatedAcrossReceipts, true);
    assert.equal(execution.duration, null, '合并后仍不擅自配对耗时');

    const reopened = await openArchive(directory);
    const stored = reopened.snapshot().executions.find(item => item.executionKey === execution.executionKey);
    assert.equal(stored.closure, 'closed');
    assert.deepEqual(stored.eventIds, ['s', 'c']);
    const openIssue = reopened.snapshot().issues.find(item => item.code === 'execution-not-closed');
    assert.ok(openIssue, '首次未闭合的原因留在归档中可供回查');
    assert.deepEqual(openIssue.missing, ['complete']);
    assert.equal(openIssue.evidence[0].eventId, 's');
    assert.ok(openIssue.evidence[0].rawHash);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('无效的全局默认值不变成业务事实，但原文保留在日志声明中', async () => {
  const routes = {
    '/log': {body: log(['/f/1'], {globals: {
      approved: attr('boolean', true),
      broken: {type: 'boolean', value: 'yes'}
    }})},
    '/f/1': {body: {traces: [{traceId: 't', events: [{
      eventId: 'e', attributes: {'concept:instance': attr('string', 'i'),
        'lifecycle:transition': attr('string', 'start')}
    }]}]}}
  };
  const {result, directory, archive} = await collectOnce(routes);
  try {
    const [record] = result.records;
    assert.equal(record.attributes.approved.value, true);
    assert.equal('broken' in record.attributes, false, '无效默认值不参与解释');
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(item => item.code === 'global-attribute-invalid' && item.key === 'broken'));
    const stored = archive.snapshot().logs[0];
    assert.deepEqual(stored.globals.broken, {type: 'boolean', value: 'yes'}, '原文保留');
    assert.equal('broken' in stored.effectiveGlobals, false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('未关联事件不因缺少执行标识而被当作已闭合', async () => {
  const routes = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [{traceId: 't', events: [
      {eventId: 's', attributes: {'lifecycle:transition': attr('string', 'start')}},
      {eventId: 'c', attributes: {'lifecycle:transition': attr('string', 'complete')}}
    ]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.executions, [], '没有执行标识就不制造执行');
    assert.equal(result.unresolved.count, 2);
    assert.equal(result.complete, true, '事件本身可读；缺口以未关联汇总呈现');
    assert.equal(result.issues.some(item => item.code === 'execution-not-closed'), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('全局默认的 concept:instance 同样可确定执行，并标明来源', async () => {
  const routes = {
    '/log': {body: log(['/f/1'], {globals: {'concept:instance': attr('string', 'i-g')}})},
    '/f/1': {body: {traces: [{traceId: 't', events: [
      {eventId: 's', attributes: {'lifecycle:transition': attr('string', 'start')}},
      {eventId: 'c', attributes: {'lifecycle:transition': attr('string', 'complete')}}
    ]}]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.records.every(record => record.association === 'explicit'), true);
    assert.equal(result.records.every(record => record.associationEvidence === 'global'), true);
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].closure, 'closed');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('不同轨迹可以有同名 eventId；同轨迹同 eventId 才构成身份冲突', async () => {
  const routes = {
    '/log': {body: log(['/f/1'])},
    '/f/1': {body: {traces: [
      {traceId: 't1', events: [{eventId: 'e', attributes: {
        'concept:instance': attr('string', 'i1'), 'lifecycle:transition': attr('string', 'start')}}]},
      {traceId: 't2', events: [{eventId: 'e', attributes: {
        'concept:instance': attr('string', 'i2'), 'lifecycle:transition': attr('string', 'complete')}}]}
    ]}}
  };
  const {result, directory} = await collectOnce(routes);
  try {
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records.map(record => record.traceId).sort(), ['t1', 't2']);
    assert.equal(new Set(result.records.map(record => record.id)).size, 2);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.complete, false, 't2 只有 complete，属于尚未解释的缺口');
    assert.deepEqual(result.executions.map(item => [item.traceId, item.closure]).sort(),
      [['t1', 'open'], ['t2', 'unclosed']], '两条轨迹各自成立，不跨轨迹合并');
  } finally { await rm(directory, {recursive: true, force: true}); }
});
