import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import jsQR from 'jsqr';
import { getRecords, getRecordsByCriteria, submitRecord, updateRecord, deleteRecord } from './api.js';
import {
  BRAND, INNER_PACK_SIZE, MASTER_BAG_SIZE, REPORTS, FORMS,
  PACK_STATUS_LABELS, BAG_STATUS_LABELS, APP_PIN, PIN_STORAGE_KEY
} from './config.js';
import {
  buildInnerPackQR, buildMasterBagQR, parseInnerPackQR, parseMasterBagQR,
  detectQRType, generateQRDataURL, generateQRDataURLWithLabel, downloadQRPNG, sanitizeFilename,
  downloadQRsAsZIP, downloadQRsAsPDF
} from './qrUtils.js';

// Keep legacy constants for existing Production Log flow
const MO_REPORT = 'All_MO';
const LOG_FORM = 'Add_Production_Log';
const LOG_REPORT = 'Production_Log_Report';

const PROCESSES = [
  { code: 'Fabric_In',     zh: '面料入库', ko: '원단입고',  moField: 'Fabric_In_house_Date',  emoji: '📥', zohoValue: 'Fabric In / 원단입고 / 面料入库' },
  { code: 'Cutting_Start', zh: '裁剪开始', ko: '재단 시작', moField: 'Cutting_Start_Date',    emoji: '✂️', zohoValue: 'Cutting Start / 재단 시작 / 裁剪开始' },
  { code: 'Cutting_End',   zh: '裁剪完成', ko: '재단 완료', moField: 'Cutting_End_Date',      emoji: '✅', zohoValue: 'Cutting End / 재단 완료 / 裁剪完成' },
  { code: 'Sewing_Start',  zh: '车缝开始', ko: '봉제 시작', moField: 'Sewing_Start_Date',     emoji: '🧵', zohoValue: 'Sewing Start / 봉제 시작 / 车缝开始' },
  { code: 'Sewing_End',    zh: '车缝完成', ko: '봉제 완료', moField: 'Sewing_Completion_Date',emoji: '🪡', zohoValue: 'Sewing End / 봉제 완료 / 车缝完成' },
  { code: 'Packing_Start', zh: '包装开始', ko: '포장 시작', moField: 'Packing_Start_Date',    emoji: '📦', zohoValue: 'Packing Start / 포장 시작 / 包装开始' },
  { code: 'Packing_End',   zh: '包装完成', ko: '포장 완료', moField: 'Packing_End_Date',      emoji: '🎁', zohoValue: 'Packing End / 포장 완료 / 包装完成' },
  { code: 'Shipped',       zh: '出货',     ko: '출고',      moField: 'Ship_Date',              emoji: '🚚', zohoValue: 'Shipped / 출고 / 出货' },
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

function getTodayDateStr() {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return pad(d.getDate()) + '-' + months[d.getMonth()] + '-' + d.getFullYear();
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
const ScanScreen = memo(function ScanScreen({ onScan, onUpload, onManual, onBack }) {
  return (
    <div className="screen active" id="screen-scan">
      <button onClick={onBack} style={{ position:'absolute', top:16, left:16, background:'transparent', border:'1px solid #D4AF37', color:G.gold, fontSize:10, fontWeight:400, letterSpacing:2, padding:'7px 14px', cursor:'pointer', zIndex:10, fontFamily:'inherit' }}>← 返回</button>
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
      <button className="btn-manual-mo" onClick={onManual}>✏️ TEXT / 文字查询</button>
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

  const processStatusMap = useMemo(() => {
    if (!logs || !logs.length) return {};
    const sorted = [...logs].sort((a, b) => {
      const ta = a['Added_Time'] || a['Log_Date'] || '';
      const tb = b['Added_Time'] || b['Log_Date'] || '';
      return parseDateRaw(String(tb)) - parseDateRaw(String(ta));
    });
    const map = {};
    sorted.forEach(r => {
      const proc = r['Process'];
      if (!proc || map[proc] != null) return;
      map[proc] = parseInt(r['Completed_Qty']) || 0;
    });
    return map;
  }, [logs]);

  const ProcBtn = ({ p, full }) => (
    <div
      className={'proc-btn' + (full ? ' proc-full' : '') + (selectedKey === p.code ? ' selected' : '')}
      onClick={() => onSelectProcess(p.code, p.zh, p.ko, p.moField, p.zohoValue)}
    >
      <span className="proc-icon">{p.emoji}</span>
      <div className="proc-name">{p.zh}</div>
      <div className="proc-sub">{p.ko}</div>
      {processStatusMap[p.zohoValue] != null
        ? <span className="proc-status proc-status-done">✅ {processStatusMap[p.zohoValue].toLocaleString()}件</span>
        : <span className="proc-status proc-status-pending">⏳ 未记录</span>}
    </div>
  );

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
        <div className="process-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <ProcBtn p={PROCESSES[0]} full />
          <ProcBtn p={PROCESSES[1]} />
          <ProcBtn p={PROCESSES[2]} />
          <ProcBtn p={PROCESSES[3]} />
          <ProcBtn p={PROCESSES[4]} />
          <ProcBtn p={PROCESSES[5]} />
          <ProcBtn p={PROCESSES[6]} />
          <ProcBtn p={PROCESSES[7]} full />
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
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={completed} onChange={(e) => setCompleted(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        <div className="qty-card muted">
          <div className="qty-card-label">未完成</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={incomplete} onChange={(e) => setIncomplete(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        <div className="qty-card danger">
          <div className="qty-card-label">不良</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={defect} onChange={(e) => setDefect(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        {showBag && (
          <div className="qty-card muted">
            <div className="qty-card-label">麻袋数量</div>
            <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={bag} onChange={(e) => setBag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
          </div>
        )}
        <div className="field-card">
          <div className="field-card-label">负责人 / 담당자 *</div>
          <input className="input-field text-field" type="text" placeholder="이름을 입력하세요" value={worker} onChange={(e) => setWorker(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        <div className="field-card">
          <div className="field-card-label">备注 / 메모</div>
          <input className="input-field text-field" type="text" placeholder="선택사항" value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
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
    <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-sm)', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-sm)', borderLeft: accent ? '3px solid var(--accent)' : undefined }}>
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
            <div style={{ fontSize: 10, color: 'var(--text4)', letterSpacing: 1, marginTop: 6, fontWeight: 500 }}>공정 기록이 저장되었습니다 · 일정 자동 업데이트</div>
          </div>
        </div>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ResultRow label="공정" value={(result.processCN || '') + (result.processKO ? ' / ' + result.processKO : '') + ' · ' + result.process} accent />
          <ResultRow label="완성수량"  value={result.completed.toLocaleString() + ' 件'} />
          {result.incomplete > 0 && <ResultRow label="미완성수량" value={result.incomplete.toLocaleString() + ' 件'} />}
          {result.defect > 0     && <ResultRow label="불량수량"  value={result.defect.toLocaleString() + ' 件'} danger />}
          <ResultRow label="담당자"    value={result.worker} />
          <ResultRow label="기록시간"  value={result.time} mute />
          {result.notes && <ResultRow label="메모" value={result.notes} mute />}
          {result.moField && (
            result.moUpdateOk ? (
              <div style={{ background: 'linear-gradient(135deg,rgba(212,185,118,.1),rgba(212,185,118,.04))', border: '1px solid rgba(212,185,118,.3)', borderRadius: 'var(--radius-sm)', padding: '12px 18px', marginTop: 2 }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: '#C9A84C', textTransform: 'uppercase', marginBottom: 6 }}>✅ 자동 갱신 성공 / 自动更新</div>
                <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{result.moField} → {result.moFieldDate}</div>
              </div>
            ) : (
              <div style={{ background: 'rgba(196,92,82,.08)', border: '1px solid rgba(196,92,82,.35)', borderRadius: 'var(--radius-sm)', padding: '12px 18px', marginTop: 2 }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: 'var(--danger)', textTransform: 'uppercase', marginBottom: 6 }}>❌ 자동 갱신 실패 / 更新失败</div>
                <div style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 500, wordBreak: 'break-all' }}>{result.moField}: {result.moUpdateError || 'Unknown error'}</div>
              </div>
            )
          )}
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <button onClick={onNextProcess} style={{ padding: 16, border: 'none', background: 'linear-gradient(135deg,#D4B976,#C9A84C)', color: '#4A3510', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit', width: '100%', boxShadow: '0 2px 8px rgba(201,168,76,.2)' }}>下一工序 / 다음 공정</button>
          <button onClick={onNewScan} style={{ padding: 16, border: 'none', background: 'var(--dark2)', color: 'var(--gold)', borderRadius: 'var(--radius-sm)', fontSize: 11, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', cursor: 'pointer', fontFamily: 'inherit', width: '100%', transition: 'var(--transition)' }}>← 重新扫码 / 새 스캔</button>
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
        style={{ background: 'var(--surface)', borderRadius: 16, width: '92%', maxWidth: 420, padding: 22, position: 'relative', boxShadow: '0 20px 60px rgba(0,0,0,.2)', animation: 'fadeIn .25s ease' }}
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

// ─── Production Log: Manual MO Entry ─────────────────────────────────
const LogManualMOScreen = memo(function LogManualMOScreen({ onSubmit, onBack }) {
  const [moInput, setMoInput] = useState('');
  const handleSubmit = () => {
    const mo = moInput.trim().toUpperCase();
    if (!mo) { alert('请输入订单号 / MO번호를 입력하세요'); return; }
    onSubmit(mo);
  };
  return (
    <div style={{ minHeight:'100vh', width:'100%', background:'var(--dark)', backgroundImage:'radial-gradient(ellipse at 50% -10%, rgba(212,175,55,0.07) 0%, transparent 55%)', padding:'80px 20px 40px', position:'relative', color:'var(--gold-light)' }}>
      <button onClick={onBack} style={{ position:'absolute', top:16, left:16, background:'transparent', border:'1px solid #D4AF37', color:'#D4AF37', fontSize:10, fontWeight:400, letterSpacing:2, padding:'7px 14px', cursor:'pointer', zIndex:10, fontFamily:'inherit' }}>← 返回</button>
      <div style={{ textAlign:'center', marginBottom:36 }}>
        <div style={{ fontSize:9, letterSpacing:4, color:'var(--gold-dim)', fontWeight:400 }}>PRODUCTION LOG</div>
        <div style={{ fontSize:22, color:'var(--gold-light)', marginTop:10, fontWeight:300, letterSpacing:2 }}>手动输入订单号</div>
        <div style={{ fontSize:10, color:'var(--gold-dim)', marginTop:6, letterSpacing:1.5 }}>수동으로 MO번호 입력</div>
        <div style={{ width:40, height:1, background:'rgba(212,175,55,0.3)', margin:'16px auto 0' }} />
      </div>
      <div style={{ position:'relative', border:'1px solid rgba(212,175,55,0.2)', borderRadius:2, background:'rgba(255,255,255,0.04)', padding:20, marginBottom:14 }}>
        <div style={{ fontSize:9, fontWeight:400, letterSpacing:2, color:'var(--gold-dim)', textTransform:'uppercase', marginBottom:10 }}>订单号 / MO번호</div>
        <input
          type="text"
          value={moInput}
          onChange={e => setMoInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
          placeholder="例: GJ26-001"
          style={{ width:'100%', padding:'10px 0', background:'transparent', border:'none', borderBottom:'1px solid rgba(212,175,55,0.3)', color:'var(--gold-light)', fontSize:18, outline:'none', fontFamily:'inherit', boxSizing:'border-box', letterSpacing:2 }}
        />
        <button onClick={handleSubmit} style={{ width:'100%', marginTop:20, padding:16, border:'1px solid #D4AF37', borderRadius:2, background:'rgba(212,175,55,0.12)', color:'#D4AF37', fontSize:12, fontWeight:400, letterSpacing:3, textTransform:'uppercase', cursor:'pointer', fontFamily:'inherit' }}>
          확인 / 确认 →
        </button>
      </div>
      <button onClick={onBack} style={{ width:'100%', padding:14, border:'1px solid rgba(212,175,55,0.2)', borderRadius:2, background:'transparent', color:'var(--gold-dim)', fontSize:11, fontWeight:400, letterSpacing:2, textTransform:'uppercase', cursor:'pointer', fontFamily:'inherit' }}>
        ← 返回 / 돌아가기
      </button>
    </div>
  );
});

// ─── Design System helpers ────────────────────────────────────────────
const G = { bg:'var(--app-bg)', card:'var(--app-card)', gold:'var(--app-gold)', goldDim:'var(--app-gold-dim)', cream:'var(--app-cream)', creamDim:'var(--app-cream-dim)', border:'var(--app-border)', borderHover:'var(--app-border-hover)', progressTrack:'var(--app-progress-track)', btnBg:'var(--app-btn-bg)', btnBgDisabled:'var(--app-btn-bg-disabled)', divider:'var(--app-divider)', borderInput:'var(--app-border-input)' };

function DkBack({ onClick }) {
  return (
    <button onClick={onClick} style={{ position:'absolute', top:16, left:16, background:'transparent', border:'1px solid '+G.gold, color:G.gold, fontSize:10, fontWeight:400, letterSpacing:2, padding:'7px 14px', cursor:'pointer', minHeight:44, fontFamily:'inherit', zIndex:10 }}>← 返回</button>
  );
}

function DkScreen({ children, style }) {
  return (
    <div style={{ minHeight:'100vh', width:'100%', background:G.bg, backgroundImage:'radial-gradient(ellipse at 50% -10%, rgba(212,175,55,0.07) 0%, transparent 55%)', position:'relative', color:G.cream, paddingBottom:40, ...style }}>
      {children}
    </div>
  );
}

function DkCard({ children, style }) {
  const br = { position:'absolute', width:14, height:14 };
  const ln = (s) => ({ position:'absolute', background:G.gold, ...s });
  return (
    <div style={{ position:'relative', border:'1px solid '+G.border, borderRadius:2, background:G.card, backdropFilter:'blur(4px)', padding:18, marginBottom:14, ...style }}>
      <div style={{ ...br, top:-1, left:-1 }}><div style={ln({ top:0, left:0, width:14, height:1.5 })} /><div style={ln({ top:0, left:0, width:1.5, height:14 })} /></div>
      <div style={{ ...br, top:-1, right:-1 }}><div style={ln({ top:0, right:0, width:14, height:1.5 })} /><div style={ln({ top:0, right:0, width:1.5, height:14 })} /></div>
      <div style={{ ...br, bottom:-1, left:-1 }}><div style={ln({ bottom:0, left:0, width:14, height:1.5 })} /><div style={ln({ bottom:0, left:0, width:1.5, height:14 })} /></div>
      <div style={{ ...br, bottom:-1, right:-1 }}><div style={ln({ bottom:0, right:0, width:14, height:1.5 })} /><div style={ln({ bottom:0, right:0, width:1.5, height:14 })} /></div>
      {children}
    </div>
  );
}

function DkBtn({ onClick, disabled, children, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ width:'100%', padding:16, border:'1px solid '+(disabled?G.border:G.gold), borderRadius:2, background:disabled?G.btnBgDisabled:G.btnBg, color:disabled?G.goldDim:G.gold, fontSize:12, fontWeight:400, letterSpacing:3, textTransform:'uppercase', cursor:disabled?'not-allowed':'pointer', fontFamily:'inherit', transition:'all .15s', marginBottom:10, ...style }}>
      {children}
    </button>
  );
}

function DkBtnOutline({ onClick, children, style }) {
  return (
    <button onClick={onClick} style={{ width:'100%', padding:14, border:'1px solid var(--app-border-input)', borderRadius:2, background:'transparent', color:G.goldDim, fontSize:11, fontWeight:400, letterSpacing:2, textTransform:'uppercase', cursor:'pointer', fontFamily:'inherit', marginBottom:10, ...style }}>
      {children}
    </button>
  );
}

function DkInput({ label, value, onChange, placeholder, type='text', inputMode, onKeyDown }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <div style={{ fontSize:9, fontWeight:400, letterSpacing:2, color:G.goldDim, textTransform:'uppercase', marginBottom:6 }}>{label}</div>}
      <input type={type} value={value} onChange={onChange} placeholder={placeholder} inputMode={inputMode} onKeyDown={onKeyDown}
        style={{ width:'100%', padding:'10px 0', background:'transparent', border:'none', borderBottom:'1px solid var(--app-border-input)', color:G.cream, fontSize:14, outline:'none', fontFamily:'inherit', boxSizing:'border-box' }}
      />
    </div>
  );
}

function DkRow({ label, value, mono }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'7px 0', borderBottom:'1px solid var(--app-divider)' }}>
      <span style={{ fontSize:10, color:G.goldDim, letterSpacing:1, fontWeight:400, flexShrink:0, paddingRight:8 }}>{label}</span>
      <span style={{ fontSize: mono ? 10 : 12, color:G.cream, textAlign:'right', wordBreak:'break-all', fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</span>
    </div>
  );
}

function getField(rec, key) {
  const v = rec?.[key];
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.display_value !== undefined) return String(v.display_value);
    if (v.zc_display_value !== undefined) return String(v.zc_display_value);
    if (v[key] !== undefined) return String(v[key]); // e.g. Style_SKU.Style_SKU
    return '-';
  }
  return String(v);
}

// ─── SVG Icons ────────────────────────────────────────────────────────
const IconFactory = () => (
  <svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="var(--app-gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="20" width="36" height="22" rx="1"/>
    <path d="M6 20 L6 14 L18 20"/>
    <path d="M18 20 L18 14 L30 20"/>
    <path d="M30 20 L30 14 L42 20"/>
    <rect x="11" y="26" width="6" height="6" rx="0.5"/>
    <rect x="21" y="26" width="6" height="6" rx="0.5"/>
    <rect x="31" y="26" width="6" height="6" rx="0.5"/>
    <rect x="19" y="34" width="10" height="8" rx="0.5"/>
    <line x1="16" y1="10" x2="16" y2="6"/>
    <line x1="24" y1="10" x2="24" y2="5"/>
    <line x1="32" y1="10" x2="32" y2="7"/>
  </svg>
);

const IconInnerPack = () => (
  <svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="var(--app-gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 12 Q10 8 14 8 L34 8 Q38 8 38 12 L38 42 Q38 44 36 44 L12 44 Q10 44 10 42 Z"/>
    <path d="M14 8 L14 6 Q14 4 16 4 L32 4 Q34 4 34 6 L34 8"/>
    <line x1="12" y1="16" x2="17" y2="11"/>
    <line x1="12" y1="21" x2="20" y2="13"/>
    <rect x="17" y="22" width="14" height="14" rx="1"/>
    <path d="M20 22 Q24 18 28 22"/>
    <path d="M17 22 L14 26 L17 27"/>
    <path d="M31 22 L34 26 L31 27"/>
  </svg>
);

const IconMasterBag = () => (
  <svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="var(--app-gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 14 Q8 18 8 30 Q8 44 24 44 Q40 44 40 30 Q40 18 30 14 Z"/>
    <path d="M18 14 Q24 10 30 14"/>
    <ellipse cx="24" cy="11" rx="5" ry="2"/>
    <path d="M19 11 L16 8 M29 11 L32 8"/>
    <line x1="15" y1="24" x2="22" y2="31"/>
    <line x1="18" y1="20" x2="28" y2="30"/>
    <line x1="22" y1="19" x2="33" y2="30"/>
    <line x1="26" y1="19" x2="36" y2="29"/>
  </svg>
);

const IconStatusScan = () => (
  <svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="var(--app-gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 24 A14 14 0 0 1 38 24"/>
    <polyline points="34,17 38,24 43,21"/>
    <path d="M38 24 A14 14 0 0 1 10 24"/>
    <polyline points="14,31 10,24 5,27"/>
    <rect x="19" y="20" width="10" height="8" rx="1"/>
  </svg>
);

// ─── NEW: Home Screen ─────────────────────────────────────────────────
const HomeScreen = memo(function HomeScreen({ onSelectProductionLog, onSelectInnerPack, onSelectMasterBag, onSelectStatusScan }) {
  const card = (onClick, Icon, label, sub) => (
    <div onClick={onClick} style={{ position:'relative', border:'1px solid '+G.border, borderRadius:2, background:G.card, padding:'20px 20px 20px 24px', marginBottom:14, display:'flex', alignItems:'center', gap:20, cursor:'pointer', transition:'all .2s' }}
      onMouseEnter={e => { e.currentTarget.style.border='1px solid '+G.borderHover; e.currentTarget.style.background='rgba(212,175,55,0.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.border='1px solid '+G.border; e.currentTarget.style.background=G.card; }}
    >
      {[{t:'-1px',l:'-1px'},{t:'-1px',r:'-1px'},{b:'-1px',l:'-1px'},{b:'-1px',r:'-1px'}].map((pos, i) => {
        const isRight = pos.r !== undefined; const isBottom = pos.b !== undefined;
        return (
          <div key={i} style={{ position:'absolute', width:14, height:14, top:pos.t, bottom:pos.b, left:pos.l, right:pos.r }}>
            <div style={{ position:'absolute', background:G.gold, [isBottom?'bottom':'top']:0, [isRight?'right':'left']:0, width:14, height:1.5 }} />
            <div style={{ position:'absolute', background:G.gold, [isBottom?'bottom':'top']:0, [isRight?'right':'left']:0, width:1.5, height:14 }} />
          </div>
        );
      })}
      <Icon />
      <div>
        <div style={{ fontSize:16, fontWeight:400, letterSpacing:2, color:G.cream }}>{label}</div>
        <div style={{ fontSize:10, color:G.goldDim, letterSpacing:1.5, marginTop:4, fontWeight:400 }}>{sub}</div>
      </div>
    </div>
  );
  return (
    <div style={{ minHeight:'100vh', width:'100%', background:G.bg, backgroundImage:'radial-gradient(ellipse at 50% -10%, rgba(212,175,55,0.07) 0%, transparent 55%)', padding:'0 20px 40px', display:'flex', flexDirection:'column', position:'relative' }}>
      <div style={{ textAlign:'center', padding:'60px 0 48px' }}>
        <div style={{ fontFamily:"'Bebas Neue',cursive", fontSize:52, letterSpacing:12, color:G.gold, lineHeight:1 }}>IKU</div>
        <div style={{ fontSize:9, color:G.goldDim, letterSpacing:6, marginTop:8, fontWeight:400 }}>PRODUCTION SYSTEM</div>
        <div style={{ fontSize:10, color:G.goldDim, letterSpacing:2, marginTop:6, fontWeight:400 }}>生产管理系统</div>
        <div style={{ width:60, height:1, background:G.border, margin:'20px auto 0' }} />
      </div>
      {card(onSelectProductionLog, IconFactory, '生产进度扫码', 'Production Log Scan')}
      {card(onSelectInnerPack, IconInnerPack, '中包袋', 'Inner Pack')}
      {card(onSelectMasterBag, IconMasterBag, '麻袋包装', 'Master Bag')}
    </div>
  );
});

// ─── NEW: Status Scan Screens ────────────────────────────────────────
const STATUS_SCAN_OPTIONS = [
  { key: 'Shipped',          icon: '🚚' },
  { key: 'Received',         icon: '📦' },
  { key: 'Out_For_Delivery', icon: '🛵' },
  { key: 'Delivered',        icon: '✅' },
];

const StatusScanModeScreen = memo(function StatusScanModeScreen({ onSelectStatus, onBack }) {
  return (
    <DkScreen style={{ padding: '80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <IconStatusScan />
        <div style={{ fontSize: 11, letterSpacing: 4, color: G.gold, marginTop: 16, fontWeight: 300 }}>STATUS SCAN</div>
        <div style={{ fontSize: 20, color: G.cream, marginTop: 6, fontWeight: 300, letterSpacing: 1 }}>选择更新状态</div>
        <div style={{ fontSize: 10, color: G.goldDim, marginTop: 4, letterSpacing: 2 }}>扫描麻袋 QR 自动更新</div>
      </div>
      {STATUS_SCAN_OPTIONS.map(s => (
        <DkBtn key={s.key} onClick={() => onSelectStatus(s.key)}>
          {s.icon} {BAG_STATUS_LABELS[s.key] || s.key}
        </DkBtn>
      ))}
    </DkScreen>
  );
});

const StatusScanCameraScreen = memo(function StatusScanCameraScreen({ targetStatus, onScan, onBack }) {
  const statusLabel = BAG_STATUS_LABELS[targetStatus] || targetStatus;
  return (
    <DkScreen style={{ padding: '80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{ fontSize: 9, letterSpacing: 4, color: G.goldDim, fontWeight: 300 }}>STATUS SCAN</div>
        <div style={{ fontSize: 20, color: G.cream, marginTop: 10, fontWeight: 300, letterSpacing: 1 }}>扫描麻袋 QR</div>
        <div style={{ display: 'inline-block', border: '1px solid rgba(212,175,55,0.5)', padding: '4px 16px', fontSize: 11, color: G.gold, letterSpacing: 1, marginTop: 12 }}>{statusLabel}</div>
        <div style={{ fontSize: 10, color: G.goldDim, marginTop: 10 }}>将麻袋 QR 对准摄像头 / 마대 QR을 스캔하세요</div>
      </div>
      <DkBtn onClick={onScan}>📷 开始扫描 / 스캔 시작</DkBtn>
      <DkBtnOutline onClick={onBack}>← 重新选择状态</DkBtnOutline>
    </DkScreen>
  );
});

const StatusScanSuccessScreen = memo(function StatusScanSuccessScreen({ result, onContinue, onHome }) {
  if (!result) return null;
  const statusLabel = BAG_STATUS_LABELS[result.status] || result.status;
  return (
    <DkScreen style={{ paddingTop: 0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize: 9, letterSpacing: 6, color: G.gold, fontWeight: 300 }}>STATUS UPDATED</div>
        <div style={{ fontSize: 11, color: G.goldDim, marginTop: 4 }}>{result.moNum} · Bag #{result.bagSeq}</div>
      </div>
      <div style={{ padding: '20px 20px 40px' }}>
        <DkCard>
          <DkRow label="新状态 / 새 상태" value={statusLabel} />
          <DkRow label="MO 번호" value={result.moNum} />
          <DkRow label="Bag #" value={String(result.bagSeq)} />
          <DkRow label="Bag UUID" value={result.bagUuid} mono />
          <DkRow label="已更新包装" value={String(result.packCount) + ' packs'} />
        </DkCard>
        <DkBtn onClick={onContinue}>📷 继续扫描 / 계속 스캔</DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Pack Menu Screen ────────────────────────────────────────────
const PackMenuScreen = memo(function PackMenuScreen({ onCreate, onBatch, onQueryMenu, onBack }) {
  return (
    <DkScreen style={{ padding:'80px 20px 40px', display:'flex', flexDirection:'column', alignItems:'center' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:32 }}>
        <div className="scan-frame-wrap">
          <div className="sc-corner sc-tl"></div>
          <div className="sc-corner sc-tr"></div>
          <div className="sc-corner sc-bl"></div>
          <div className="sc-corner sc-br"></div>
          <div className="sc-inner"><div className="sc-dot"></div></div>
          <div className="sc-line"></div>
        </div>
        <div style={{ fontSize:11, letterSpacing:4, color:G.gold, marginTop:16, fontWeight:400 }}>INNER PACK</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:6, fontWeight:400, letterSpacing:1 }}>中包袋 / 중간포장</div>
      </div>
      <button className="btn-upload-qr" onClick={onCreate}>➕ 新建包装 / 새 포장 생성</button>
      <button className="btn-scan-start" onClick={onBatch} style={{ marginTop:12 }}>📦 批量生成 / 일괄 생성</button>
      <button className="btn-manual-mo" onClick={onQueryMenu} style={{ marginTop:12 }}>🔍 QR 查询 / QR 조회</button>
    </DkScreen>
  );
});

// ─── NEW: Bag Menu Screen ─────────────────────────────────────────────
const BagMenuScreen = memo(function BagMenuScreen({ onCreate, onBatch, onQueryMenu, onBack }) {
  return (
    <DkScreen style={{ padding:'80px 20px 40px', display:'flex', flexDirection:'column', alignItems:'center' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:32 }}>
        <div className="scan-frame-wrap">
          <div className="sc-corner sc-tl"></div>
          <div className="sc-corner sc-tr"></div>
          <div className="sc-corner sc-bl"></div>
          <div className="sc-corner sc-br"></div>
          <div className="sc-inner"><div className="sc-dot"></div></div>
          <div className="sc-line"></div>
        </div>
        <div style={{ fontSize:11, letterSpacing:4, color:G.gold, marginTop:16, fontWeight:400 }}>MASTER BAG</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:6, fontWeight:400, letterSpacing:1 }}>麻袋包装 / 마대</div>
      </div>
      <button className="btn-upload-qr" onClick={onCreate}>➕ 新建麻袋 / 새 마대 생성</button>
      <button className="btn-scan-start" onClick={onBatch} style={{ marginTop:12 }}>📦 批量生成 / 일괄 생성</button>
      <button className="btn-manual-mo" onClick={onQueryMenu} style={{ marginTop:12 }}>🔍 QR 查询 / QR 조회</button>
    </DkScreen>
  );
});

// ─── NEW: Bag MO Select Screen ────────────────────────────────────────
const BagMOSelectScreen = memo(function BagMOSelectScreen({ onScan, onManual, onBack }) {
  const [manualMO, setManualMO] = useState('');
  const handleManualSubmit = () => {
    const mo = manualMO.trim().toUpperCase();
    if (!mo) { alert('请输入订单号'); return; }
    onManual(mo);
  };
  return (
    <DkScreen style={{ padding:'80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:36 }}>
        <div style={{ fontSize:9, letterSpacing:4, color:G.goldDim, fontWeight:400 }}>STEP 1 / 2</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:10, fontWeight:400, letterSpacing:1 }}>选择订单 / MO 선택</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:4 }}>Which MO is this bag for?</div>
      </div>
      <DkBtn onClick={onScan}>📷 扫描 MO QR / QR 스캔</DkBtn>
      <div style={{ textAlign:'center', color:G.goldDim, fontSize:10, letterSpacing:2, margin:'10px 0' }}>— OR —</div>
      <DkCard>
        <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>手动输入 / 수동 입력</div>
        <DkInput value={manualMO} onChange={e => setManualMO(e.target.value)} placeholder="例: GJ26-1" onKeyDown={e => { if (e.key === 'Enter') handleManualSubmit(); }} />
        <DkBtn onClick={handleManualSubmit} style={{ marginTop:8, marginBottom:0 }}>确认 / 확인</DkBtn>
      </DkCard>
    </DkScreen>
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
    <DkScreen style={{ padding:'80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:36 }}>
        <div style={{ fontSize:9, letterSpacing:4, color:G.goldDim, fontWeight:400 }}>STEP 1 / 3</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:10, fontWeight:400, letterSpacing:1 }}>选择订单 / MO 선택</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:4 }}>Which MO is this pack for?</div>
      </div>
      <DkBtn onClick={onScan}>📷 扫描 MO QR / QR 스캔</DkBtn>
      <div style={{ textAlign:'center', color:G.goldDim, fontSize:10, letterSpacing:2, margin:'10px 0' }}>— OR —</div>
      <DkCard>
        <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>手动输入 / 수동 입력</div>
        <DkInput value={manualMO} onChange={e => setManualMO(e.target.value)} placeholder="例: GJ26-1" onKeyDown={e => { if (e.key === 'Enter') handleManualSubmit(); }} />
        <DkBtn onClick={handleManualSubmit} style={{ marginTop:8, marginBottom:0 }}>确认 / 확인</DkBtn>
      </DkCard>
    </DkScreen>
  );
});

// ─── NEW: Pack Create Screen ──────────────────────────────────────────
const PackCreateScreen = memo(function PackCreateScreen({
  packMO, composition, setComposition, packSequence, worker, setWorker,
  isRemainder, setIsRemainder, lastComposition, onSubmit, onBack, submitting
}) {
  const selectedCount = composition.filter(c => c.selected).length;
  const applyStandard = () => setComposition(composition.map(c => ({ ...c, selected: true })));
  const applyLastPack = () => {
    if (!lastComposition) return;
    setComposition(composition.map(c => {
      const found = lastComposition.find(l => l.color === c.color && l.size === c.size);
      return { ...c, selected: !!found };
    }));
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
    if (!worker.trim()) { alert('请输入负责人 / 담당자를 입력하세요'); return; }
    onSubmit();
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>INNER PACK #{packSequence}</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{packMO.mo_number}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{packMO.sku} · {packMO.factory}</div>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:12 }}>
          <div style={{ fontSize:11, color:G.gold }}>{selectedCount}</div>
          <div style={{ flex:1, height:2, background:G.progressTrack, borderRadius:1 }}>
            <div style={{ height:'100%', background:G.gold, width:Math.min(100, selectedCount / INNER_PACK_SIZE * 100) + '%', borderRadius:1, transition:'width .2s' }} />
          </div>
          <div style={{ fontSize:11, color:G.goldDim }}>{INNER_PACK_SIZE}</div>
        </div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>包装组成 / 포장 구성</div>
          <div style={{ display:'flex', gap:8, marginBottom:14 }}>
            <button onClick={applyStandard} style={{ flex:1, padding:'9px 8px', border:'1px solid '+G.borderHover, borderRadius:2, background:G.btnBg, color:G.gold, fontSize:10, letterSpacing:1, cursor:'pointer', fontFamily:'inherit' }}>标准 / Standard</button>
            {lastComposition && (
              <button onClick={applyLastPack} style={{ flex:1, padding:'9px 8px', border:'1px solid '+G.border, borderRadius:2, background:'transparent', color:G.goldDim, fontSize:10, letterSpacing:1, cursor:'pointer', fontFamily:'inherit' }}>上次 / Copy Last</button>
            )}
          </div>
          <div style={{ maxHeight:260, overflowY:'auto' }}>
            {composition.length === 0 ? (
              <div style={{ textAlign:'center', color:G.goldDim, padding:20, fontSize:11, letterSpacing:1 }}>此订单没有标准配货信息</div>
            ) : composition.map((item, idx) => (
              <div key={idx} onClick={() => toggleItem(idx)} style={{ display:'flex', alignItems:'center', padding:'10px 0', borderBottom: idx < composition.length - 1 ? '1px solid var(--app-divider)' : 'none', cursor:'pointer' }}>
                <div style={{ width:16, height:16, border:'1px solid '+(item.selected?G.gold:G.border), borderRadius:2, marginRight:12, background:item.selected?G.btnBg:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {item.selected && <div style={{ width:8, height:8, background:G.gold, borderRadius:1 }} />}
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, color:G.cream, fontWeight:400 }}>{item.color}</div>
                  <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>Size: {item.size}</div>
                </div>
                <div style={{ fontSize:11, color:G.goldDim }}>×{item.qty || 1}</div>
              </div>
            ))}
          </div>
        </DkCard>
        <DkCard>
          <label style={{ display:'flex', alignItems:'center', cursor:'pointer', gap:12 }}>
            <div onClick={() => setIsRemainder(!isRemainder)} style={{ width:16, height:16, border:'1px solid '+(isRemainder?G.gold:G.border), borderRadius:2, background:isRemainder?G.btnBg:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
              {isRemainder && <div style={{ width:8, height:8, background:G.gold, borderRadius:1 }} />}
            </div>
            <div>
              <div style={{ fontSize:12, color:G.cream, fontWeight:400 }}>剩余包装 / 자투리 포장</div>
              <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>末尾零头, 不是{INNER_PACK_SIZE}件标准包装</div>
            </div>
          </label>
        </DkCard>
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => setWorker(e.target.value)} placeholder="姓名 Name" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
        </DkCard>
        <DkBtn onClick={handleSubmit} disabled={submitting} style={{ marginTop:8, padding:18, fontSize:11, letterSpacing:3 }}>
          {submitting ? '保存中...' : `✅ ${selectedCount}件 打包完成 / 포장 완료`}
        </DkBtn>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Pack Success Screen ─────────────────────────────────────────
const PackSuccessScreen = memo(function PackSuccessScreen({ pack, onNextPack, onHome }) {
  if (!pack) return null;
  const handleDownload = async () => {
    const label = `${pack.moNumber} / Inner Pack #${pack.packSequence} / ${pack.totalQty} pcs`;
    const dataURL = await generateQRDataURLWithLabel(pack.qrText, label);
    downloadQRPNG(dataURL, sanitizeFilename(`${pack.moNumber}_InnerPack_${pack.packSequence}_${pack.totalQty}pcs.png`));
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px 20px 20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>PACK CREATED</div>
        <div style={{ fontSize:11, color:G.goldDim, marginTop:4 }}>{pack.moNumber} · Pack #{pack.packSequence}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard style={{ textAlign:'center', padding:20 }}>
          <img src={pack.qrDataURL} alt="QR" style={{ width:'100%', maxWidth:280, margin:'0 auto', display:'block', borderRadius:2 }} />
          <div style={{ fontSize:9, color:G.goldDim, marginTop:12, fontFamily:'monospace', wordBreak:'break-all', letterSpacing:.5 }}>{pack.qrText}</div>
        </DkCard>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>包装内容 / 포장 내용</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6 }}>
            {pack.items.map((item, i) => (
              <div key={i} style={{ border:'1px solid var(--app-border)', padding:'6px 8px', borderRadius:2 }}>
                <div style={{ fontSize:11, color:G.cream, fontWeight:400 }}>{item.color}</div>
                <div style={{ fontSize:10, color:G.goldDim }}>{item.size} · {item.qty}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop:12, paddingTop:10, borderTop:'1px solid var(--app-divider)', fontSize:11, color:G.goldDim, letterSpacing:1 }}>
            Total <span style={{ color:G.gold }}>{pack.totalQty} 件</span>{pack.isRemainder ? ' · 剩余' : ''}
          </div>
        </DkCard>
        <DkBtn onClick={handleDownload}>📥 下载 QR 图片 / QR 다운로드</DkBtn>
        <DkBtn onClick={onNextPack}>➕ 继续下一包 / 다음 포장</DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Pack Detail Screen ──────────────────────────────────────────
const PackDetailScreen = memo(function PackDetailScreen({ detail, onBack, onEditStatus, onDelete, requirePin: reqPin }) {
  const [showPicker, setShowPicker] = useState(false);
  const [updating, setUpdating] = useState(false);
  if (!detail) return null;
  const statusLabel = PACK_STATUS_LABELS[detail.pack_status] || detail.pack_status;
  const handleStatusSelect = async (newStatus) => {
    setUpdating(true);
    try { await onEditStatus(newStatus); setShowPicker(false); }
    catch (e) { alert('更新失败: ' + (e?.message || String(e))); }
    finally { setUpdating(false); }
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>INNER PACK DETAIL</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{detail.mo_number} · Pack #{detail.pack_sequence}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{(detail.factory && typeof detail.factory === 'object') ? (detail.factory.display_value || '') : (detail.factory || '')}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, fontWeight:400 }}>状态 / 상태</div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ border:'1px solid rgba(212,175,55,0.4)', padding:'3px 10px', fontSize:10, color:G.gold, letterSpacing:1 }}>{statusLabel}</div>
              {reqPin && onEditStatus && (
                <button onClick={() => reqPin(() => setShowPicker(true))} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.3)', color:G.goldDim, fontSize:9, letterSpacing:1, padding:'3px 8px', cursor:'pointer', fontFamily:'inherit' }}>✏️</button>
              )}
            </div>
          </div>
          <DkRow label="包装UUID" value={detail.uuid} mono />
          <DkRow label="负责人 / 담당자" value={detail.worker || '-'} />
          <DkRow label="总数量 / 총 수량" value={String(detail.total_qty) + ' 件'} />
          <DkRow label="是否剩余 / 자투리 여부" value={detail.is_remainder ? '是 / 예' : '否 / 아니오'} />
          <DkRow label="所属麻袋 / 마대 소속" value={detail.assigned_to_bag || '-'} />
          <DkRow label="创建时间 / 생성 시간" value={formatDate(detail.created_time) || '-'} />
          <DkRow label="最近修改 / 최근 수정" value={formatDate(detail.modified_time) || '-'} />
        </DkCard>
        {detail.items && detail.items.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>包装内容 / 포장 내용</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6 }}>
              {detail.items.map((item, i) => (
                <div key={i} style={{ border:'1px solid var(--app-border)', padding:'6px 8px', borderRadius:2 }}>
                  <div style={{ fontSize:11, color:G.cream, fontWeight:400 }}>{item.color}</div>
                  <div style={{ fontSize:10, color:G.goldDim }}>{item.size} · {item.qty}</div>
                </div>
              ))}
            </div>
          </DkCard>
        )}
        <DkBtn onClick={async () => {
          const qrUrl = window.location.origin + '/view/inner/' + detail.uuid;
          const label = `${detail.mo_number} / Inner Pack #${detail.pack_sequence} / ${detail.total_qty} pcs`;
          const dataURL = await generateQRDataURLWithLabel(qrUrl, label);
          downloadQRPNG(dataURL, sanitizeFilename(`${detail.mo_number}_InnerPack_${detail.pack_sequence}_${detail.total_qty}pcs.png`));
        }}>📥 下载 QR / QR 다운로드</DkBtn>
        {onDelete && reqPin && (
          <button onClick={() => reqPin(() => onDelete())}
            style={{ width:'100%', padding:14, border:'1px solid rgba(239,68,68,0.35)', borderRadius:2, background:'rgba(239,68,68,0.07)', color:'#EF4444', fontSize:11, fontWeight:400, letterSpacing:2, cursor:'pointer', fontFamily:'inherit', marginBottom:10 }}
          >🗑️ 删除包装 / 포장 삭제</button>
        )}
      </div>
      {showPicker && (
        <div style={{ position:'fixed', top:0, left:0, width:'100%', height:'100%', background:'rgba(0,0,0,0.75)', backdropFilter:'blur(4px)', zIndex:9999, display:'flex', justifyContent:'center', alignItems:'center' }}
          onClick={() => { if (!updating) setShowPicker(false); }}
        >
          <div style={{ background:'#1A1710', border:'1px solid rgba(212,175,55,0.35)', borderRadius:4, width:'88%', maxWidth:360, padding:24 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize:10, letterSpacing:3, color:G.gold, marginBottom:16, fontWeight:400 }}>更新状态 / 상태 변경</div>
            {Object.entries(PACK_STATUS_LABELS).map(([key, lbl]) => (
              <button key={key} onClick={() => { if (!updating) handleStatusSelect(key); }} disabled={updating}
                style={{ display:'block', width:'100%', padding:'11px 14px', marginBottom:6, background: key === detail.pack_status ? G.btnBg : 'transparent', border:'1px solid '+(key === detail.pack_status ? G.borderHover : G.border), color: key === detail.pack_status ? G.gold : G.goldDim, fontSize:11, letterSpacing:1, cursor: updating ? 'wait' : 'pointer', fontFamily:'inherit', textAlign:'left', borderRadius:2 }}
              >{lbl}</button>
            ))}
            <button onClick={() => setShowPicker(false)} style={{ display:'block', width:'100%', padding:10, marginTop:6, background:'transparent', border:'none', color:G.goldDim, fontSize:10, cursor:'pointer', fontFamily:'inherit' }}>取消 / 취소</button>
          </div>
        </div>
      )}
    </DkScreen>
  );
});

// ─── NEW: Bag Create Screen ───────────────────────────────────────────
const BagCreateScreen = memo(function BagCreateScreen({
  bagMO, scannedPacks, isRemainder, setIsRemainder, worker, setWorker,
  onScanNext, onRemovePack, onSubmit, onBack, submitting,
  availablePacks, availablePacksLoading, onSelectPack, onSelectFirst10, onClearAll
}) {
  const count = scannedPacks.length;
  const totalQty = scannedPacks.reduce((s, p) => s + (parseInt(p.total_qty) || 12), 0);
  const selectedUUIDs = useMemo(() => new Set(scannedPacks.map(p => p.uuid)), [scannedPacks]);
  const maxReached = count >= MASTER_BAG_SIZE;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>MASTER BAG</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{bagMO ? bagMO.mo_number : '—'} · {count} / {MASTER_BAG_SIZE} 包装</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{totalQty} 件 · Total pieces</div>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:12 }}>
          <div style={{ flex:1, height:2, background:G.progressTrack, borderRadius:1 }}>
            <div style={{ height:'100%', background:G.gold, width:Math.min(100, count / MASTER_BAG_SIZE * 100) + '%', borderRadius:1, transition:'width .2s' }} />
          </div>
          <div style={{ fontSize:10, color:G.goldDim }}>{count}/{MASTER_BAG_SIZE}</div>
        </div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>选择中包袋 / 중간포장 선택</div>
          {availablePacksLoading ? (
            <div style={{ display:'flex', justifyContent:'center', padding:'20px 0' }}><div className="spinner" style={{ width:24, height:24 }} /></div>
          ) : !availablePacks || availablePacks.length === 0 ? (
            <div style={{ textAlign:'center', color:G.goldDim, fontSize:11, padding:'16px 0', letterSpacing:1 }}>所有包装已分配 / 모든 포장이 마대에 할당됨</div>
          ) : (
            <>
              <div style={{ display:'flex', gap:8, marginBottom:12 }}>
                <button onClick={() => onSelectFirst10(availablePacks)} style={{ flex:1, padding:'8px 0', background:G.btnBg, border:'1px solid '+G.borderHover, color:G.gold, fontSize:10, letterSpacing:1, cursor:'pointer', fontFamily:'inherit', borderRadius:2 }}>⚡ 前{MASTER_BAG_SIZE}个 / 처음 {MASTER_BAG_SIZE}개</button>
                <button onClick={onClearAll} style={{ flex:1, padding:'8px 0', background:'transparent', border:'1px solid '+G.border, color:G.goldDim, fontSize:10, letterSpacing:1, cursor:'pointer', fontFamily:'inherit', borderRadius:2 }}>✕ 清除 / 전체 해제</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:5, maxHeight:260, overflowY:'auto' }}>
                {availablePacks.map(p => {
                  const uuid = p['Pack_UUID'];
                  const seq = p['Pack_Sequence'];
                  const isSelected = selectedUUIDs.has(uuid);
                  const isDisabled = maxReached && !isSelected;
                  return (
                    <button key={uuid} onClick={() => !isDisabled && onSelectPack(p)}
                      style={{ padding:'9px 2px', background:isSelected ? G.btnBg : 'transparent', border:'1px solid '+(isSelected ? G.borderHover : isDisabled ? 'rgba(212,175,55,0.15)' : G.border), color:isSelected ? G.gold : isDisabled ? 'rgba(212,175,55,0.25)' : G.goldDim, fontSize:10, letterSpacing:.5, cursor:isDisabled?'default':'pointer', fontFamily:'inherit', borderRadius:2, textAlign:'center', fontWeight:isSelected?700:400 }}
                    >#{seq}</button>
                  );
                })}
              </div>
              <div style={{ marginTop:10, fontSize:10, color:G.goldDim, display:'flex', justifyContent:'space-between' }}>
                <span>可用 / 사용 가능: <span style={{ color:G.gold, fontWeight:700 }}>{availablePacks.length}</span></span>
                <span>已选 / 선택: <span style={{ color:G.gold, fontWeight:700 }}>{count}</span> / {MASTER_BAG_SIZE}</span>
              </div>
            </>
          )}
        </DkCard>
        <DkBtn onClick={onScanNext} style={{ marginTop:4 }}>📷 扫描包装 QR / 포장 QR 스캔 ({count} 已扫描)</DkBtn>
        <DkCard>
          <div style={{ display:'flex', alignItems:'center', gap:12, cursor:'pointer' }} onClick={() => setIsRemainder(!isRemainder)}>
            <div style={{ width:16, height:16, border:'1px solid '+(isRemainder?G.gold:G.border), borderRadius:2, background:isRemainder?G.btnBg:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
              {isRemainder && <div style={{ width:8, height:8, background:G.gold, borderRadius:1 }} />}
            </div>
            <div>
              <div style={{ fontSize:12, color:G.cream, fontWeight:400 }}>剩余麻袋 / 자투리 마대</div>
              <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>不足 {MASTER_BAG_SIZE} 个包装</div>
            </div>
          </div>
        </DkCard>
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => setWorker(e.target.value)} placeholder="姓名 Name" onKeyDown={e => { if (e.key === 'Enter' && !submitting && count > 0) onSubmit(); }} />
        </DkCard>
        <DkBtn onClick={onSubmit} disabled={submitting || count === 0} style={{ padding:18, fontSize:11, letterSpacing:3 }}>
          {submitting ? '保存中...' : `✅ ${count}包装 装袋完成 / 마대 완료`}
        </DkBtn>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Bag Success Screen ──────────────────────────────────────────
const BagSuccessScreen = memo(function BagSuccessScreen({ bag, onNewBag, onHome }) {
  if (!bag) return null;
  const handleDownload = async () => {
    const label = `${bag.moNumber} / Master Bag #${bag.bagSequence} / ${bag.totalQty} pcs`;
    const dataURL = await generateQRDataURLWithLabel(bag.qrText, label);
    downloadQRPNG(dataURL, sanitizeFilename(`${bag.moNumber}_MasterBag_${bag.bagSequence}_${bag.totalQty}pcs.png`));
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>BAG CREATED</div>
        <div style={{ fontSize:11, color:G.goldDim, marginTop:4 }}>{bag.moNumber} · Bag #{bag.bagSequence}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard style={{ textAlign:'center', padding:20 }}>
          <img src={bag.qrDataURL} alt="QR" style={{ width:'100%', maxWidth:280, margin:'0 auto', display:'block', borderRadius:2 }} />
          <div style={{ fontSize:9, color:G.goldDim, marginTop:12, fontFamily:'monospace', wordBreak:'break-all' }}>{bag.qrText}</div>
        </DkCard>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>麻袋内容 / 마대 내용</div>
          <div style={{ fontSize:12, color:G.cream, marginBottom:8 }}>{bag.packCount} packs · {bag.totalQty} 件{bag.isRemainder ? ' · 剩余' : ''}</div>
          {bag.packs && bag.packs.map((p, i) => (
            <div key={p.uuid} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:11, color:G.goldDim, borderTop: i === 0 ? '1px solid var(--app-divider)' : 'none', marginTop: i === 0 ? 6 : 0 }}>
              <span>Pack {i + 1} · {p.mo_number}</span>
              <span>{p.total_qty} 件</span>
            </div>
          ))}
        </DkCard>
        <DkBtn onClick={handleDownload}>📥 下载 QR 图片 / QR 다운로드</DkBtn>
        <DkBtn onClick={onNewBag}>➕ 生成新麻袋 / 새 마대</DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Bag Detail Screen ───────────────────────────────────────────
const BagDetailScreen = memo(function BagDetailScreen({ detail, onBack, onEditStatus, onDelete, requirePin: reqPin }) {
  const [showPicker, setShowPicker] = useState(false);
  const [updating, setUpdating] = useState(false);
  if (!detail) return null;
  const statusLabel = BAG_STATUS_LABELS[detail.bag_status] || detail.bag_status;
  const handleStatusSelect = async (newStatus) => {
    setUpdating(true);
    try { await onEditStatus(newStatus); setShowPicker(false); }
    catch (e) { alert('更新失败: ' + (e?.message || String(e))); }
    finally { setUpdating(false); }
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>MASTER BAG DETAIL</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{detail.mo_number} · Bag #{detail.bag_sequence}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, fontWeight:400 }}>状态 / 상태</div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ border:'1px solid rgba(212,175,55,0.4)', padding:'3px 10px', fontSize:10, color:G.gold, letterSpacing:1 }}>{statusLabel}</div>
              {reqPin && onEditStatus && (
                <button onClick={() => reqPin(() => setShowPicker(true))} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.3)', color:G.goldDim, fontSize:9, letterSpacing:1, padding:'3px 8px', cursor:'pointer', fontFamily:'inherit' }}>✏️</button>
              )}
            </div>
          </div>
          <DkRow label="麻袋UUID" value={detail.uuid} mono />
          <DkRow label="内包数量 / 포장 수" value={String(detail.inner_pack_count) + ' packs'} />
          <DkRow label="总数量 / 총 수량" value={String(detail.total_qty) + ' 件'} />
          <DkRow label="是否剩余 / 자투리 여부" value={detail.is_remainder ? '是 / 예' : '否 / 아니오'} />
          <DkRow label="负责人 / 담당자" value={detail.worker || '-'} />
          <DkRow label="目的地 / 출고지" value={detail.destination === 'MEX-Guadalajara' ? '墨西哥-과달라하라 / MEX-Guadalajara' : (detail.destination || '-')} />
          <DkRow label="到达MEX / 멕시코 도착" value={detail.received_at_mex || '-'} />
          <DkRow label="创建时间 / 생성 시간" value={formatDate(detail.created_time) || '-'} />
          <DkRow label="最近修改 / 최근 수정" value={formatDate(detail.modified_time) || '-'} />
        </DkCard>
        {detail.inner_pack_uuids && detail.inner_pack_uuids.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>包装列表 / 포장 목록</div>
            {detail.inner_pack_uuids.map((uuid, i) => (
              <div key={uuid} style={{ padding:'6px 0', borderBottom:'1px solid var(--app-divider)', fontSize:10, color:G.goldDim, fontFamily:'monospace' }}>
                {i + 1}. {uuid}
              </div>
            ))}
          </DkCard>
        )}
        <DkBtn onClick={async () => {
          const qrUrl = window.location.origin + '/view/bag/' + detail.uuid;
          const label = `${detail.mo_number} / Master Bag #${detail.bag_sequence} / ${detail.total_qty} pcs`;
          const dataURL = await generateQRDataURLWithLabel(qrUrl, label);
          downloadQRPNG(dataURL, sanitizeFilename(`${detail.mo_number}_MasterBag_${detail.bag_sequence}_${detail.total_qty}pcs.png`));
        }}>📥 下载 QR / QR 다운로드</DkBtn>
        {onDelete && reqPin && (
          <button onClick={() => reqPin(() => onDelete())}
            style={{ width:'100%', padding:14, border:'1px solid rgba(239,68,68,0.35)', borderRadius:2, background:'rgba(239,68,68,0.07)', color:'#EF4444', fontSize:11, fontWeight:400, letterSpacing:2, cursor:'pointer', fontFamily:'inherit', marginBottom:10 }}
          >🗑️ 删除麻袋 / 마대 삭제</button>
        )}
      </div>
      {showPicker && (
        <div style={{ position:'fixed', top:0, left:0, width:'100%', height:'100%', background:'rgba(0,0,0,0.75)', backdropFilter:'blur(4px)', zIndex:9999, display:'flex', justifyContent:'center', alignItems:'center' }}
          onClick={() => { if (!updating) setShowPicker(false); }}
        >
          <div style={{ background:'#1A1710', border:'1px solid rgba(212,175,55,0.35)', borderRadius:4, width:'88%', maxWidth:360, padding:24 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize:10, letterSpacing:3, color:G.gold, marginBottom:16, fontWeight:400 }}>更新状态 / 상태 변경</div>
            {Object.entries(BAG_STATUS_LABELS).map(([key, lbl]) => (
              <button key={key} onClick={() => { if (!updating) handleStatusSelect(key); }} disabled={updating}
                style={{ display:'block', width:'100%', padding:'11px 14px', marginBottom:6, background: key === detail.bag_status ? G.btnBg : 'transparent', border:'1px solid '+(key === detail.bag_status ? G.borderHover : G.border), color: key === detail.bag_status ? G.gold : G.goldDim, fontSize:11, letterSpacing:1, cursor: updating ? 'wait' : 'pointer', fontFamily:'inherit', textAlign:'left', borderRadius:2 }}
              >{lbl}</button>
            ))}
            <button onClick={() => setShowPicker(false)} style={{ display:'block', width:'100%', padding:10, marginTop:6, background:'transparent', border:'none', color:G.goldDim, fontSize:10, cursor:'pointer', fontFamily:'inherit' }}>取消 / 취소</button>
          </div>
        </div>
      )}
    </DkScreen>
  );
});

// ─── Pack List Screen ─────────────────────────────────────────────────
const PackListScreen = memo(function PackListScreen({ onBack, onSelectPack }) {
  const [mo, setMo] = useState('');
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    const moNum = mo.trim().toUpperCase();
    if (!moNum) { alert('请输入订单号'); return; }
    setLoading(true);
    setSearched(true);
    try {
      const res = await getRecords(REPORTS.INNER_PACK);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const filtered = list
        .filter(r => {
          let m = r['MO_Number'];
          if (typeof m === 'object') m = m.display_value || '';
          return String(m).toUpperCase() === moNum;
        })
        .map(r => {
          let moN = r['MO_Number'];
          if (typeof moN === 'object') moN = moN.display_value || '';
          const w = r['Worker'];
          return {
            uuid: r['Pack_UUID'],
            mo_number: moN,
            pack_sequence: parseInt(r['Pack_Sequence']) || 0,
            total_qty: r['Total_Qty'],
            pack_status: r['Pack_Status'] || 'Created',
            worker: typeof w === 'object' ? (w.display_value || '') : (w || ''),
            created_time: r['Added_Time'] || r['Created_Time'] || '',
          };
        })
        .sort((a, b) => parseDateRaw(b.created_time) - parseDateRaw(a.created_time));
      setPacks(filtered);
    } catch (e) {
      alert('查询失败: ' + (e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>PACK QUERY</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>查询包装 / 포장 조회</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <DkInput label="订单号 / MO 번호" value={mo} onChange={e => setMo(e.target.value)} placeholder="例: GJ26-1" onKeyDown={e => { if (e.key === 'Enter' && !loading) search(); }} />
          <DkBtn onClick={search} disabled={loading} style={{ marginTop:8, marginBottom:0 }}>{loading ? '查询中...' : '🔍 查询 / 조회'}</DkBtn>
        </DkCard>
        {searched && !loading && packs.length === 0 && (
          <div style={{ textAlign:'center', color:G.goldDim, padding:24, fontSize:11, letterSpacing:1 }}>此订单没有包装记录</div>
        )}
        {packs.map(p => (
          <DkCard key={p.uuid} style={{ marginBottom:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div onClick={() => onSelectPack(p.uuid)} style={{ flex:1, cursor:'pointer' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                  <div style={{ fontSize:9, letterSpacing:2, color:G.gold, border:'1px solid rgba(212,175,55,0.4)', padding:'1px 6px' }}>Pack #{p.pack_sequence}</div>
                  <div style={{ fontSize:9, color:G.goldDim, letterSpacing:1 }}>{PACK_STATUS_LABELS[p.pack_status] || p.pack_status}</div>
                </div>
                <div style={{ fontSize:11, color:G.cream, marginBottom:2 }}>{p.mo_number} · {p.total_qty} 件</div>
                <div style={{ fontSize:9, color:G.goldDim }}>{p.worker || '-'} · {formatDate(p.created_time)}</div>
              </div>
              <button onClick={async e => {
                e.stopPropagation();
                const qrUrl = window.location.origin + '/view/inner/' + p.uuid;
                const label = `${p.mo_number} / Inner Pack #${p.pack_sequence} / ${p.total_qty} pcs`;
                const dataURL = await generateQRDataURLWithLabel(qrUrl, label);
                downloadQRPNG(dataURL, sanitizeFilename(`${p.mo_number}_InnerPack_${p.pack_sequence}_${p.total_qty}pcs.png`));
              }} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.3)', color:G.goldDim, fontSize:10, padding:'6px 10px', cursor:'pointer', fontFamily:'inherit', flexShrink:0, marginLeft:8 }}>📥</button>
            </div>
          </DkCard>
        ))}
      </div>
    </DkScreen>
  );
});

// ─── Bag List Screen ──────────────────────────────────────────────────
const BagListScreen = memo(function BagListScreen({ onBack, onSelectBag }) {
  const [mo, setMo] = useState('');
  const [bags, setBags] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    const moNum = mo.trim().toUpperCase();
    if (!moNum) { alert('请输入订单号'); return; }
    setLoading(true);
    setSearched(true);
    try {
      const res = await getRecords(REPORTS.MASTER_BAG);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const filtered = list
        .filter(r => {
          let m = r['MO_Number'];
          if (typeof m === 'object') m = m.display_value || '';
          return String(m).toUpperCase() === moNum;
        })
        .map(r => {
          let moN = r['MO_Number'];
          if (typeof moN === 'object') moN = moN.display_value || '';
          const w = r['Worker'];
          return {
            uuid: r['Bag_UUID'],
            mo_number: moN,
            bag_sequence: parseInt(r['Bag_Sequence']) || 0,
            inner_pack_count: r['Inner_Pack_Count'],
            total_qty: r['Total_Qty'],
            bag_status: r['Bag_Status'] || 'Created',
            worker: typeof w === 'object' ? (w.display_value || '') : (w || ''),
            destination: r['Destination'] || '',
            created_time: r['Added_Time'] || r['Created_Time'] || '',
          };
        })
        .sort((a, b) => parseDateRaw(b.created_time) - parseDateRaw(a.created_time));
      setBags(filtered);
    } catch (e) {
      alert('查询失败: ' + (e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>BAG QUERY</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>查询麻袋 / 마대 조회</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <DkInput label="订单号 / MO 번호" value={mo} onChange={e => setMo(e.target.value)} placeholder="例: GJ26-1" onKeyDown={e => { if (e.key === 'Enter' && !loading) search(); }} />
          <DkBtn onClick={search} disabled={loading} style={{ marginTop:8, marginBottom:0 }}>{loading ? '查询中...' : '🔍 查询 / 조회'}</DkBtn>
        </DkCard>
        {searched && !loading && bags.length === 0 && (
          <div style={{ textAlign:'center', color:G.goldDim, padding:24, fontSize:11, letterSpacing:1 }}>此订单没有麻袋记录</div>
        )}
        {bags.map(b => (
          <DkCard key={b.uuid} style={{ marginBottom:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div onClick={() => onSelectBag(b.uuid)} style={{ flex:1, cursor:'pointer' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                  <div style={{ fontSize:9, letterSpacing:2, color:G.gold, border:'1px solid rgba(212,175,55,0.4)', padding:'1px 6px' }}>Bag #{b.bag_sequence}</div>
                  <div style={{ fontSize:9, color:G.goldDim, letterSpacing:1 }}>{BAG_STATUS_LABELS[b.bag_status] || b.bag_status}</div>
                </div>
                <div style={{ fontSize:11, color:G.cream, marginBottom:2 }}>{b.mo_number} · {b.inner_pack_count} packs · {b.total_qty} 件</div>
                <div style={{ fontSize:9, color:G.goldDim }}>{b.worker || '-'}{b.destination ? ' → ' + b.destination : ''} · {formatDate(b.created_time)}</div>
              </div>
              <button onClick={async e => {
                e.stopPropagation();
                const qrUrl = window.location.origin + '/view/bag/' + b.uuid;
                const label = `${b.mo_number} / Master Bag #${b.bag_sequence} / ${b.total_qty} pcs`;
                const dataURL = await generateQRDataURLWithLabel(qrUrl, label);
                downloadQRPNG(dataURL, sanitizeFilename(`${b.mo_number}_MasterBag_${b.bag_sequence}_${b.total_qty}pcs.png`));
              }} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.3)', color:G.goldDim, fontSize:10, padding:'6px 10px', cursor:'pointer', fontFamily:'inherit', flexShrink:0, marginLeft:8 }}>📥</button>
            </div>
          </DkCard>
        ))}
      </div>
    </DkScreen>
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
        const res = await getRecordsByCriteria(REPORTS.INNER_PACK, `Pack_UUID == "${uuid}"`);
        if (cancelled) return;
        const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
        const found = list[0] || null;
        if (!found) { setNotFound(true); return; }
        let items = [];
        try { items = JSON.parse(found['Items_JSON'] || '[]'); } catch (e) {}
        let moNum = found['MO_Number'];
        if (typeof moNum === 'object') moNum = moNum.display_value || '';
        setRecord({
          uuid: found['Pack_UUID'],
          mo_number: moNum,
          sku: getField(found, 'Style_SKU') || getField(found, 'SKU'),
          factory: getField(found, 'Factory'),
          pack_sequence: found['Pack_Sequence'],
          total_qty: found['Total_Qty'],
          items,
          worker: getField(found, 'Worker'),
          created_time: getField(found, 'Added_Time') || getField(found, 'Created_Time'),
          modified_time: getField(found, 'Modified_Time'),
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
    <DkScreen style={{ display:'flex', justifyContent:'center', alignItems:'center' }}>
      <div className="spinner"></div>
    </DkScreen>
  );

  if (notFound) return (
    <DkScreen style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ fontSize:11, letterSpacing:3, color:G.goldDim, marginBottom:16 }}>记录未找到</div>
      <div style={{ fontSize:13, color:G.cream, marginBottom:8 }}>기록을 찾을 수 없습니다</div>
      <div style={{ fontSize:10, color:G.goldDim, marginBottom:24, fontFamily:'monospace', wordBreak:'break-all', textAlign:'center' }}>{uuid}</div>
      <DkBtn onClick={onHome} style={{ width:'auto', padding:'12px 32px' }}>🏠 返回首页 / 홈으로</DkBtn>
    </DkScreen>
  );

  const statusLabel = PACK_STATUS_LABELS[record.pack_status] || record.pack_status;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px 20px 18px' }}>
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>中间包装详情 / 중간포장 상세</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{record.mo_number} · Pack #{record.pack_sequence}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{record.factory}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, fontWeight:400 }}>状态 / 상태</div>
            <div style={{ border:'1px solid rgba(212,175,55,0.4)', padding:'3px 10px', fontSize:10, color:G.gold, letterSpacing:1 }}>{statusLabel}</div>
          </div>
          {record.is_remainder && (
            <div style={{ display:'inline-block', border:'1px solid rgba(212,175,55,0.4)', padding:'2px 10px', fontSize:10, color:G.goldDim, marginBottom:10, letterSpacing:1 }}>残余 / 자투리</div>
          )}
          <DkRow label="订单号 / MO 번호" value={record.mo_number} />
          <DkRow label="SKU" value={record.sku || '-'} />
          <DkRow label="工厂 / 공장" value={record.factory || '-'} />
          <DkRow label="中包袋编号 / 포장 순번" value={String(record.pack_sequence)} />
          <DkRow label="总件数 / 총 수량" value={String(record.total_qty) + ' 件'} />
          <DkRow label="负责人 / 담당자" value={record.worker || '-'} />
          <DkRow label="创建时间 / 생성 시간" value={formatDate(record.created_time) || '-'} />
          <DkRow label="最近修改 / 최근 수정" value={formatDate(record.modified_time) || '-'} />
        </DkCard>
        {record.items && record.items.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>包装内容 / 포장 내용</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:4, fontSize:9, color:G.goldDim, letterSpacing:1, marginBottom:8 }}>
              <span>颜色 / Color</span><span style={{ textAlign:'center' }}>尺码 / Size</span><span style={{ textAlign:'right' }}>数量 / Qty</span>
            </div>
            {record.items.map((item, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', padding:'5px 0', borderBottom:'1px solid var(--app-divider)', fontSize:12 }}>
                <span style={{ color:G.cream }}>{item.color}</span>
                <span style={{ textAlign:'center', color:G.cream }}>{item.size}</span>
                <span style={{ textAlign:'right', color:G.gold }}>{item.qty}</span>
              </div>
            ))}
          </DkCard>
        )}
        <DkBtnOutline onClick={onHome}>🏠 返回首页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
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
        const bagRes = await getRecordsByCriteria(REPORTS.MASTER_BAG, `Bag_UUID == "${uuid}"`);
        const bagList = (bagRes && bagRes.code === 3000 && Array.isArray(bagRes.data)) ? bagRes.data : [];
        const foundBag = bagList[0] || null;
        if (!foundBag) { if (!cancelled) setNotFound(true); return; }

        let packUUIDs = [];
        try { packUUIDs = JSON.parse(foundBag['Inner_Pack_UUIDs'] || '[]'); } catch (e) {}
        let moNum = foundBag['MO_Number'];
        if (typeof moNum === 'object') moNum = moNum.display_value || '';

        const bagData = {
          uuid: foundBag['Bag_UUID'],
          mo_number: moNum,
          factory: getField(foundBag, 'Factory'),
          destination: getField(foundBag, 'Destination'),
          bag_sequence: foundBag['Bag_Sequence'],
          inner_pack_count: foundBag['Inner_Pack_Count'],
          inner_pack_uuids: packUUIDs,
          total_qty: foundBag['Total_Qty'],
          is_remainder: foundBag['Is_Remainder'] === 'true' || foundBag['Is_Remainder'] === true,
          worker: getField(foundBag, 'Worker'),
          created_time: getField(foundBag, 'Added_Time') || getField(foundBag, 'Created_Time'),
          modified_time: getField(foundBag, 'Modified_Time'),
          bag_status: foundBag['Bag_Status'] || 'Created',
          received_at_mex: getField(foundBag, 'Received_At_MEX'),
        };

        let packs = [];
        if (packUUIDs.length > 0) {
          const packRes = await getRecordsByCriteria(REPORTS.INNER_PACK, `MO_Number == "${moNum}"`);
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
    <DkScreen style={{ display:'flex', justifyContent:'center', alignItems:'center' }}>
      <div className="spinner"></div>
    </DkScreen>
  );

  if (notFound) return (
    <DkScreen style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ fontSize:11, letterSpacing:3, color:G.goldDim, marginBottom:16 }}>记录未找到</div>
      <div style={{ fontSize:13, color:G.cream, marginBottom:8 }}>기록을 찾을 수 없습니다</div>
      <div style={{ fontSize:10, color:G.goldDim, marginBottom:24, fontFamily:'monospace', wordBreak:'break-all', textAlign:'center' }}>{uuid}</div>
      <DkBtn onClick={onHome} style={{ width:'auto', padding:'12px 32px' }}>🏠 返回首页 / 홈으로</DkBtn>
    </DkScreen>
  );

  const statusLabel = BAG_STATUS_LABELS[bagRecord.bag_status] || bagRecord.bag_status;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px 20px 18px' }}>
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>麻袋详情 / 마대 상세</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{bagRecord.mo_number} · Bag #{bagRecord.bag_sequence}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{bagRecord.factory}{bagRecord.destination ? ' → ' + (bagRecord.destination === 'MEX-Guadalajara' ? '墨西哥-과달라하라 / MEX-Guadalajara' : bagRecord.destination) : ''}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, fontWeight:400 }}>状态 / 상태</div>
            <div style={{ border:'1px solid rgba(212,175,55,0.4)', padding:'3px 10px', fontSize:10, color:G.gold, letterSpacing:1 }}>{statusLabel}</div>
          </div>
          {bagRecord.is_remainder && (
            <div style={{ display:'inline-block', border:'1px solid rgba(212,175,55,0.4)', padding:'2px 10px', fontSize:10, color:G.goldDim, marginBottom:10, letterSpacing:1 }}>残余 / 자투리</div>
          )}
          <DkRow label="订单号 / MO 번호" value={bagRecord.mo_number} />
          <DkRow label="工厂 / 공장" value={bagRecord.factory || '-'} />
          <DkRow label="目的地 / 목적지" value={bagRecord.destination === 'MEX-Guadalajara' ? '墨西哥-과달라하라 / MEX-Guadalajara' : (bagRecord.destination || '-')} />
          <DkRow label="麻袋编号 / 마대 순번" value={String(bagRecord.bag_sequence)} />
          <DkRow label="内装包数 / 포장 수" value={String(bagRecord.inner_pack_count) + ' packs'} />
          <DkRow label="总件数 / 총 수량" value={String(bagRecord.total_qty) + ' 件'} />
          <DkRow label="负责人 / 담당자" value={bagRecord.worker || '-'} />
          <DkRow label="创建时间 / 생성 시간" value={formatDate(bagRecord.created_time) || '-'} />
          <DkRow label="最近修改 / 최근 수정" value={formatDate(bagRecord.modified_time) || '-'} />
          {bagRecord.received_at_mex && <DkRow label="到达MEX / 멕시코 도착" value={formatDate(bagRecord.received_at_mex)} />}
        </DkCard>

        {innerPacks.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>包装列表 / 포장 목록</div>
            {innerPacks.map((p, i) => (
              <div key={p.uuid} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid var(--app-divider)', fontSize:11 }}>
                <span style={{ color:G.goldDim }}>Pack {p.pack_sequence || (i + 1)} · {p.uuid.substring(0, 8)}...</span>
                <span style={{ color:G.gold }}>{p.total_qty} 件</span>
              </div>
            ))}
          </DkCard>
        )}

        {colorSizeSummary.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>颜色/尺码汇总 / 색상·사이즈 합계</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:4, fontSize:9, color:G.goldDim, letterSpacing:1, marginBottom:8 }}>
              <span>颜色 / Color</span><span style={{ textAlign:'center' }}>尺码 / Size</span><span style={{ textAlign:'right' }}>합계</span>
            </div>
            {colorSizeSummary.map((row, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', padding:'5px 0', borderBottom:'1px solid var(--app-divider)', fontSize:12 }}>
                <span style={{ color:G.cream }}>{row.color}</span>
                <span style={{ textAlign:'center', color:G.cream }}>{row.size}</span>
                <span style={{ textAlign:'right', color:G.gold }}>{row.qty}</span>
              </div>
            ))}
          </DkCard>
        )}

        <DkBtnOutline onClick={onHome}>🏠 返回首页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
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
          placeholder="8位PIN / 8자리 PIN"
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

// ─── Batch Pack Screens ───────────────────────────────────────────────
const BatchPackInputScreen = memo(function BatchPackInputScreen({ packMO, defaultStartSeq, onSubmit, onBack }) {
  const [startSeq, setStartSeq] = useState(String(defaultStartSeq || 1));
  const [endSeq, setEndSeq] = useState(String(defaultStartSeq || 1));
  const [worker, setWorker] = useState('');
  const count = Math.max(0, (parseInt(endSeq) || 0) - (parseInt(startSeq) || 0) + 1);
  const handleSubmit = () => {
    const s = parseInt(startSeq), e = parseInt(endSeq);
    if (!s || !e || s > e || s < 1) { alert('请输入有效的序号范围'); return; }
    if (!worker.trim()) { alert('请输入负责人 / 담당자'); return; }
    onSubmit({ startSeq: s, endSeq: e, worker: worker.trim() });
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>BATCH CREATE · INNER PACK</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{packMO ? packMO.mo_number : '—'}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{packMO ? packMO.sku : ''}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:14, fontWeight:400 }}>序号范围 / 시퀀스 범위</div>
          <DkInput label="开始序号 / 시작 번호" value={startSeq} onChange={e => setStartSeq(e.target.value)} type="number" inputMode="numeric" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
          <DkInput label="结束序号 / 종료 번호" value={endSeq} onChange={e => setEndSeq(e.target.value)} type="number" inputMode="numeric" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
          <div style={{ fontSize:12, color:G.gold, marginTop:4, fontWeight:400 }}>共 {count} 包 / 총 {count} 포장</div>
        </DkCard>
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => setWorker(e.target.value)} placeholder="姓名 Name" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
        </DkCard>
        {packMO && packMO.standard_assortment && packMO.standard_assortment.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>每包内容 / 포장 구성</div>
            {packMO.standard_assortment.map((it, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:11, color:G.goldDim, borderBottom:'1px solid var(--app-divider)' }}>
                <span style={{ color:G.cream }}>{it.color} · {it.size}</span>
                <span style={{ color:G.gold }}>{it.qty} 件</span>
              </div>
            ))}
          </DkCard>
        )}
        <DkBtn onClick={handleSubmit} disabled={count <= 0 || !worker.trim()}>
          ▶ 开始批量生成 / 일괄 생성 시작 ({count})
        </DkBtn>
      </div>
    </DkScreen>
  );
});

const BatchPackProgressScreen = memo(function BatchPackProgressScreen({ progress }) {
  const pct = progress.total > 0 ? Math.round(progress.current / progress.total * 100) : 0;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>BATCH CREATING...</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:8, fontWeight:400 }}>{progress.current} / {progress.total}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ height:4, background:G.progressTrack, borderRadius:2, marginBottom:14 }}>
            <div style={{ height:'100%', background:G.gold, width:pct+'%', borderRadius:2, transition:'width .3s' }} />
          </div>
          <div style={{ fontSize:11, color:G.goldDim, textAlign:'center' }}>{pct}% · {progress.errors.length > 0 ? progress.errors.length + ' 错误' : '进行中...'}</div>
        </DkCard>
        {progress.items.slice(-5).map(it => (
          <div key={it.seq} style={{ padding:'6px 12px', marginBottom:4, border:'1px solid var(--app-divider)', fontSize:10, color:G.goldDim, display:'flex', justifyContent:'space-between' }}>
            <span>Pack #{it.seq}</span>
            <span style={{ color:G.gold }}>✓</span>
          </div>
        ))}
      </div>
    </DkScreen>
  );
});

const BatchPackDoneScreen = memo(function BatchPackDoneScreen({ result, onHome, onNextPack, onRetryFailed }) {
  const [downloading, setDownloading] = useState(false);
  const savedItems = result.items.filter(it => it.savedToZoho !== false);
  const handleZIP = async () => {
    if (downloading || savedItems.length === 0) return;
    setDownloading(true);
    try {
      const qrItems = savedItems.map(it => ({
        text: it.qrText,
        filename: sanitizeFilename(`${result.moNumber}_InnerPack_${it.seq}_${it.totalQty}pcs.png`)
      }));
      await downloadQRsAsZIP(qrItems, sanitizeFilename(`${result.moNumber}_InnerPacks_Batch.zip`));
    } finally { setDownloading(false); }
  };
  const handlePDF = async () => {
    if (downloading || savedItems.length === 0) return;
    setDownloading(true);
    try {
      const qrItems = savedItems.map(it => ({
        text: it.qrText,
        filename: sanitizeFilename(`${result.moNumber}_InnerPack_${it.seq}_${it.totalQty}pcs.png`)
      }));
      await downloadQRsAsPDF(qrItems, sanitizeFilename(`${result.moNumber}_InnerPacks_Batch.pdf`));
    } finally { setDownloading(false); }
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>BATCH COMPLETE</div>
        <div style={{ fontSize:11, color:G.goldDim, marginTop:4 }}>{result.moNumber}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <DkRow label="已创建 / 생성 완료" value={String(savedItems.length) + ' 包装'} />
          <DkRow label="失败 / 실패" value={String(result.errors.length) + ' 个'} />
          <DkRow label="负责人 / 담당자" value={result.worker} />
        </DkCard>
        {result.errors.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:'#EF4444', marginBottom:10 }}>失败记录 / 실패 목록</div>
            {result.errors.map((e, i) => (
              <div key={i} style={{ fontSize:10, color:'#EF4444', padding:'3px 0' }}>Pack #{e.seq}: {e.error}</div>
            ))}
          </DkCard>
        )}
        <DkBtn onClick={handleZIP} disabled={downloading || savedItems.length === 0}>
          {downloading ? '生成中...' : '📦 ZIP 下载 QR / ZIP 다운로드'}
        </DkBtn>
        <DkBtn onClick={handlePDF} disabled={downloading || savedItems.length === 0}>
          {downloading ? '生成中...' : '📄 PDF 下载 QR / PDF 다운로드'}
        </DkBtn>
        {result.errors.length > 0 && onRetryFailed && (
          <DkBtn onClick={onRetryFailed}>🔄 重试失败 / 실패 재시도 ({result.errors.length})</DkBtn>
        )}
        <DkBtnOutline onClick={onNextPack}>➕ 继续创建包装 / 포장 계속 생성</DkBtnOutline>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── Batch Bag Screens ────────────────────────────────────────────────
const BatchBagInputScreen = memo(function BatchBagInputScreen({ bagMO, onSubmit, onBack }) {
  const [startSeq, setStartSeq] = useState('1');
  const [endSeq, setEndSeq] = useState('10');
  const [worker, setWorker] = useState('');
  const packCount = Math.max(0, (parseInt(endSeq) || 0) - (parseInt(startSeq) || 0) + 1);
  const bagCount = Math.ceil(packCount / MASTER_BAG_SIZE);
  const handleSubmit = () => {
    const s = parseInt(startSeq), e = parseInt(endSeq);
    if (!s || !e || s > e || s < 1) { alert('请输入有效的包装序号范围'); return; }
    if (!worker.trim()) { alert('请输入负责人 / 담당자'); return; }
    onSubmit({ startPackSeq: s, endPackSeq: e, worker: worker.trim() });
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>BATCH CREATE · MASTER BAG</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{bagMO ? bagMO.mo_number : '—'}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:14, fontWeight:400 }}>包装序号范围 / 포장 범위</div>
          <DkInput label="开始包装序号 / 시작 포장 번호" value={startSeq} onChange={e => setStartSeq(e.target.value)} type="number" inputMode="numeric" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
          <DkInput label="结束包装序号 / 종료 포장 번호" value={endSeq} onChange={e => setEndSeq(e.target.value)} type="number" inputMode="numeric" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
          <div style={{ fontSize:12, color:G.gold, marginTop:4, fontWeight:400 }}>
            {packCount} 包装 → {bagCount} 麻袋 / {bagCount} 마대
            {packCount % MASTER_BAG_SIZE !== 0 && packCount > 0 && (
              <span style={{ color:G.goldDim, fontSize:10 }}> (含1个自投리 {packCount % MASTER_BAG_SIZE}包)</span>
            )}
          </div>
        </DkCard>
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => setWorker(e.target.value)} placeholder="姓名 Name" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
        </DkCard>
        <DkCard style={{ fontSize:10, color:G.goldDim, lineHeight:1.8 }}>
          <div style={{ fontWeight:400, color:G.gold, marginBottom:6 }}>注意 / 주의사항</div>
          <div>· 系统将自动加载指定范围内的包装</div>
          <div>· 已装袋的包装将被跳过</div>
          <div>· 每 {MASTER_BAG_SIZE} 个包装自动组成一个麻袋</div>
          <div>· 目的地自动设为 MEX-Guadalajara</div>
        </DkCard>
        <DkBtn onClick={handleSubmit} disabled={packCount <= 0 || !worker.trim()}>
          ▶ 开始批量装袋 / 일괄 마대 생성 ({bagCount})
        </DkBtn>
      </div>
    </DkScreen>
  );
});

const BatchBagProgressScreen = memo(function BatchBagProgressScreen({ progress }) {
  const pct = progress.total > 0 ? Math.round(progress.current / progress.total * 100) : 0;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>BATCH BAGGING...</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:8, fontWeight:400 }}>{progress.current} / {progress.total} 麻袋</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ height:4, background:G.progressTrack, borderRadius:2, marginBottom:14 }}>
            <div style={{ height:'100%', background:G.gold, width:pct+'%', borderRadius:2, transition:'width .3s' }} />
          </div>
          <div style={{ fontSize:11, color:G.goldDim, textAlign:'center' }}>{pct}% · {progress.errors.length > 0 ? progress.errors.length + ' 错误' : '处理中...'}</div>
        </DkCard>
        {progress.items.slice(-4).map(it => (
          <div key={it.bagSeq} style={{ padding:'6px 12px', marginBottom:4, border:'1px solid var(--app-divider)', fontSize:10, color:G.goldDim, display:'flex', justifyContent:'space-between' }}>
            <span>Bag #{it.bagSeq} · {it.packCount} packs</span>
            <span style={{ color:G.gold }}>✓</span>
          </div>
        ))}
      </div>
    </DkScreen>
  );
});

const BatchBagDoneScreen = memo(function BatchBagDoneScreen({ result, onHome, onSingleBag, onRetryFailed }) {
  const [downloading, setDownloading] = useState(false);
  const savedItems = result.items.filter(it => it.savedToZoho !== false);
  const handleZIP = async () => {
    if (downloading || savedItems.length === 0) return;
    setDownloading(true);
    try {
      const qrItems = savedItems.map(it => ({
        text: it.qrText,
        filename: sanitizeFilename(`${result.moNumber}_MasterBag_${it.bagSeq}_${it.totalQty}pcs.png`)
      }));
      await downloadQRsAsZIP(qrItems, sanitizeFilename(`${result.moNumber}_MasterBags_Batch.zip`));
    } finally { setDownloading(false); }
  };
  const handlePDF = async () => {
    if (downloading || savedItems.length === 0) return;
    setDownloading(true);
    try {
      const qrItems = savedItems.map(it => ({
        text: it.qrText,
        filename: sanitizeFilename(`${result.moNumber}_MasterBag_${it.bagSeq}_${it.totalQty}pcs.png`)
      }));
      await downloadQRsAsPDF(qrItems, sanitizeFilename(`${result.moNumber}_MasterBags_Batch.pdf`));
    } finally { setDownloading(false); }
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>BATCH BAGS COMPLETE</div>
        <div style={{ fontSize:11, color:G.goldDim, marginTop:4 }}>{result.moNumber}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <DkRow label="已创建麻袋 / 생성 완료" value={String(savedItems.length) + ' 麻袋'} />
          <DkRow label="失败 / 실패" value={String(result.errors.length) + ' 个'} />
          <DkRow label="负责人 / 담당자" value={result.worker} />
        </DkCard>
        {result.errors.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:'#EF4444', marginBottom:10 }}>失败记录 / 실패 목록</div>
            {result.errors.map((e, i) => (
              <div key={i} style={{ fontSize:10, color:'#EF4444', padding:'3px 0' }}>Bag #{e.bagSeq}: {e.error}</div>
            ))}
          </DkCard>
        )}
        <DkBtn onClick={handleZIP} disabled={downloading || savedItems.length === 0}>
          {downloading ? '生成中...' : '📦 ZIP 下载 QR / ZIP 다운로드'}
        </DkBtn>
        <DkBtn onClick={handlePDF} disabled={downloading || savedItems.length === 0}>
          {downloading ? '生成中...' : '📄 PDF 下载 QR / PDF 다운로드'}
        </DkBtn>
        {result.errors.length > 0 && onRetryFailed && (
          <DkBtn onClick={onRetryFailed}>🔄 重试失败 / 실패 재시도 ({result.errors.length})</DkBtn>
        )}
        <DkBtnOutline onClick={onSingleBag}>➕ 继续单个装袋 / 단일 마대 계속</DkBtnOutline>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── FIX 6: Query sub-menus ──────────────────────────────────────────
const PackQuerySubMenu = memo(function PackQuerySubMenu({ onTextQuery, onScanQuery, onBack }) {
  return (
    <DkScreen style={{ padding:'80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:40 }}>
        <IconInnerPack />
        <div style={{ fontSize:11, letterSpacing:4, color:G.gold, marginTop:16, fontWeight:400 }}>QR 查询 / QR 조회</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:6, fontWeight:400, letterSpacing:1 }}>包装查询</div>
      </div>
      <DkBtn onClick={onTextQuery}>📋 文字查询 / 텍스트 조회</DkBtn>
      <DkBtn onClick={onScanQuery}>🔍 扫码查询 / 스캔 조회</DkBtn>
    </DkScreen>
  );
});

const BagQuerySubMenu = memo(function BagQuerySubMenu({ onTextQuery, onScanQuery, onBack }) {
  return (
    <DkScreen style={{ padding:'80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:40 }}>
        <IconMasterBag />
        <div style={{ fontSize:11, letterSpacing:4, color:G.gold, marginTop:16, fontWeight:400 }}>QR 查询 / QR 조회</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:6, fontWeight:400, letterSpacing:1 }}>麻袋查询</div>
      </div>
      <DkBtn onClick={onTextQuery}>📋 文字查询 / 텍스트 조회</DkBtn>
      <DkBtn onClick={onScanQuery}>🔍 扫码查询 / 스캔 조회</DkBtn>
    </DkScreen>
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
  const [bagMO, setBagMO] = useState(null);
  const [createdBag, setCreatedBag] = useState(null);
  const [scannedBagDetail, setScannedBagDetail] = useState(null);
  const [availablePacks, setAvailablePacks] = useState([]);
  const [availablePacksLoading, setAvailablePacksLoading] = useState(false);

  // ── Scan mode ──
  const [scanMode, setScanMode] = useState('production_log');

  // ── Detail nav source ──
  const [packDetailFrom, setPackDetailFrom] = useState('pack_menu');
  const [bagDetailFrom, setBagDetailFrom] = useState('bag_menu');

  // ── PIN gate state ──
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinSuccessCallback, setPinSuccessCallback] = useState(null);

  // ── Status Scan state ──
  const [statusScanTargetStatus, setStatusScanTargetStatus] = useState('');
  const [statusScanResult, setStatusScanResult] = useState(null);

  // ── Theme state ──
  const [theme, setTheme] = useState(() => localStorage.getItem('factoryapp_theme') || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('factoryapp_theme', theme);
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme(t => t === 'dark' ? 'light' : 'dark'), []);

  // ── Batch Pack state ──
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, items: [], errors: [] });
  const [batchResult, setBatchResult] = useState(null);

  // ── Batch Bag state ──
  const [batchBagProgress, setBatchBagProgress] = useState({ current: 0, total: 0, items: [], errors: [] });
  const [batchBagResult, setBatchBagResult] = useState(null);

  // ── Toast state ──
  const [toastMsg, setToastMsg] = useState('');
  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 2500);
  }, []);

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

      const skuStr = getField(found, 'Style_SKU') || getField(found, 'SKU') || '-';

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
        factory: getField(found, 'Factory') || '-',
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

  const fetchMODataForBag = useCallback(async (moNumber) => {
    try {
      const res = await getRecords(REPORTS.MO);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const found = list.find((r) => r['MO_Number'] === moNumber);
      if (!found) {
        setCurrentScreen('bag_mo_select');
        alert('未找到订单: ' + moNumber);
        return;
      }
      setBagMO({
        mo_number: found['MO_Number'] || moNumber,
        sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-',
        factory: getField(found, 'Factory') || '-',
      });
      setCurrentScreen('bag_create');
      setAvailablePacksLoading(true);
      setAvailablePacks([]);
      (async () => {
        try {
          const allPacks = [];
          let from = 1;
          const limit = 200;
          while (true) {
            const pr = await getRecordsByCriteria(REPORTS.INNER_PACK, `MO_Number == "${moNumber}" && Pack_Status == "Created"`, { from, limit });
            const data = (pr && pr.code === 3000 && Array.isArray(pr.data)) ? pr.data : [];
            if (data.length === 0) break;
            allPacks.push(...data);
            if (data.length < limit) break;
            from += limit;
            if (from > 10000) break;
          }
          const unassigned = allPacks
            .filter(p => !p['Assigned_To_Bag'] || p['Assigned_To_Bag'] === '')
            .sort((a, b) => (parseInt(a['Pack_Sequence']) || 0) - (parseInt(b['Pack_Sequence']) || 0));
          console.log('[Master Bag] Total unassigned packs:', unassigned.length);
          console.log('[Master Bag] First Pack:', unassigned[0]?.['Pack_Sequence']);
          console.log('[Master Bag] Last Pack:', unassigned[unassigned.length - 1]?.['Pack_Sequence']);
          setAvailablePacks(unassigned);
          setAvailablePacksLoading(false);
        } catch {
          setAvailablePacksLoading(false);
        }
      })();
    } catch (err) {
      setCurrentScreen('bag_mo_select');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  const fetchMODataForBatchPack = useCallback(async (moNumber) => {
    try {
      const res = await getRecords(REPORTS.MO);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const found = list.find((r) => r['MO_Number'] === moNumber);
      if (!found) { setCurrentScreen('batch_pack_mo_select'); alert('未找到订单: ' + moNumber); return; }
      let standardAssortment = [];
      const jsonStr = found['Standard_Assortment_JSON'];
      if (jsonStr && typeof jsonStr === 'string') {
        try { let c = jsonStr.trim(); if (!c.startsWith('[')) c = '[' + c + ']'; standardAssortment = JSON.parse(c); } catch (e) {}
      }
      let nextSequence = 1;
      try {
        const packRes = await getRecords(REPORTS.INNER_PACK);
        if (packRes && packRes.code === 3000 && Array.isArray(packRes.data)) {
          const existing = packRes.data.filter(p => { let m = p['MO_Number']; if (typeof m === 'object') m = m.display_value || ''; return m === moNumber; });
          nextSequence = existing.length + 1;
        }
      } catch (e) {}
      setPackMO({ mo_number: found['MO_Number'] || moNumber, sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-', factory: getField(found, 'Factory') || '-', order_qty: parseInt(found['Plan_Total_Quantity']) || 0, plan_notes: found['Plan_Notes'] || '', standard_assortment: standardAssortment, record_id: found['ID'] });
      setPackSequence(nextSequence);
      setCurrentScreen('batch_pack_input');
    } catch (err) {
      setCurrentScreen('batch_pack_mo_select');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  const fetchMODataForBatchBag = useCallback(async (moNumber) => {
    try {
      const res = await getRecords(REPORTS.MO);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const found = list.find((r) => r['MO_Number'] === moNumber);
      if (!found) { setCurrentScreen('batch_bag_mo_select'); alert('未找到订单: ' + moNumber); return; }
      setBagMO({ mo_number: found['MO_Number'] || moNumber, sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-', factory: getField(found, 'Factory') || '-' });
      setCurrentScreen('batch_bag_input');
    } catch (err) {
      setCurrentScreen('batch_bag_mo_select');
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
        record_id: found['ID'],
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
        created_time: found['Added_Time'] || found['Created_Time'] || '',
        modified_time: found['Modified_Time'] || ''
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
      'SKU':            packMO.sku,
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

  const handleSelectPackFromList = useCallback((rawPack) => {
    const uuid = rawPack['Pack_UUID'];
    if (!uuid) return;
    setBagScannedPacks(prev => {
      if (prev.find(p => p.uuid === uuid)) return prev.filter(p => p.uuid !== uuid);
      if (prev.length >= MASTER_BAG_SIZE) return prev;
      let moNum = rawPack['MO_Number'];
      if (typeof moNum === 'object') moNum = moNum.display_value || '';
      let items = [];
      try { items = JSON.parse(rawPack['Items_JSON'] || '[]'); } catch (e) {}
      return [...prev, { uuid, qrText: '', mo_number: moNum, items, total_qty: rawPack['Total_Qty'] || 12, record_id: rawPack['ID'] }];
    });
  }, []);

  const handleSelectFirst10Packs = useCallback((packs) => {
    const first10 = packs.slice(0, MASTER_BAG_SIZE).map(rawPack => {
      let moNum = rawPack['MO_Number'];
      if (typeof moNum === 'object') moNum = moNum.display_value || '';
      let items = [];
      try { items = JSON.parse(rawPack['Items_JSON'] || '[]'); } catch (e) {}
      return { uuid: rawPack['Pack_UUID'], qrText: '', mo_number: moNum, items, total_qty: rawPack['Total_Qty'] || 12, record_id: rawPack['ID'] };
    });
    setBagScannedPacks(first10);
  }, []);

  const handleCreateBag = useCallback(async () => {
    if (!bagMO) {
      alert('请先选择订单号 / MO를 먼저 선택하세요');
      return;
    }
    if (bagScannedPacks.length === 0) {
      alert('请至少扫描一个包装');
      return;
    }
    if (!bagIsRemainder && bagScannedPacks.length !== MASTER_BAG_SIZE) {
      if (!window.confirm(`不是 ${MASTER_BAG_SIZE} 个 (${bagScannedPacks.length}个). 继续?`)) return;
    }
    if (!bagWorker.trim()) {
      alert('请输入负责人 / 담당자');
      return;
    }

    const primaryMO = bagMO.mo_number;
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
      'SKU':              bagMO.sku,
      'Factory':          bagMO.factory,
      'Inner_Pack_Count': bagScannedPacks.length,
      'Inner_Pack_UUIDs': JSON.stringify(bagScannedPacks.map(p => p.uuid)),
      'Total_Qty':        totalQty,
      'Is_Remainder':     bagIsRemainder,
      'Worker':           bagWorker.trim(),
      'Destination':      'MEX-Guadalajara',
      'Bag_Status':       'Created'
    };

    try {
      setLoadingMsg('保存麻袋信息...');
      setCurrentScreen('loading');

      const bagRes = await submitRecord(FORMS.MASTER_BAG, bagData);
      if (!bagRes || bagRes.code !== 3000) {
        throw new Error('保存失败: ' + JSON.stringify(bagRes));
      }

      setLoadingMsg('状态更新中...');
      await Promise.all(bagScannedPacks.map(p =>
        updateRecord(REPORTS.INNER_PACK, p.record_id, {
          'Assigned_To_Bag': uuid,
          'Pack_Status': 'Bagged'
        }).catch(updErr => console.warn('[bag] pack update failed', p.uuid, updErr))
      ));

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
  }, [bagMO, bagScannedPacks, bagIsRemainder, bagWorker]);

  const handleBatchCreatePacks = useCallback(async ({ startSeq, endSeq, worker }) => {
    if (!packMO) return;
    const total = endSeq - startSeq + 1;
    const items = [], errors = [];
    setBatchProgress({ current: 0, total, items: [], errors: [] });
    setCurrentScreen('batch_pack_progress');
    const selectedItems = (packMO.standard_assortment || []).map(it => ({ color: it.color, size: it.size, qty: it.qty || 1 }));
    const totalQty = selectedItems.reduce((s, it) => s + (parseInt(it.qty) || 1), 0);
    const totalExpected = packMO.order_qty > 0 ? Math.ceil(packMO.order_qty / INNER_PACK_SIZE) : 0;
    const seqs = Array.from({ length: total }, (_, i) => startSeq + i);
    let idx = 0;
    const createOnePack = async (seq) => {
      const qrText = buildInnerPackQR();
      const uuid = qrText.split('/view/inner/')[1];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await submitRecord(FORMS.INNER_PACK, {
            'Pack_UUID': uuid, 'Brand': BRAND, 'MO_Number': packMO.mo_number,
            'SKU': packMO.sku, 'Pack_Sequence': seq, 'Total_Expected': totalExpected, 'Total_Qty': totalQty,
            'Is_Remainder': false, 'Items_JSON': JSON.stringify(selectedItems),
            'Worker': worker, 'Factory': packMO.factory, 'Pack_Status': 'Created'
          });
          if (!res || res.code !== 3000) throw new Error('保存失败 code=' + (res && res.code));
          return { seq, uuid, qrText, totalQty, savedToZoho: true };
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
      }
    };
    const createWorker = async () => {
      while (idx < seqs.length) {
        const i = idx++;
        try { const r = await createOnePack(seqs[i]); items.push(r); }
        catch (e) { errors.push({ seq: seqs[i], error: e.message || String(e) }); }
        setBatchProgress(p => ({ ...p, current: p.current + 1, items: [...items], errors: [...errors] }));
      }
    };
    await Promise.all(Array.from({ length: 3 }, () => createWorker()));
    setBatchResult({ items, errors, moNumber: packMO.mo_number, worker, lastSeq: endSeq });
    setCurrentScreen('batch_pack_done');
  }, [packMO]);

  const handleRetryFailedPacks = useCallback(async () => {
    if (!packMO || !batchResult || batchResult.errors.length === 0) return;
    const failedSeqs = batchResult.errors.map(e => e.seq);
    const prevItems = batchResult.items;
    const worker = batchResult.worker;
    const total = failedSeqs.length;
    const newItems = [], newErrors = [];
    setBatchProgress({ current: 0, total, items: [], errors: [] });
    setCurrentScreen('batch_pack_progress');
    const selectedItems = (packMO.standard_assortment || []).map(it => ({ color: it.color, size: it.size, qty: it.qty || 1 }));
    const totalQty = selectedItems.reduce((s, it) => s + (parseInt(it.qty) || 1), 0);
    const totalExpected = packMO.order_qty > 0 ? Math.ceil(packMO.order_qty / INNER_PACK_SIZE) : 0;
    let idx = 0;
    const createWorker = async () => {
      while (idx < failedSeqs.length) {
        const i = idx++;
        const seq = failedSeqs[i];
        try {
          const qrText = buildInnerPackQR();
          const uuid = qrText.split('/view/inner/')[1];
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await submitRecord(FORMS.INNER_PACK, {
                'Pack_UUID': uuid, 'Brand': BRAND, 'MO_Number': packMO.mo_number,
                'SKU': packMO.sku, 'Pack_Sequence': seq, 'Total_Expected': totalExpected, 'Total_Qty': totalQty,
                'Is_Remainder': false, 'Items_JSON': JSON.stringify(selectedItems),
                'Worker': worker, 'Factory': packMO.factory, 'Pack_Status': 'Created'
              });
              if (!res || res.code !== 3000) throw new Error('code=' + (res && res.code));
              newItems.push({ seq, uuid, qrText, totalQty, savedToZoho: true });
              break;
            } catch (e) {
              if (attempt === 3) throw e;
              await new Promise(r => setTimeout(r, 500 * attempt));
            }
          }
        } catch (e) {
          newErrors.push({ seq, error: e.message || String(e) });
        }
        setBatchProgress(p => ({ ...p, current: p.current + 1, items: [...newItems], errors: [...newErrors] }));
      }
    };
    await Promise.all(Array.from({ length: 3 }, () => createWorker()));
    setBatchResult({ items: [...prevItems, ...newItems], errors: newErrors, moNumber: packMO.mo_number, worker, lastSeq: batchResult.lastSeq });
    setCurrentScreen('batch_pack_done');
  }, [packMO, batchResult]);

  const handleBatchCreateBags = useCallback(async ({ startPackSeq, endPackSeq, worker }) => {
    if (!bagMO) return;
    try {
      setLoadingMsg('加载包装数据...');
      setCurrentScreen('loading');
      const packRes = await getRecords(REPORTS.INNER_PACK);
      const allPacks = (packRes && packRes.code === 3000 && Array.isArray(packRes.data)) ? packRes.data : [];
      const moPacks = allPacks
        .filter(p => { let m = p['MO_Number']; if (typeof m === 'object') m = m.display_value || ''; const seq = parseInt(p['Pack_Sequence']) || 0; return m === bagMO.mo_number && seq >= startPackSeq && seq <= endPackSeq; })
        .sort((a, b) => parseInt(a['Pack_Sequence']) - parseInt(b['Pack_Sequence']));
      if (moPacks.length === 0) { setCurrentScreen('batch_bag_input'); alert('未找到指定范围内的包装 / 해당 범위의 포장 없음'); return; }
      const alreadyBagged = moPacks.filter(p => p['Assigned_To_Bag'] && p['Assigned_To_Bag'] !== '');
      if (alreadyBagged.length > 0) { setCurrentScreen('batch_bag_input'); alert(alreadyBagged.length + ' 个包装已经装袋'); return; }
      const bagListRes = await getRecords(REPORTS.MASTER_BAG);
      const existingBagsForMO = (bagListRes && bagListRes.code === 3000 && Array.isArray(bagListRes.data))
        ? bagListRes.data.filter(b => { let m = b['MO_Number']; if (typeof m === 'object') m = m.display_value || ''; return m === bagMO.mo_number; })
        : [];
      let nextBagSeq = existingBagsForMO.length + 1;
      const bagGroups = [];
      for (let i = 0; i < moPacks.length; i += MASTER_BAG_SIZE) {
        const group = moPacks.slice(i, i + MASTER_BAG_SIZE);
        bagGroups.push({ packs: group, bagSeq: nextBagSeq++, isRemainder: group.length < MASTER_BAG_SIZE });
      }
      const items = [], errors = [];
      setBatchBagProgress({ current: 0, total: bagGroups.length, items: [], errors: [] });
      setCurrentScreen('batch_bag_progress');
      const createOneBag = async (bagDef) => {
        const { packs, bagSeq, isRemainder } = bagDef;
        const qrText = buildMasterBagQR();
        const uuid = qrText.split('/view/bag/')[1];
        const totalQty = packs.reduce((s, p) => s + (parseInt(p['Total_Qty']) || 12), 0);
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const res = await submitRecord(FORMS.MASTER_BAG, {
              'Bag_UUID': uuid, 'Brand': BRAND, 'Bag_Sequence': bagSeq, 'MO_Number': bagMO.mo_number,
              'SKU': bagMO.sku, 'Factory': bagMO.factory,
              'Inner_Pack_Count': packs.length, 'Inner_Pack_UUIDs': JSON.stringify(packs.map(p => p['Pack_UUID'])),
              'Total_Qty': totalQty, 'Is_Remainder': isRemainder, 'Worker': worker,
              'Destination': 'MEX-Guadalajara', 'Bag_Status': 'Created'
            });
            if (!res || res.code !== 3000) throw new Error('Save failed bagSeq=' + bagSeq + ' code=' + (res && res.code));
            await Promise.all(packs.map(p =>
              updateRecord(REPORTS.INNER_PACK, p['ID'], { 'Assigned_To_Bag': uuid, 'Pack_Status': 'Bagged' })
                .catch(e => console.warn('[batch-bag] pack update failed', p['Pack_UUID'], e))
            ));
            return { bagSeq, uuid, qrText, totalQty, packCount: packs.length, isRemainder, savedToZoho: true };
          } catch (e) {
            if (attempt === 3) throw e;
            await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
      };
      let idx = 0;
      const createBagWorker = async () => {
        while (idx < bagGroups.length) {
          const i = idx++;
          try { const r = await createOneBag(bagGroups[i]); items.push(r); }
          catch (e) { errors.push({ bagSeq: bagGroups[i].bagSeq, error: e.message || String(e) }); }
          setBatchBagProgress(p => ({ ...p, current: p.current + 1, items: [...items], errors: [...errors] }));
        }
      };
      await Promise.all(Array.from({ length: 2 }, () => createBagWorker()));
      setBatchBagResult({ items, errors, moNumber: bagMO.mo_number, worker, startPackSeq, endPackSeq });
      setCurrentScreen('batch_bag_done');
    } catch (err) {
      setCurrentScreen('batch_bag_input');
      alert('批量装袋失败: ' + (err?.message || String(err)));
    }
  }, [bagMO]);

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
        record_id: found['ID'],
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
        created_time: found['Added_Time'] || found['Created_Time'] || '',
        modified_time: found['Modified_Time'] || '',
        received_at_mex: found['Received_At_MEX'] || ''
      });
      setCurrentScreen('bag_detail');
    } catch (err) {
      setCurrentScreen('bag_menu');
      alert('查询失败: ' + (err?.message || String(err)));
    }
  }, []);

  // ── Status change handlers ──
  const handlePackStatusChange = useCallback(async (newStatus) => {
    if (!scannedPackDetail?.record_id) return;
    await updateRecord(REPORTS.INNER_PACK, scannedPackDetail.record_id, { 'Pack_Status': newStatus });
    setScannedPackDetail(prev => ({ ...prev, pack_status: newStatus }));
  }, [scannedPackDetail]);

  const handleBagStatusChange = useCallback(async (newStatus) => {
    if (!scannedBagDetail?.record_id) return;
    await updateRecord(REPORTS.MASTER_BAG, scannedBagDetail.record_id, { 'Bag_Status': newStatus });
    setScannedBagDetail(prev => ({ ...prev, bag_status: newStatus }));
  }, [scannedBagDetail]);

  // ── Status Scan handler ──
  const handleStatusScanUpdate = useCallback(async (bagUuid) => {
    setLoadingMsg('状态更新中...');
    setCurrentScreen('loading');
    try {
      const bagRes = await getRecords(REPORTS.MASTER_BAG);
      const bagList = (bagRes && bagRes.code === 3000 && Array.isArray(bagRes.data)) ? bagRes.data : [];
      const foundBag = bagList.find(r => r['Bag_UUID'] === bagUuid);
      if (!foundBag) {
        setCurrentScreen('status_scan_camera');
        alert('未找到此麻袋 / 마대 없음');
        return;
      }
      let moNum = foundBag['MO_Number'];
      if (typeof moNum === 'object') moNum = moNum.display_value || '';
      let packUUIDs = [];
      try { packUUIDs = JSON.parse(foundBag['Inner_Pack_UUIDs'] || '[]'); } catch (e) {}

      await updateRecord(REPORTS.MASTER_BAG, foundBag['ID'], { 'Bag_Status': statusScanTargetStatus });

      let packCount = 0;
      if (packUUIDs.length > 0) {
        const packRes = await getRecords(REPORTS.INNER_PACK);
        const packList = (packRes && packRes.code === 3000 && Array.isArray(packRes.data)) ? packRes.data : [];
        const matched = packList.filter(r => packUUIDs.includes(r['Pack_UUID']));
        packCount = matched.length;
        await Promise.all(matched.map(p =>
          updateRecord(REPORTS.INNER_PACK, p['ID'], { 'Pack_Status': statusScanTargetStatus })
            .catch(e => console.warn('[status-scan] pack update failed', p['Pack_UUID'], e))
        ));
      }

      setStatusScanResult({
        bagUuid,
        moNum,
        bagSeq: foundBag['Bag_Sequence'],
        packCount,
        status: statusScanTargetStatus
      });
      setCurrentScreen('status_scan_success');
    } catch (err) {
      setCurrentScreen('status_scan_camera');
      alert('更新失败: ' + (err?.message || String(err)));
    }
  }, [statusScanTargetStatus]);

  // ── Delete handlers ──
  const handleDeletePack = useCallback(async () => {
    if (!scannedPackDetail?.record_id) return;
    if (!window.confirm(`确定删除此包装? 不可撤销\nPack #${scannedPackDetail.pack_sequence} · ${scannedPackDetail.mo_number}`)) return;
    try {
      setLoadingMsg('正在删除...');
      setCurrentScreen('loading');
      await deleteRecord(REPORTS.INNER_PACK, scannedPackDetail.record_id);
      setScannedPackDetail(null);
      showToast('✓ 包装已删除');
      setCurrentScreen(packDetailFrom);
    } catch (e) {
      setCurrentScreen('pack_detail');
      alert('删除失败: ' + (e?.message || String(e)));
    }
  }, [scannedPackDetail, packDetailFrom, showToast]);

  const handleDeleteBag = useCallback(async () => {
    if (!scannedBagDetail?.record_id) return;
    if (!window.confirm(`确定删除此麻袋? 不可撤销\nBag #${scannedBagDetail.bag_sequence} · ${scannedBagDetail.mo_number}`)) return;
    try {
      setLoadingMsg('正在删除...');
      setCurrentScreen('loading');
      await deleteRecord(REPORTS.MASTER_BAG, scannedBagDetail.record_id);
      setScannedBagDetail(null);
      showToast('✓ 麻袋已删除');
      setCurrentScreen(bagDetailFrom);
    } catch (e) {
      setCurrentScreen('bag_detail');
      alert('删除失败: ' + (e?.message || String(e)));
    }
  }, [scannedBagDetail, bagDetailFrom, showToast]);

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

    if (scanMode === 'bag_mo') {
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
      fetchMODataForBag(moNumber);
      return;
    }

    if (scanMode === 'batch_pack_mo') {
      if (qrType !== 'production_log') { setCameraOpen(false); alert('请扫描生产进度QR (MO QR)'); return; }
      let moNumber = '';
      text.split(/[|\n\r]+/).forEach((part) => { const idx = part.indexOf(':'); if (idx < 0) return; const key = part.substring(0, idx).trim().toUpperCase(); if (key === 'MO') moNumber = part.substring(idx + 1).trim(); });
      if (!moNumber && /^[A-Z]{2}\d{2}-\d+/i.test(text)) moNumber = text;
      if (!moNumber) { setCameraOpen(false); alert('未能识别订单号'); return; }
      flushSync(() => { setCameraOpen(false); setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); });
      fetchMODataForBatchPack(moNumber);
      return;
    }

    if (scanMode === 'batch_bag_mo') {
      if (qrType !== 'production_log') { setCameraOpen(false); alert('请扫描生产进度QR (MO QR)'); return; }
      let moNumber = '';
      text.split(/[|\n\r]+/).forEach((part) => { const idx = part.indexOf(':'); if (idx < 0) return; const key = part.substring(0, idx).trim().toUpperCase(); if (key === 'MO') moNumber = part.substring(idx + 1).trim(); });
      if (!moNumber && /^[A-Z]{2}\d{2}-\d+/i.test(text)) moNumber = text;
      if (!moNumber) { setCameraOpen(false); alert('未能识别订单号'); return; }
      flushSync(() => { setCameraOpen(false); setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); });
      fetchMODataForBatchBag(moNumber);
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

    if (scanMode === 'status_scan') {
      const uuid = parseMasterBagQR(text);
      if (!uuid) {
        setCameraOpen(false);
        alert('不是有效的麻袋QR / 유효한 마대 QR이 아닙니다');
        return;
      }
      flushSync(() => {
        setCameraOpen(false);
        setLoadingMsg('状态更新中...');
        setCurrentScreen('loading');
      });
      handleStatusScanUpdate(uuid);
      return;
    }
  }, [scanMode, bagScannedPacks, fetchMOData, fetchMODataForPack, fetchMODataForBag, fetchMODataForBatchPack, fetchMODataForBatchBag, fetchInnerPackDetail, addPackToBag, fetchMasterBagDetail, handleStatusScanUpdate]);

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

  const handleSelectProcess = useCallback((procCode, procZH, procKO, procMoField, procZohoValue) => {
    setSelectedProcess({ key: procCode, cn: procZH, ko: procKO, moField: procMoField, zohoValue: procZohoValue });
    setCurrentScreen('input');
  }, []);

  const handleSubmit = useCallback(async (form) => {
    const todayStr = getTodayStr();
    const dateOnlyStr = getTodayDateStr();
    const logData = {
      'MO_Number':      moData.mo_number,
      'SKU':            moData.sku,
      'Factory':        moData.factory,
      'Process':        selectedProcess.zohoValue || selectedProcess.key,
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

    const updatePayload = {};
    if (selectedProcess.moField) {
      updatePayload[selectedProcess.moField] = dateOnlyStr;
    }
    let moUpdateOk = false;
    let moUpdateError = '';
    console.log('[MO_PATCH] Starting — recordId:', moRecordId, 'report:', MO_REPORT);
    console.log('[MO_PATCH] Payload:', JSON.stringify(updatePayload));
    try {
      const patchRes = await updateRecord(MO_REPORT, moRecordId, updatePayload);
      console.log('[MO_PATCH] Response:', JSON.stringify(patchRes));
      if (patchRes && patchRes.code === 3000) {
        moUpdateOk = true;
        console.log('[MO_PATCH] ✅ Success');
      } else {
        moUpdateError = patchRes ? JSON.stringify(patchRes) : 'No response';
        console.error('[MO_PATCH] ❌ Non-3000 response:', moUpdateError);
      }
    } catch (updErr) {
      moUpdateError = (updErr && (updErr.message || JSON.stringify(updErr.body))) || String(updErr);
      console.error('[MO_PATCH] ❌ Exception:', updErr, 'body:', updErr && updErr.body);
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    setSubmitResult({
      mo: moData.mo_number,
      process: selectedProcess.key,
      processCN: selectedProcess.cn,
      processKO: selectedProcess.ko,
      moField: selectedProcess.moField,
      moFieldDate: dateOnlyStr,
      moUpdateOk,
      moUpdateError,
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
            onSelectStatusScan={() => setCurrentScreen('status_scan_mode')}
          />
        )}

        {/* Production Log screens */}
        {currentScreen === 'scan' && <ScanScreen onScan={handleScanRequest} onUpload={openUpload} onManual={() => setCurrentScreen('log_manual_mo')} onBack={() => { setScanMode('production_log'); setCurrentScreen('home'); }} />}
        {currentScreen === 'log_manual_mo' && (
          <LogManualMOScreen
            onSubmit={(mo) => { setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); fetchMOData(mo); }}
            onBack={() => setCurrentScreen('scan')}
          />
        )}
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
            onBatch={() => requirePin(() => setCurrentScreen('batch_pack_mo_select'))}
            onQueryMenu={() => setCurrentScreen('pack_query_sub_menu')}
            onBack={() => { window.history.pushState({}, '', '/'); setCurrentScreen('home'); }}
          />
        )}
        {currentScreen === 'pack_query_sub_menu' && (
          <PackQuerySubMenu
            onTextQuery={() => setCurrentScreen('pack_list')}
            onScanQuery={() => { setPackDetailFrom('pack_query_sub_menu'); setScanMode('inner_pack_detail'); setCameraOpen(true); }}
            onBack={() => setCurrentScreen('pack_menu')}
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
            onBack={() => { setScannedPackDetail(null); setCurrentScreen(packDetailFrom); }}
            onEditStatus={handlePackStatusChange}
            onDelete={handleDeletePack}
            requirePin={requirePin}
          />
        )}
        {currentScreen === 'pack_list' && (
          <PackListScreen
            onBack={() => setCurrentScreen('pack_query_sub_menu')}
            onSelectPack={(uuid) => {
              setPackDetailFrom('pack_list');
              setLoadingMsg('查询包装信息...');
              setCurrentScreen('loading');
              fetchInnerPackDetail(uuid);
            }}
          />
        )}

        {/* Batch Pack screens */}
        {currentScreen === 'batch_pack_mo_select' && (
          <PackMOSelectScreen
            onScan={() => { setScanMode('batch_pack_mo'); setCameraOpen(true); }}
            onManual={(mo) => { setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); fetchMODataForBatchPack(mo); }}
            onBack={() => setCurrentScreen('pack_menu')}
          />
        )}
        {currentScreen === 'batch_pack_input' && packMO && (
          <BatchPackInputScreen
            packMO={packMO}
            defaultStartSeq={packSequence}
            onSubmit={handleBatchCreatePacks}
            onBack={() => setCurrentScreen('batch_pack_mo_select')}
          />
        )}
        {currentScreen === 'batch_pack_progress' && (
          <BatchPackProgressScreen progress={batchProgress} />
        )}
        {currentScreen === 'batch_pack_done' && batchResult && (
          <BatchPackDoneScreen
            result={batchResult}
            onHome={() => { setPackMO(null); setBatchResult(null); setPackSequence(1); setCurrentScreen('home'); }}
            onNextPack={() => {
              const nextSeq = batchResult.items.length > 0 ? Math.max(...batchResult.items.map(it => it.seq)) + 1 : packSequence;
              setPackSequence(nextSeq);
              setBatchResult(null);
              if (packMO && packMO.standard_assortment) setPackComposition(packMO.standard_assortment.map(it => ({ ...it, selected: true })));
              setPackIsRemainder(false);
              setCurrentScreen('pack_create');
            }}
            onRetryFailed={batchResult.errors.length > 0 ? handleRetryFailedPacks : null}
          />
        )}

        {/* Master Bag screens */}
        {currentScreen === 'bag_menu' && (
          <BagMenuScreen
            onCreate={() => requirePin(() => {
              setBagScannedPacks([]); setBagIsRemainder(false);
              setBagWorker(''); setBagMO(null);
              setCurrentScreen('bag_mo_select');
            })}
            onBatch={() => requirePin(() => { setBagMO(null); setCurrentScreen('batch_bag_mo_select'); })}
            onQueryMenu={() => setCurrentScreen('bag_query_sub_menu')}
            onBack={() => { window.history.pushState({}, '', '/'); setCurrentScreen('home'); }}
          />
        )}
        {currentScreen === 'bag_query_sub_menu' && (
          <BagQuerySubMenu
            onTextQuery={() => setCurrentScreen('bag_list')}
            onScanQuery={() => { setBagDetailFrom('bag_query_sub_menu'); setScanMode('master_bag_detail'); setCameraOpen(true); }}
            onBack={() => setCurrentScreen('bag_menu')}
          />
        )}
        {currentScreen === 'bag_mo_select' && (
          <BagMOSelectScreen
            onScan={() => { setScanMode('bag_mo'); setCameraOpen(true); }}
            onManual={(mo) => {
              setLoadingMsg('加载订单数据...');
              setCurrentScreen('loading');
              fetchMODataForBag(mo);
            }}
            onBack={() => setCurrentScreen('bag_menu')}
          />
        )}
        {currentScreen === 'bag_create' && (
          <BagCreateScreen
            bagMO={bagMO}
            scannedPacks={bagScannedPacks}
            isRemainder={bagIsRemainder}
            setIsRemainder={setBagIsRemainder}
            worker={bagWorker}
            setWorker={setBagWorker}
            onScanNext={() => { setScanMode('master_bag_compose'); setCameraOpen(true); }}
            onRemovePack={handleRemovePackFromBag}
            onSubmit={handleCreateBag}
            onBack={() => { setAvailablePacks([]); setCurrentScreen('bag_mo_select'); }}
            submitting={false}
            availablePacks={availablePacks}
            availablePacksLoading={availablePacksLoading}
            onSelectPack={handleSelectPackFromList}
            onSelectFirst10={handleSelectFirst10Packs}
            onClearAll={() => setBagScannedPacks([])}
          />
        )}
        {currentScreen === 'bag_success' && (
          <BagSuccessScreen
            bag={createdBag}
            onNewBag={() => {
              setBagScannedPacks([]); setCreatedBag(null); setBagIsRemainder(false);
              setBagWorker(''); setBagMO(null);
              setCurrentScreen('bag_mo_select');
            }}
            onHome={() => {
              setBagScannedPacks([]); setCreatedBag(null); setBagIsRemainder(false);
              setBagWorker(''); setBagMO(null);
              setCurrentScreen('home');
            }}
          />
        )}
        {currentScreen === 'bag_detail' && scannedBagDetail && (
          <BagDetailScreen
            detail={scannedBagDetail}
            onBack={() => { setScannedBagDetail(null); setCurrentScreen(bagDetailFrom); }}
            onEditStatus={handleBagStatusChange}
            onDelete={handleDeleteBag}
            requirePin={requirePin}
          />
        )}
        {currentScreen === 'bag_list' && (
          <BagListScreen
            onBack={() => setCurrentScreen('bag_query_sub_menu')}
            onSelectBag={(uuid) => {
              setBagDetailFrom('bag_list');
              setLoadingMsg('查询麻袋信息...');
              setCurrentScreen('loading');
              fetchMasterBagDetail(uuid);
            }}
          />
        )}

        {/* Batch Bag screens */}
        {currentScreen === 'batch_bag_mo_select' && (
          <BagMOSelectScreen
            onScan={() => { setScanMode('batch_bag_mo'); setCameraOpen(true); }}
            onManual={(mo) => { setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); fetchMODataForBatchBag(mo); }}
            onBack={() => setCurrentScreen('bag_menu')}
          />
        )}
        {currentScreen === 'batch_bag_input' && bagMO && (
          <BatchBagInputScreen
            bagMO={bagMO}
            onSubmit={handleBatchCreateBags}
            onBack={() => setCurrentScreen('batch_bag_mo_select')}
          />
        )}
        {currentScreen === 'batch_bag_progress' && (
          <BatchBagProgressScreen progress={batchBagProgress} />
        )}
        {currentScreen === 'batch_bag_done' && batchBagResult && (
          <BatchBagDoneScreen
            result={batchBagResult}
            onHome={() => { setBagMO(null); setBatchBagResult(null); setCurrentScreen('home'); }}
            onSingleBag={() => {
              setBatchBagResult(null);
              setBagScannedPacks([]); setBagIsRemainder(false); setBagWorker('');
              setCurrentScreen('bag_create');
            }}
            onRetryFailed={batchBagResult.errors.length > 0 ? () => {
              setBatchBagResult(null);
              setCurrentScreen('batch_bag_input');
            } : null}
          />
        )}

        {/* Status Scan screens */}
        {currentScreen === 'status_scan_mode' && (
          <StatusScanModeScreen
            onSelectStatus={(status) => {
              setStatusScanTargetStatus(status);
              setStatusScanResult(null);
              setCurrentScreen('status_scan_camera');
            }}
            onBack={() => setCurrentScreen('home')}
          />
        )}
        {currentScreen === 'status_scan_camera' && (
          <StatusScanCameraScreen
            targetStatus={statusScanTargetStatus}
            onScan={() => { setScanMode('status_scan'); setCameraOpen(true); }}
            onBack={() => setCurrentScreen('status_scan_mode')}
          />
        )}
        {currentScreen === 'status_scan_success' && (
          <StatusScanSuccessScreen
            result={statusScanResult}
            onContinue={() => { setStatusScanResult(null); setCurrentScreen('status_scan_camera'); }}
            onHome={() => { setStatusScanResult(null); setStatusScanTargetStatus(''); setCurrentScreen('home'); }}
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
      {toastMsg && (
        <div style={{ position:'fixed', bottom:28, left:'50%', transform:'translateX(-50%)', background:'rgba(20,16,6,0.95)', border:'1px solid rgba(212,175,55,0.5)', color:G.gold, padding:'10px 22px', borderRadius:2, fontSize:11, letterSpacing:2, zIndex:99999, whiteSpace:'nowrap', pointerEvents:'none' }}>
          {toastMsg}
        </div>
      )}
      {!cameraOpen && (
        <button
          onClick={toggleTheme}
          style={{ position:'fixed', top:14, right:14, background:'rgba(13,10,6,0.7)', border:'1px solid '+G.border, color:G.goldDim, fontSize:16, padding:'5px 9px', cursor:'pointer', fontFamily:'inherit', zIndex:1000, lineHeight:1, backdropFilter:'blur(6px)', WebkitBackdropFilter:'blur(6px)', borderRadius:2 }}
          title={theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'}
        >
          {theme === 'dark' ? '☀' : '🌙'}
        </button>
      )}
    </>
  );
}
