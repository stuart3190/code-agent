import { BACKUP_PRIMARY_KEYS } from './backupPrimaryKeys.mjs';

export function cursorFilter(keys, row) {
  const literal = value => {
    if (value === null || value === undefined) throw new Error('backup primary key is missing');
    return typeof value === 'number' ? String(value) : JSON.stringify(String(value));
  };
  return keys.map((key, index) => {
    const terms = keys.slice(0, index).map(k => `${k}.eq.${literal(row[k])}`);
    terms.push(`${key}.gt.${literal(row[key])}`);
    return terms.length === 1 ? terms[0] : `and(${terms.join(',')})`;
  }).join(',');
}

// Keyset pages avoid offset shifts when earlier rows are removed during a live backup.
// This is a bounded logical export, not a cross-table point-in-time database snapshot.
export async function dumpTable(svc, table, { pageSize = 100, minPage = 10,
  pause = () => new Promise(resolve => setTimeout(resolve, 50)),
  retryPause = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log } = {}) {
  const keys = BACKUP_PRIMARY_KEYS[table];
  if (!keys?.length) throw new Error(`backup primary key not configured: ${table}`);
  const rows = []; const seen = new Set(); let cursor = null; let size = pageSize; let transientRetries = 0;
  for (;;) {
    let query = svc.from(table).select('*');
    for (const key of keys) query = query.order(key, { ascending: true });
    if (cursor) query = query.or(cursorFilter(keys, cursor));
    const { data, error, status } = await query.limit(size);
    if (error) {
      if (/timeout|canceling statement/i.test(error.message || '') && size > minPage) {
        size = Math.max(minPage, Math.floor(size / 4));
        log(`  ${table}: page too heavy, retrying at ${size} rows`);
        await pause(); continue;
      }
      if (([429, 502, 503, 504].includes(status) || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(error.message || ''))
          && transientRetries < 3) {
        transientRetries += 1;
        log(`  ${table}: transient transport failure (${status || 'network'}), retry ${transientRetries}/3`);
        await retryPause(1000 * 2 ** transientRetries); continue;
      }
      throw new Error(`${table}: ${String(error.message || 'request failed').slice(0, 300)}`);
    }
    transientRetries = 0;
    for (const row of data || []) {
      cursorFilter(keys, row); // fail on incomplete identity, including the first page
      const identity = JSON.stringify(keys.map(key => row[key]));
      if (seen.has(identity)) throw new Error(`${table}: duplicate primary key during backup`);
      seen.add(identity); rows.push(row);
    }
    if (!data?.length || data.length < size) break;
    cursor = data.at(-1);
    await pause();
  }
  return rows;
}
