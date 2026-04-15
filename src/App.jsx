import React, { useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { getRecords, submitRecord, updateRecord } from './api.js';

const MO_REPORT = 'All_MO';
const LOG_FORM = 'Add_Production_Log';
const LOG_REPORT = 'Production_Log_Report';

const PROCESS_MAP = {
  'Cutting / 재단 / 裁剪':       { dateStart: 'Cutting_Start_Date',   dateEnd: 'Cutting_End_Date',       qty: 'Cut_Quantity' },
  'Sewing / 봉제 / 缝制':        { dateStart: 'Sewing_Start_Date',    dateEnd: 'Sewing_Completion_Date', qty: null },
  'Packing / 포장 / 包装':       { dateStart: 'Packing_Start_Date',   dateEnd: 'Packing_End_Date',       qty: null },
  'Completed / 생산완료 / 生产完成': { dateStart: null,                dateEnd: null,                     qty: 'Finished_Quantity' },
  'Shipped / 출고완료 / 已出货':  { dateStart: null,                   dateEnd: 'Ship_Date',              qty: null }
};

const PROCS = [
  { key: 'Cutting / 재단 / 裁剪',        cn: '裁剪',     icon: '✂️', sub: 'Cutting' },
  { key: 'Sewing / 봉제 / 缝制',         cn: '缝制',     icon: '🧵', sub: 'Sewing' },
  { key: 'Packing / 포장 / 包装',        cn: '包装',     icon: '📦', sub: 'Packing' },
  { key: 'Completed / 생산완료 / 生产完成', cn: '生产完成', icon: '✅', sub: 'Completed' },
  { key: 'Shipped / 출고완료 / 已出货',   cn: '出货',     icon: '🚚', sub: 'Shipped', full: true }
];

function parsePlanNotes(planNotes) {
  if (!planNotes) return [];
  const lines = planNotes.split(/\n|\r\n|\r/);
  const result = [];
  lines.forEach((line) => {
    if (!line.trim()) return;
    const parts = line.split('|');
    let color = '', size = '', qty = '';
    parts.forEach((part) => {
      part = part.trim();
      if (/^Color:/i.test(part)) color = part.replace(/^Color:/i, '').trim();
      else if (/^Size:/i.test(part)) size = part.replace(/^Size:/i, '').trim();
      else if (/^Qty:/i.test(part)) qty = part.replace(/^Qty:/i, '').trim();
    });
    if (color || size || qty) result.push({ color, size, qty });
  });
  return result;
}

function NotesTable({ planNotes }) {
  const rows = parsePlanNotes(planNotes);
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 10, borderTop: '0.5px solid #E2E8F0', paddingTop: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', fontSize: 11, fontWeight: 700, color: '#94A3B8', padding: '4px 0', borderBottom: '0.5px solid #F1F5F9', marginBottom: 4 }}>
        <span>颜色/Color</span>
        <span style={{ textAlign: 'center' }}>尺码/Size</span>
        <span style={{ textAlign: 'right' }}>数量/Qty</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', fontSize: 12, padding: '5px 0', borderBottom: '0.5px solid #F8FAFC' }}>
          <span style={{ color: '#374151' }}>{r.color}</span>
          <span style={{ textAlign: 'center', color: '#374151' }}>{r.size}</span>
          <span style={{ textAlign: 'right', fontWeight: 600, color: '#1E3A8A' }}>{r.qty}</span>
        </div>
      ))}
    </div>
  );
}

function formatDate(raw) {
  if (!raw) return '-';
  let s = (typeof raw === 'object') ? (raw.display_value || '') : String(raw);
  s = s.trim();
  if (!s) return '-';
  const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2})/);
  if (m) return m[3] + '-' + (months[m[2]] || m[2]) + '-' + m[1] + ' ' + m[4];
  return s;
}

function parseDateRaw(s) {
  if (!s) return 0;
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const m = s.match(/(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return new Date(+m[3], months[m[2]], +m[1], +m[4], +m[5], +m[6]).getTime();
}

function getTodayStr() {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return pad(d.getDate()) + '-' + months[d.getMonth()] + '-' + d.getFullYear()
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function CameraOverlay({ onResult, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanningRef = useRef(true);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    let raf;

    function tick() {
      if (!scanningRef.current) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        if (code) {
          scanningRef.current = false;
          stop();
          onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    }

    function stop() {
      scanningRef.current = false;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (raf) cancelAnimationFrame(raf);
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        streamRef.current = s;
        video.srcObject = s;
        video.play();
        raf = requestAnimationFrame(tick);
      })
      .catch((err) => {
        stop();
        alert('无法访问摄像头: ' + err.message);
        onCancel();
      });

    return () => { stop(); };
  }, [onResult, onCancel]);

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: '#000', zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <video ref={videoRef} playsInline autoPlay style={{ width: '100%', maxWidth: 480, maxHeight: '60vh', objectFit: 'cover', borderRadius: 8 }} />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <p style={{ color: '#fff', fontSize: 14, marginTop: 16, textAlign: 'center' }}>将二维码对准中心区域</p>
      <button
        onClick={onCancel}
        style={{ marginTop: 16, padding: '12px 32px', background: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', color: '#1E3A8A' }}
      >取消</button>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState('scan');
  const [loadingMsg, setLoadingMsg] = useState('正在读取订单信息...');
  const [moData, setMoData] = useState({});
  const [moRecordId, setMoRecordId] = useState('');
  const [selectedProcess, setSelectedProcess] = useState('');
  const [selectedProcessCN, setSelectedProcessCN] = useState('');
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsShown, setLogsShown] = useState(false);
  const [modalIdx, setModalIdx] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileInputRef = useRef(null);

  const [fCompleted, setFCompleted] = useState('');
  const [fIncomplete, setFIncomplete] = useState('');
  const [fDefect, setFDefect] = useState('');
  const [fBag, setFBag] = useState('');
  const [fWorker, setFWorker] = useState('');
  const [fNotes, setFNotes] = useState('');
  const [submitErr, setSubmitErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [successSnapshot, setSuccessSnapshot] = useState(null);

  useEffect(() => { window.scrollTo(0, 0); }, [screen]);

  function resetFormFields() {
    setFCompleted(''); setFIncomplete(''); setFDefect('');
    setFBag(''); setFWorker(''); setFNotes('');
    setSubmitErr('');
  }

  function goToScan() {
    setMoData({}); setMoRecordId('');
    setSelectedProcess(''); setSelectedProcessCN('');
    setLogs([]); setLogsShown(false);
    resetFormFields();
    setScreen('scan');
  }

  function startScan() {
    setCameraOpen(true);
  }

  function openUpload() {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }

  function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
      URL.revokeObjectURL(img.src);
      if (code && code.data) {
        onQR(code.data);
      } else {
        alert('无法识别二维码，请重试\nQR 코드를 인식할 수 없습니다');
      }
    };
    img.onerror = () => { alert('图片加载失败'); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(file);
  }

  function onQR(qrText) {
    setCameraOpen(false);
    const text = (qrText || '').trim();
    let moNumber = '', skuVal = '', factoryVal = '';
    text.split(/[|\n\r]+/).forEach((part) => {
      part = part.trim();
      const idx = part.indexOf(':');
      if (idx < 0) return;
      const key = part.substring(0, idx).trim().toUpperCase();
      const val = part.substring(idx + 1).trim();
      if (key === 'MO') moNumber = val;
      else if (key === 'SKU') skuVal = val;
      else if (key === 'FACTORY') factoryVal = val;
    });
    if (!moNumber) {
      if (/^[A-Z]{2}\d{2}-\d+/i.test(text)) moNumber = text;
      else { alert('未能识别订单号\n\n扫描内容: ' + text); return; }
    }
    setLoadingMsg('正在读取订单信息...');
    setScreen('loading');
    fetchMOData(moNumber, skuVal, factoryVal);
  }

  async function fetchMOData(moNumber, sku, factory) {
    try {
      const res = await getRecords(MO_REPORT);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const found = list.find((r) => r['MO_Number'] === moNumber);
      if (!found) {
        setScreen('scan');
        alert('未找到订单号: ' + moNumber + '\n请确认后重新扫描');
        return;
      }
      const r = found;
      let skuStr = sku || '-';
      const skuRaw = r['Style_SKU'];
      if (skuRaw) {
        if (typeof skuRaw === 'object') skuStr = skuRaw.display_value || skuRaw.Style_SKU || skuStr;
        else if (skuRaw !== '-') skuStr = skuRaw;
      }
      const next = {
        mo_number: r['MO_Number'] || moNumber,
        sku: skuStr,
        factory: factory || '-',
        order_qty: parseInt(r['Plan_Total_Quantity']) || 0,
        current_status: r['Production_Status'] || '-',
        plan_notes: r['Plan_Notes'] || ''
      };
      setMoData(next);
      setMoRecordId(r['ID']);
      setScreen('info');
      setTimeout(() => fetchLogs(next.mo_number), 300);
    } catch (err) {
      setScreen('scan');
      alert('数据读取失败，请重试\n' + (err && err.message || JSON.stringify(err)));
    }
  }

  async function fetchLogs(moNumber) {
    setLogsShown(true);
    setLogsLoading(true);
    try {
      const res = await getRecords(LOG_REPORT);
      let list = [];
      if (res && res.code === 3000 && Array.isArray(res.data)) {
        list = res.data.filter((r) => {
          let recMO = r['MO_Number'];
          if (typeof recMO === 'object') recMO = recMO.display_value || '';
          return recMO === moNumber;
        });
        list.sort((a, b) => {
          let da = a['Log_Date'] || '';
          let db = b['Log_Date'] || '';
          if (typeof da === 'object') da = da.display_value || '';
          if (typeof db === 'object') db = db.display_value || '';
          return parseDateRaw(String(db)) - parseDateRaw(String(da));
        });
      }
      setLogs(list);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }

  function selectProcess(procKey, procCN) {
    setSelectedProcess(procKey);
    setSelectedProcessCN(procCN);
    resetFormFields();
    setTimeout(() => setScreen('input'), 150);
  }

  async function submitData() {
    const completedQty = parseInt(fCompleted) || 0;
    const defectQty = parseInt(fDefect) || 0;
    const incompleteQty = parseInt(fIncomplete) || 0;
    const bagQty = parseInt(fBag) || 0;
    const worker = fWorker.trim();
    const notes = fNotes.trim();
    const todayStr = getTodayStr();
    if (completedQty <= 0) { setSubmitErr('请输入完成数量'); return; }
    if (!worker) { setSubmitErr('请输入负责人姓名（必填）'); return; }
    setSubmitErr('');
    setSubmitting(true);
    const logData = {
      'MO_Number': moData.mo_number,
      'SKU': moData.sku,
      'Factory': moData.factory,
      'Process': selectedProcess,
      'Completed_Qty': completedQty,
      'Incomplete_Qty': incompleteQty,
      'Defect_Qty': defectQty,
      'Bag_Qty': bagQty,
      'Worker': worker,
      'Log_Date': todayStr,
      'Notes': notes
    };
    try {
      const res = await submitRecord(LOG_FORM, logData);
      if (!res || res.code !== 3000) {
        setSubmitErr('日志保存失败: ' + JSON.stringify(res));
        setSubmitting(false);
        return;
      }
      const map = PROCESS_MAP[selectedProcess];
      const updateData = { 'Production_Status': selectedProcess };
      if (map) {
        if (map.dateStart) updateData[map.dateStart] = todayStr;
        if (map.dateEnd) updateData[map.dateEnd] = todayStr;
        if (map.qty) updateData[map.qty] = completedQty;
      }
      try { await updateRecord(MO_REPORT, moRecordId, updateData); } catch { /* ignore */ }
      showSuccess(completedQty, incompleteQty, defectQty, worker, notes);
    } catch (err) {
      setSubmitErr('提交失败，请重试: ' + (err && err.message || JSON.stringify(err)));
      setSubmitting(false);
    }
  }

  function showSuccess(completedQty, incompleteQty, defectQty, worker, notes) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    setSuccessSnapshot({
      mo: moData.mo_number,
      process: selectedProcess,
      processCN: selectedProcessCN,
      completed: completedQty,
      incomplete: incompleteQty,
      defect: defectQty,
      worker: worker || '未填写',
      notes,
      time: timeStr
    });
    setSubmitting(false);
    setScreen('success');
  }

  const showBag = selectedProcess.indexOf('Packing') >= 0 || selectedProcess.indexOf('Shipped') >= 0;
  const notesRows = useMemo(() => parsePlanNotes(moData.plan_notes), [moData.plan_notes]);
  const modalLog = (modalIdx != null) ? logs[modalIdx] : null;

  return (
    <>
      <div className="container">
        {/* SCAN */}
        <div className={'screen' + (screen === 'scan' ? ' active' : '')} id="screen-scan">
          <div className="scan-wordmark">IKU Production System</div>
          <div className="scan-frame-wrap">
            <div className="sc-corner sc-tl"></div>
            <div className="sc-corner sc-tr"></div>
            <div className="sc-corner sc-bl"></div>
            <div className="sc-corner sc-br"></div>
            <div className="sc-inner"><div className="sc-dot"></div></div>
            <div className="sc-line"></div>
          </div>
          <div className="scan-label-wrap">
            <p>QR코드를 프레임 안에 맞춰주세요</p>
            <p>请将二维码对准框内</p>
          </div>
          <button className="btn-scan-start" onClick={startScan}>SCAN START / 开始扫码</button>
          <button className="btn-upload-qr" onClick={openUpload}>QR UPLOAD / 上传二维码</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <div className="scan-hint-wrap">
            <p>카메라가 자동으로 QR을 인식합니다</p>
            <p>摄像头将自动识别二维码</p>
          </div>
        </div>

        {/* LOADING */}
        <div className={'screen' + (screen === 'loading' ? ' active' : '')} id="screen-loading">
          <div className="loading-wrap">
            <div className="spinner"></div>
            <p>{loadingMsg}</p>
          </div>
        </div>

        {/* INFO */}
        <div className={'screen' + (screen === 'info' ? ' active' : '')} id="screen-info" style={{ background: 'var(--surface2)', minHeight: '100vh', padding: 16 }}>
          <button className="back-link" onClick={goToScan}>← 重新扫码</button>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-title">订单信息确认</div>
            <div className="info-row"><span className="info-label">订单号 (MO)</span><span className="info-value">{moData.mo_number || '-'}</span></div>
            <div className="info-row"><span className="info-label">品号 (SKU)</span><span className="info-value">{moData.sku || '-'}</span></div>
            <div className="info-row"><span className="info-label">工厂</span><span className="info-value">{moData.factory || '-'}</span></div>
            <div className="info-row"><span className="info-label">订单数量</span><span className="info-value">{moData.order_qty != null ? moData.order_qty.toLocaleString() + ' 件' : '-'}</span></div>
            <div className="info-row"><span className="info-label">当前状态</span><span className="status-pill">{moData.current_status || '-'}</span></div>
          </div>

          {notesRows.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="card-title">订单明细 / 주문내용</div>
              <NotesTable planNotes={moData.plan_notes} />
            </div>
          )}

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="process-title">请选择当前工序</div>
            <div className="process-grid">
              {PROCS.map((p) => (
                <div
                  key={p.key}
                  className={'proc-btn' + (p.full ? ' proc-full' : '') + (selectedProcess === p.key ? ' selected' : '')}
                  onClick={() => selectProcess(p.key, p.cn)}
                >
                  <span className="proc-icon">{p.icon}</span>
                  <div className="proc-name">{p.cn}</div>
                  <div className="proc-sub">{p.sub}</div>
                </div>
              ))}
            </div>
          </div>

          {logsShown && (
            <div className="card" id="log-section">
              <div className="card-title">工序记录 / 공정기록</div>
              <div id="log-list">
                {logsLoading ? (
                  <div className="log-loading"><div className="log-spinner"></div>加载中...</div>
                ) : logs.length === 0 ? (
                  <div className="log-empty">暂无工序记录</div>
                ) : logs.map((r, i) => {
                  const process = r['Process'] || '-';
                  const completed = parseInt(r['Completed_Qty']) || 0;
                  const defect = parseInt(r['Defect_Qty']) || 0;
                  let worker = r['Worker'] || r['Worker_Name'] || r['Responsible'] || '';
                  if (typeof worker === 'object') worker = worker.display_value || '';
                  worker = String(worker).trim() || '未填写';
                  const date = formatDate(r['Log_Date'] || r['Log_DateTime'] || r['Created_Time'] || '');
                  const notes = r['Notes'] || '';
                  return (
                    <div key={i} className="log-item" onClick={() => setModalIdx(i)} style={{ cursor: 'pointer' }}>
                      <div>
                        <div className="log-process"><span className="log-dot"></span>{process}</div>
                        <div className="log-meta">负责人: {worker}{notes ? ' · ' + notes : ''}</div>
                      </div>
                      <div>
                        <div className="log-qty">完成 {completed.toLocaleString()}件</div>
                        {defect > 0 && <div className="log-defect">▲ 불량 {defect}件</div>}
                        <div className="log-date">{date}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* INPUT */}
        <div className={'screen' + (screen === 'input' ? ' active' : '')} id="screen-input">
          <div className="input-hero">
            <div className="input-hero-row">
              <button className="back-link" onClick={() => setScreen('info')} style={{ fontSize: 18, marginBottom: 0 }}>←</button>
              <div>
                <div className="input-hero-proc">{selectedProcessCN || 'CUTTING'}</div>
                <div className="input-hero-mo">{selectedProcessCN ? selectedProcessCN + ' · ' + (moData.mo_number || '-') : '-'}</div>
              </div>
            </div>
            <div className="input-progress">
              <div className="input-progress-bar active"></div>
              <div className="input-progress-bar active"></div>
              <div className="input-progress-bar active"></div>
              <div className="input-progress-bar inactive"></div>
            </div>
          </div>

          <div className="card" style={{ margin: '12px 16px', marginBottom: 12 }}>
            <div className="card-title">订单确认</div>
            <div className="info-row"><span className="info-label">订单号</span><span className="info-value">{moData.mo_number || '-'}</span></div>
            <div className="info-row"><span className="info-label">SKU</span><span className="info-value">{moData.sku || '-'}</span></div>
            <div className="info-row"><span className="info-label">工序</span><span className="info-value" style={{ color: '#1E3A8A' }}>{selectedProcess ? selectedProcessCN + ' (' + selectedProcess + ')' : '-'}</span></div>
            <div className="info-row"><span className="info-label">订单数量 (参考)</span><span className="info-value" style={{ color: '#7C3AED' }}>{moData.order_qty != null ? moData.order_qty.toLocaleString() + ' 件' : '-'}</span></div>
            <div id="c-subform"><NotesTable planNotes={moData.plan_notes} /></div>
          </div>

          <div style={{ padding: '0 16px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div className="qty-card">
              <div className="qty-card-label">完成 *</div>
              <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={fCompleted} onChange={(e) => setFCompleted(e.target.value)} />
            </div>
            <div className="qty-card muted">
              <div className="qty-card-label">未完成</div>
              <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={fIncomplete} onChange={(e) => setFIncomplete(e.target.value)} />
            </div>
            <div className="qty-card danger">
              <div className="qty-card-label">不良</div>
              <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={fDefect} onChange={(e) => setFDefect(e.target.value)} />
            </div>
            {showBag && (
              <div className="qty-card muted" style={{ display: 'block' }}>
                <div className="qty-card-label">麻袋数量</div>
                <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={fBag} onChange={(e) => setFBag(e.target.value)} />
              </div>
            )}
            <div className="field-card">
              <div className="field-card-label">负责人 / 담당자 *</div>
              <input className="input-field text-field" type="text" placeholder="이름을 입력하세요" value={fWorker} onChange={(e) => setFWorker(e.target.value)} />
            </div>
            <div className="field-card">
              <div className="field-card-label">备注 / 메모</div>
              <input className="input-field text-field" type="text" placeholder="선택사항" value={fNotes} onChange={(e) => setFNotes(e.target.value)} />
            </div>
          </div>

          <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }} id="worker-area"></div>
          <div id="submit-err">{submitErr && <div className="err-box">{submitErr}</div>}</div>
          <div className="btn-row" style={{ marginTop: 12, paddingBottom: 24 }}>
            <button className="btn-back" onClick={() => setScreen('info')}>← 返回</button>
            <button className="btn-submit" disabled={submitting} onClick={submitData}>{submitting ? '提交中...' : '确认提交 →'}</button>
          </div>
        </div>

        {/* SUCCESS */}
        <div className={'screen' + (screen === 'success' ? ' active' : '')} id="screen-success">
          <div style={{ background: 'var(--dark)', padding: '14px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundImage: 'radial-gradient(ellipse at 30% 50%,rgba(212,185,118,.06) 0%,transparent 60%)' }}>
            <span style={{ fontFamily: "'Bebas Neue',cursive", letterSpacing: 4, fontSize: 12, color: 'var(--gold)' }}>SAVED</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,.3)', letterSpacing: 1 }}>{successSnapshot ? successSnapshot.mo : '-'}</span>
          </div>
          <div style={{ background: 'var(--surface2)', minHeight: 'calc(100vh - 48px)', paddingBottom: 32 }}>
            <div className="success-banner">
              <div className="success-icon">
                <svg viewBox="0 0 22 22" fill="none" width="22" height="22"><polyline points="4,11 9,16 18,6" stroke="#C9A84C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div className="success-title">저장 완료 · 提交成功</div>
                <div style={{ fontSize: 10, color: 'var(--text4)', letterSpacing: 1, marginTop: 6, fontWeight: 500 }}>공정 기록이 저장되었습니다</div>
              </div>
            </div>
            <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {successSnapshot && <>
                <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: '3px solid var(--accent)', boxShadow: 'var(--shadow-sm)' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>공정</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6B4D12' }}>{successSnapshot.processCN} · {successSnapshot.process}</span>
                </div>
                <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>완성수량</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{successSnapshot.completed.toLocaleString()} 件</span>
                </div>
                {successSnapshot.incomplete > 0 && (
                  <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>미완성수량</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{successSnapshot.incomplete.toLocaleString()} 件</span>
                  </div>
                )}
                {successSnapshot.defect > 0 && (
                  <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>불량수량</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)' }}>{successSnapshot.defect.toLocaleString()} 件</span>
                  </div>
                )}
                <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>담당자</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{successSnapshot.worker}</span>
                </div>
                <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>기록시간</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>{successSnapshot.time}</span>
                </div>
                {successSnapshot.notes && (
                  <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>메모</span>
                    <span style={{ fontSize: 12, color: 'var(--text2)' }}>{successSnapshot.notes}</span>
                  </div>
                )}
              </>}
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              <button onClick={goToScan} style={{ padding: 16, border: 'none', background: 'var(--dark2)', color: 'var(--gold)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit', width: '100%', transition: 'var(--transition)' }}>← NEW SCAN / 새 스캔</button>
            </div>
          </div>
        </div>
      </div>

      {/* LOG MODAL */}
      {modalLog && (
        <div
          style={{ display: 'flex', position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 9999, justifyContent: 'center', alignItems: 'center' }}
          onClick={() => setModalIdx(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 16, width: '92%', maxWidth: 420, padding: 22, position: 'relative', boxShadow: '0 20px 60px rgba(0,0,0,.2)', animation: 'fadeIn .25s ease' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', letterSpacing: '-.3px' }}>工序记录 상세</span>
              <span onClick={() => setModalIdx(null)} style={{ cursor: 'pointer', fontSize: 18, color: 'var(--text4)', padding: '4px 8px', borderRadius: 6, transition: 'var(--transition)' }}>✕</span>
            </div>
            <div>
              {(() => {
                const r = modalLog;
                const process = r['Process'] || '-';
                const completed = r['Completed_Qty'] || '0';
                const incomplete = r['Incomplete_Qty'] || '0';
                const defect = r['Defect_Qty'] || '0';
                let worker = r['Worker'];
                worker = worker && typeof worker === 'object' ? worker.display_value : String(worker || '');
                worker = worker.trim() || '未填写';
                const date = formatDate(r['Log_Date'] || r['Log_DateTime'] || '');
                const notes = r['Notes'] || '-';
                return (
                  <>
                    <div className="modal-row"><span className="modal-label">工序</span><span className="modal-value">{process}</span></div>
                    <div className="modal-row"><span className="modal-label">完成数量</span><span className="modal-value">{completed} 件</span></div>
                    <div className="modal-row"><span className="modal-label">未完成数量</span><span className="modal-value">{incomplete} 件</span></div>
                    <div className="modal-row"><span className="modal-label">不良数量</span><span className="modal-value">{defect} 件</span></div>
                    <div className="modal-row"><span className="modal-label">负责人</span><span className="modal-value">{worker}</span></div>
                    <div className="modal-row"><span className="modal-label">记录时间</span><span className="modal-value">{date}</span></div>
                    <div className="modal-row"><span className="modal-label">备注</span><span className="modal-value">{notes}</span></div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {cameraOpen && (
        <CameraOverlay onResult={onQR} onCancel={() => setCameraOpen(false)} />
      )}
    </>
  );
}
