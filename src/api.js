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

export function getRecords(report, criteria = '', { record_cursor, sort_by, sort_order, max_records } = {}) {
  let url = API_BASE + '/api/get-records?report=' + encodeURIComponent(report);
  if (criteria) url += '&criteria=' + encodeURIComponent(criteria);
  if (record_cursor) url += '&record_cursor=' + encodeURIComponent(record_cursor);
  if (sort_by) url += '&sort_by=' + encodeURIComponent(sort_by);
  if (sort_order) url += '&sort_order=' + encodeURIComponent(sort_order);
  if (max_records) url += '&max_records=' + encodeURIComponent(max_records);
  return jfetch(url);
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
