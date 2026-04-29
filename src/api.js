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

export function getRecords(report) {
  return jfetch('/api/get-records?report=' + encodeURIComponent(report));
}

export function getRecordsByCriteria(report, criteria, { from = 1, limit = 200 } = {}) {
  return jfetch('/api/get-records?report=' + encodeURIComponent(report) + '&criteria=' + encodeURIComponent(criteria) + '&from=' + encodeURIComponent(from) + '&limit=' + encodeURIComponent(limit));
}

export function submitRecord(form, data) {
  return jfetch('/api/submit-record?form=' + encodeURIComponent(form), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  });
}

export function updateRecord(report, id, data) {
  return jfetch('/api/update-record?report=' + encodeURIComponent(report) + '&id=' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data })
  });
}

export function deleteRecord(report, id) {
  return jfetch('/api/delete-record?report=' + encodeURIComponent(report) + '&id=' + encodeURIComponent(id), {
    method: 'DELETE'
  });
}
