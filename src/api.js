const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error((body && body.error) || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getRecords(report, criteria = '', { record_cursor } = {}) {
  // NOTE: sort_by / sort_order intentionally NOT forwarded — the Zoho report
  // endpoint rejects them for these reports (HTTP 400). max_records is fixed
  // server-side (200). Keep the query minimal to avoid 400s.
  let url = API_BASE + '/api/get-records?report=' + encodeURIComponent(report);
  if (criteria) url += '&criteria=' + encodeURIComponent(criteria);
  if (record_cursor) url += '&record_cursor=' + encodeURIComponent(record_cursor);
  try {
    return await jfetch(url);
  } catch (err) {
    // Treat a 400 (bad criteria / empty Zoho result) as an empty result set so
    // callers (e.g. 재다운로드 / redownload) degrade gracefully instead of failing.
    if (err && err.status === 400) {
      return { code: 3000, data: [], record_cursor: null, message: 'Empty result (400 treated as success)' };
    }
    throw err;
  }
}

export function getRecordsByCriteria(report, criteria, opts = {}) {
  return getRecords(report, criteria, opts);
}

export function submitRecord(form, data) {
  return jfetch(API_BASE + '/api/submit-record?form=' + encodeURIComponent(form), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  });
}

export function updateRecord(report, id, data) {
  return jfetch(API_BASE + '/api/update-record?report=' + encodeURIComponent(report) + '&id=' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  });
}

export function deleteRecord(report, id) {
  return jfetch(API_BASE + '/api/delete-record?report=' + encodeURIComponent(report) + '&id=' + encodeURIComponent(id), {
    method: 'DELETE'
  });
}
