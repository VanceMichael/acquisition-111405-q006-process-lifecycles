import {digest} from './archive.mjs';

const SUPPORTED_TYPES = new Set(['string', 'int', 'date', 'boolean']);
const LIFECYCLE_TRANSITIONS = new Set(['start', 'complete', 'suspend', 'resume']);
const INSTANCE_KEY = 'concept:instance';
const TRANSITION_KEY = 'lifecycle:transition';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => value === undefined ? undefined : structuredClone(value);

function stableSerialize(value) {
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (isObject(value)) {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function attributeEntryProblem(entry) {
  if (!isObject(entry)) return '属性值不是对象';
  if (!hasOwn(entry, 'type') || !hasOwn(entry, 'value')) return '属性值缺少 type 或 value';
  if (typeof entry.type !== 'string' || !SUPPORTED_TYPES.has(entry.type)) return `不支持的属性类型：${String(entry.type)}`;
  if (entry.type === 'string' && typeof entry.value !== 'string') return 'string 属性的 value 不是字符串';
  if (entry.type === 'int' && !Number.isInteger(entry.value)) return 'int 属性的 value 不是整数';
  if (entry.type === 'boolean' && typeof entry.value !== 'boolean') return 'boolean 属性的 value 不是布尔值';
  if (entry.type === 'date' && !['string', 'number'].includes(typeof entry.value)) return 'date 属性的 value 不是字符串或数字';
  return null;
}

function attributeProblems(attributes) {
  if (!isObject(attributes)) return [{key: null, problem: '属性集合不是对象'}];
  return Object.entries(attributes)
    .map(([key, entry]) => ({key, problem: attributeEntryProblem(entry)}))
    .filter(item => item.problem);
}

function scalarOf(entry) {
  if (attributeEntryProblem(entry)) return {valid: false};
  return {valid: true, value: entry.value, type: entry.type};
}

function issue(code, severity, message, details = {}) {
  return {code, severity, message, ...details};
}

function normalizeLog(payload, issues) {
  if (!isObject(payload)) {
    issues.push(issue('log-invalid', 'error', '来源日志不是对象，无法解释'));
    return {log: null, fatal: true};
  }
  let fatal = false;
  let logId = null;
  if (typeof payload.logId === 'string' && payload.logId) logId = payload.logId;
  else {
    issues.push(issue('log-id-missing', 'error', '来源日志缺少可用的 logId，不能形成稳定的归档标识'));
    fatal = true;
  }

  const declaredGlobals = {};
  const globals = {};
  if (!isObject(payload.globals)) {
    issues.push(issue('globals-invalid', 'error', '日志的 globals 不是对象，不能当作事件默认属性使用', {logId}));
  } else {
    const problems = attributeProblems(payload.globals);
    for (const {key, problem} of problems) {
      issues.push(issue('global-attribute-invalid', 'error', `全局默认属性 ${key ?? '(集合)'} 无效：${problem}`,
        {logId, key, scope: 'global'}));
    }
    const invalid = new Set(problems.map(item => item.key));
    for (const [key, value] of Object.entries(payload.globals)) {
      declaredGlobals[key] = clone(value);
      // 声明无效的默认值不能静默变成有效业务事实；原文保留在 logs 中。
      if (!invalid.has(key)) globals[key] = clone(value);
    }
  }

  let classifiers = [];
  let classificationKeys = [];
  if (!Array.isArray(payload.classifiers)) {
    issues.push(issue('classifiers-invalid', 'error', '日志的 classifiers 不是数组，不能据此解释活动', {logId}));
  } else {
    classifiers = clone(payload.classifiers);
    classifiers.forEach((classifier, classifierIndex) => {
      const usable = isObject(classifier) && typeof classifier.name === 'string' && classifier.name &&
        Array.isArray(classifier.keys) && classifier.keys.every(key => typeof key === 'string' && key);
      if (!usable) {
        issues.push(issue('classifier-invalid', 'error', '分类器声明不完整，原值保留但不据此推断',
          {logId, classifierIndex, declared: clone(classifier)}));
        return;
      }
      classificationKeys.push({name: classifier.name, keys: clone(classifier.keys)});
    });
  }

  let fragments = [];
  if (!Array.isArray(payload.fragments)) {
    issues.push(issue('fragments-invalid', 'error', '日志的 fragments 不是数组，无法领取分片', {logId}));
    fatal = true;
  } else {
    fragments = clone(payload.fragments);
  }

  const closed = payload.closed === true;
  if (!closed) {
    issues.push(issue('log-not-closed', 'error',
      payload.closed === false
        ? '来源声明日志尚未关闭，后续分片可能尚未送达'
        : '来源未声明日志已关闭，不能确认本次领取完整', {logId}));
  }

  return {log: {logId, globals, declaredGlobals, classifiers, classificationKeys, fragments, closed}, fatal};
}

function mergeAttributes(globals, eventAttributes) {
  const attributes = {};
  const attributeOrigins = {};
  for (const [key, value] of Object.entries(globals)) {
    attributes[key] = clone(value);
    attributeOrigins[key] = 'global';
  }
  for (const [key, value] of Object.entries(eventAttributes)) {
    attributes[key] = clone(value);
    attributeOrigins[key] = 'event';
  }
  return {attributes, attributeOrigins};
}

function classify(attributes, attributeOrigins, classifiers) {
  return classifiers.map(classifier => {
    const values = {};
    const valueOrigins = {};
    let complete = true;
    for (const key of classifier.keys) {
      if (hasOwn(attributes, key) && scalarOf(attributes[key]).valid) {
        values[key] = clone(attributes[key]);
        valueOrigins[key] = attributeOrigins[key];
      } else {
        values[key] = null;
        valueOrigins[key] = null;
        complete = false;
      }
    }
    return {
      name: classifier.name,
      keys: clone(classifier.keys),
      values,
      valueOrigins,
      complete,
      derived: true,
      derivedFrom: '来源声明的分类器键与实际生效属性'
    };
  });
}

function buildRecord({event, traceId, traceExtras, log, fragment, fragmentIndex, traceIndex, eventIndex,
  arrival, occurrences, rawHash, issues}) {
  const eventId = event.eventId;
  const {attributes, attributeOrigins} = mergeAttributes(log.globals, event.attributes);
  const details = {logId: log.logId, traceId, eventId, fragment, arrival};

  let execution = {executionId: null, association: 'unresolved', associationBasis: null, associationEvidence: null};
  if (hasOwn(attributes, INSTANCE_KEY)) {
    const scalar = scalarOf(attributes[INSTANCE_KEY]);
    const text = scalar.valid ? String(scalar.value) : '';
    if (!text) {
      issues.push(issue('instance-invalid', 'warning',
        'concept:instance 存在但不能作为执行标识读取；事件保留为未关联', details));
    } else {
      execution = {
        executionId: text,
        association: 'explicit',
        associationBasis: INSTANCE_KEY,
        associationEvidence: attributeOrigins[INSTANCE_KEY]
      };
    }
  }

  let lifecycle = {transition: null, transitionOrigin: null, recognized: false, basis: 'source-attribute'};
  if (hasOwn(attributes, TRANSITION_KEY)) {
    const scalar = scalarOf(attributes[TRANSITION_KEY]);
    if (!scalar.valid) {
      issues.push(issue('lifecycle-invalid', 'warning', 'lifecycle:transition 存在但无法作为阶段值读取', details));
    } else {
      const transition = String(scalar.value);
      lifecycle = {
        transition,
        transitionOrigin: attributeOrigins[TRANSITION_KEY],
        recognized: LIFECYCLE_TRANSITIONS.has(transition),
        basis: 'source-attribute'
      };
      if (!lifecycle.recognized) {
        issues.push(issue('lifecycle-unknown', 'warning',
          `lifecycle:transition 的取值 ${transition} 不在声明的生命阶段内；原样保留但不作为阶段事实`, details));
      }
    }
  }

  const sourceTimes = [];
  for (const [key, entry] of Object.entries(attributes)) {
    if (attributeEntryProblem(entry) || entry.type !== 'date') continue;
    sourceTimes.push({key, type: entry.type, value: clone(entry.value), origin: attributeOrigins[key]});
  }
  let sourceTime = null;
  let sourceTimeNote;
  if (sourceTimes.length === 1) {
    sourceTime = sourceTimes[0];
    sourceTimeNote = '来源事件显式携带的日期属性原值；未按到达先后以外的顺序重排';
  } else if (sourceTimes.length > 1) {
    sourceTimeNote = '来源事件带有多个日期属性，未擅自选定唯一来源时间';
  } else {
    sourceTimeNote = '来源事件没有携带日期属性；只保留到达次序，不推断时间';
  }

  return {
    id: `${log.logId}:${traceId}:${eventId}`,
    logId: log.logId,
    traceId,
    eventId,
    attributes,
    attributeOrigins,
    invalidAttributes: attributeProblems(event.attributes).map(item => item.key).filter(key => key !== null),
    executionId: execution.executionId,
    association: execution.association,
    associationBasis: execution.associationBasis,
    associationEvidence: execution.associationEvidence,
    associationReason: execution.association === 'explicit'
      ? `来源事件带有 concept:instance（${execution.associationEvidence === 'global' ? '来自全局默认值' : '来自事件自身'}），与 traceId 共同确定执行`
      : '来源事件缺少可用的 concept:instance；保留为未关联，不按活动名或到达时间猜测同一执行',
    lifecycle,
    classification: classify(attributes, attributeOrigins, log.classificationKeys),
    arrival,
    occurrences: clone(occurrences),
    sourceTime,
    sourceTimes,
    sourceTimeNote,
    duration: null,
    durationReason: '未取得可确认的起止关系；不按时间最近配对，不把缺失阶段解释为耗时 0',
    provenance: {
      origin: 'source',
      logId: log.logId,
      traceId,
      eventId,
      fragment,
      fragmentIndex,
      traceIndex,
      eventIndex,
      arrival,
      rawHash,
      sourceEvent: clone(event),
      traceExtras: clone(traceExtras)
    }
  };
}

function buildExecutions(records) {
  const groups = new Map();
  for (const record of records) {
    if (record.association !== 'explicit') continue;
    const executionKey = `${record.traceId}\u0000${record.executionId}`;
    let group = groups.get(executionKey);
    if (!group) {
      group = {
        executionId: record.executionId,
        traceId: record.traceId,
        executionKey,
        logId: record.logId,
        association: 'explicit',
        associationBasis: record.associationBasis,
        associationEvidence: record.associationEvidence,
        eventIds: [],
        evidence: [],
        transitions: {start: [], complete: [], suspend: [], resume: [], other: []}
      };
      groups.set(executionKey, group);
    }
    group.eventIds.push(record.eventId);
    group.evidence.push({
      eventId: record.eventId,
      transition: record.lifecycle.recognized ? record.lifecycle.transition : null,
      arrival: record.arrival,
      fragment: record.provenance.fragment,
      rawHash: record.provenance.rawHash
    });
    const transition = record.lifecycle.recognized ? record.lifecycle.transition : 'other';
    group.transitions[transition].push(record.eventId);
  }

  return [...groups.values()].map(group => {
    const hasStart = group.transitions.start.length > 0;
    const hasComplete = group.transitions.complete.length > 0;
    let closure;
    let missing;
    let closureReason;
    if (hasStart && hasComplete) {
      closure = 'closed';
      missing = [];
      closureReason = '同一 traceId 与 concept:instance 下同时收到 start 和 complete 来源记录';
    } else if (hasStart) {
      closure = 'open';
      missing = ['complete'];
      closureReason = '收到 start 来源记录，尚无 complete 记录；不以时间远近推断结束';
    } else if (hasComplete) {
      closure = 'unclosed';
      missing = ['start'];
      closureReason = '只收到 complete 来源记录，没有 start 记录；不以零耗时或推断起始补齐';
    } else {
      closure = 'unknown';
      missing = ['start', 'complete'];
      closureReason = '没有可用于判断闭合的生命阶段来源记录';
    }
    return {
      ...group,
      closure,
      missing,
      closureReason,
      derived: true,
      derivedFrom: '来源事件的 lifecycle:transition 记录；不做时间配对',
      duration: null,
      durationReason: closure === 'closed'
        ? '成对阶段已确认，但来源未声明起止配对关系；不按时间远近配对，故不给出耗时'
        : '缺少完整阶段记录；耗时尚不能确定，不记为 0'
    };
  });
}

function readTrace(trace, traceIndex, context) {
  const {log, fragment, fragmentIndex, issues, events} = context;
  if (!isObject(trace)) {
    issues.push(issue('trace-invalid', 'error', '分片中的轨迹不是对象',
      {logId: log.logId, fragment, traceIndex}));
    return;
  }
  if (typeof trace.traceId !== 'string' || !trace.traceId) {
    issues.push(issue('trace-id-missing', 'error', '轨迹缺少 traceId，无法确定事件归属',
      {logId: log.logId, fragment, traceIndex}));
    return;
  }
  if (!Array.isArray(trace.events)) {
    issues.push(issue('trace-events-invalid', 'error', '轨迹的 events 不是数组',
      {logId: log.logId, traceId: trace.traceId, fragment, traceIndex}));
    return;
  }
  const traceExtras = {};
  for (const [key, value] of Object.entries(trace)) {
    if (key === 'traceId' || key === 'events') continue;
    traceExtras[key] = clone(value);
  }
  trace.events.forEach((event, eventIndex) => {
    const arrival = events.nextArrival++;
    const details = {logId: log.logId, traceId: trace.traceId, fragment, traceIndex, eventIndex, arrival};
    if (!isObject(event)) {
      issues.push(issue('event-invalid', 'error', '事件不是对象，未发布为确定事件', details));
      events.invalid++;
      return;
    }
    if (typeof event.eventId !== 'string' || !event.eventId) {
      issues.push(issue('event-id-missing', 'error', '事件缺少 eventId，无法形成稳定业务标识', details));
      events.invalid++;
      return;
    }
    if (!isObject(event.attributes)) {
      issues.push(issue('event-attributes-invalid', 'error', '事件的 attributes 不是对象，未发布为确定事件',
        {...details, eventId: event.eventId}));
      events.invalid++;
      return;
    }
    for (const {key, problem} of attributeProblems(event.attributes)) {
      issues.push(issue('event-attribute-invalid', 'error',
        `事件属性 ${key ?? '(集合)'} 无效：${problem}；原文保留，但不作为业务事实解释`,
        {...details, eventId: event.eventId, key}));
      events.invalid++;
    }
    events.byId.set(event.eventId, [...(events.byId.get(event.eventId) ?? []), {
      traceId: trace.traceId, event, traceExtras, ...details
    }]);
  });
}

function publishEvents(events, context) {
  const {log, issues, records, conflicts, rawHashes, priorEvents} = context;

  // 事件的业务身份由 traceId 与 eventId 共同确定：不同轨迹中的同名 eventId 不是同一次执行，
  // 也不能因此互相比对内容。
  const byIdentity = new Map();
  for (const [eventId, candidates] of events.byId) {
    for (const candidate of candidates) {
      const key = `${candidate.traceId}\u0000${eventId}`;
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), {...candidate, eventId}]);
    }
  }

  for (const candidates of byIdentity.values()) {
    const eventId = candidates[0].eventId;
    const traceId = candidates[0].traceId;
    const recordId = `${log.logId}:${traceId}:${eventId}`;
    // 同一 traceId 下同名 eventId 在不同轨迹里仍无法区分时，才是真正的身份歧义。
    const byContent = new Map();
    for (const candidate of candidates) {
      const fingerprint = stableSerialize(candidate.event);
      if (!byContent.has(fingerprint)) byContent.set(fingerprint, []);
      byContent.get(fingerprint).push(candidate);
    }
    const prior = priorEvents.get(`${log.logId}\u0000${traceId}\u0000${eventId}`) ?? [];
    const priorFingerprints = new Set(prior.map(priorEvent => stableSerialize(priorEvent.event)));
    const differsFromPrior = priorFingerprints.size > 0 &&
      [...byContent.keys()].some(fingerprint => !priorFingerprints.has(fingerprint));
    const describe = candidate => ({
      traceId: candidate.traceId,
      fragment: candidate.fragment,
      fragmentIndex: candidate.fragmentIndex,
      traceIndex: candidate.traceIndex,
      eventIndex: candidate.eventIndex,
      arrival: candidate.arrival,
      rawHash: rawHashes.get(candidate.fragment) ?? null
    });
    const base = {logId: log.logId, traceId, eventId};

    if (byContent.size > 1 || differsFromPrior) {
      const priorCandidates = prior.map(priorEvent => ({
        origin: 'archive',
        traceId: priorEvent.traceId,
        fragment: priorEvent.fragment,
        rawHash: priorEvent.rawHash,
        event: clone(priorEvent.event)
      }));
      issues.push(issue('event-conflict', 'error',
        `同一轨迹 ${traceId} 中 eventId ${eventId} 出现内容不一致的候选，原文都保留，暂不发布其中任一为确定事件`,
        {...base,
          priorCandidates,
          candidates: candidates.map(candidate => ({...describe(candidate), event: clone(candidate.event)}))}));
      conflicts.push({
        recordId,
        eventId,
        traceId,
        reason: byContent.size > 1
          ? '同一轨迹中同名 eventId 的候选内容不一致'
          : '本次候选与已归档的同轨迹同 eventId 内容不一致',
        priorCandidates,
        candidates: candidates.map(candidate => ({...describe(candidate), event: clone(candidate.event)}))
      });
      continue;
    }

    const identical = [...byContent.values()][0];
    const first = identical[0];
    if (identical.length > 1) {
      issues.push(issue('event-repeated', 'warning',
        `事件 ${eventId} 以相同内容到达 ${identical.length} 次，按一次来源记录处理`,
        {...base, arrivals: identical.map(candidate => candidate.arrival)}));
    }
    records.push(buildRecord({
      event: first.event,
      traceId: first.traceId,
      traceExtras: first.traceExtras,
      log,
      fragment: first.fragment,
      fragmentIndex: first.fragmentIndex,
      traceIndex: first.traceIndex,
      eventIndex: first.eventIndex,
      arrival: first.arrival,
      occurrences: identical.map(candidate => ({
        arrival: candidate.arrival,
        fragment: candidate.fragment,
        fragmentIndex: candidate.fragmentIndex,
        traceIndex: candidate.traceIndex,
        eventIndex: candidate.eventIndex,
        rawHash: rawHashes.get(candidate.fragment) ?? null
      })),
      rawHash: rawHashes.get(first.fragment) ?? null,
      issues
    }));
  }
}

function readPriorEvents(archive) {
  const priorEvents = new Map();
  for (const previous of archive.sourceRecords()) {
    if (!previous.provenance.sourceEvent) continue;
    const key = `${previous.logId}\u0000${previous.traceId}\u0000${previous.eventId}`;
    priorEvents.set(key, [...(priorEvents.get(key) ?? []), {
      traceId: previous.traceId,
      event: previous.provenance.sourceEvent,
      fragment: previous.provenance.fragment,
      rawHash: previous.provenance.rawHash ?? null
    }]);
  }
  return priorEvents;
}

const recordIdentity = record => `${record.logId}\u0000${record.traceId}\u0000${record.eventId}`;

// 同一执行可能跨分片、跨多次领取到达。合并时仍以 traceId + concept:instance 为准，
// 绝不以活动名或时间邻近合并。
function mergeExecutionEvidence(records, priorRecords) {
  const byEvent = new Map();
  for (const record of records) byEvent.set(recordIdentity(record), record);
  const merged = [];
  for (const previous of priorRecords) {
    const current = byEvent.get(recordIdentity(previous));
    merged.push(current ?? previous);
  }
  const seen = new Set(merged.map(recordIdentity));
  for (const record of records) {
    if (!seen.has(recordIdentity(record))) merged.push(record);
  }
  return merged;
}

export async function collectSource({transport, archive}) {
  const issues = [];
  const records = [];
  const conflicts = [];
  const rawHashes = new Map();
  let complete = true;

  async function finish({log = null, logs = [], received = 0, invalid = 0} = {}) {
    if (!records.length) {
      const blocked = conflicts.length > 0 || invalid > 0 || received > 0;
      issues.push(issue('no-published-events', blocked ? 'error' : 'notice',
        blocked
          ? '本次收到来源事件，但没有可发布的确定记录'
          : '来源没有提供任何事件；这是可解释的空结果，不是请求错误',
        {logId: log?.logId ?? null, receivedEvents: received, invalidEvents: invalid,
          conflicts: conflicts.length}));
      // 空结果不声明完整：即使来源明确给出空日志，也没有可解释的事件可确认。
      complete = false;
    }
    records.sort((left, right) => left.arrival - right.arrival);

    // 闭合状态以整份归档（含本次）为准，避免同一次执行被分片或多次领取拆开。
    const allSourceRecords = mergeExecutionEvidence(records, archive.sourceRecords());
    const archivedExecutions = buildExecutions(allSourceRecords);
    const ownExecutions = buildExecutions(records);
    const currentKeys = new Set(ownExecutions.map(item => item.executionKey));
    const executions = archivedExecutions.filter(item => currentKeys.has(item.executionKey));
    for (const execution of executions) {
      const own = ownExecutions.find(item => item.executionKey === execution.executionKey);
      execution.runEventIds = own?.eventIds ?? execution.eventIds;
      execution.aggregatedAcrossReceipts = execution.eventIds.length > (own?.eventIds.length ?? 0);
      if (execution.closure === 'closed') continue;
      const severity = execution.closure === 'unclosed' ? 'error' : 'warning';
      issues.push(issue('execution-not-closed', severity,
        `执行 ${execution.executionId}（trace ${execution.traceId}）尚不能闭合：${execution.closureReason}`,
        {logId: execution.logId, executionId: execution.executionId, traceId: execution.traceId,
          executionKey: execution.executionKey, closure: execution.closure, missing: execution.missing,
          eventIds: execution.eventIds, evidence: execution.evidence,
          aggregatedAcrossReceipts: execution.aggregatedAcrossReceipts}));
    }
    const unresolvedEvents = records.filter(record => record.association === 'unresolved');
    if (unresolvedEvents.length) {
      issues.push(issue('association-unresolved', 'warning',
        `${unresolvedEvents.length} 条来源事件没有可用的 concept:instance，按来源声明保留为未关联`,
        {logId: log?.logId ?? null, eventIds: unresolvedEvents.map(record => record.eventId),
          traceIds: [...new Set(unresolvedEvents.map(record => record.traceId))]}));
    }
    if (issues.some(item => item.severity === 'error')) complete = false;
    await archive.commit({
      records,
      exchanges: transport.exchanges,
      issues,
      logs,
      executions: archivedExecutions
    });
    return {
      records,
      complete,
      issues,
      evidenceCount: transport.exchanges.length,
      log,
      logs,
      executions,
      unresolved: {
        count: unresolvedEvents.length,
        eventIds: unresolvedEvents.map(record => record.eventId),
        traceIds: [...new Set(unresolvedEvents.map(record => record.traceId))],
        reason: '事件没有可用的 concept:instance；不按活动名或时间猜测同一执行'
      },
      conflicts,
      receivedEvents: received,
      invalidEvents: invalid,
      empty: records.length === 0
    };
  }

  let logResponse;
  try { logResponse = await transport.request('/log'); }
  catch (error) {
    issues.push(issue('log-transport', 'error', `来源日志领取失败：${error.message}`, {url: '/log'}));
    return finish();
  }
  if (!logResponse.ok) {
    issues.push(issue('log-status', 'error', `来源日志请求返回状态 ${logResponse.status}`,
      {url: '/log', status: logResponse.status}));
    return finish();
  }
  let payload;
  try { payload = logResponse.json(); }
  catch (error) {
    issues.push(issue('log-json-invalid', 'error', `来源日志不是有效 JSON：${error.message}`, {url: '/log'}));
    return finish();
  }

  const normalized = normalizeLog(payload, issues);
  const log = normalized.log;
  const logs = !normalized.fatal && log ? [{
    logId: log.logId,
    // 归档保留来源声明的全部默认值，包括无效项；解释只使用有效的默认值。
    globals: log.declaredGlobals,
    effectiveGlobals: log.globals,
    classifiers: log.classifiers,
    fragments: log.fragments,
    closed: log.closed,
    origin: 'source'
  }] : [];
  if (normalized.fatal || !log) return finish({logs});

  const links = [];
  const seen = new Set();
  for (const link of log.fragments) {
    if (typeof link !== 'string' || !link) {
      issues.push(issue('fragment-link-invalid', 'error', '分片链接不是可用的字符串，已跳过',
        {logId: log.logId, link: clone(link)}));
      continue;
    }
    let resolved;
    try { resolved = new URL(link, transport.origin); }
    catch {
      issues.push(issue('fragment-link-invalid', 'error', `分片链接无法解析：${link}`, {logId: log.logId, link}));
      continue;
    }
    if (!['http:', 'https:'].includes(resolved.protocol) || resolved.origin !== transport.origin) {
      issues.push(issue('fragment-out-of-origin', 'error', `分片链接指向来源以外的站点，未发起请求：${link}`,
        {logId: log.logId, link, origin: resolved.origin}));
      continue;
    }
    if (seen.has(resolved.href)) {
      issues.push(issue('fragment-duplicate', 'warning', `分片链接重复，按一次领取处理：${link}`,
        {logId: log.logId, link}));
      continue;
    }
    seen.add(resolved.href);
    links.push(link);
  }

  const events = {byId: new Map(), nextArrival: 0, invalid: 0};
  const priorEvents = readPriorEvents(archive);
  for (let fragmentIndex = 0; fragmentIndex < links.length; fragmentIndex++) {
    const link = links[fragmentIndex];
    let response;
    try { response = await transport.request(link); }
    catch (error) {
      issues.push(issue('fragment-transport', 'error', `分片领取失败：${error.message}`,
        {logId: log.logId, fragment: link}));
      continue;
    }
    rawHashes.set(link, digest(response.bytes));
    if (!response.ok) {
      issues.push(issue('fragment-status', 'error', `分片请求返回状态 ${response.status}`,
        {logId: log.logId, fragment: link, status: response.status}));
      continue;
    }
    let fragment;
    try { fragment = response.json(); }
    catch (error) {
      issues.push(issue('fragment-json-invalid', 'error', `分片不是有效 JSON：${error.message}`,
        {logId: log.logId, fragment: link}));
      continue;
    }
    if (!isObject(fragment) || !Array.isArray(fragment.traces)) {
      issues.push(issue('fragment-invalid', 'error', '分片缺少 traces 数组，原文保留但不解释',
        {logId: log.logId, fragment: link}));
      continue;
    }
    fragment.traces.forEach((trace, traceIndex) => {
      readTrace(trace, traceIndex, {log, fragment: link, fragmentIndex, issues, events});
    });
  }

  publishEvents(events, {log, issues, records, conflicts, rawHashes, priorEvents});
  if (events.invalid) complete = false;
  if (conflicts.length) complete = false;
  return finish({log, logs, received: records.length + events.invalid + conflicts.length, invalid: events.invalid});
}
