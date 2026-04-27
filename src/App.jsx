import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import jsQR from 'jsqr';
import { getRecords, submitRecord, updateRecord } from './api.js';
import {
  BRAND, INNER_PACK_SIZE, MASTER_BAG_SIZE, REPORTS, FORMS,
  PACK_STATUS_LABELS, BAG_STATUS_LABELS, APP_PIN, PIN_STORAGE_KEY
} from './config.js';
import {
  buildInnerPackQR, buildMasterBagQR, parseInnerPackQR, parseMasterBagQR,
  detectQRType, generateQRDataURL, downloadQRPNG
} from './qrUtils.js';

// Keep legacy constants for existing Production Log flow
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
  { key: 'Cutting / 재단 / 裁剪',         cn: '裁剪',     icon: '✂️', sub: 'Cutting' },
  { key: 'Sewing / 봉제 / 缝制',          cn: '缝制',     icon: '🧵', sub: 'Sewing' },
  { key: 'Packing / 포장 / 包装',         cn: '包装',     icon: '📦', sub: 'Packing' },
  { key: 'Completed / 생산완료 / 生产完成', cn: '生产完成', icon: '✅', sub: 'Completed' },
  { key: 'Shipped / 출고완료 / 已出货',    cn: '出货',     icon: '🚚', sub: 'Shipped', full: true }
];

// ─── Helpers ──────────────────────────────────────────────────────────
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

// ─── Camera overlay (full-screen, mounted only when active) ───────────
function CameraOverlay({ onResult, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanningRef = useRef(true);
  const cbRef = useRef({ onResult, onCancel });
  cbRef.current.onResult = onResult;
  cbRef.current.onCancel = onCancel;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    let raf;
    let firedResult = false;

    function tick() {
      if (!scanningRef.current) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
        if (code && !firedResult) {
          firedResult = true;
          scanningRef.current = false;
          stop();
          cbRef.current.onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    }

    function stop() {
      scanningRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (raf) cancelAnimationFrame(raf);
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (!scanningRef.current) { s.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = s;
        video.srcObject = s;
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        raf = requestAnimationFrame(tick);
      })
      .catch((err) => {
        stop();
        alert('无法访问摄像头: ' + err.message);
        cbRef.current.onCancel();
      });

    return () => { stop(); };
  }, []);

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

// ─── Existing Production Log screens ──────────────────────────────────
const ScanScreen = memo(function ScanScreen({ onScan, onUpload }) {
  return (
    <div className="screen active" id="screen-scan">
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
      <button className="btn-scan-start" onClick={onScan}>SCAN START / 开始扫码</button>
      <button className="btn-upload-qr" onClick={onUpload}>QR UPLOAD / 上传二维码</button>
      <div className="scan-hint-wrap">
        <p>카메라가 자동으로 QR을 인식합니다</p>
        <p>摄像头将自动识别二维码</p>
      </div>
    </div>
  );
});

const LoadingScreen = memo(function LoadingScreen({ message }) {
  return (
    <div className="screen active" id="screen-loading">
      <div className="loading-wrap">
        <div className="spinner"></div>
        <p>{message}</p>
      </div>
    </div>
  );
});

const InfoScreen = memo(function InfoScreen({ moData, logs, logsLoading, logsShown, selectedKey, onSelectProcess, onBack, onOpenLog }) {
  const notesRows = useMemo(() => parsePlanNotes(moData && moData.plan_notes), [moData]);
  const orderQty = moData && moData.order_qty != null ? moData.order_qty.toLocaleString() + ' 件' : '-';

  return (
    <div className="screen active" id="screen-info" style={{ background: 'var(--surface2)', minHeight: '100vh', width: '100%', padding: 16 }}>
      <button className="back-link" onClick={onBack}>← 重新扫码</button>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title">订单信息确认</div>
        <div className="info-row"><span className="info-label">订单号 (MO)</span><span className="info-value">{(moData && moData.mo_number) || '-'}</span></div>
        <div className="info-row"><span className="info-label">品号 (SKU)</span><span className="info-value">{(moData && moData.sku) || '-'}</span></div>
        <div className="info-row"><span className="info-label">工厂</span><span className="info-value">{(moData && moData.factory) || '-'}</span></div>
        <div className="info-row"><span className="info-label">订单数量</span><span className="info-value">{orderQty}</span></div>
        <div className="info-row"><span className="info-label">当前状态</span><span className="status-pill">{(moData && moData.current_status) || '-'}</span></div>
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
              className={'proc-btn' + (p.full ? ' proc-full' : '') + (selectedKey === p.key ? ' selected' : '')}
              onClick={() => onSelectProcess(p.key, p.cn)}
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
                <div key={i} className="log-item" onClick={() => onOpenLog(r)} style={{ cursor: 'pointer' }}>
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
  );
});

const InputScreen = memo(function InputScreen({ moData, process, onSubmit, onBack }) {
  const [completed, setCompleted] = useState('');
  const [incomplete, setIncomplete] = useState('');
  const [defect, setDefect] = useState('');
  const [bag, setBag] = useState('');
  const [worker, setWorker] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const showBag = process.key.indexOf('Packing') >= 0 || process.key.indexOf('Shipped') >= 0;
  const orderQty = moData && moData.order_qty != null ? moData.order_qty.toLocaleString() + ' 件' : '-';

  async function handleSubmit() {
    const completedQty = parseInt(completed) || 0;
    const incompleteQty = parseInt(incomplete) || 0;
    const defectQty = parseInt(defect) || 0;
    const bagQty = parseInt(bag) || 0;
    const w = worker.trim();
    const n = notes.trim();
    if (completedQty <= 0) { setErr('请输入完成数量'); return; }
    if (!w) { setErr('请输入负责人姓名（必填）'); return; }
    setErr('');
    setSubmitting(true);
    try {
      await onSubmit({ completedQty, incompleteQty, defectQty, bagQty, worker: w, notes: n });
    } catch (e) {
      setErr(e.message || JSON.stringify(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="screen active" id="screen-input" style={{ minHeight: '100vh', width: '100%' }}>
      <div className="input-hero">
        <div className="input-hero-row">
          <button className="back-link" onClick={onBack} style={{ fontSize: 18, marginBottom: 0 }}>←</button>
          <div>
            <div className="input-hero-proc">{process.cn || 'CUTTING'}</div>
            <div className="input-hero-mo">{process.cn ? process.cn + ' · ' + ((moData && moData.mo_number) || '-') : '-'}</div>
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
        <div className="info-row"><span className="info-label">订单号</span><span className="info-value">{(moData && moData.mo_number) || '-'}</span></div>
        <div className="info-row"><span className="info-label">SKU</span><span className="info-value">{(moData && moData.sku) || '-'}</span></div>
        <div className="info-row"><span className="info-label">工序</span><span className="info-value" style={{ color: '#1E3A8A' }}>{process.key ? process.cn + ' (' + process.key + ')' : '-'}</span></div>
        <div className="info-row"><span className="info-label">订单数量 (参考)</span><span className="info-value" style={{ color: '#7C3AED' }}>{orderQty}</span></div>
        <div><NotesTable planNotes={moData && moData.plan_notes} /></div>
      </div>

      <div style={{ padding: '0 16px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div className="qty-card">
          <div className="qty-card-label">完成 *</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={completed} onChange={(e) => setCompleted(e.target.value)} />
        </div>
        <div className="qty-card muted">
          <div className="qty-card-label">未完成</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={incomplete} onChange={(e) => setIncomplete(e.target.value)} />
        </div>
        <div className="qty-card danger">
          <div className="qty-card-label">不良</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={defect} onChange={(e) => setDefect(e.target.value)} />
        </div>
        {showBag && (
          <div className="qty-card muted">
            <div className="qty-card-label">麻袋数量</div>
            <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={bag} onChange={(e) => setBag(e.target.value)} />
          </div>
        )}
        <div className="field-card">
          <div className="field-card-label">负责人 / 담당자 *</div>
          <input className="input-field text-field" type="text" placeholder="이름을 입력하세요" value={worker} onChange={(e) => setWorker(e.target.value)} />
        </div>
        <div className="field-card">
          <div className="field-card-label">备注 / 메모</div>
          <input className="input-field text-field" type="text" placeholder="선택사항" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      <div>{err && <div className="err-box">{err}</div>}</div>
      <div className="btn-row" style={{ marginTop: 12, paddingBottom: 24 }}>
        <button className="btn-back" onClick={onBack}>← 返回</button>
        <button className="btn-submit" disabled={submitting} onClick={handleSubmit}>{submitting ? '提交中...' : '确认提交 →'}</button>
      </div>
    </div>
  );
});

const ResultRow = memo(function ResultRow({ label, value, accent, danger, mute }) {
  const valColor = danger ? 'var(--danger)' : (accent ? '#6B4D12' : 'var(--text)');
  return (
    <div style={{ background: '#fff', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)', borderLeft: accent ? '3px solid var(--accent)' : undefined }}>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'var(--text3)', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: accent ? 12 : 13, fontWeight: mute ? 500 : 700, color: mute ? 'var(--text2)' : valColor }}>{value}</span>
    </div>
  );
});

const SuccessScreen = memo(function SuccessScreen({ result, onNextProcess, onNewScan }) {
  if (!result) return null;
  return (
    <div className="screen active" id="screen-success" style={{ minHeight: '100vh', width: '100%' }}>
      <div style={{ background: 'var(--dark)', padding: '14px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundImage: 'radial-gradient(ellipse at 30% 50%,rgba(212,185,118,.06) 0%,transparent 60%)' }}>
        <span style={{ fontFamily: "'Bebas Neue',cursive", letterSpacing: 4, fontSize: 12, color: 'var(--gold)' }}>SAVED</span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,.3)', letterSpacing: 1 }}>{result.mo}</span>
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
          <ResultRow label="공정"      value={result.processCN + ' · ' + result.process} accent />
          <ResultRow label="완성수량"  value={result.completed.toLocaleString() + ' 件'} />
          {result.incomplete > 0 && <ResultRow label="미완성수량" value={result.incomplete.toLocaleString() + ' 件'} />}
          {result.defect > 0     && <ResultRow label="불량수량"  value={result.defect.toLocaleString() + ' 件'} danger />}
          <ResultRow label="담당자"    value={result.worker} />
          <ResultRow label="기록시간"  value={result.time} mute />
          {result.notes && <ResultRow label="메모" value={result.notes} mute />}
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <button onClick={onNextProcess} style={{ padding: 16, border: 'none', background: 'linear-gradient(135deg,#D4B976,#C9A84C)', color: '#4A3510', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit', width: '100%', boxShadow: '0 2px 8px rgba(201,168,76,.2)' }}>下一工序 / 다음 공정</button>
          <button onClick={onNewScan} style={{ padding: 16, border: 'none', background: 'var(--dark2)', color: 'var(--gold)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit', width: '100%', transition: 'var(--transition)' }}>← NEW SCAN / 새 스캔</button>
        </div>
      </div>
    </div>
  );
});

const LogModal = memo(function LogModal({ log, onClose }) {
  const process    = log['Process'] || '-';
  const completed  = log['Completed_Qty'] || '0';
  const incomplete = log['Incomplete_Qty'] || '0';
  const defect     = log['Defect_Qty'] || '0';
  let worker = log['Worker'];
  worker = worker && typeof worker === 'object' ? worker.display_value : String(worker || '');
  worker = worker.trim() || '未填写';
  const date = formatDate(log['Log_Date'] || log['Log_DateTime'] || '');
  const notes = log['Notes'] || '-';
  return (
    <div
      style={{ display: 'flex', position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 9999, justifyContent: 'center', alignItems: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 16, width: '92%', maxWidth: 420, padding: 22, position: 'relative', boxShadow: '0 20px 60px rgba(0,0,0,.2)', animation: 'fadeIn .25s ease' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', letterSpacing: '-.3px' }}>工序记录 상세</span>
          <span onClick={onClose} style={{ cursor: 'pointer', fontSize: 18, color: 'var(--text4)', padding: '4px 8px', borderRadius: 6 }}>✕</span>
        </div>
        <div className="modal-row"><span className="modal-label">工序</span><span className="modal-value">{process}</span></div>
        <div className="modal-row"><span className="modal-label">完成数量</span><span className="modal-value">{completed} 件</span></div>
        <div className="modal-row"><span className="modal-label">未完成数量</span><span className="modal-value">{incomplete} 件</span></div>
        <div className="modal-row"><span className="modal-label">不良数量</span><span className="modal-value">{defect} 件</span></div>
        <div className="modal-row"><span className="modal-label">负责人</span><span className="modal-value">{worker}</span></div>
        <div className="modal-row"><span className="modal-label">记录时间</span><span className="modal-value">{date}</span></div>
        <div className="modal-row"><span className="modal-label">备注</span><span className="modal-value">{notes}</span></div>
      </div>
    </div>
  );
});

// ─── NEW: Home Screen ─────────────────────────────────────────────────
const HomeScreen = memo(function HomeScreen({ onSelectProductionLog, onSelectInnerPack, onSelectMasterBag }) {
  const btnStyle = {
    width: '100%',
    padding: '24px 20px',
    marginBottom: 16,
    border: 'none',
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    transition: 'transform 0.15s, box-shadow 0.15s',
  };
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', padding: 20, background: 'var(--surface2)' }}>
      <div style={{ textAlign: 'center', padding: '32px 0 40px' }}>
        <div style={{ fontFamily: "'Bebas Neue', cursive", fontSize: 32, letterSpacing: 4, color: 'var(--dark)' }}>IKU</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', letterSpacing: 2, marginTop: 4 }}>PRODUCTION SYSTEM</div>
        <div style={{ fontSize: 11, color: 'var(--text4)', marginTop: 4 }}>生产管理系统</div>
      </div>
      <button style={{ ...btnStyle, background: 'linear-gradient(135deg, #1E3A8A, #1E40AF)', color: '#fff' }} onClick={onSelectProductionLog}>
        <span style={{ fontSize: 32 }}>🏭</span>
        <div>
          <div>生产进度扫码</div>
          <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.85, marginTop: 2 }}>Production Log Scan</div>
        </div>
      </button>
      <button style={{ ...btnStyle, background: 'linear-gradient(135deg, #C9A84C, #B08E3A)', color: '#fff' }} onClick={onSelectInnerPack}>
        <span style={{ fontSize: 32 }}>📦</span>
        <div>
          <div>中间包装</div>
          <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.85, marginTop: 2 }}>Inner Pack · 12 pcs</div>
        </div>
      </button>
      <button style={{ ...btnStyle, background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', color: '#fff' }} onClick={onSelectMasterBag}>
        <span style={{ fontSize: 32 }}>🎒</span>
        <div>
          <div>麻袋</div>
          <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.85, marginTop: 2 }}>Master Bag · 10 packs · 120 pcs</div>
        </div>
      </button>
    </div>
  );
});

// ─── NEW: Pack Menu Screen ────────────────────────────────────────────
const PackMenuScreen = memo(function PackMenuScreen({ onCreate, onScan, onBack }) {
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', padding: 20, background: 'var(--surface2)' }}>
      <button className="back-link" onClick={onBack} style={{ marginBottom: 20 }}>← 返回 / 돌아가기</button>
      <div style={{ textAlign: 'center', padding: '20px 0 30px' }}>
        <div style={{ fontSize: 48 }}>📦</div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 8 }}>中间包装 / 중간 포장</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>12 pcs / pack</div>
      </div>
      <button onClick={onCreate} style={{
        width: '100%', padding: '24px', marginBottom: 12, border: 'none', borderRadius: 12,
        background: 'linear-gradient(135deg, #C9A84C, #B08E3A)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
      }}>
        <span style={{ fontSize: 28 }}>➕</span>
        <div style={{ textAlign: 'left' }}>
          <div>生成新包装</div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>Create New Inner Pack</div>
        </div>
      </button>
      <button onClick={onScan} style={{
        width: '100%', padding: '24px', border: 'none', borderRadius: 12,
        background: '#fff', color: 'var(--text)', fontSize: 15, fontWeight: 700, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
      }}>
        <span style={{ fontSize: 28 }}>🔍</span>
        <div style={{ textAlign: 'left' }}>
          <div>扫码查询</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Scan to View Details</div>
        </div>
      </button>
    </div>
  );
});

// ─── NEW: Bag Menu Screen ─────────────────────────────────────────────
const BagMenuScreen = memo(function BagMenuScreen({ onCreate, onScan, onBack }) {
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', padding: 20, background: 'var(--surface2)' }}>
      <button className="back-link" onClick={onBack} style={{ marginBottom: 20 }}>← 返回 / 돌아가기</button>
      <div style={{ textAlign: 'center', padding: '20px 0 30px' }}>
        <div style={{ fontSize: 48 }}>🎒</div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 8 }}>麻袋 / 마대</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>10 packs · 120 pcs / bag</div>
      </div>
      <button onClick={onCreate} style={{
        width: '100%', padding: '24px', marginBottom: 12, border: 'none', borderRadius: 12,
        background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
      }}>
        <span style={{ fontSize: 28 }}>➕</span>
        <div style={{ textAlign: 'left' }}>
          <div>生成新麻袋</div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>Create New Master Bag</div>
        </div>
      </button>
      <button onClick={onScan} style={{
        width: '100%', padding: '24px', border: 'none', borderRadius: 12,
        background: '#fff', color: 'var(--text)', fontSize: 15, fontWeight: 700, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
      }}>
        <span style={{ fontSize: 28 }}>🔍</span>
        <div style={{ textAlign: 'left' }}>
          <div>扫码查询</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Scan to View Details</div>
        </div>
      </button>
    </div>
  );
});

// ─── NEW: Pack MO Select Screen ───────────────────────────────────────
const PackMOSelectScreen = memo(function PackMOSelectScreen({ onScan, onManual, onBack }) {
  const [manualMO, setManualMO] = useState('');
  const handleManualSubmit = () => {
    const mo = manualMO.trim().toUpperCase();
    if (!mo) { alert('请输入订单号'); return; }
    onManual(mo);
  };
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', padding: 20, background: 'var(--surface2)' }}>
      <button className="back-link" onClick={onBack} style={{ marginBottom: 20 }}>← 返回</button>
      <div style={{ textAlign: 'center', padding: '20px 0 30px' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>选择订单 / MO 선택</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>Which MO is this pack for?</div>
      </div>
      <button onClick={onScan} style={{
        width: '100%', padding: '20px', marginBottom: 16, border: 'none', borderRadius: 12,
        background: 'linear-gradient(135deg, #1E3A8A, #1E40AF)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer'
      }}>📷 扫描 MO QR / QR 스캔</button>
      <div style={{ textAlign: 'center', color: 'var(--text4)', fontSize: 12, margin: '16px 0' }}>— 或 / or —</div>
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8 }}>手动输入订单号 / 수동 입력</div>
        <input
          type="text"
          value={manualMO}
          onChange={(e) => setManualMO(e.target.value)}
          placeholder="例: TS26-105"
          style={{ width: '100%', padding: 12, border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, marginBottom: 10, boxSizing: 'border-box' }}
        />
        <button onClick={handleManualSubmit} style={{
          width: '100%', padding: 12, border: 'none', borderRadius: 8,
          background: 'var(--dark)', color: 'var(--gold)', fontSize: 13, fontWeight: 700, cursor: 'pointer'
        }}>确认 / 확인</button>
      </div>
    </div>
  );
});

// ─── NEW: Pack Create Screen ──────────────────────────────────────────
const PackCreateScreen = memo(function PackCreateScreen({
  packMO, composition, setComposition, packSequence, worker, setWorker,
  isRemainder, setIsRemainder, lastComposition, onSubmit, onBack, submitting
}) {
  const selectedCount = composition.filter(c => c.selected).length;

  const applyStandard = () => {
    setComposition(composition.map(c => ({ ...c, selected: true })));
  };

  const applyLastPack = () => {
    if (!lastComposition) return;
    const newComp = composition.map(c => {
      const found = lastComposition.find(l => l.color === c.color && l.size === c.size);
      return { ...c, selected: !!found };
    });
    setComposition(newComp);
  };

  const toggleItem = (idx) => {
    const next = [...composition];
    next[idx] = { ...next[idx], selected: !next[idx].selected };
    setComposition(next);
  };

  const handleSubmit = () => {
    if (selectedCount === 0) { alert('请选择包装组成'); return; }
    if (!isRemainder && selectedCount !== INNER_PACK_SIZE) {
      if (!window.confirm(`당 상 ${INNER_PACK_SIZE}개가 아닙니다 (${selectedCount}개). 계속? / Not ${INNER_PACK_SIZE} items (${selectedCount}). Continue?`)) return;
    }
    if (!worker.trim()) { alert('请输入担当者 / 담당자를 입력하세요'); return; }
    onSubmit();
  };

  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'var(--dark)', padding: '14px 20px', color: '#fff' }}>
        <button onClick={onBack} style={{ background: 'transparent', border: 'none', color: 'var(--gold)', fontSize: 14, cursor: 'pointer', marginBottom: 8 }}>← 返回</button>
        <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--gold)', marginBottom: 4 }}>INNER PACK #{packSequence}</div>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{packMO.mo_number}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{packMO.sku} · {packMO.factory}</div>
      </div>

      <div style={{ padding: 16 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>包装组成 / 포장 구성</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>{selectedCount} / {INNER_PACK_SIZE}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button onClick={applyStandard} style={{ flex: 1, padding: '10px 8px', border: 'none', borderRadius: 8, background: 'var(--gold)', color: '#4A3510', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>标准配货 / Standard</button>
            {lastComposition && (
              <button onClick={applyLastPack} style={{ flex: 1, padding: '10px 8px', border: 'none', borderRadius: 8, background: '#F1F5F9', color: 'var(--text)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>上次相同 / Copy Last</button>
            )}
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {composition.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text4)', padding: 20, fontSize: 12 }}>
                此订单没有标准配货信息 / Standard Assortment 없음
              </div>
            ) : (
              composition.map((item, idx) => (
                <div key={idx} onClick={() => toggleItem(idx)} style={{
                  display: 'flex', alignItems: 'center', padding: '10px 4px',
                  borderBottom: idx < composition.length - 1 ? '1px solid #F1F5F9' : 'none',
                  cursor: 'pointer'
                }}>
                  <input type="checkbox" checked={!!item.selected} readOnly style={{ width: 18, height: 18, marginRight: 12 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{item.color}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>Size: {item.size}</div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>x {item.qty || 1}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={isRemainder} onChange={(e) => setIsRemainder(e.target.checked)} style={{ width: 18, height: 18, marginRight: 10 }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>剩余包装 / 자투리 포장</span>
          </label>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 28, marginTop: 4 }}>末尾零头, 不是12件标准包装</div>
        </div>

        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6 }}>担当者 / 담당자 *</div>
          <input type="text" value={worker} onChange={(e) => setWorker(e.target.value)}
            placeholder="姓名 Name"
            style={{ width: '100%', padding: 10, border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
          />
        </div>

        <button disabled={submitting} onClick={handleSubmit} style={{
          width: '100%', padding: 18, border: 'none', borderRadius: 12,
          background: submitting ? '#9CA3AF' : 'linear-gradient(135deg, #C9A84C, #B08E3A)',
          color: '#fff', fontSize: 15, fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer',
          marginBottom: 20
        }}>
          {submitting ? '保存中...' : `✅ ${selectedCount}件 打包完成 / ${selectedCount}개 포장 완료`}
        </button>
      </div>
    </div>
  );
});

// ─── NEW: Pack Success Screen ─────────────────────────────────────────
const PackSuccessScreen = memo(function PackSuccessScreen({ pack, onNextPack, onHome }) {
  if (!pack) return null;
  const handleDownload = () => {
    const fname = `${pack.moNumber}_Pack_${pack.packSequence}.png`;
    downloadQRPNG(pack.qrDataURL, fname);
  };
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'var(--dark)', padding: '14px 20px', color: '#fff', textAlign: 'center' }}>
        <div style={{ fontFamily: "'Bebas Neue', cursive", letterSpacing: 4, fontSize: 12, color: 'var(--gold)' }}>PACK CREATED</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{pack.moNumber} · Pack #{pack.packSequence}</div>
      </div>
      <div style={{ padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: 24, textAlign: 'center', marginBottom: 16 }}>
          <img src={pack.qrDataURL} alt="QR" style={{ width: '100%', maxWidth: 320, margin: '0 auto', display: 'block' }} />
          <div style={{ fontSize: 10, color: 'var(--text4)', marginTop: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>{pack.qrText}</div>
        </div>
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 8 }}>包装内容 / 포장 내용</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {pack.items.map((item, i) => (
              <div key={i} style={{ background: '#F8FAFC', padding: '6px 8px', borderRadius: 6, fontSize: 11 }}>
                <div style={{ fontWeight: 600 }}>{item.color}</div>
                <div style={{ color: 'var(--text3)' }}>{item.size} · {item.qty}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #F1F5F9', fontSize: 12, color: 'var(--text2)' }}>
            Total: <b>{pack.totalQty} 件</b>{pack.isRemainder ? ' · 剩余' : ''}
          </div>
        </div>
        <button onClick={handleDownload} style={{
          width: '100%', padding: 14, border: 'none', borderRadius: 10,
          background: 'linear-gradient(135deg, #C9A84C, #B08E3A)', color: '#fff', fontSize: 14, fontWeight: 700,
          cursor: 'pointer', marginBottom: 10
        }}>📥 下载 QR 图片 / QR 다운로드</button>
        <button onClick={onNextPack} style={{
          width: '100%', padding: 14, border: 'none', borderRadius: 10,
          background: 'var(--dark)', color: 'var(--gold)', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10
        }}>➕ 继续下一包 / 다음 포장 (같은 MO)</button>
        <button onClick={onHome} style={{
          width: '100%', padding: 14, border: 'none', borderRadius: 10,
          background: '#F1F5F9', color: 'var(--text)', fontSize: 13, fontWeight: 700, cursor: 'pointer'
        }}>🏠 返回主页 / 홈으로</button>
      </div>
    </div>
  );
});

// ─── NEW: Pack Detail Screen ──────────────────────────────────────────
const PackDetailScreen = memo(function PackDetailScreen({ detail, onBack }) {
  if (!detail) return null;
  const statusLabel = PACK_STATUS_LABELS[detail.pack_status] || detail.pack_status;
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'var(--dark)', padding: '14px 20px', color: '#fff' }}>
        <button onClick={onBack} style={{ background: 'transparent', border: 'none', color: 'var(--gold)', fontSize: 14, cursor: 'pointer', marginBottom: 8 }}>← 返回</button>
        <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--gold)', marginBottom: 4 }}>INNER PACK DETAIL</div>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{detail.mo_number} · Pack #{detail.pack_sequence}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{detail.factory}</div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>状态 / 상태</div>
            <div style={{ padding: '4px 12px', borderRadius: 20, background: '#FEF3C7', color: '#92400E', fontSize: 11, fontWeight: 700 }}>{statusLabel}</div>
          </div>
          {[
            ['Pack UUID', detail.uuid],
            ['Brand', detail.brand],
            ['Worker / 담당자', detail.worker],
            ['Total Qty', String(detail.total_qty) + ' 件'],
            ['Is Remainder', detail.is_remainder ? '是 / 예' : '否 / 아니오'],
            ['Assigned To Bag', detail.assigned_to_bag || '-'],
            ['Created Time', detail.created_time || '-'],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F8FAFC', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)', fontWeight: 600 }}>{label}</span>
              <span style={{
                color: 'var(--text)', fontFamily: label === 'Pack UUID' ? 'monospace' : 'inherit',
                fontSize: label === 'Pack UUID' ? 10 : 12, maxWidth: '60%', textAlign: 'right', wordBreak: 'break-all'
              }}>{value}</span>
            </div>
          ))}
        </div>
        {detail.items && detail.items.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>包装内容 / 포장 내용</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
              {detail.items.map((item, i) => (
                <div key={i} style={{ background: '#F8FAFC', padding: '6px 8px', borderRadius: 6, fontSize: 11 }}>
                  <div style={{ fontWeight: 600 }}>{item.color}</div>
                  <div style={{ color: 'var(--text3)' }}>{item.size} · {item.qty}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// ─── NEW: Bag Create Screen ───────────────────────────────────────────
const BagCreateScreen = memo(function BagCreateScreen({
  scannedPacks, isRemainder, setIsRemainder, worker, setWorker, destination, setDestination,
  onScanNext, onRemovePack, onSubmit, onBack, submitting
}) {
  const count = scannedPacks.length;
  const totalQty = scannedPacks.reduce((s, p) => s + (parseInt(p.total_qty) || 12), 0);
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', padding: '14px 20px', color: '#fff' }}>
        <button onClick={onBack} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 14, cursor: 'pointer', marginBottom: 8, opacity: 0.8 }}>← 返回</button>
        <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.8, marginBottom: 4 }}>MASTER BAG</div>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{count} / {MASTER_BAG_SIZE} 包装</div>
        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>{totalQty} 件 · Total pieces</div>
      </div>

      <div style={{ padding: 16 }}>
        <button onClick={onScanNext} style={{
          width: '100%', padding: 18, border: 'none', borderRadius: 12,
          background: '#1E3A8A', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 14
        }}>📷 扫描包装 QR / 포장 QR 스캔 ({count} 已扫描)</button>

        {count > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8 }}>已扫描包装 / 스캔된 포장</div>
            {scannedPacks.map((p, i) => (
              <div key={p.uuid} style={{
                display: 'flex', alignItems: 'center', padding: '8px 0',
                borderBottom: i < scannedPacks.length - 1 ? '1px solid #F1F5F9' : 'none'
              }}>
                <div style={{
                  width: 24, height: 24, borderRadius: 12, background: '#EDE9FE', color: '#6D28D9',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, marginRight: 10,
                  flexShrink: 0
                }}>{i + 1}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{p.mo_number}</div>
                  <div style={{ fontSize: 10, color: 'var(--text4)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.uuid.substring(0, 13)}...</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginRight: 10 }}>{p.total_qty}件</div>
                <button onClick={() => onRemovePack(p.uuid)} style={{ background: 'transparent', border: 'none', color: '#EF4444', fontSize: 18, cursor: 'pointer', padding: 4 }}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={isRemainder} onChange={(e) => setIsRemainder(e.target.checked)} style={{ width: 18, height: 18, marginRight: 10 }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>剩余麻袋 / 자투리 마대</span>
          </label>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 28, marginTop: 4 }}>不足 {MASTER_BAG_SIZE} 个包装</div>
        </div>

        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6 }}>担当者 / 담당자 *</div>
          <input type="text" value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="姓名 Name"
            style={{ width: '100%', padding: 10, border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
        </div>

        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6 }}>目的地 / 목적지</div>
          <input type="text" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="例: ZLO-Manzanillo"
            style={{ width: '100%', padding: 10, border: '1px solid #E2E8F0', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
        </div>

        <button disabled={submitting || count === 0} onClick={onSubmit} style={{
          width: '100%', padding: 18, border: 'none', borderRadius: 12,
          background: (submitting || count === 0) ? '#9CA3AF' : 'linear-gradient(135deg, #7C3AED, #6D28D9)',
          color: '#fff', fontSize: 15, fontWeight: 700, cursor: (submitting || count === 0) ? 'not-allowed' : 'pointer',
          marginBottom: 20
        }}>
          {submitting ? '保存中...' : `✅ ${count}包装 装袋完成 / 마대 완료`}
        </button>
      </div>
    </div>
  );
});

// ─── NEW: Bag Success Screen ──────────────────────────────────────────
const BagSuccessScreen = memo(function BagSuccessScreen({ bag, onNewBag, onHome }) {
  if (!bag) return null;
  const handleDownload = () => {
    const fname = `${bag.moNumber}_Bag_${bag.bagSequence}.png`;
    downloadQRPNG(bag.qrDataURL, fname);
  };
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', padding: '14px 20px', color: '#fff', textAlign: 'center' }}>
        <div style={{ fontFamily: "'Bebas Neue', cursive", letterSpacing: 4, fontSize: 12 }}>BAG CREATED</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{bag.moNumber} · Bag #{bag.bagSequence}</div>
      </div>
      <div style={{ padding: 20 }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: 24, textAlign: 'center', marginBottom: 16 }}>
          <img src={bag.qrDataURL} alt="QR" style={{ width: '100%', maxWidth: 320, margin: '0 auto', display: 'block' }} />
          <div style={{ fontSize: 10, color: 'var(--text4)', marginTop: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>{bag.qrText}</div>
        </div>
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 8 }}>麻袋内容 / 마대 내용</div>
          <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>{bag.packCount} packs · {bag.totalQty} 件{bag.isRemainder ? ' · 剩余' : ''}</div>
          {bag.packs && bag.packs.map((p, i) => (
            <div key={p.uuid} style={{
              display: 'flex', justifyContent: 'space-between', padding: '4px 0',
              fontSize: 11, color: 'var(--text3)',
              borderTop: i === 0 ? '1px solid #F1F5F9' : 'none', marginTop: i === 0 ? 4 : 0
            }}>
              <span>Pack {i + 1} · {p.mo_number}</span>
              <span>{p.total_qty} 件</span>
            </div>
          ))}
        </div>
        <button onClick={handleDownload} style={{
          width: '100%', padding: 14, border: 'none', borderRadius: 10,
          background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', color: '#fff', fontSize: 14, fontWeight: 700,
          cursor: 'pointer', marginBottom: 10
        }}>📥 下载 QR 图片 / QR 다운로드</button>
        <button onClick={onNewBag} style={{
          width: '100%', padding: 14, border: 'none', borderRadius: 10,
          background: 'var(--dark)', color: '#A78BFA', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10
        }}>➕ 生成新麻袋 / 새 마대</button>
        <button onClick={onHome} style={{
          width: '100%', padding: 14, border: 'none', borderRadius: 10,
          background: '#F1F5F9', color: 'var(--text)', fontSize: 13, fontWeight: 700, cursor: 'pointer'
        }}>🏠 返回主页 / 홈으로</button>
      </div>
    </div>
  );
});

// ─── NEW: Bag Detail Screen ───────────────────────────────────────────
const BagDetailScreen = memo(function BagDetailScreen({ detail, onBack }) {
  if (!detail) return null;
  const statusLabel = BAG_STATUS_LABELS[detail.bag_status] || detail.bag_status;
  return (
    <div className="screen active" style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', padding: '14px 20px', color: '#fff' }}>
        <button onClick={onBack} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 14, cursor: 'pointer', marginBottom: 8, opacity: 0.8 }}>← 返回</button>
        <div style={{ fontSize: 11, letterSpacing: 2, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>MASTER BAG DETAIL</div>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{detail.mo_number} · Bag #{detail.bag_sequence}</div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>状态 / 상태</div>
            <div style={{ padding: '4px 12px', borderRadius: 20, background: '#EDE9FE', color: '#6D28D9', fontSize: 11, fontWeight: 700 }}>{statusLabel}</div>
          </div>
          {[
            ['Bag UUID', detail.uuid],
            ['Brand', detail.brand],
            ['Inner Packs', String(detail.inner_pack_count) + ' packs'],
            ['Total Qty', String(detail.total_qty) + ' 件'],
            ['Is Remainder', detail.is_remainder ? '是 / 예' : '否 / 아니오'],
            ['Worker / 담당자', detail.worker],
            ['Destination', detail.destination || '-'],
            ['Received At MEX', detail.received_at_mex || '-'],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F8FAFC', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)', fontWeight: 600 }}>{label}</span>
              <span style={{
                color: 'var(--text)', fontFamily: label === 'Bag UUID' ? 'monospace' : 'inherit',
                fontSize: label === 'Bag UUID' ? 10 : 12, maxWidth: '60%', textAlign: 'right', wordBreak: 'break-all'
              }}>{value}</span>
            </div>
          ))}
        </div>
        {detail.inner_pack_uuids && detail.inner_pack_uuids.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>包装列表 / 포장 목록</div>
            {detail.inner_pack_uuids.map((uuid, i) => (
              <div key={uuid} style={{ padding: '6px 0', borderBottom: '1px solid #F8FAFC', fontSize: 11, color: 'var(--text3)', fontFamily: 'monospace' }}>
                {i + 1}. {uuid}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── URL routing helper ───────────────────────────────────────────────
function getInitialScreenFromUrl() {
  const path = window.location.pathname;
  const innerMatch = path.match(/^\/view\/inner\/([0-9a-f-]+)$/i);
  const bagMatch   = path.match(/^\/view\/bag\/([0-9a-f-]+)$/i);
  if (innerMatch) return { screen: 'view-inner', uuid: innerMatch[1] };
  if (bagMatch)   return { screen: 'view-bag',   uuid: bagMatch[1] };
  return { screen: 'home', uuid: null };
}

// ─── ViewInnerScreen (read-only, URL-accessible) ──────────────────────
const ViewInnerScreen = memo(function ViewInnerScreen({ uuid, onHome }) {
  const [record, setRecord]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getRecords(REPORTS.INNER_PACK);
        if (cancelled) return;
        const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
        const found = list.find(r => r['Pack_UUID'] === uuid);
        if (!found) { setNotFound(true); return; }
        let items = [];
        try { items = JSON.parse(found['Items_JSON'] || '[]'); } catch (e) {}
        let moNum = found['MO_Number'];
        if (typeof moNum === 'object') moNum = moNum.display_value || '';
        setRecord({
          uuid: found['Pack_UUID'],
          mo_number: moNum,
          sku: found['Style_SKU'] || found['SKU'] || '',
          factory: found['Factory'] || '',
          pack_sequence: found['Pack_Sequence'],
          total_qty: found['Total_Qty'],
          items,
          worker: found['Worker'] || '',
          created_time: found['Added_Time'] || found['Created_Time'] || '',
          pack_status: found['Pack_Status'] || 'Created',
          is_remainder: found['Is_Remainder'] === 'true' || found['Is_Remainder'] === true,
        });
      } catch (e) {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uuid]);

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <div className="spinner"></div>
    </div>
  );

  if (notFound) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>记录未找到 / 기록을 찾을 수 없습니다</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 24, fontFamily: 'monospace', wordBreak: 'break-all', textAlign: 'center' }}>{uuid}</div>
      <button onClick={onHome} style={{ padding: '12px 24px', border: 'none', borderRadius: 10, background: 'var(--dark)', color: 'var(--gold)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🏠 返回首页 / 홈으로</button>
    </div>
  );

  const statusLabel = PACK_STATUS_LABELS[record.pack_status] || record.pack_status;
  return (
    <div style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'var(--dark)', padding: '14px 20px', color: '#fff' }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--gold)', marginBottom: 4 }}>中间包装详情 / 중간포장 상세</div>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{record.mo_number} · Pack #{record.pack_sequence}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{record.factory}</div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>状态 / 상태</div>
            <div style={{ padding: '4px 12px', borderRadius: 20, background: '#FEF3C7', color: '#92400E', fontSize: 11, fontWeight: 700 }}>{statusLabel}</div>
          </div>
          {record.is_remainder && (
            <div style={{ display: 'inline-block', padding: '2px 10px', background: '#FEE2E2', color: '#991B1B', borderRadius: 20, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>자투리 / 残余</div>
          )}
          {[
            ['MO 번호 / 订单号', record.mo_number],
            ['SKU', record.sku || '-'],
            ['工厂 / 공장', record.factory || '-'],
            ['Pack # / 포장 순번', String(record.pack_sequence)],
            ['总件数 / 총 수량', String(record.total_qty) + ' 件'],
            ['担当者 / 담당자', record.worker || '-'],
            ['创建时间 / 생성 시간', formatDate(record.created_time)],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F8FAFC', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)', fontWeight: 600 }}>{label}</span>
              <span style={{ color: 'var(--text)', textAlign: 'right', maxWidth: '60%' }}>{value}</span>
            </div>
          ))}
        </div>
        {record.items && record.items.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>包装内容 / 포장 내용</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, fontSize: 11, fontWeight: 700, color: '#94A3B8', marginBottom: 6 }}>
              <span>颜色 / Color</span><span style={{ textAlign: 'center' }}>尺码 / Size</span><span style={{ textAlign: 'right' }}>数量 / Qty</span>
            </div>
            {record.items.map((item, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', padding: '5px 0', borderBottom: '1px solid #F8FAFC', fontSize: 12 }}>
                <span style={{ color: '#374151' }}>{item.color}</span>
                <span style={{ textAlign: 'center', color: '#374151' }}>{item.size}</span>
                <span style={{ textAlign: 'right', fontWeight: 600, color: '#1E3A8A' }}>{item.qty}</span>
              </div>
            ))}
          </div>
        )}
        <button onClick={onHome} style={{ width: '100%', padding: 14, border: 'none', borderRadius: 10, background: '#F1F5F9', color: 'var(--text)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🏠 返回首页 / 홈으로</button>
      </div>
    </div>
  );
});

// ─── ViewBagScreen (read-only, URL-accessible) ────────────────────────
const ViewBagScreen = memo(function ViewBagScreen({ uuid, onHome }) {
  const [bagRecord, setBagRecord]           = useState(null);
  const [innerPacks, setInnerPacks]         = useState([]);
  const [colorSizeSummary, setColorSizeSummary] = useState([]);
  const [loading, setLoading]               = useState(true);
  const [notFound, setNotFound]             = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bagRes = await getRecords(REPORTS.MASTER_BAG);
        const bagList = (bagRes && bagRes.code === 3000 && Array.isArray(bagRes.data)) ? bagRes.data : [];
        const foundBag = bagList.find(r => r['Bag_UUID'] === uuid);
        if (!foundBag) { if (!cancelled) setNotFound(true); return; }

        let packUUIDs = [];
        try { packUUIDs = JSON.parse(foundBag['Inner_Pack_UUIDs'] || '[]'); } catch (e) {}
        let moNum = foundBag['MO_Number'];
        if (typeof moNum === 'object') moNum = moNum.display_value || '';

        const bagData = {
          uuid: foundBag['Bag_UUID'],
          mo_number: moNum,
          factory: foundBag['Factory'] || '',
          destination: foundBag['Destination'] || '',
          bag_sequence: foundBag['Bag_Sequence'],
          inner_pack_count: foundBag['Inner_Pack_Count'],
          inner_pack_uuids: packUUIDs,
          total_qty: foundBag['Total_Qty'],
          is_remainder: foundBag['Is_Remainder'] === 'true' || foundBag['Is_Remainder'] === true,
          worker: foundBag['Worker'] || '',
          created_time: foundBag['Added_Time'] || foundBag['Created_Time'] || '',
          bag_status: foundBag['Bag_Status'] || 'Created',
          received_at_mex: foundBag['Received_At_MEX'] || '',
        };

        let packs = [];
        if (packUUIDs.length > 0) {
          const packRes = await getRecords(REPORTS.INNER_PACK);
          if (packRes && packRes.code === 3000 && Array.isArray(packRes.data)) {
            packs = packRes.data
              .filter(r => packUUIDs.includes(r['Pack_UUID']))
              .map(r => {
                let items = [];
                try { items = JSON.parse(r['Items_JSON'] || '[]'); } catch (e) {}
                let moN = r['MO_Number'];
                if (typeof moN === 'object') moN = moN.display_value || '';
                return { uuid: r['Pack_UUID'], pack_sequence: r['Pack_Sequence'], total_qty: r['Total_Qty'], mo_number: moN, items };
              });
          }
        }

        const map = {};
        packs.forEach(p => {
          (p.items || []).forEach(item => {
            const key = item.color + '|' + item.size;
            if (!map[key]) map[key] = { color: item.color, size: item.size, qty: 0 };
            map[key].qty += parseInt(item.qty) || 1;
          });
        });
        const summary = Object.values(map).sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size));

        if (!cancelled) { setBagRecord(bagData); setInnerPacks(packs); setColorSizeSummary(summary); }
      } catch (e) {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uuid]);

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <div className="spinner"></div>
    </div>
  );

  if (notFound) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>记录未找到 / 기록을 찾을 수 없습니다</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 24, fontFamily: 'monospace', wordBreak: 'break-all', textAlign: 'center' }}>{uuid}</div>
      <button onClick={onHome} style={{ padding: '12px 24px', border: 'none', borderRadius: 10, background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🏠 返回首页 / 홈으로</button>
    </div>
  );

  const statusLabel = BAG_STATUS_LABELS[bagRecord.bag_status] || bagRecord.bag_status;
  const extraRows = bagRecord.received_at_mex ? [['Received At MEX', formatDate(bagRecord.received_at_mex)]] : [];
  return (
    <div style={{ minHeight: '100vh', width: '100%', background: 'var(--surface2)' }}>
      <div style={{ background: 'linear-gradient(135deg, #7C3AED, #6D28D9)', padding: '14px 20px', color: '#fff' }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>麻袋详情 / 마대 상세</div>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{bagRecord.mo_number} · Bag #{bagRecord.bag_sequence}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{bagRecord.factory}{bagRecord.destination ? ' → ' + bagRecord.destination : ''}</div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>状态 / 상태</div>
            <div style={{ padding: '4px 12px', borderRadius: 20, background: '#EDE9FE', color: '#6D28D9', fontSize: 11, fontWeight: 700 }}>{statusLabel}</div>
          </div>
          {bagRecord.is_remainder && (
            <div style={{ display: 'inline-block', padding: '2px 10px', background: '#FEE2E2', color: '#991B1B', borderRadius: 20, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>자투리 / 残余</div>
          )}
          {[
            ['MO 번호 / 订单号', bagRecord.mo_number],
            ['工厂 / 공장', bagRecord.factory || '-'],
            ['目的地 / 목적지', bagRecord.destination || '-'],
            ['Bag # / 마대 순번', String(bagRecord.bag_sequence)],
            ['内装包数 / 포장 수', String(bagRecord.inner_pack_count) + ' packs'],
            ['总件数 / 총 수량', String(bagRecord.total_qty) + ' 件'],
            ['担当者 / 담당자', bagRecord.worker || '-'],
            ['创建时间 / 생성 시간', formatDate(bagRecord.created_time)],
            ...extraRows,
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F8FAFC', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)', fontWeight: 600 }}>{label}</span>
              <span style={{ color: 'var(--text)', textAlign: 'right', maxWidth: '60%' }}>{value}</span>
            </div>
          ))}
        </div>

        {innerPacks.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>包装列表 / 포장 목록</div>
            {innerPacks.map((p, i) => (
              <div key={p.uuid} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F8FAFC', fontSize: 12 }}>
                <span style={{ color: 'var(--text3)' }}>Pack {p.pack_sequence || (i + 1)} · {p.uuid.substring(0, 8)}...</span>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{p.total_qty} 件</span>
              </div>
            ))}
          </div>
        )}

        {colorSizeSummary.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>颜色/尺码汇总 / 색상·사이즈 합계</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, fontSize: 11, fontWeight: 700, color: '#94A3B8', marginBottom: 6 }}>
              <span>颜色 / Color</span><span style={{ textAlign: 'center' }}>尺码 / Size</span><span style={{ textAlign: 'right' }}>合计 / 합계</span>
            </div>
            {colorSizeSummary.map((row, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', padding: '5px 0', borderBottom: '1px solid #F8FAFC', fontSize: 12 }}>
                <span style={{ color: '#374151' }}>{row.color}</span>
                <span style={{ textAlign: 'center', color: '#374151' }}>{row.size}</span>
                <span style={{ textAlign: 'right', fontWeight: 600, color: '#1E3A8A' }}>{row.qty}</span>
              </div>
            ))}
          </div>
        )}

        <button onClick={onHome} style={{ width: '100%', padding: 14, border: 'none', borderRadius: 10, background: '#F1F5F9', color: 'var(--text)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🏠 返回首页 / 홈으로</button>
      </div>
    </div>
  );
});

// ─── PinGate modal ────────────────────────────────────────────────────
const PinGate = memo(function PinGate({ onSuccess, onCancel }) {
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  const handleSubmit = () => {
    if (pinInput === APP_PIN) {
      localStorage.setItem(PIN_STORAGE_KEY, 'verified');
      onSuccess();
    } else {
      setPinError('PIN码错误 / PIN이 틀립니다');
      setPinInput('');
    }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '90%', maxWidth: 360, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 20, textAlign: 'center' }}>🔒 请输入PIN码 / PIN 입력</div>
        <input
          type="password"
          value={pinInput}
          onChange={(e) => { setPinInput(e.target.value); setPinError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          placeholder="8자리 PIN / 8位PIN"
          maxLength={8}
          autoFocus
          style={{ width: '100%', padding: 14, border: '2px solid #E2E8F0', borderRadius: 10, fontSize: 18, textAlign: 'center', letterSpacing: 6, boxSizing: 'border-box', marginBottom: 12 }}
        />
        {pinError && <div style={{ color: '#EF4444', fontSize: 12, textAlign: 'center', marginBottom: 12, fontWeight: 600 }}>{pinError}</div>}
        <button onClick={handleSubmit} style={{ width: '100%', padding: 14, border: 'none', borderRadius: 10, background: 'var(--dark)', color: 'var(--gold)', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>确认 / 확인</button>
        <button onClick={onCancel} style={{ width: '100%', padding: 14, border: '1px solid #E2E8F0', borderRadius: 10, background: '#fff', color: 'var(--text)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>取消 / 취소</button>
      </div>
    </div>
  );
});

// ─── App: orchestration only ──────────────────────────────────────────
export default function App() {
  // ── Existing Production Log state ──
  const [currentScreen, setCurrentScreen] = useState(getInitialScreenFromUrl().screen);
  const [viewUuid, setViewUuid] = useState(getInitialScreenFromUrl().uuid);
  const [moData, setMoData] = useState(null);
  const [moRecordId, setMoRecordId] = useState('');
  const [selectedProcess, setSelectedProcess] = useState({ key: '', cn: '' });
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsShown, setLogsShown] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('正在读取订单信息...');
  const [submitResult, setSubmitResult] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [modalLog, setModalLog] = useState(null);
  const fileInputRef = useRef(null);

  // ── New: Inner Pack state ──
  const [packMO, setPackMO] = useState(null);
  const [packComposition, setPackComposition] = useState([]);
  const [packWorker, setPackWorker] = useState('');
  const [packIsRemainder, setPackIsRemainder] = useState(false);
  const [packSequence, setPackSequence] = useState(1);
  const [lastPackComposition, setLastPackComposition] = useState(null);
  const [createdPack, setCreatedPack] = useState(null);
  const [scannedPackDetail, setScannedPackDetail] = useState(null);

  // ── New: Master Bag state ──
  const [bagScannedPacks, setBagScannedPacks] = useState([]);
  const [bagIsRemainder, setBagIsRemainder] = useState(false);
  const [bagWorker, setBagWorker] = useState('');
  const [bagDestination, setBagDestination] = useState('');
  const [createdBag, setCreatedBag] = useState(null);
  const [scannedBagDetail, setScannedBagDetail] = useState(null);

  // ── Scan mode ──
  const [scanMode, setScanMode] = useState('production_log');

  // ── PIN gate state ──
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinSuccessCallback, setPinSuccessCallback] = useState(null);

  const isPinVerified = () => localStorage.getItem(PIN_STORAGE_KEY) === 'verified';
  const requirePin = (onSuccess) => {
    if (isPinVerified()) { onSuccess(); }
    else { setPinSuccessCallback(() => onSuccess); setPinModalOpen(true); }
  };

  // ── URL routing — popstate (browser back/forward) ──
  useEffect(() => {
    const onPop = () => {
      const { screen, uuid } = getInitialScreenFromUrl();
      setCurrentScreen(screen);
      setViewUuid(uuid);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => { window.scrollTo(0, 0); }, [currentScreen]);

  // ── Existing Production Log handlers ──
  const fetchLogs = useCallback(async (moNumber) => {
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
  }, []);

  const fetchMOData = useCallback(async (moNumber, sku, factory) => {
    console.log('[scan] fetchMOData start mo=' + moNumber);
    try {
      const res = await getRecords(MO_REPORT);
      console.log('[scan] fetchMOData got ' + (res && res.data ? res.data.length : 0) + ' records, code=' + (res && res.code));
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const found = list.find((r) => r['MO_Number'] === moNumber);
      if (!found) {
        setCurrentScreen('scan');
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
      setCurrentScreen('info');
      setTimeout(() => fetchLogs(next.mo_number), 300);
    } catch (err) {
      setCurrentScreen('scan');
      alert('数据读取失败，请重试\n' + (err && err.message || JSON.stringify(err)));
    }
  }, [fetchLogs]);

  // ── New: Inner Pack handlers ──
  const fetchMODataForPack = useCallback(async (moNumber) => {
    try {
      const res = await getRecords(REPORTS.MO);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const found = list.find((r) => r['MO_Number'] === moNumber);
      if (!found) {
        setCurrentScreen('pack_mo_select');
        alert('未找到订单: ' + moNumber);
        return;
      }

      let skuStr = '-';
      const skuRaw = found['Style_SKU'];
      if (skuRaw) {
        if (typeof skuRaw === 'object') skuStr = skuRaw.display_value || '-';
        else skuStr = String(skuRaw);
      }

      let standardAssortment = [];
      const jsonStr = found['Standard_Assortment_JSON'];
      if (jsonStr && typeof jsonStr === 'string') {
        try {
          let cleaned = jsonStr.trim();
          if (!cleaned.startsWith('[')) cleaned = '[' + cleaned + ']';
          standardAssortment = JSON.parse(cleaned);
        } catch (e) {
          console.error('Failed to parse Standard_Assortment_JSON', e);
          standardAssortment = [];
        }
      }

      let nextSequence = 1;
      try {
        const packRes = await getRecords(REPORTS.INNER_PACK);
        if (packRes && packRes.code === 3000 && Array.isArray(packRes.data)) {
          const existingPacks = packRes.data.filter(p => {
            let m = p['MO_Number'];
            if (typeof m === 'object') m = m.display_value || '';
            return m === moNumber;
          });
          nextSequence = existingPacks.length + 1;
        }
      } catch (e) {
        console.warn('Could not fetch existing pack count', e);
      }

      setPackMO({
        mo_number: found['MO_Number'] || moNumber,
        sku: skuStr,
        factory: String(found['Factory'] || '-'),
        order_qty: parseInt(found['Plan_Total_Quantity']) || 0,
        plan_notes: found['Plan_Notes'] || '',
        standard_assortment: standardAssortment,
        record_id: found['ID']
      });
      setPackSequence(nextSequence);

      if (standardAssortment.length > 0) {
        setPackComposition(standardAssortment.map(it => ({ ...it, selected: true })));
      } else {
        setPackComposition([]);
      }

      setCurrentScreen('pack_create');
    } catch (err) {
      setCurrentScreen('pack_mo_select');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  const fetchInnerPackDetail = useCallback(async (uuid) => {
    try {
      const res = await getRecords(REPORTS.INNER_PACK);
      if (!res || res.code !== 3000 || !Array.isArray(res.data)) {
        throw new Error('查询失败');
      }
      const found = res.data.find(r => r['Pack_UUID'] === uuid);
      if (!found) {
        setCurrentScreen('pack_menu');
        alert('未找到此包装 / 포장 없음\n' + uuid);
        return;
      }
      let items = [];
      try {
        const itemsJson = found['Items_JSON'];
        if (itemsJson) items = JSON.parse(itemsJson);
      } catch (e) {}
      let moNum = found['MO_Number'];
      if (typeof moNum === 'object') moNum = moNum.display_value || '';
      setScannedPackDetail({
        uuid: found['Pack_UUID'],
        brand: found['Brand'] || '',
        mo_number: moNum,
        pack_sequence: found['Pack_Sequence'],
        total_qty: found['Total_Qty'],
        is_remainder: found['Is_Remainder'] === 'true' || found['Is_Remainder'] === true,
        items,
        worker: found['Worker'] || '',
        factory: found['Factory'] || '',
        assigned_to_bag: found['Assigned_To_Bag'] || '',
        pack_status: found['Pack_Status'] || 'Created',
        created_time: found['Added_Time'] || found['Created_Time'] || ''
      });
      setCurrentScreen('pack_detail');
    } catch (err) {
      setCurrentScreen('pack_menu');
      alert('查询失败: ' + (err?.message || String(err)));
    }
  }, []);

  const handleCreatePack = useCallback(async () => {
    if (!packMO) return;
    const selectedItems = packComposition.filter(c => c.selected).map(c => ({
      color: c.color, size: c.size, qty: c.qty || 1
    }));
    if (selectedItems.length === 0) return;

    const qrText = buildInnerPackQR();
    const uuid = qrText.split('/view/inner/')[1];
    const totalQty = selectedItems.reduce((sum, it) => sum + (parseInt(it.qty) || 1), 0);
    const totalExpected = packMO.order_qty > 0 ? Math.ceil(packMO.order_qty / INNER_PACK_SIZE) : 0;

    const packData = {
      'Pack_UUID':      uuid,
      'Brand':          BRAND,
      'MO_Number':      packMO.mo_number,
      'Pack_Sequence':  packSequence,
      'Total_Expected': totalExpected,
      'Total_Qty':      totalQty,
      'Is_Remainder':   packIsRemainder,
      'Items_JSON':     JSON.stringify(selectedItems),
      'Worker':         packWorker.trim(),
      'Factory':        packMO.factory,
      'Pack_Status':    'Created'
    };

    try {
      setLoadingMsg('保存包装信息...');
      setCurrentScreen('loading');

      const res = await submitRecord(FORMS.INNER_PACK, packData);
      if (!res || res.code !== 3000) {
        throw new Error('保存失败: ' + JSON.stringify(res));
      }

      const qrDataURL = await generateQRDataURL(qrText, 512);

      setCreatedPack({
        uuid,
        qrText,
        qrDataURL,
        items: selectedItems,
        totalQty,
        packSequence,
        moNumber: packMO.mo_number,
        isRemainder: packIsRemainder
      });
      setLastPackComposition(selectedItems);
      setCurrentScreen('pack_success');
    } catch (err) {
      setCurrentScreen('pack_create');
      alert('保存失败 / 저장 실패: ' + (err?.message || String(err)));
    }
  }, [packMO, packComposition, packWorker, packIsRemainder, packSequence]);

  // ── New: Master Bag handlers ──
  const addPackToBag = useCallback(async (uuid, qrText) => {
    setLoadingMsg('加载包装信息...');
    setCurrentScreen('loading');
    try {
      const res = await getRecords(REPORTS.INNER_PACK);
      if (!res || res.code !== 3000 || !Array.isArray(res.data)) {
        throw new Error('查询失败');
      }
      const found = res.data.find(r => r['Pack_UUID'] === uuid);
      if (!found) {
        setCurrentScreen('bag_create');
        alert('未找到此包装 / 포장 정보 없음');
        return;
      }
      if (found['Assigned_To_Bag'] && found['Assigned_To_Bag'] !== '') {
        setCurrentScreen('bag_create');
        alert('此包装已经装袋: ' + found['Assigned_To_Bag']);
        return;
      }
      let moNum = found['MO_Number'];
      if (typeof moNum === 'object') moNum = moNum.display_value || '';
      let items = [];
      try { items = JSON.parse(found['Items_JSON'] || '[]'); } catch (e) {}

      setBagScannedPacks(prev => [...prev, {
        uuid,
        qrText,
        mo_number: moNum,
        items,
        total_qty: found['Total_Qty'] || 12,
        record_id: found['ID']
      }]);
      setCurrentScreen('bag_create');
    } catch (err) {
      setCurrentScreen('bag_create');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  const handleRemovePackFromBag = useCallback((uuid) => {
    setBagScannedPacks(prev => prev.filter(p => p.uuid !== uuid));
  }, []);

  const handleCreateBag = useCallback(async () => {
    if (bagScannedPacks.length === 0) {
      alert('请至少扫描一个包装');
      return;
    }
    if (!bagIsRemainder && bagScannedPacks.length !== MASTER_BAG_SIZE) {
      if (!window.confirm(`不是 ${MASTER_BAG_SIZE} 个 (${bagScannedPacks.length}个). 继续?`)) return;
    }
    if (!bagWorker.trim()) {
      alert('请输入担当者 / 담당자');
      return;
    }

    const primaryMO = bagScannedPacks[0].mo_number;
    const qrText = buildMasterBagQR();
    const uuid = qrText.split('/view/bag/')[1];
    const totalQty = bagScannedPacks.reduce((s, p) => s + (parseInt(p.total_qty) || 12), 0);

    let bagSequence = 1;
    try {
      const bagRes = await getRecords(REPORTS.MASTER_BAG);
      if (bagRes && bagRes.code === 3000 && Array.isArray(bagRes.data)) {
        const existing = bagRes.data.filter(b => {
          let m = b['MO_Number'];
          if (typeof m === 'object') m = m.display_value || '';
          return m === primaryMO;
        });
        bagSequence = existing.length + 1;
      }
    } catch (e) {}

    const bagData = {
      'Bag_UUID':         uuid,
      'Brand':            BRAND,
      'Bag_Sequence':     bagSequence,
      'MO_Number':        primaryMO,
      'Inner_Pack_Count': bagScannedPacks.length,
      'Inner_Pack_UUIDs': JSON.stringify(bagScannedPacks.map(p => p.uuid)),
      'Total_Qty':        totalQty,
      'Is_Remainder':     bagIsRemainder,
      'Worker':           bagWorker.trim(),
      'Destination':      bagDestination.trim(),
      'Bag_Status':       'Created'
    };

    try {
      setLoadingMsg('保存麻袋信息...');
      setCurrentScreen('loading');

      const bagRes = await submitRecord(FORMS.MASTER_BAG, bagData);
      if (!bagRes || bagRes.code !== 3000) {
        throw new Error('保存失败: ' + JSON.stringify(bagRes));
      }

      for (const p of bagScannedPacks) {
        try {
          await updateRecord(REPORTS.INNER_PACK, p.record_id, {
            'Assigned_To_Bag': uuid,
            'Pack_Status': 'Bagged'
          });
        } catch (updErr) {
          console.warn('[bag] pack update failed', p.uuid, updErr);
        }
      }

      const qrDataURL = await generateQRDataURL(qrText, 512);
      setCreatedBag({
        uuid,
        qrText,
        qrDataURL,
        moNumber: primaryMO,
        bagSequence,
        packCount: bagScannedPacks.length,
        totalQty,
        isRemainder: bagIsRemainder,
        packs: bagScannedPacks
      });
      setCurrentScreen('bag_success');
    } catch (err) {
      setCurrentScreen('bag_create');
      alert('保存失败: ' + (err?.message || String(err)));
    }
  }, [bagScannedPacks, bagIsRemainder, bagWorker, bagDestination]);

  const fetchMasterBagDetail = useCallback(async (uuid) => {
    try {
      const res = await getRecords(REPORTS.MASTER_BAG);
      if (!res || res.code !== 3000 || !Array.isArray(res.data)) throw new Error('查询失败');
      const found = res.data.find(r => r['Bag_UUID'] === uuid);
      if (!found) {
        setCurrentScreen('bag_menu');
        alert('未找到此麻袋 / 마대 없음\n' + uuid);
        return;
      }
      let packUUIDs = [];
      try { packUUIDs = JSON.parse(found['Inner_Pack_UUIDs'] || '[]'); } catch (e) {}
      let moNum = found['MO_Number'];
      if (typeof moNum === 'object') moNum = moNum.display_value || '';

      setScannedBagDetail({
        uuid: found['Bag_UUID'],
        brand: found['Brand'] || '',
        bag_sequence: found['Bag_Sequence'],
        mo_number: moNum,
        inner_pack_count: found['Inner_Pack_Count'],
        inner_pack_uuids: packUUIDs,
        total_qty: found['Total_Qty'],
        is_remainder: found['Is_Remainder'] === 'true' || found['Is_Remainder'] === true,
        worker: found['Worker'] || '',
        factory: found['Factory'] || '',
        destination: found['Destination'] || '',
        bag_status: found['Bag_Status'] || 'Created',
        received_at_mex: found['Received_At_MEX'] || ''
      });
      setCurrentScreen('bag_detail');
    } catch (err) {
      setCurrentScreen('bag_menu');
      alert('查询失败: ' + (err?.message || String(err)));
    }
  }, []);

  // ── Modified handleQR — dispatches based on scanMode ──
  const handleQR = useCallback((qrText) => {
    const text = (qrText || '').trim();
    console.log('[scan] QR detected, len=' + text.length + ' mode=' + scanMode);

    const qrType = detectQRType(text);

    if (scanMode === 'production_log') {
      if (qrType !== 'production_log') {
        setCameraOpen(false);
        alert('QR 타입 불일치: 생산 진척 QR이 아닙니다.\n扫描的不是生产进度QR');
        return;
      }
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
        else {
          setCameraOpen(false);
          alert('未能识别订单号\n扫描内容: ' + text);
          return;
        }
      }
      flushSync(() => {
        setCameraOpen(false);
        setLoadingMsg('正在读取订单信息...');
        setCurrentScreen('loading');
      });
      fetchMOData(moNumber, skuVal, factoryVal);
      return;
    }

    if (scanMode === 'inner_pack_mo') {
      if (qrType !== 'production_log') {
        setCameraOpen(false);
        alert('请扫描生产进度QR (MO QR)\n생산 진척 QR을 스캔하세요');
        return;
      }
      let moNumber = '';
      text.split(/[|\n\r]+/).forEach((part) => {
        const idx = part.indexOf(':');
        if (idx < 0) return;
        const key = part.substring(0, idx).trim().toUpperCase();
        if (key === 'MO') moNumber = part.substring(idx + 1).trim();
      });
      if (!moNumber && /^[A-Z]{2}\d{2}-\d+/i.test(text)) moNumber = text;
      if (!moNumber) {
        setCameraOpen(false);
        alert('未能识别订单号');
        return;
      }
      flushSync(() => {
        setCameraOpen(false);
        setLoadingMsg('加载订单数据...');
        setCurrentScreen('loading');
      });
      fetchMODataForPack(moNumber);
      return;
    }

    if (scanMode === 'inner_pack_detail') {
      const uuid = parseInnerPackQR(text);
      if (!uuid) {
        setCameraOpen(false);
        alert('不是有效的包装QR');
        return;
      }
      flushSync(() => {
        setCameraOpen(false);
        setLoadingMsg('查询包装信息...');
        setCurrentScreen('loading');
      });
      fetchInnerPackDetail(uuid);
      return;
    }

    if (scanMode === 'master_bag_compose') {
      const uuid = parseInnerPackQR(text);
      if (!uuid) {
        setCameraOpen(false);
        alert('请扫描中间包装QR\n중간 포장 QR을 스캔하세요');
        return;
      }
      if (bagScannedPacks.find(p => p.uuid === uuid)) {
        setCameraOpen(false);
        alert('此包装已经添加过了');
        return;
      }
      setCameraOpen(false);
      addPackToBag(uuid, text);
      return;
    }

    if (scanMode === 'master_bag_detail') {
      const uuid = parseMasterBagQR(text);
      if (!uuid) {
        setCameraOpen(false);
        alert('不是有效的麻袋QR');
        return;
      }
      flushSync(() => {
        setCameraOpen(false);
        setLoadingMsg('查询麻袋信息...');
        setCurrentScreen('loading');
      });
      fetchMasterBagDetail(uuid);
      return;
    }
  }, [scanMode, bagScannedPacks, fetchMOData, fetchMODataForPack, fetchInnerPackDetail, addPackToBag, fetchMasterBagDetail]);

  // ── Existing handlers (unchanged except handleBackToScan goes to 'home') ──
  const handleScanRequest = useCallback(() => setCameraOpen(true), []);
  const handleCameraCancel = useCallback(() => setCameraOpen(false), []);

  const openUpload = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, []);

  const handleFileChange = useCallback((e) => {
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
        handleQR(code.data);
      } else {
        alert('无法识别二维码，请重试\nQR 코드를 인식할 수 없습니다');
      }
    };
    img.onerror = () => { alert('图片加载失败'); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(file);
  }, [handleQR]);

  const handleSelectProcess = useCallback((procKey, procCN) => {
    setSelectedProcess({ key: procKey, cn: procCN });
    setCurrentScreen('input');
  }, []);

  const handleSubmit = useCallback(async (form) => {
    const todayStr = getTodayStr();
    const logData = {
      'MO_Number':      moData.mo_number,
      'SKU':            moData.sku,
      'Factory':        moData.factory,
      'Process':        selectedProcess.key,
      'Completed_Qty':  form.completedQty,
      'Incomplete_Qty': form.incompleteQty,
      'Defect_Qty':     form.defectQty,
      'Bag_Qty':        form.bagQty,
      'Worker':         form.worker,
      'Log_Date':       todayStr,
      'Notes':          form.notes
    };
    const res = await submitRecord(LOG_FORM, logData);
    if (!res || res.code !== 3000) {
      throw new Error('日志保存失败: ' + JSON.stringify(res));
    }

    const map = PROCESS_MAP[selectedProcess.key];
    const updateData = { 'Production_Status': selectedProcess.key };
    if (map) {
      if (map.dateStart) updateData[map.dateStart] = todayStr;
      if (map.dateEnd)   updateData[map.dateEnd]   = todayStr;
      if (map.qty)       updateData[map.qty]       = form.completedQty;
    }
    try {
      await updateRecord(MO_REPORT, moRecordId, updateData);
    } catch (updErr) {
      console.warn('[submit] MO update failed (log was saved)', {
        fields: Object.keys(updateData),
        status: updErr && updErr.status,
        body: updErr && updErr.body
      });
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    setSubmitResult({
      mo: moData.mo_number,
      process: selectedProcess.key,
      processCN: selectedProcess.cn,
      completed: form.completedQty,
      incomplete: form.incompleteQty,
      defect: form.defectQty,
      worker: form.worker || '未填写',
      notes: form.notes,
      time: timeStr
    });
    setCurrentScreen('success');
  }, [moData, moRecordId, selectedProcess]);

  const handleBackToInfo = useCallback(() => setCurrentScreen('info'), []);

  const handleBackToScan = useCallback(() => {
    setMoData(null); setMoRecordId('');
    setSelectedProcess({ key: '', cn: '' });
    setLogs([]); setLogsShown(false);
    setSubmitResult(null);
    setCurrentScreen('home');
  }, []);

  const handleNextProcess = useCallback(() => {
    setSelectedProcess({ key: '', cn: '' });
    setSubmitResult(null);
    setCurrentScreen('info');
    if (moData && moData.mo_number) setTimeout(() => fetchLogs(moData.mo_number), 200);
  }, [moData, fetchLogs]);

  const handleCloseModal = useCallback(() => setModalLog(null), []);

  return (
    <>
      <div className="container" style={{ overflow: 'hidden' }}>

        {/* Home */}
        {currentScreen === 'home' && (
          <HomeScreen
            onSelectProductionLog={() => { setScanMode('production_log'); setCurrentScreen('scan'); }}
            onSelectInnerPack={() => setCurrentScreen('pack_menu')}
            onSelectMasterBag={() => setCurrentScreen('bag_menu')}
          />
        )}

        {/* Production Log screens */}
        {currentScreen === 'scan' && <ScanScreen onScan={handleScanRequest} onUpload={openUpload} />}
        {currentScreen === 'loading' && <LoadingScreen message={loadingMsg} />}
        {currentScreen === 'info' && (
          <InfoScreen
            moData={moData}
            logs={logs}
            logsLoading={logsLoading}
            logsShown={logsShown}
            selectedKey={selectedProcess.key}
            onSelectProcess={handleSelectProcess}
            onBack={handleBackToScan}
            onOpenLog={setModalLog}
          />
        )}
        {currentScreen === 'input' && (
          <InputScreen
            moData={moData}
            process={selectedProcess}
            onSubmit={handleSubmit}
            onBack={handleBackToInfo}
          />
        )}
        {currentScreen === 'success' && (
          <SuccessScreen
            result={submitResult}
            onNextProcess={handleNextProcess}
            onNewScan={() => setCurrentScreen('home')}
          />
        )}

        {/* Inner Pack screens */}
        {currentScreen === 'pack_menu' && (
          <PackMenuScreen
            onCreate={() => requirePin(() => setCurrentScreen('pack_mo_select'))}
            onScan={() => { setScanMode('inner_pack_detail'); setCameraOpen(true); }}
            onBack={() => { window.history.pushState({}, '', '/'); setCurrentScreen('home'); }}
          />
        )}
        {currentScreen === 'pack_mo_select' && (
          <PackMOSelectScreen
            onScan={() => { setScanMode('inner_pack_mo'); setCameraOpen(true); }}
            onManual={(mo) => {
              setLoadingMsg('加载订单数据...');
              setCurrentScreen('loading');
              fetchMODataForPack(mo);
            }}
            onBack={() => setCurrentScreen('pack_menu')}
          />
        )}
        {currentScreen === 'pack_create' && packMO && (
          <PackCreateScreen
            packMO={packMO}
            composition={packComposition}
            setComposition={setPackComposition}
            packSequence={packSequence}
            worker={packWorker}
            setWorker={setPackWorker}
            isRemainder={packIsRemainder}
            setIsRemainder={setPackIsRemainder}
            lastComposition={lastPackComposition}
            onSubmit={handleCreatePack}
            onBack={() => setCurrentScreen('pack_mo_select')}
            submitting={false}
          />
        )}
        {currentScreen === 'pack_success' && (
          <PackSuccessScreen
            pack={createdPack}
            onNextPack={() => {
              setPackSequence(s => s + 1);
              setCreatedPack(null);
              setPackComposition(
                packMO && packMO.standard_assortment
                  ? packMO.standard_assortment.map(it => ({ ...it, selected: true }))
                  : []
              );
              setPackIsRemainder(false);
              setCurrentScreen('pack_create');
            }}
            onHome={() => {
              setPackMO(null); setCreatedPack(null); setPackComposition([]);
              setPackWorker(''); setPackIsRemainder(false); setPackSequence(1);
              setCurrentScreen('home');
            }}
          />
        )}
        {currentScreen === 'pack_detail' && scannedPackDetail && (
          <PackDetailScreen
            detail={scannedPackDetail}
            onBack={() => { setScannedPackDetail(null); setCurrentScreen('pack_menu'); }}
          />
        )}

        {/* Master Bag screens */}
        {currentScreen === 'bag_menu' && (
          <BagMenuScreen
            onCreate={() => requirePin(() => {
              setBagScannedPacks([]); setBagIsRemainder(false);
              setBagWorker(''); setBagDestination('');
              setCurrentScreen('bag_create');
            })}
            onScan={() => { setScanMode('master_bag_detail'); setCameraOpen(true); }}
            onBack={() => { window.history.pushState({}, '', '/'); setCurrentScreen('home'); }}
          />
        )}
        {currentScreen === 'bag_create' && (
          <BagCreateScreen
            scannedPacks={bagScannedPacks}
            isRemainder={bagIsRemainder}
            setIsRemainder={setBagIsRemainder}
            worker={bagWorker}
            setWorker={setBagWorker}
            destination={bagDestination}
            setDestination={setBagDestination}
            onScanNext={() => { setScanMode('master_bag_compose'); setCameraOpen(true); }}
            onRemovePack={handleRemovePackFromBag}
            onSubmit={handleCreateBag}
            onBack={() => setCurrentScreen('bag_menu')}
            submitting={false}
          />
        )}
        {currentScreen === 'bag_success' && (
          <BagSuccessScreen
            bag={createdBag}
            onNewBag={() => {
              setBagScannedPacks([]); setCreatedBag(null); setBagIsRemainder(false);
              setBagWorker(''); setBagDestination('');
              setCurrentScreen('bag_create');
            }}
            onHome={() => {
              setBagScannedPacks([]); setCreatedBag(null); setBagIsRemainder(false);
              setBagWorker(''); setBagDestination('');
              setCurrentScreen('home');
            }}
          />
        )}
        {currentScreen === 'bag_detail' && scannedBagDetail && (
          <BagDetailScreen
            detail={scannedBagDetail}
            onBack={() => { setScannedBagDetail(null); setCurrentScreen('bag_menu'); }}
          />
        )}

        {/* Public read-only view screens */}
        {currentScreen === 'view-inner' && (
          <ViewInnerScreen
            uuid={viewUuid}
            onHome={() => { window.history.pushState({}, '', '/'); setCurrentScreen('home'); setViewUuid(null); }}
          />
        )}
        {currentScreen === 'view-bag' && (
          <ViewBagScreen
            uuid={viewUuid}
            onHome={() => { window.history.pushState({}, '', '/'); setCurrentScreen('home'); setViewUuid(null); }}
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      </div>
      {modalLog && <LogModal log={modalLog} onClose={handleCloseModal} />}
      {cameraOpen && <CameraOverlay onResult={handleQR} onCancel={handleCameraCancel} />}
      {pinModalOpen && (
        <PinGate
          onSuccess={() => { setPinModalOpen(false); if (pinSuccessCallback) { pinSuccessCallback(); setPinSuccessCallback(null); } }}
          onCancel={() => { setPinModalOpen(false); setPinSuccessCallback(null); }}
        />
      )}
    </>
  );
}
