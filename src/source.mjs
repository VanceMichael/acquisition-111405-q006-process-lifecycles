import {stableStringify} from './archive.mjs';

const TRANSITIONS = new Set(['start', 'complete', 'suspend', 'resume']);

export function isTypedCell(cell) {
  return cell !== null && typeof cell === 'object' && !Array.isArray(cell)
    && typeof cell.type === 'string' && Object.prototype.hasOwnProperty.call(cell, 'value');
}

function issue(kind, message, location, extra = {}) {
  return {kind, message, location, ...extra};
}

// 仅做结构接收与来源校验；不通过则抛出，调用方无法得到任何可解释的日志目录。
async function fetchLogDescriptor(transport) {
  const response = await transport.request('/log');
  if (!response.ok) throw new Error(`日志目录领取失败：${response.status}`);
  let descriptor;
  try { descriptor = response.json(); }
  catch { throw new Error('日志目录不是有效JSON'); }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new Error('日志目录结构无效');
  if (typeof descriptor.logId !== 'string' || !descriptor.logId) throw new Error('日志目录缺少logId');
  if (!Array.isArray(descriptor.fragments)) throw new Error('日志目录缺少fragments分片清单');
  if (descriptor.fragments.some(path => typeof path !== 'string' || !path)) throw new Error('分片清单含无效路径');
  const globals = descriptor.globals && typeof descriptor.globals === 'object' && !Array.isArray(descriptor.globals) ? descriptor.globals : {};
  const classifiers = Array.isArray(descriptor.classifiers) ? descriptor.classifiers : [];
  return {
    logId: descriptor.logId,
    globals,
    classifiers,
    fragments: descriptor.fragments,
    closed: descriptor.closed === true
  };
}

// 逐分片领取：单个分片失败只登记可复核问题，保留其他安全独立部分。
async function fetchFragments(transport, descriptor) {
  const documents = [];
  const issues = [];
  for (const [fragmentIndex, path] of descriptor.fragments.entries()) {
    let response;
    try {
      response = await transport.request(path);
    } catch (error) {
      issues.push(issue('fragment-unavailable', `分片无法领取：${error.message}`, {fragmentIndex, path}));
      continue;
    }
    if (!response.ok) {
      issues.push(issue('fragment-unavailable', `分片返回错误状态${response.status}`, {fragmentIndex, path, status: response.status}));
      continue;
    }
    let payload;
    try { payload = response.json(); }
    catch {
      issues.push(issue('fragment-malformed', '分片不是有效JSON', {fragmentIndex, path}));
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.traces)) {
      issues.push(issue('fragment-malformed', '分片缺少traces轨迹数组', {fragmentIndex, path}));
      continue;
    }
    documents.push({fragmentIndex, path, traces: payload.traces});
  }
  return {documents, issues};
}

function buildRecord({descriptor, occurrence, arrivalIndex, evidence, duplicateCount}) {
  const {traceId, event} = occurrence;
  const attributes = {};
  const overrideKeys = [];
  const inheritedKeys = [];
  const localIssues = [];

  // 全局默认值原样继承，并显式标注来源是全局默认而非事件实际覆盖。
  for (const [key, cell] of Object.entries(descriptor.globals)) {
    if (!isTypedCell(cell)) {
      localIssues.push(issue('global-attribute-malformed', `全局默认属性${key}不是合法的类型值单元`,
        {path: '/log', traceId, eventId: event.eventId, attribute: key}));
      continue;
    }
    attributes[key] = {...cell, origin: 'global'};
  }

  // 覆盖仅按键是否存在判断：false、0 同样构成覆盖，绝不回退到默认值。
  for (const [key, cell] of Object.entries(event.attributes ?? {})) {
    if (!isTypedCell(cell)) {
      attributes[key] = {raw: cell, origin: 'event', interpreted: false};
      localIssues.push(issue('event-attribute-malformed', `事件属性${key}不是合法的类型值单元，未解释为业务事实`,
        {traceId, eventId: event.eventId, attribute: key}));
      overrideKeys.push(key);
      continue;
    }
    attributes[key] = {...cell, origin: 'event'};
    overrideKeys.push(key);
  }
  for (const key of Object.keys(attributes)) {
    if (!overrideKeys.includes(key)) inheritedKeys.push(key);
  }

  const instanceCell = event.attributes?.['concept:instance'];
  const hasInstance = isTypedCell(instanceCell) && instanceCell.value !== null && instanceCell.value !== undefined;
  const executionId = hasInstance ? instanceCell.value : null;
  const transitionCell = event.attributes?.['lifecycle:transition'];
  const lifecycleTransition = isTypedCell(transitionCell) ? transitionCell.value : null;

  return {
    record: {
      id: `${descriptor.logId}|${traceId}|${event.eventId}`,
      logId: descriptor.logId,
      traceId,
      eventId: event.eventId,
      attributes,
      overrideKeys,
      inheritedKeys,
      lifecycleTransition,
      lifecycleTransitionKnown: TRANSITIONS.has(lifecycleTransition),
      executionId,
      association: hasInstance ? 'explicit' : 'unresolved',
      arrivalIndex,
      evidence,
      duplicates: duplicateCount
    },
    issues: localIssues
  };
}

// 纯解释层：保留来源轨迹与到达次序，只按 concept:instance 确认执行关联，不做时间就近配对。
export function interpretFragments({descriptor, documents, initialIssues = []}) {
  const issues = [...initialIssues];
  const occurrencesByEvent = new Map();
  const traces = new Map();
  let arrivalIndex = 0;

  for (const document of documents) {
    document.traces.forEach((trace, traceIndex) => {
      if (!trace || typeof trace !== 'object' || Array.isArray(trace)
        || typeof trace.traceId !== 'string' || !trace.traceId || !Array.isArray(trace.events)) {
        issues.push(issue('trace-malformed', '轨迹结构无效，已跳过该轨迹',
          {fragmentIndex: document.fragmentIndex, path: document.path, traceIndex}));
        return;
      }
      if (!traces.has(trace.traceId)) {
        traces.set(trace.traceId, {traceId: trace.traceId, fragmentIndexes: [], eventIds: []});
      }
      const traceSummary = traces.get(trace.traceId);
      traceSummary.fragmentIndexes.push(document.fragmentIndex);
      for (const event of trace.events) {
        const order = arrivalIndex++;
        traceSummary.eventIds.push(event && event.eventId != null ? String(event.eventId) : null);
        if (!event || typeof event !== 'object' || Array.isArray(event)
          || typeof event.eventId !== 'string' || !event.eventId
          || !event.attributes || typeof event.attributes !== 'object' || Array.isArray(event.attributes)) {
          issues.push(issue('event-malformed', '事件结构无效，未发布为确定事件',
            {fragmentIndex: document.fragmentIndex, path: document.path, traceId: trace.traceId, eventIndex: order}));
          continue;
        }
        const occurrence = {
          traceId: trace.traceId,
          event,
          arrivalIndex: order,
          fragmentIndex: document.fragmentIndex,
          fragmentPath: document.path
        };
        if (!occurrencesByEvent.has(event.eventId)) occurrencesByEvent.set(event.eventId, []);
        occurrencesByEvent.get(event.eventId).push(occurrence);
      }
    });
  }

  const records = [];
  for (const [eventId, occurrences] of occurrencesByEvent) {
    const canonicals = new Set(occurrences.map(item => stableStringify(item.event)));
    const traceIds = new Set(occurrences.map(item => item.traceId));
    const evidence = occurrences.map(item => ({fragmentIndex: item.fragmentIndex, path: item.fragmentPath}));
    if (canonicals.size > 1 || traceIds.size > 1) {
      // 冲突：两份候选都保留在原文证据中，records 不发布其中任一，绝不静默覆盖。
      issues.push(issue('event-conflict', `事件${eventId}存在不一致候选，未发布为确定事件`,
        {eventId, traceIds: [...traceIds]},
        {candidates: occurrences.map(item => ({
          fragmentIndex: item.fragmentIndex, path: item.fragmentPath,
          traceId: item.traceId, arrivalIndex: item.arrivalIndex, event: item.event
        }))}));
      continue;
    }
    const first = occurrences[0];
    const {record, issues: recordIssues} = buildRecord({
      descriptor,
      occurrence: first,
      arrivalIndex: first.arrivalIndex,
      evidence,
      duplicateCount: occurrences.length
    });
    records.push(record);
    issues.push(...recordIssues);
  }
  records.sort((a, b) => a.arrivalIndex - b.arrivalIndex);

  // 执行关联：只有显式 concept:instance 才能与 traceId 共同确定一次执行。
  const executionMap = new Map();
  const unlinked = [];
  for (const record of records) {
    if (record.association !== 'explicit') {
      unlinked.push({traceId: record.traceId, eventId: record.eventId,
        reason: '缺少 concept:instance，保留未关联，不做就近配对'});
      continue;
    }
    const key = `${record.traceId}␟${stableStringify(record.executionId)}`;
    if (!executionMap.has(key)) {
      executionMap.set(key, {
        logId: descriptor.logId, traceId: record.traceId, executionId: record.executionId,
        association: 'explicit', eventIds: [], transitions: []
      });
    }
    const execution = executionMap.get(key);
    execution.eventIds.push(record.eventId);
    execution.transitions.push({eventId: record.eventId, transition: record.lifecycleTransition, arrivalIndex: record.arrivalIndex});
  }

  const executions = [];
  for (const execution of executionMap.values()) {
    const hasStart = execution.transitions.some(item => item.transition === 'start');
    const hasComplete = execution.transitions.some(item => item.transition === 'complete');
    const reasons = [];
    if (!hasStart) reasons.push({code: 'missing-start', message: '缺少 start 开始记录（不推断开始时间，不按就近配对）'});
    if (!hasComplete) reasons.push({code: 'missing-complete', message: '缺少 complete 完成记录（缺少阶段不解释为耗时为零）'});
    const open = !hasStart || !hasComplete;
    executions.push({...execution, open, reasons});
    if (open) {
      issues.push(issue('execution-open', `执行${execution.traceId}/${execution.executionId}尚不能闭合`,
        {traceId: execution.traceId, executionId: execution.executionId},
        {missing: reasons.map(item => item.code), eventIds: execution.eventIds}));
    }
  }
  executions.sort((a, b) => a.eventIds[0]?.localeCompare(b.eventIds[0] ?? ''));

  return {records, executions, unlinked, traces: [...traces.values()], issues};
}

export async function collectSource({transport, archive}) {
  const descriptor = await fetchLogDescriptor(transport);
  const {documents, issues: fetchIssues} = await fetchFragments(transport, descriptor);
  const issues = [...fetchIssues];
  if (!descriptor.closed) {
    issues.push(issue('log-not-closed', '来源声明日志尚未闭合，后续可能补送分片', {path: '/log', logId: descriptor.logId}));
  }
  const interpreted = interpretFragments({descriptor, documents, initialIssues: issues});
  const complete = interpreted.issues.length === 0 && descriptor.closed;

  const result = {
    mode: 'source',
    log: {
      logId: descriptor.logId,
      closed: descriptor.closed,
      classifiers: structuredClone(descriptor.classifiers),
      globals: structuredClone(descriptor.globals),
      fragments: descriptor.fragments
    },
    records: interpreted.records,
    traces: interpreted.traces,
    executions: interpreted.executions,
    unlinked: interpreted.unlinked,
    complete,
    issues: interpreted.issues,
    evidenceCount: transport.exchanges.length
  };

  const previous = archive.snapshot().meta?.find(item => item.kind === 'source-log' && item.logId === descriptor.logId);
  const meta = {
    kind: 'source-log',
    logId: descriptor.logId,
    closed: descriptor.closed,
    classifiers: result.log.classifiers,
    globals: result.log.globals,
    fragments: descriptor.fragments,
    collectedAt: new Date().toISOString(),
    runs: (previous?.runs ?? 0) + 1,
    counts: {
      records: result.records.length,
      executions: result.executions.length,
      openExecutions: result.executions.filter(item => item.open).length,
      unresolved: result.unlinked.length,
      issues: result.issues.length
    }
  };
  await archive.commit({
    records: result.records,
    exchanges: transport.exchanges,
    issues: result.issues,
    meta
  });
  return result;
}
