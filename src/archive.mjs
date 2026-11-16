import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename} from 'node:fs/promises';
import {join} from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// 业务身份比较用的稳定序列化，保证跨进程键序不影响去重与冲突判断。
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.partial`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function openArchive(directory) {
  await mkdir(join(directory, 'raw'), {recursive: true});
  const indexPath = join(directory, 'index.json');
  let state = {schema: 2, records: [], evidence: [], issues: [], meta: []};
  try { state = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // schema=1 的旧摘要索引仍可读取；首次写入时平滑升级到 schema=2。
  if (![1, 2].includes(state.schema) || !Array.isArray(state.records) || !Array.isArray(state.evidence)) {
    throw new Error('资料索引版本或结构无效');
  }
  if (!Array.isArray(state.issues)) state.issues = [];
  if (!Array.isArray(state.meta)) state.meta = [];
  for (const item of state.evidence) {
    if (!/^[a-f0-9]{64}$/.test(item.hash)) throw new Error('资料索引摘要无效');
    if (digest(await readFile(join(directory, 'raw', item.hash))) !== item.hash) throw new Error('原文摘要不匹配');
  }
  let tail = Promise.resolve();
  return {
    snapshot: () => structuredClone(state),
    async raw(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('原文引用无效');
      const bytes = await readFile(join(directory, 'raw', hash));
      if (digest(bytes) !== hash) throw new Error('原文损坏');
      return bytes;
    },
    commit({records = [], exchanges = [], issues = [], meta = null} = {}) {
      const operation = tail.then(async () => {
        const next = structuredClone(state);
        next.schema = 2;
        if (!Array.isArray(next.meta)) next.meta = [];
        for (const exchange of exchanges) {
          const hash = digest(exchange.bytes);
          await atomicWrite(join(directory, 'raw', hash), exchange.bytes);
          const item = {url: exchange.url, method: exchange.method, status: exchange.status, headers: exchange.headers, hash};
          const receipt = digest(Buffer.from(JSON.stringify(item)));
          if (!next.evidence.some(previous => previous.receipt === receipt)) next.evidence.push({...item, receipt});
        }
        for (const record of records) {
          if (typeof record.id !== 'string' || !record.id) throw new Error('资料缺少归档标识');
          const revision = digest(Buffer.from(JSON.stringify(record)));
          if (!next.records.some(previous => previous.id === record.id && previous.revision === revision)) {
            next.records.push({...structuredClone(record), revision});
          }
        }
        // 问题按内容稳定去重：重复领取不把同一条缺口重复写进索引。
        for (const item of issues) {
          const revision = digest(Buffer.from(stableStringify(item)));
          if (!next.issues.some(previous => previous.revision === revision)) {
            next.issues.push({...structuredClone(item), revision});
          }
        }
        if (meta) {
          if (typeof meta !== 'object' || Array.isArray(meta) || !meta.kind) throw new Error('归档元资料结构无效');
          const position = next.meta.findIndex(item => item.kind === meta.kind && item.logId === meta.logId);
          const stored = structuredClone(meta);
          if (position >= 0) next.meta[position] = stored;
          else next.meta.push(stored);
        }
        await atomicWrite(indexPath, JSON.stringify(next, null, 2) + '\n');
        state = next;
        return structuredClone(state);
      });
      tail = operation.catch(() => {});
      return operation;
    }
  };
}
