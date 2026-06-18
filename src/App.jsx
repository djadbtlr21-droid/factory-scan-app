import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import jsQR from 'jsqr';
import { getRecords, getRecordsByCriteria, submitRecord, updateRecord, deleteRecord } from './api.js';
import {
  BRAND, INNER_PACK_SIZE, MASTER_BAG_SIZE, REPORTS, FORMS,
  PACK_STATUS_LABELS, BAG_STATUS_LABELS, APP_PIN, PIN_STORAGE_KEY
} from './config.js';
import {
  getAppBaseUrl, buildInnerPackQR, buildMasterBagQR, parseInnerPackQR, parseMasterBagQR,
  detectQRType, generateQRDataURL, generateQRDataURLWithLabel, downloadQRPNG, sanitizeFilename,
  downloadQRsAsZIP, downloadQRsAsPDF
} from './qrUtils.js';
import { generateInnerPackExcel, generateMasterBagExcel, generateSingleInnerPackExcel, generateSingleMasterBagExcel } from './utils/excelLabels.js';
import { logActivity, getRecentActivities, clearActivities } from './utils/recentActivity.js';
import { formatFactory, findFieldValue, readLookupSubfield, resolveColorDot, CHINESE_STYLE_NAME_FIELDS } from './utils/displayHelpers.js';

// Small inline color swatch shown before a color name. Keyword-mapped
// (see resolveColorDot); unmatched colors get a neutral dashed dot so the
// column never goes dotless / ragged.
function ColorDot({ text }) {
  const d = resolveColorDot(text);
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 11,
        height: 11,
        borderRadius: '50%',
        background: d.color,
        marginRight: 6,
        verticalAlign: 'middle',
        flexShrink: 0,
        boxSizing: 'border-box',
        border: d.neutral ? '1px dashed #9ca3af' : (d.outline ? '1px solid #c9c9c9' : '1px solid rgba(0,0,0,0.15)'),
      }}
    />
  );
}

// Lightbox modal — full-screen image overlay rendered via portal into document.body.
// Closes on: X button / overlay click / ESC key.
function Lightbox({ src, onClose }) {
  const proxied = '/api/zoho-image?url=' + encodeURIComponent(src);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', h);
    };
  }, [onClose]);
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
        background: 'rgba(0,0,0,0.92)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
        style={{
          position: 'absolute', top: 16, right: 16,
          background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff',
          fontSize: 24, width: 48, height: 48, borderRadius: '50%',
          cursor: 'pointer', lineHeight: '48px', textAlign: 'center', padding: 0,
          touchAction: 'manipulation',
        }}
      >×</button>
      {!loaded && (
        <div className="spinner" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }} />
      )}
      <img
        src={proxied}
        onLoad={() => setLoaded(true)}
        onClick={(e) => e.stopPropagation()}
        alt=""
        style={{
          maxWidth: '95vw', maxHeight: '95vh', objectFit: 'contain', borderRadius: 8,
          display: loaded ? 'block' : 'none', touchAction: 'manipulation',
        }}
      />
    </div>,
    document.body
  );
}

// Thumbnail + integrated lightbox.
// Shows a rounded square thumbnail; skeleton while loading; hidden on error.
// Click opens full-screen lightbox.
function MOThumbnail({ url, size = 72 }) {
  const [status, setStatus] = useState('loading'); // 'loading' | 'ok' | 'error'
  const [open, setOpen] = useState(false);
  if (!url) return null;
  const proxied = '/api/zoho-image?url=' + encodeURIComponent(url);
  if (status === 'error') return null;
  return (
    <>
      <div
        onClick={() => status === 'ok' && setOpen(true)}
        style={{
          width: size, height: size, borderRadius: 8, overflow: 'hidden', flexShrink: 0,
          background: status === 'loading' ? 'rgba(156,163,175,0.25)' : 'transparent',
          cursor: status === 'ok' ? 'pointer' : 'default',
        }}
      >
        <img
          src={proxied}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('error')}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: status === 'ok' ? 'block' : 'none' }}
        />
      </div>
      {open && <Lightbox src={url} onClose={() => setOpen(false)} />}
    </>
  );
}

// Full-width image banner for the scan result "订单信息" card.
// Shows below the card title, above info rows. Hidden when no URL or load error.
function MOImageBanner({ url }) {
  const [status, setStatus] = useState('loading');
  const [open, setOpen] = useState(false);
  if (!url) return null;
  const proxied = '/api/zoho-image?url=' + encodeURIComponent(url);
  if (status === 'error') return null;
  return (
    <>
      <div
        style={{
          width: '100%', borderRadius: 12, overflow: 'hidden',
          background: '#f5f0e8', marginBottom: 12,
          cursor: status === 'ok' ? 'pointer' : 'default',
        }}
        onClick={() => status === 'ok' && setOpen(true)}
      >
        {status === 'loading' && <div className="img-skeleton" />}
        <img
          src={proxied}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('error')}
          alt=""
          style={{
            width: '100%', maxHeight: 220, objectFit: 'contain',
            padding: '8px 0', display: status === 'ok' ? 'block' : 'none',
          }}
        />
      </div>
      {open && <Lightbox src={url} onClose={() => setOpen(false)} />}
    </>
  );
}

function MOImageThumb({ url, containerStyle, imgStyle }) {
  const [status, setStatus] = useState('loading');
  const [open, setOpen] = useState(false);
  if (!url) return null;
  const proxied = '/api/zoho-image?url=' + encodeURIComponent(url);
  if (status === 'error') return null;
  return (
    <>
      <div
        onClick={() => status === 'ok' && setOpen(true)}
        style={{
          flexShrink: 0, overflow: 'hidden', background: '#f5f0e8',
          cursor: status === 'ok' ? 'pointer' : 'default',
          width: '28%', aspectRatio: '1 / 1', borderRadius: 10,
          ...containerStyle,
        }}
      >
        {status === 'loading' && (
          <div style={{ width: '100%', height: '100%', background: 'transparent', animation: 'imgSkeletonPulse 1.5s ease-in-out infinite' }} />
        )}
        <img
          src={proxied}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('error')}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: status === 'ok' ? 'block' : 'none', ...imgStyle }}
        />
      </div>
      {open && <Lightbox src={url} onClose={() => setOpen(false)} />}
    </>
  );
}

// Keep legacy constants for existing Production Log flow
const MO_REPORT = 'All_MO';
const LOG_FORM = 'Add_Production_Log';
const LOG_REPORT = 'Production_Log_Report';

function buildMOData(mo) {
  const assortment = mo?.standard_assortment || [];
  const colors = [...new Set(assortment.map(it => it.color).filter(Boolean))];
  const sizes  = [...new Set(assortment.map(it => it.size).filter(Boolean))];
  return {
    MO_Number:  mo?.mo_number  || '',
    ITEM_NO:    mo?.chi_style_name || '',
    COLOR_LIST: colors.join(', '),
    SURTIDO:    colors.length ? colors.length + 'COLOR' : '',
    SIZE_LIST:  sizes.join(' '),
  };
}

function parseStandardAssortment(found) {
  const jsonStr = found['Standard_Assortment_JSON'];
  if (!jsonStr || typeof jsonStr !== 'string') return [];
  try {
    let c = jsonStr.trim();
    if (!c.startsWith('[')) c = '[' + c + ']';
    return JSON.parse(c);
  } catch (_) { return []; }
}

function buildMODataFromRaw(rawRecord) {
  if (!rawRecord) return { MO_Number: '', ITEM_NO: '', COLOR_LIST: '', SURTIDO: '', SIZE_LIST: '' };
  let moNum = rawRecord['MO_Number'];
  if (typeof moNum === 'object') moNum = moNum.display_value || '';
  return buildMOData({
    mo_number: moNum || '',
    chi_style_name: rawRecord['Chi_Style_Name'] || '',
    standard_assortment: parseStandardAssortment(rawRecord),
  });
}

const PROCESSES = [
  { code: 'Fabric_In',     zh: '面料入库', ko: '원단입고',  moField: 'Fabric_In_house_Date',  emoji: '📥', zohoValue: 'Fabric In / 원단입고 / 面料入库' },
  { code: 'Cutting_Start', zh: '裁剪开始', ko: '재단 시작', moField: 'Cutting_Start_Date',    emoji: '✂️', zohoValue: 'Cutting Start / 재단 시작 / 裁剪开始' },
  { code: 'Cutting_End',   zh: '裁剪完成', ko: '재단 완료', moField: 'Cutting_End_Date',      emoji: '✅', zohoValue: 'Cutting End / 재단 완료 / 裁剪完成' },
  { code: 'Sewing_Start',  zh: '裁缝开始', ko: '재봉 시작', moField: 'Sewing_Start_Date',     emoji: '🧵', zohoValue: 'Sewing Start / 봉제 시작 / 车缝开始' },
  { code: 'Sewing_End',    zh: '裁缝完成', ko: '재봉 완료', moField: 'Sewing_Completion_Date',emoji: '✅', zohoValue: 'Sewing End / 봉제 완료 / 车缝完成' },
  { code: 'Packing_Start',       zh: '包装开始', ko: '포장 시작', moField: 'Packing_Start_Date',    emoji: '📦',  zohoValue: 'Packing Start / 포장 시작 / 包装开始' },
  { code: 'Packing_End',         zh: '包装完成', ko: '포장 완료', moField: 'Packing_End_Date',      emoji: '✅', zohoValue: 'Packing End / 포장 완료 / 包装完成' },
  { code: 'Production_Complete', zh: '生产完成', ko: '생산 완료', moField: null,                    emoji: '✅',  zohoValue: 'Completed / 생산완료 / 生产完成' },
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
    <div style={{ marginTop: 10, borderTop: '0.5px solid var(--app-divider)', paddingTop: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', fontSize: 11, fontWeight: 700, color: 'var(--app-gold)', letterSpacing: 1, padding: '4px 0', borderBottom: '0.5px solid var(--app-divider)', marginBottom: 4 }}>
        <span>颜色 / 색상</span>
        <span style={{ textAlign: 'center' }}>尺码 / 사이즈</span>
        <span style={{ textAlign: 'right' }}>数量 / 수량</span>
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', fontSize: 12, padding: '5px 0', borderBottom: '0.5px solid var(--app-divider)' }}>
          <span style={{ color: 'var(--text)', display: 'inline-flex', alignItems: 'center' }}><ColorDot text={r.color} />{r.color}</span>
          <span style={{ textAlign: 'center', color: 'var(--text)' }}>{r.size}</span>
          <span style={{ textAlign: 'right', fontWeight: 600, color: 'var(--app-gold)' }}>{r.qty}</span>
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
      <p style={{ color: '#fff', fontSize: 14, marginTop: 16, textAlign: 'center' }}>将二维码对准中心区域 / QR을 중앙에 맞추세요</p>
      <button
        onClick={onCancel}
        style={{ marginTop: 16, padding: '12px 32px', background: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', color: '#1E3A8A' }}
      >取消 / 취소</button>
    </div>
  );
}

// ─── Shared scan-style layout (Production Log / Inner Pack / Master Bag menus) ─
const ScanStyleScreen = memo(function ScanStyleScreen({
  onBack,
  systemLabel = 'IKU PRODUCTION SYSTEM',
  pageLabel,
  pageTitle,
  buttons = [],
  showInstruction = true,
  showBottomHint = true,
}) {
  return (
    <div className="scan-screen">
      <button onClick={onBack} className="atelier-back">← 返回</button>
      <div className="scan-wordmark">{systemLabel}</div>
      <div className="scan-frame-wrap">
        <div className="sc-corner sc-tl"></div>
        <div className="sc-corner sc-tr"></div>
        <div className="sc-corner sc-bl"></div>
        <div className="sc-corner sc-br"></div>
        <div className="sc-inner"><div className="sc-dot"></div></div>
        <div className="sc-line"></div>
      </div>
      {pageLabel && <div className="atelier-page-caption">{pageLabel}</div>}
      {pageTitle && <div className="atelier-page-subtitle">{pageTitle}</div>}
      {showInstruction && (
        <div className="scan-label-wrap">
          <p>QR코드를 프레임 안에 맞춰주세요</p>
          <p>请将二维码对准框内</p>
        </div>
      )}
      {buttons.length > 0 && (
        <div className="atelier-btn-stack">
          {buttons.map((btn, i) => (
            <button key={i} className="atelier-btn-primary" onClick={btn.onClick}>{btn.label}</button>
          ))}
        </div>
      )}
      {showBottomHint && (
        <div className="scan-hint-wrap">
          <p>카메라가 자동으로 QR을 인식합니다</p>
          <p>摄像头将自动识别二维码</p>
        </div>
      )}
    </div>
  );
});

// ─── Existing Production Log screens ──────────────────────────────────
const ScanScreen = memo(function ScanScreen({ onScan, onUpload, onQrQuery, onBack }) {
  return (
    <ScanStyleScreen
      onBack={onBack}
      systemLabel="IKU PRODUCTION SYSTEM"
      buttons={[
        { label: '开始扫码 / 스캔 시작', onClick: onScan },
        { label: '上传二维码 / QR 업로드', onClick: onUpload },
        { label: 'QR查询 / QR 조회', onClick: onQrQuery },
      ]}
      showInstruction={true}
      showBottomHint={true}
    />
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

const InfoScreen = memo(function InfoScreen({ moData, logs, logsLoading, selectedKey, onSelectProcess, onBack }) {
  const notesRows = useMemo(() => parsePlanNotes(moData && moData.plan_notes), [moData]);
  const orderQty = moData && moData.order_qty != null ? moData.order_qty.toLocaleString() + ' 件' : '-';

  // 공정별 최신 기록 맵 (logs는 내림차순 정렬됨 → 첫 항목이 최신)
  const processStatusMap = useMemo(() => {
    if (!logs || !logs.length) return {};
    const map = {};
    logs.forEach(r => {
      const proc = r['Process'];
      if (!proc || map[proc]) return;
      map[proc] = {
        qty: parseInt(r['Completed_Qty']) || 0,
        date: r['Log_Date'] || r['Log_DateTime'] || r['Added_Time'] || '',
      };
    });
    return map;
  }, [logs]);

  const ProcBtn = ({ p, full }) => {
    const st = processStatusMap[p.zohoValue];
    return (
      <div
        className={'proc-btn' + (full ? ' proc-full' : '') + (selectedKey === p.code ? ' selected' : '')}
        onClick={() => onSelectProcess(p.code, p.zh, p.ko, p.moField, p.zohoValue)}
      >
        <span className="proc-icon">{st ? '✅' : p.emoji}</span>
        <div className="proc-name">{p.zh}</div>
        <div className="proc-sub">{p.ko}</div>
        {st ? (
          <>
            <span className="proc-status proc-status-done">✅ 기록완료 {formatDate(String(st.date))}</span>
            <span className="proc-status" style={{ color: 'var(--app-gold, #c9a84c)', fontSize: 10 }}>📦 {st.qty.toLocaleString()}件</span>
          </>
        ) : (
          <span className="proc-status proc-status-pending">⏳ 未记录 / 미기록</span>
        )}
      </div>
    );
  };

  return (
    <div className="screen active" id="screen-info" style={{ background: 'var(--surface2)', minHeight: '100vh', width: '100%', padding: 16 }}>
      <button className="back-link" onClick={onBack}>← 重新扫码</button>
      {moData?.is_shipped && (
        <div style={{ background:'rgba(220,38,38,0.12)', border:'1px solid rgba(220,38,38,0.4)', borderRadius:8, padding:'10px 14px', marginBottom:12, fontSize:12, color:'#FCA5A5' }}>
          ⚠ 此订单已出货 / 이 오더는 이미 출고되었습니다<br />
          <span style={{ fontSize:11, opacity:.8 }}>继续操作可能产生异常记录 / 추가 작업 시 비정상 기록 발생 가능</span>
        </div>
      )}
      {moData?.is_completed && (
        <div style={{ background:'rgba(16,185,129,0.1)', border:'1px solid rgba(16,185,129,0.35)', borderRadius:8, padding:'10px 14px', marginBottom:12, fontSize:12, color:'#6EE7B7' }}>
          ℹ 此订单生产已完成 / 이 오더 생산이 완료되었습니다
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title">订单信息 / 주문 정보</div>
        {/* 상단 2열 */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {/* 좌측: 텍스트 전체 */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* [1] 1줄 형식 label : value */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', flexShrink: 0 }}>订单号 / MO : </span>
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{(moData && moData.mo_number) || '-'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', flexShrink: 0 }}>工厂 / 공장 : </span>
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-primary)' }}>{(moData && moData.factory) || '-'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', flexShrink: 0 }}>订单数量 / 주문 수량 : </span>
                <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-primary)' }}>{orderQty}</span>
              </div>
              {moData && moData.fabric ? (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', flexShrink: 0 }}>面料 / 원단 : </span>
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-primary)' }}>{moData.fabric}</span>
                </div>
              ) : null}
            </div>
            {/* [2] 구분선(텍스트 컬럼 너비) + 2줄 블록 */}
            {(moData?.sku || moData?.chi_style_name) ? (
              <>
                <div style={{ borderTop: '0.5px solid var(--border-subtle)', margin: '8px 0' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {moData?.sku ? (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>品号 / SKU</div>
                      <div style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{moData.sku}</div>
                    </div>
                  ) : null}
                  {moData?.chi_style_name ? (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>中文款名 / 중문 스타일명</div>
                      <div style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-text-primary)' }}>{moData.chi_style_name}</div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          {/* 우측: 88×210 이미지, contain + top 정렬 */}
          <MOImageThumb
            url={moData && moData.style_image_url}
            containerStyle={{
              width: 88, height: 210, flexShrink: 0, alignSelf: 'flex-start',
              borderRadius: 8, background: 'var(--color-background-secondary)',
              aspectRatio: undefined,
            }}
            imgStyle={{ objectFit: 'contain', objectPosition: 'top' }}
          />
        </div>
        {/* 하단 전체 너비: 구분선 + 当前状态 */}
        <div style={{ borderTop: '0.5px solid var(--border-subtle)', marginTop: 10, paddingTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>当前状态 / 현재 상태</span>
          <span className="status-pill">{(moData && moData.current_status) || '-'}</span>
        </div>
      </div>

      {notesRows.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-title">订单明细 / 주문내용</div>
          <NotesTable planNotes={moData.plan_notes} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="process-title">请选择当前工序 / 현재 공정 선택</div>
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

      <div className="card" id="log-section" style={{ marginBottom: 12 }}>
        <div className="card-title">工序记录 / 공정기록</div>
        <div id="log-list">
          {logsLoading ? (
            <div className="log-loading"><div className="log-spinner"></div>加载中 / 로딩...</div>
          ) : !logs || logs.length === 0 ? (
            <div className="log-empty">暂无工序记录 / 공정 기록 없음</div>
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
              <div key={i} className="log-item">
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

  const showBag = process.key.indexOf('Packing') >= 0;
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
        <div className="card-title">订单确认 / 주문 확인</div>
        <div className="info-row"><span className="info-label">订单号 / MO</span><span className="info-value">{(moData && moData.mo_number) || '-'}</span></div>
        <div className="info-row"><span className="info-label">SKU</span><span className="info-value">{(moData && moData.sku) || '-'}</span></div>
        <div className="info-row"><span className="info-label">工序 / 공정</span><span className="info-value" style={{ color: '#1E3A8A' }}>{process.key ? process.cn + ' (' + process.key + ')' : '-'}</span></div>
        <div className="info-row"><span className="info-label">订单数量 / 주문 수량</span><span className="info-value" style={{ color: '#7C3AED' }}>{orderQty}</span></div>
        <div><NotesTable planNotes={moData && moData.plan_notes} /></div>
      </div>

      <div style={{ padding: '0 16px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div className="qty-card">
          <div className="qty-card-label">完成 / 완료 *</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={completed} onChange={(e) => setCompleted(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        <div className="qty-card muted">
          <div className="qty-card-label">未完成 / 미완료</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={incomplete} onChange={(e) => setIncomplete(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        <div className="qty-card danger">
          <div className="qty-card-label">不良 / 불량</div>
          <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={defect} onChange={(e) => setDefect(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        {showBag && (
          <div className="qty-card muted">
            <div className="qty-card-label">麻袋数量 / 마대 수량</div>
            <input className="input-field" type="number" placeholder="0" min="0" inputMode="numeric" value={bag} onChange={(e) => setBag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
          </div>
        )}
        <div className="field-card">
          <div className="field-card-label">负责人 / 담당자 *</div>
          <input className="input-field text-field" type="text" placeholder="姓名 / 이름" value={worker} onChange={(e) => setWorker(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
        <div className="field-card">
          <div className="field-card-label">备注 / 메모</div>
          <input className="input-field text-field" type="text" placeholder="选填 / 선택사항" value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }} />
        </div>
      </div>

      <div>{err && <div className="err-box">{err}</div>}</div>
      <div className="btn-row" style={{ marginTop: 12, paddingBottom: 24 }}>
        <button className="btn-back" onClick={onBack}>← 返回</button>
        <button className="btn-submit" disabled={submitting} onClick={handleSubmit}>{submitting ? '提交中 / 처리중...' : '确认提交 / 제출 →'}</button>
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
            <div style={{ fontSize: 10, color: 'var(--text4)', letterSpacing: 1, marginTop: 6, fontWeight: 500 }}>工艺记录已保存 · 进度自动更新 · 공정 기록 저장됨</div>
          </div>
        </div>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <ResultRow label="工艺 / 공정" value={(result.processCN || '') + (result.processKO ? ' / ' + result.processKO : '') + ' · ' + result.process} accent />
          <ResultRow label="完成数量 / 완성수량"  value={result.completed.toLocaleString() + ' 件'} />
          {result.incomplete > 0 && <ResultRow label="未完成数量 / 미완성수량" value={result.incomplete.toLocaleString() + ' 件'} />}
          {result.defect > 0     && <ResultRow label="不良数量 / 불량수량"  value={result.defect.toLocaleString() + ' 件'} danger />}
          <ResultRow label="负责人 / 담당자"    value={result.worker} />
          <ResultRow label="记录时间 / 기록시간"  value={result.time} mute />
          {result.notes && <ResultRow label="备注 / 메모" value={result.notes} mute />}
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
          <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', letterSpacing: '-.3px' }}>工序记录 / 공정 기록 상세</span>
          <span onClick={onClose} style={{ cursor: 'pointer', fontSize: 18, color: 'var(--text4)', padding: '4px 8px', borderRadius: 6 }}>✕</span>
        </div>
        <div className="modal-row"><span className="modal-label">工序 / 공정</span><span className="modal-value">{process}</span></div>
        <div className="modal-row"><span className="modal-label">完成数量 / 완성수량</span><span className="modal-value">{completed} 件</span></div>
        <div className="modal-row"><span className="modal-label">未完成数量 / 미완성수량</span><span className="modal-value">{incomplete} 件</span></div>
        <div className="modal-row"><span className="modal-label">不良数量 / 불량수량</span><span className="modal-value">{defect} 件</span></div>
        <div className="modal-row"><span className="modal-label">负责人 / 담당자</span><span className="modal-value">{worker}</span></div>
        <div className="modal-row"><span className="modal-label">记录时间 / 기록시간</span><span className="modal-value">{date}</span></div>
        <div className="modal-row"><span className="modal-label">备注 / 메모</span><span className="modal-value">{notes}</span></div>
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
        <div style={{ fontSize:22, color:'var(--gold-light)', marginTop:10, fontWeight:300, letterSpacing:2 }}>手动输入订单号 / 수동 MO 입력</div>
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
          placeholder="例 / 예: GJ26-001"
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

// Probe a record for a Zoho image field URL.
// Returns the first absolute URL found, or '' if none.
// Handles:
//   - string "https://..." → direct
//   - string "[\"\/api\/v2.1\/...\"]" → JSON-encoded array of relative paths
//   - JS array of strings or objects
//   - object with download_url / url / display_value / value
const ZOHO_CREATOR_BASE = 'https://creator.zoho.com';
const STYLE_IMAGE_KEYS = ['Style_Image', 'Style_Photo', 'Product_Image', 'Image', 'Photo'];
function pickUrlFromValue(v) {
  if (!v) return '';
  // JSON-encoded string array from Zoho Creator image field, e.g.
  // "[\"/api/v2.1/jeramoda/eom/report/All_MO/.../download?filepath=...\"]"
  if (typeof v === 'string' && v.trimStart().startsWith('[')) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr) && arr.length > 0) {
        const path = String(arr[0] || '');
        if (path.startsWith('http')) return path;
        if (path.startsWith('/')) return ZOHO_CREATOR_BASE + path;
      }
    } catch (_) { /* fall through */ }
    return '';
  }
  if (typeof v === 'string') {
    if (v.startsWith('http')) return v;
    if (v.startsWith('/')) return ZOHO_CREATOR_BASE + v;
    return '';
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = pickUrlFromValue(item);
      if (s) return s;
    }
    return '';
  }
  const s = String(v.download_url || v.url || v.display_value || v.value || '');
  if (s.startsWith('http')) return s;
  if (s.startsWith('/')) return ZOHO_CREATOR_BASE + s;
  return '';
}
function extractImageUrl(rec) {
  if (!rec) return '';
  // Priority: direct JSON-array string from Zoho Creator image field.
  // e.g. Style_Image = '["/api/v2.1/.../download?filepath=..."]'
  for (const k of STYLE_IMAGE_KEYS) {
    const raw = rec[k];
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (t.startsWith('[')) {
        try {
          // Zoho sometimes returns [#"..."] — strip the # before parsing
          const arr = JSON.parse(t.replace(/^\[#/, '['));
          if (Array.isArray(arr)) {
            for (const item of arr) {
              const p = String(item || '');
              if (p.startsWith('/')) return 'https://creator.zoho.com' + p;
              if (p.startsWith('http')) return p;
            }
          }
        } catch (_) {}
      } else if (t.startsWith('http')) {
        return t;
      }
    }
  }
  // Fallback: generic object/array probe via pickUrlFromValue.
  for (const k of STYLE_IMAGE_KEYS) {
    const s = pickUrlFromValue(rec[k]);
    if (s) return s;
  }
  for (const k of STYLE_IMAGE_KEYS) {
    const s = readLookupSubfield(rec, ['Style_SKU', 'Style', 'Styles', 'Style_Name'], k);
    if (s && s.startsWith('http')) return s;
  }
  return '';
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

const IconReserved = () => (
  <svg viewBox="0 0 48 48" width="42" height="42" fill="none" stroke="var(--app-gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 20 L24 8 L42 20 L42 44 L6 44 Z"/>
    <line x1="6" y1="20" x2="42" y2="20"/>
    <rect x="19" y="30" width="10" height="14" rx="1"/>
    <rect x="8" y="24" width="9" height="9" rx="1"/>
    <rect x="31" y="24" width="9" height="9" rx="1"/>
    <line x1="24" y1="8" x2="24" y2="20"/>
  </svg>
);

// ─── NEW: Home Screen ─────────────────────────────────────────────────
const HomeScreen = memo(function HomeScreen({ onSelectProductionLog, onSelectInnerPack, onSelectMasterBag, onSelectStatusScan, onSelectReserved, onSelectRecentActivity }) {
  return (
    <div style={{ minHeight:'100vh', background:'var(--bg-base)' }}>
      <div className="atelier-home">
        <header className="atelier-header">
          <div className="atelier-mark">IKU</div>
          <div className="atelier-divider"></div>
          <p className="atelier-tagline">생산 관리 시스템</p>
          <p className="atelier-tagline-cn">生产管理系统</p>
        </header>
        <nav className="atelier-menu">
          <div className="atelier-menu-item" onClick={onSelectProductionLog}>
            <span className="atelier-index">01</span>
            <span className="atelier-title">生产进度</span>
            <span className="atelier-subtitle">생산 진척</span>
            <span className="atelier-arrow">→</span>
          </div>
          <div className="atelier-menu-item" onClick={onSelectInnerPack}>
            <span className="atelier-index">02</span>
            <span className="atelier-title">中包袋</span>
            <span className="atelier-subtitle">중간포장</span>
            <span className="atelier-arrow">→</span>
          </div>
          <div className="atelier-menu-item" onClick={onSelectMasterBag}>
            <span className="atelier-index">03</span>
            <span className="atelier-title">麻袋包装</span>
            <span className="atelier-subtitle">마대 포장</span>
            <span className="atelier-arrow">→</span>
          </div>
          <div className="atelier-menu-item" onClick={onSelectReserved}>
            <span className="atelier-index">04</span>
            <span className="atelier-title">中国仓库保留</span>
            <span className="atelier-subtitle">중국창고 보관</span>
            <span className="atelier-arrow">→</span>
          </div>
          <div className="atelier-menu-item" onClick={onSelectRecentActivity}>
            <span className="atelier-index">05</span>
            <span className="atelier-title">最近记录</span>
            <span className="atelier-subtitle">최근 기록</span>
            <span className="atelier-arrow">→</span>
          </div>
        </nav>
      </div>
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
        <div style={{ fontSize: 20, color: G.cream, marginTop: 6, fontWeight: 300, letterSpacing: 1 }}>选择更新状态 / 상태 선택</div>
        <div style={{ fontSize: 10, color: G.goldDim, marginTop: 4, letterSpacing: 2 }}>扫描麻袋 QR 自动更新 / 마대 QR 스캔 시 자동 갱신</div>
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
        <div style={{ fontSize: 20, color: G.cream, marginTop: 10, fontWeight: 300, letterSpacing: 1 }}>扫描麻袋 QR / 마대 QR 스캔</div>
        <div style={{ display: 'inline-block', border: '1px solid rgba(212,175,55,0.5)', padding: '4px 16px', fontSize: 11, color: G.gold, letterSpacing: 1, marginTop: 12 }}>{statusLabel}</div>
        <div style={{ fontSize: 10, color: G.goldDim, marginTop: 10 }}>将麻袋 QR 对准摄像头 / 마대 QR을 스캔하세요</div>
      </div>
      <DkBtn onClick={onScan}>📷 开始扫描 / 스캔 시작</DkBtn>
      <DkBtnOutline onClick={onBack}>← 重新选择状态 / 상태 다시 선택</DkBtnOutline>
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
          <DkRow label="订单 / MO" value={result.moNum} />
          <DkRow label="麻袋 # / Bag #" value={String(result.bagSeq)} />
          <DkRow label="麻袋 UUID / Bag UUID" value={result.bagUuid} mono />
          <DkRow label="已更新包装 / 갱신된 포장" value={String(result.packCount) + ' packs'} />
        </DkCard>
        <DkBtn onClick={onContinue}>📷 继续扫描 / 계속 스캔</DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Pack Menu Screen ────────────────────────────────────────────
const PackMenuScreen = memo(function PackMenuScreen({ onStandard, onLeftover, onQueryMenu, onBack }) {
  return (
    <ScanStyleScreen
      onBack={onBack}
      systemLabel="IKU PRODUCTION SYSTEM"
      pageLabel="INNER PACK"
      pageTitle="中包袋 / 중간포장"
      buttons={[
        { label: '标准中包袋 / 표준중간포장', onClick: onStandard },
        { label: '尾包 / 자투리포장', onClick: onLeftover },
        { label: 'QR 查询 / QR 조회', onClick: onQueryMenu },
      ]}
      showInstruction={true}
      showBottomHint={true}
    />
  );
});

// ─── Bag Menu Screen ──────────────────────────────────────────────────
const BagMenuScreen = memo(function BagMenuScreen({ onCreate, onQueryMenu, onBulkShip, onBack }) {
  return (
    <ScanStyleScreen
      onBack={onBack}
      systemLabel="IKU PRODUCTION SYSTEM"
      pageLabel="MASTER BAG"
      pageTitle="麻袋包装 / 마대"
      buttons={[
        { label: '新建麻袋 / 새 마대 생성', onClick: onCreate },
        { label: '批量出货 / 일괄 출고', onClick: onBulkShip },
        { label: 'QR 查询 / QR 조회', onClick: onQueryMenu },
      ]}
      showInstruction={true}
      showBottomHint={true}
    />
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
        <DkInput value={manualMO} onChange={e => setManualMO(e.target.value)} placeholder="例 / 예: GJ26-1" onKeyDown={e => { if (e.key === 'Enter') handleManualSubmit(); }} />
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
        <DkInput value={manualMO} onChange={e => setManualMO(e.target.value)} placeholder="例 / 예: GJ26-1" onKeyDown={e => { if (e.key === 'Enter') handleManualSubmit(); }} />
        <DkBtn onClick={handleManualSubmit} style={{ marginTop:8, marginBottom:0 }}>确认 / 확인</DkBtn>
      </DkCard>
    </DkScreen>
  );
});

// ─── NEW: Standard Pack — Worker Input Gate ───────────────────────────
// Standard record is created/updated with this worker name. Required.
const StandardPackWorkerInputScreen = memo(function StandardPackWorkerInputScreen({
  moNumber, worker, setWorker, onConfirm, onBack, submitting,
}) {
  const trimmed = (worker || '').trim();
  const ready = trimmed.length > 0 && !submitting;
  return (
    <DkScreen style={{ padding:'80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:36 }}>
        <div style={{ fontSize:9, letterSpacing:4, color:G.goldDim, fontWeight:400 }}>STEP 2 / 3</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:10, fontWeight:400, letterSpacing:1 }}>担当者 / 담당자</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:4 }}>{moNumber}</div>
      </div>
      <DkCard>
        <DkInput
          label="담당자 이름 / 担当者"
          value={worker}
          onChange={e => setWorker(e.target.value)}
          placeholder="담당자 / 担当者 이름"
          onKeyDown={e => { if (e.key === 'Enter' && ready) onConfirm(trimmed); }}
        />
        <div style={{ fontSize:10, color:G.goldDim, marginTop:4 }}>
          담당자 이름이 표준중간포장 레코드에 저장됩니다 / 担当者将保存到标准中包袋记录
        </div>
      </DkCard>
      <DkBtn onClick={() => onConfirm(trimmed)} disabled={!ready}>
        {submitting ? '处理中...' : '확인 / 确认'}
      </DkBtn>
    </DkScreen>
  );
});

// ─── NEW: Standard Pack QR Screen ─────────────────────────────────────
// Shared QR for every standard (12-pcs) Inner Pack of an MO. User picks
// how many physical copies of the same label to print/download.
const StandardPackQRScreen = memo(function StandardPackQRScreen({
  standardPack, packMO, copies, setCopies, worker, onLogActivity, onBumpTotalExpected, onBack, onHome,
}) {
  const [copyMode, setCopyMode] = useState('mo'); // 'mo' | 'manual' | 'one'
  const [manualInput, setManualInput] = useState(String(copies || 1));
  const [downloading, setDownloading] = useState(false);

  const recommended = packMO?.order_qty > 0
    ? Math.ceil(packMO.order_qty / INNER_PACK_SIZE) : 1;

  const applyMode = (mode) => {
    setCopyMode(mode);
    if (mode === 'mo') { setCopies(recommended); setManualInput(String(recommended)); }
    else if (mode === 'one') { setCopies(1); setManualInput('1'); }
  };

  const handleManualChange = (e) => {
    const v = e.target.value.replace(/[^\d]/g, '');
    setManualInput(v);
    setCopyMode('manual');
    const n = parseInt(v) || 0;
    if (n > 0) setCopies(n);
  };

  const N = Math.max(1, parseInt(copies) || 1);
  const moData = packMO ? buildMOData(packMO) : null;

  const logDownload = (channel, n) => {
    if (!onLogActivity) return;
    onLogActivity({
      timestamp: Date.now(),
      type: 'inner_pack',
      action: 'standard_downloaded',
      moNumber: packMO?.mo_number,
      moStyleSku: packMO?.sku || '',
      packNumbers: [0],
      bagNumbers: null,
      pieceCount: INNER_PACK_SIZE,
      creator: worker || '',
      channel,
      copies: n,
    });
  };

  const handlePNG = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const label = `${packMO.mo_number} / 표준중간포장 / ${INNER_PACK_SIZE} pcs`;
      const dataURL = await generateQRDataURLWithLabel(standardPack.qrText, label);
      downloadQRPNG(dataURL, sanitizeFilename(`${packMO.mo_number}_Standard_InnerPack.png`));
      logDownload('png', 1);
      if (onBumpTotalExpected) await onBumpTotalExpected(1);
    } catch (err) { alert('PNG 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
  };

  const handleExcel = async () => {
    if (downloading || !moData) return;
    setDownloading(true);
    try {
      const standardPackItem = {
        packNumber: 0,
        qrText: standardPack.qrText,
        totalQty: INNER_PACK_SIZE,
        isRemainder: false,
        isStandard: true,
        items: null,
      };
      const packList = Array(N).fill(standardPackItem);
      await generateInnerPackExcel(
        moData, packList,
        sanitizeFilename(`${packMO.mo_number}_Standard_InnerPack_${N}copies.xlsx`)
      );
      logDownload('excel', N);
      if (onBumpTotalExpected) await onBumpTotalExpected(N);
    } catch (err) { alert('Excel 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
  };

  const handlePDF = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const qrItems = Array.from({ length: N }, (_, i) => ({
        text: standardPack.qrText,
        filename: sanitizeFilename(`${packMO.mo_number}_Standard_InnerPack_${i + 1}.png`),
      }));
      await downloadQRsAsPDF(
        qrItems,
        sanitizeFilename(`${packMO.mo_number}_Standard_InnerPack_${N}copies.pdf`)
      );
      logDownload('pdf', N);
      if (onBumpTotalExpected) await onBumpTotalExpected(N);
    } catch (err) { alert('PDF 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
  };

  const radioRow = (mode, body) => (
    <div onClick={() => applyMode(mode)} style={{
      display:'flex', alignItems:'flex-start', gap:10, padding:'10px 0',
      cursor:'pointer', borderBottom:'1px solid var(--app-divider)',
    }}>
      <div style={{
        width:14, height:14, marginTop:3, borderRadius:'50%',
        border:'1px solid '+(copyMode===mode?G.gold:G.border),
        background: copyMode===mode ? G.btnBg : 'transparent',
        flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        {copyMode===mode && <div style={{ width:6, height:6, background:G.gold, borderRadius:'50%' }} />}
      </div>
      <div style={{ flex:1 }}>{body}</div>
    </div>
  );

  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>STANDARD PACK QR</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{packMO?.mo_number}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{INNER_PACK_SIZE} pcs · 共享QR / 공유 QR</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard style={{ textAlign:'center', padding:20 }}>
          <img src={standardPack.qrDataURL} alt="QR" style={{ width:200, height:200, margin:'0 auto', display:'block', borderRadius:2 }} />
          <div style={{ fontSize:10, color:G.cream, marginTop:14, lineHeight:1.5 }}>
            모든 표준중간포장(12pcs)에 동일한 QR을 사용합니다
          </div>
          <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>
            所有标准中包袋使用同一QR码
          </div>
        </DkCard>

        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:6, fontWeight:400 }}>
            인쇄 매수 선택 / 选择打印数量
          </div>

          {radioRow('manual', (
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:12, color:G.cream }}>직접 입력 / 直接输入:</span>
              <input
                type="text" inputMode="numeric" value={manualInput}
                onChange={handleManualChange}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width:60, padding:'4px 8px', background:'transparent',
                  border:'1px solid '+G.border, borderRadius:2, color:G.gold,
                  fontSize:13, textAlign:'center', fontFamily:'inherit', outline:'none',
                }}
              />
              <span style={{ fontSize:11, color:G.goldDim }}>장 / 张</span>
            </div>
          ))}

          {radioRow('mo', (
            <div>
              <div style={{ fontSize:12, color:G.cream }}>MO 기준 자동 계산 / 按MO自动</div>
              <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>
                Plan_Total_Quantity({packMO?.order_qty || 0}) ÷ {INNER_PACK_SIZE} = {recommended}张 / 장 권장
              </div>
            </div>
          ))}

          {radioRow('one', (
            <div style={{ fontSize:12, color:G.cream }}>1장 (빠른 다운로드) / 1张快速下载</div>
          ))}
        </DkCard>

        <DkBtn onClick={handlePNG} disabled={downloading}>
          {downloading ? '处理中...' : '📷 PNG (1장 / 1张)'}
        </DkBtn>
        <DkBtn onClick={handleExcel} disabled={downloading || !moData}>
          {downloading ? '处理中...' : `📊 Excel (${N}장 / ${N}张)`}
        </DkBtn>
        <DkBtn onClick={handlePDF} disabled={downloading}>
          {downloading ? '处理中...' : `📄 PDF (${N}장 / ${N}张)`}
        </DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── Production Log: Scan-or-Manual Choice ───────────────────────────
const LogScanChoiceScreen = memo(function LogScanChoiceScreen({ onScan, onManual, onBack }) {
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
        <div style={{ fontSize:20, color:G.cream, fontWeight:400, letterSpacing:1 }}>扫描或输入 / 스캔 또는 입력</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:6 }}>Scan QR code or enter manually</div>
      </div>
      <DkBtn onClick={onScan}>📷 扫描 MO QR / QR 스캔</DkBtn>
      <div style={{ textAlign:'center', color:G.goldDim, fontSize:10, letterSpacing:2, margin:'10px 0' }}>— OR —</div>
      <DkCard>
        <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>手动输入 / 수동 입력</div>
        <DkInput value={manualMO} onChange={e => setManualMO(e.target.value)} placeholder="例 / 예: GJ26-1" onKeyDown={e => { if (e.key === 'Enter') handleManualSubmit(); }} />
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
  const totalQty = isRemainder
    ? composition.filter(c => c.selected).reduce((sum, c) => sum + (parseInt(c.qty) || 1), 0)
    : selectedCount;

  const applyStandard = () => setComposition(composition.map(c => ({ ...c, selected: true, qty: 1 })));
  const applyLastPack = () => {
    if (!lastComposition) return;
    setComposition(composition.map(c => {
      const found = lastComposition.find(l => l.color === c.color && l.size === c.size);
      return { ...c, selected: !!found, qty: found ? (parseInt(found.qty) || 1) : (parseInt(c.qty) || 1) };
    }));
  };
  const toggleItem = (idx) => {
    const next = [...composition];
    const wasSelected = next[idx].selected;
    next[idx] = { ...next[idx], selected: !wasSelected, qty: !wasSelected ? 1 : (parseInt(next[idx].qty) || 1) };
    setComposition(next);
  };
  const changeQty = (idx, delta) => {
    const next = [...composition];
    const item = next[idx];
    const newQty = Math.max(1, Math.min(99, (parseInt(item.qty) || 1) + delta));
    next[idx] = { ...item, qty: newQty, selected: true };
    setComposition(next);
  };
  const toggleRemainder = () => {
    const next = !isRemainder;
    setIsRemainder(next);
    if (!next) {
      setComposition(composition.map(c => ({ ...c, selected: true, qty: 1 })));
    }
  };
  const handleSubmit = () => {
    if (selectedCount === 0 || totalQty === 0) { alert('请选择至少 1 件 / 최소 1개 이상 선택'); return; }
    if (!isRemainder && selectedCount !== INNER_PACK_SIZE) {
      if (!window.confirm(`당 상 ${INNER_PACK_SIZE}개가 아닙니다 (${selectedCount}개). 계속? / Not ${INNER_PACK_SIZE} items (${selectedCount}). Continue?`)) return;
    }
    if (!worker.trim()) { alert('请输入负责人 / 담당자를 입력하세요'); return; }
    onSubmit();
  };

  const stepperBtn = (label, onClick, disabled) => (
    <button onClick={onClick} disabled={disabled}
      style={{ width:40, height:40, border:'1px solid '+(disabled?G.border:G.borderHover), borderRadius:2, background:'transparent', color:disabled?G.border:G.gold, fontSize:18, lineHeight:'1', cursor:disabled?'default':'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, touchAction:'manipulation' }}>
      {label}
    </button>
  );

  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>INNER PACK #{packSequence}</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{packMO.mo_number}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{packMO.sku} · {packMO.factory}</div>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:12 }}>
          {isRemainder ? (
            <>
              <div style={{ fontSize:11, color:G.gold }}>{totalQty} 件</div>
              <div style={{ flex:1, height:2, background:G.progressTrack, borderRadius:1 }}>
                <div style={{ height:'100%', background:G.gold, width:'100%', borderRadius:1 }} />
              </div>
              <div style={{ fontSize:11, color:G.goldDim }}>자투리</div>
            </>
          ) : (
            <>
              <div style={{ fontSize:11, color:G.gold }}>{selectedCount}</div>
              <div style={{ flex:1, height:2, background:G.progressTrack, borderRadius:1 }}>
                <div style={{ height:'100%', background:G.gold, width:Math.min(100, selectedCount / INNER_PACK_SIZE * 100) + '%', borderRadius:1, transition:'width .2s' }} />
              </div>
              <div style={{ fontSize:11, color:G.goldDim }}>{INNER_PACK_SIZE}</div>
            </>
          )}
        </div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>包装组成 / 포장 구성</div>
          {!isRemainder && (
            <div style={{ display:'flex', gap:8, marginBottom:14 }}>
              <button onClick={applyStandard} style={{ flex:1, padding:'9px 8px', border:'1px solid '+G.borderHover, borderRadius:2, background:G.btnBg, color:G.gold, fontSize:10, letterSpacing:1, cursor:'pointer', fontFamily:'inherit' }}>标准 / Standard</button>
              {lastComposition && (
                <button onClick={applyLastPack} style={{ flex:1, padding:'9px 8px', border:'1px solid '+G.border, borderRadius:2, background:'transparent', color:G.goldDim, fontSize:10, letterSpacing:1, cursor:'pointer', fontFamily:'inherit' }}>上次 / Copy Last</button>
              )}
            </div>
          )}
          <div style={{ maxHeight:isRemainder ? 340 : 260, overflowY:'auto' }}>
            {composition.length === 0 ? (
              <div style={{ textAlign:'center', color:G.goldDim, padding:20, fontSize:11, letterSpacing:1 }}>此订单没有标准配货信息</div>
            ) : composition.map((item, idx) => (
              isRemainder ? (
                <div key={idx} style={{ display:'flex', alignItems:'center', padding:'10px 0', borderBottom: idx < composition.length - 1 ? '1px solid var(--app-divider)' : 'none', gap:10 }}>
                  <div onClick={() => toggleItem(idx)} style={{ width:20, height:20, border:'1px solid '+(item.selected?G.gold:G.border), borderRadius:2, background:item.selected?G.btnBg:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                    {item.selected && <div style={{ width:10, height:10, background:G.gold, borderRadius:1 }} />}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, color:item.selected?G.cream:G.goldDim, fontWeight:400, display:'flex', alignItems:'center' }}><ColorDot text={item.color} />{item.color}</div>
                    <div style={{ fontSize:10, color:G.goldDim, marginTop:1 }}>Size: {item.size}</div>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                    {stepperBtn('−', () => { if ((parseInt(item.qty)||1) <= 1) toggleItem(idx); else changeQty(idx, -1); }, !item.selected)}
                    <div style={{ width:32, textAlign:'center', fontSize:15, color:item.selected?G.cream:G.border, fontWeight:400 }}>
                      {item.selected ? (parseInt(item.qty) || 1) : 0}
                    </div>
                    {stepperBtn('+', () => changeQty(idx, 1), !item.selected)}
                  </div>
                </div>
              ) : (
                <div key={idx} onClick={() => toggleItem(idx)} style={{ display:'flex', alignItems:'center', padding:'10px 0', borderBottom: idx < composition.length - 1 ? '1px solid var(--app-divider)' : 'none', cursor:'pointer' }}>
                  <div style={{ width:16, height:16, border:'1px solid '+(item.selected?G.gold:G.border), borderRadius:2, marginRight:12, background:item.selected?G.btnBg:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {item.selected && <div style={{ width:8, height:8, background:G.gold, borderRadius:1 }} />}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, color:G.cream, fontWeight:400, display:'flex', alignItems:'center' }}><ColorDot text={item.color} />{item.color}</div>
                    <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>Size: {item.size}</div>
                  </div>
                  <div style={{ fontSize:11, color:G.goldDim }}>×{item.qty || 1}</div>
                </div>
              )
            ))}
          </div>
          {isRemainder && totalQty > 0 && (
            <div style={{ marginTop:12, paddingTop:10, borderTop:'1px solid var(--app-divider)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontSize:10, color:G.goldDim }}>合计 / 합계</span>
              <span style={{ fontSize:15, color:G.gold, fontWeight:400 }}>{totalQty} 件</span>
            </div>
          )}
        </DkCard>
        <DkCard>
          <label style={{ display:'flex', alignItems:'center', cursor:'pointer', gap:12 }}>
            <div onClick={toggleRemainder} style={{ width:16, height:16, border:'1px solid '+(isRemainder?G.gold:G.border), borderRadius:2, background:isRemainder?G.btnBg:'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
              {isRemainder && <div style={{ width:8, height:8, background:G.gold, borderRadius:1 }} />}
            </div>
            <div>
              <div style={{ fontSize:12, color:G.cream, fontWeight:400 }}>剩余包装 / 자투리 포장</div>
              <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>末尾零头, 不是{INNER_PACK_SIZE}件标准包装</div>
            </div>
          </label>
        </DkCard>
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => setWorker(e.target.value)} placeholder="姓名 / 이름" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
        </DkCard>
        <DkBtn onClick={handleSubmit} disabled={submitting || totalQty === 0} style={{ marginTop:8, padding:18, fontSize:11, letterSpacing:3 }}>
          {submitting ? '保存中...' : totalQty === 0
            ? '请选择 / 선택하세요'
            : isRemainder
              ? `✅ ${totalQty}件 打包完成 / 포장 완료 (剩余 / 자투리)`
              : `✅ ${totalQty}件 打包完成 / 포장 완료`}
        </DkBtn>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Pack Success Screen ─────────────────────────────────────────
const PackSuccessScreen = memo(function PackSuccessScreen({ pack, moData, onNextPack, onHome }) {
  if (!pack) return null;
  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    const label = `${pack.moNumber} / Inner Pack #${pack.packSequence} / ${pack.totalQty} pcs`;
    const dataURL = await generateQRDataURLWithLabel(pack.qrText, label);
    downloadQRPNG(dataURL, sanitizeFilename(`${pack.moNumber}_InnerPack_${pack.packSequence}_${pack.totalQty}pcs.png`));
  };
  const handleExcel = async () => {
    if (!moData || downloading) return;
    setDownloading(true);
    try {
      await generateInnerPackExcel(moData, [{
        packNumber: pack.packSequence, qrText: pack.qrText,
        totalQty: pack.totalQty, isRemainder: pack.isRemainder || false, items: pack.items || [],
      }], sanitizeFilename(`${pack.moNumber}_InnerPack_#${pack.packSequence}.xlsx`));
    } catch (err) { alert('Excel 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
  };
  const handlePDF = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadQRsAsPDF(
        [{ text: pack.qrText, filename: sanitizeFilename(`${pack.moNumber}_InnerPack_${pack.packSequence}.png`) }],
        sanitizeFilename(`${pack.moNumber}_InnerPack_#${pack.packSequence}.pdf`)
      );
    } catch (err) { alert('PDF 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
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
                <div style={{ fontSize:11, color:G.cream, fontWeight:400, display:'flex', alignItems:'center' }}><ColorDot text={item.color} />{item.color}</div>
                <div style={{ fontSize:10, color:G.goldDim }}>{item.size} · {item.qty}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop:12, paddingTop:10, borderTop:'1px solid var(--app-divider)', fontSize:11, color:G.goldDim, letterSpacing:1 }}>
            Total <span style={{ color:G.gold }}>{pack.totalQty} 件</span>{pack.isRemainder ? ' · 剩余' : ''}
          </div>
        </DkCard>
        <DkBtn onClick={handleDownload} disabled={downloading}>📷 QR 이미지 다운로드 / QR 图片下载</DkBtn>
        <DkBtn onClick={handleExcel} disabled={downloading || !moData}>
          {downloading ? '처리중...' : '📊 Excel 다운로드 / Excel 下载'}
        </DkBtn>
        <DkBtn onClick={handlePDF} disabled={downloading}>
          {downloading ? '처리중...' : '📄 PDF 다운로드 / PDF 下载'}
        </DkBtn>
        <DkBtn onClick={onNextPack}>➕ 继续下一包 / 다음 포장</DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Color × Size quantity matrix (used in pack detail) ─────────
const ColorSizeMatrix = memo(function ColorSizeMatrix({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  // Group by color, then by size
  const byColor = new Map();
  const sizeSet = new Set();
  for (const it of items) {
    const color = (it?.color || '').trim();
    const size  = (it?.size  || '').trim();
    const qty   = parseInt(it?.qty) || 0;
    if (!color || !size) continue;
    sizeSet.add(size);
    if (!byColor.has(color)) byColor.set(color, new Map());
    const sizeMap = byColor.get(color);
    sizeMap.set(size, (sizeMap.get(size) || 0) + qty);
  }
  if (byColor.size === 0) return null;
  const sizes = Array.from(sizeSet);
  const colors = Array.from(byColor.keys());
  return (
    <DkCard>
      <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>색상/사이즈 수량 / 颜色/尺码数量</div>
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11, color:G.cream }}>
          <thead>
            <tr style={{ borderBottom:'1px solid var(--app-divider)' }}>
              <th style={{ textAlign:'left', padding:'6px 8px', fontWeight:400, fontSize:9, color:G.goldDim, letterSpacing:1 }}>색상 / 颜色</th>
              {sizes.map(s => (
                <th key={s} style={{ textAlign:'center', padding:'6px 6px', fontWeight:400, fontSize:9, color:G.goldDim, letterSpacing:1 }}>{s}</th>
              ))}
              <th style={{ textAlign:'right', padding:'6px 8px', fontWeight:400, fontSize:9, color:G.gold, letterSpacing:1 }}>합계 / 合计</th>
            </tr>
          </thead>
          <tbody>
            {colors.map(c => {
              const sizeMap = byColor.get(c);
              const rowTotal = sizes.reduce((s, sz) => s + (sizeMap.get(sz) || 0), 0);
              return (
                <tr key={c} style={{ borderBottom:'1px solid var(--app-divider)' }}>
                  <td style={{ padding:'6px 8px', color:G.cream }}><span style={{ display:'inline-flex', alignItems:'center' }}><ColorDot text={c} />{c}</span></td>
                  {sizes.map(s => (
                    <td key={s} style={{ padding:'6px 6px', textAlign:'center', color: sizeMap.get(s) ? G.cream : G.goldDim }}>
                      {sizeMap.get(s) || '-'}
                    </td>
                  ))}
                  <td style={{ padding:'6px 8px', textAlign:'right', color:G.gold }}>{rowTotal}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </DkCard>
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
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>
          {detail.mo_number} · {detail.is_remainder ? '尾包 / 자투리포장' : '标准中包袋 / 표준중간포장'}
        </div>
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
          <DkRow label="包装UUID / 포장 UUID" value={detail.uuid} mono />
          <DkRow label="负责人 / 담당자" value={detail.worker || '-'} />
          <DkRow label="总数量 / 총 수량" value={String(detail.total_qty) + ' 件'} />
          <DkRow label="是否剩余 / 자투리 여부" value={detail.is_remainder ? '是 / 예' : '否 / 아니오'} />
          <DkRow label="所属麻袋 / 마대 소속" value={detail.assigned_to_bag || '-'} />
          <DkRow label="创建时间 / 생성 시간" value={formatDate(detail.created_time) || '-'} />
          <DkRow label="最近修改 / 최근 수정" value={formatDate(detail.modified_time) || '-'} />
        </DkCard>
        <ColorSizeMatrix items={detail.items} />
        <DkBtn onClick={async () => {
          const qrUrl = getAppBaseUrl() + '/view/inner/' + detail.uuid;
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

// ─── NEW: Quantity-based Bag Create Screen ───────────────────────────
// Standard packs share one Zoho record per MO, so we input a count rather
// than scanning UUIDs. Leftover packs (Is_Remainder=true) are picked
// individually because each is unique.
const BagCreateQtyScreen = memo(function BagCreateQtyScreen({
  bagMO, info, leftoverPacks, standardCount, setStandardCount,
  selectedLeftovers, toggleLeftover, worker, setWorker,
  containerNo, setContainerNo,
  onSubmit, onBack, submitting, loading,
}) {
  const stdN = parseInt(standardCount) || 0;
  const leftoverQty = leftoverPacks
    .filter(p => selectedLeftovers.has(p.uuid))
    .reduce((s, p) => s + (parseInt(p.total_qty) || 0), 0);
  const totalQty = stdN * INNER_PACK_SIZE + leftoverQty;
  const ready = !submitting && worker.trim().length > 0 && (stdN > 0 || selectedLeftovers.size > 0);
  const overAvailable = info.standardExists && stdN > info.available;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>MASTER BAG</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{bagMO ? bagMO.mo_number : '—'}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{bagMO?.factory || '-'}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        {loading && (
          <DkCard style={{ textAlign:'center', padding:24 }}>
            <div className="spinner" style={{ width:24, height:24, margin:'0 auto 10px' }} />
            <div style={{ fontSize:11, color:G.goldDim }}>현황 로딩 중... / 加载中...</div>
          </DkCard>
        )}
        {!loading && (
          <>
            <DkCard>
              <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>标准中包袋现况 / 표준중간포장 현황</div>
              {!info.standardExists ? (
                <div style={{ padding:'8px 0', fontSize:11, color:G.goldDim }}>
                  표준중간포장 레코드가 아직 없습니다. QR을 먼저 인쇄하세요.
                  <br />标准中包袋记录尚未创建，请先打印QR。
                </div>
              ) : info.totalExpected === 0 ? (
                <div style={{ padding:'8px 0', fontSize:11, color:'#FCA5A5' }}>
                  ⚠ QR 未印刷 / QR 미인쇄
                  <br /><span style={{ color:G.goldDim }}>请先打印 / 먼저 표준중간포장 QR을 인쇄(다운로드)하세요</span>
                </div>
              ) : (
                <>
                  <DkRow label="총 인쇄 수량 / 总打印" value={String(info.totalExpected) + ' 个'} />
                  <DkRow label="기존 마대 합산 / 已分配" value={String(info.existingStandardCount) + ' 个'} />
                  <DkRow label="사용 가능 / 可用" value={String(info.available) + ' 个'} />
                </>
              )}
            </DkCard>

            <DkCard>
              <DkInput
                label="标准中包袋数 / 표준중간포장 수 *"
                value={standardCount}
                onChange={(e) => setStandardCount(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="0"
                inputMode="numeric"
              />
              {overAvailable && (
                <div style={{ fontSize:10, color:'#FCA5A5', marginTop:6 }}>
                  ⚠ 사용 가능({info.available})을 초과합니다 / 超出可用数量
                </div>
              )}
            </DkCard>

            <DkCard>
              <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>尾包 / 자투리포장</div>
              {leftoverPacks.length === 0 ? (
                <div style={{ padding:'8px 0', fontSize:11, color:G.goldDim }}>未分配尾包 / 미할당 자투리 없음</div>
              ) : leftoverPacks.map(p => {
                const checked = selectedLeftovers.has(p.uuid);
                const itemSummary = (p.items || []).slice(0, 3).map(it => `${it.color || ''} ${it.size || ''}`.trim()).filter(Boolean).join(', ');
                return (
                  <label key={p.uuid} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0', borderBottom:'1px solid var(--app-divider)', cursor:'pointer' }}>
                    <div onClick={() => toggleLeftover(p.uuid)} style={{
                      width:16, height:16, border:'1px solid '+(checked?G.gold:G.border),
                      borderRadius:2, background: checked?G.btnBg:'transparent',
                      flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center',
                    }}>
                      {checked && <div style={{ width:8, height:8, background:G.gold, borderRadius:1 }} />}
                    </div>
                    <div onClick={() => toggleLeftover(p.uuid)} style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, color:G.cream }}>
                        {p.total_qty} 件{itemSummary ? ` · ${itemSummary}${(p.items?.length || 0) > 3 ? '…' : ''}` : ''}
                      </div>
                      <div style={{ fontSize:9, color:G.goldDim, marginTop:2, fontFamily:'monospace' }}>
                        {String(p.uuid).slice(0, 8)}…
                      </div>
                    </div>
                  </label>
                );
              })}
            </DkCard>

            <DkCard>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ fontSize:10, color:G.goldDim, letterSpacing:1 }}>총 수량 / 总数量</span>
                <span style={{ fontSize:18, color:G.gold }}>
                  {totalQty} 件
                  <span style={{ fontSize:10, color:G.goldDim, marginLeft:8 }}>
                    ({stdN}×{INNER_PACK_SIZE} + {leftoverQty})
                  </span>
                </span>
              </div>
            </DkCard>

            {stdN > 0 && (() => {
              const PACKS_PER_BAG = 10;
              const bagCount = Math.floor(stdN / PACKS_PER_BAG);
              const leftoverPackCount = stdN % PACKS_PER_BAG;
              return (
                <DkCard>
                  <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:8, fontWeight:400 }}>
                    预计麻袋数 / 예상 마대 수
                  </div>
                  <div style={{ fontSize:22, color:G.gold, fontWeight:500 }}>
                    {bagCount} 个/개
                  </div>
                  {leftoverPackCount > 0 ? (
                    <div style={{ fontSize:11, color:'#F59E0B', marginTop:6 }}>
                      + 나머지 {leftoverPackCount}팩 / 余{leftoverPackCount}包
                      <div style={{ fontSize:9, color:'rgba(245,158,11,0.7)', marginTop:2 }}>
                        (尾包/자투리포장 별도 처리 필요)
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize:10, color:G.goldDim, marginTop:4 }}>
                      (나머지 0팩 / 余 0 包)
                    </div>
                  )}
                </DkCard>
              );
            })()}

            <DkCard>
              <DkInput
                label="컨테이너 넘버 / 柜号"
                value={containerNo}
                onChange={(e) => setContainerNo(e.target.value)}
                placeholder="예: Y6-30 / 例如: Y6-30"
              />
            </DkCard>
            <DkCard>
              <DkInput
                label="负责人 / 담당자 *"
                value={worker}
                onChange={(e) => setWorker(e.target.value)}
                placeholder="姓名 / 이름"
                onKeyDown={(e) => { if (e.key === 'Enter' && ready) onSubmit(); }}
              />
            </DkCard>

            <DkBtn onClick={onSubmit} disabled={!ready} style={{ padding:18, fontSize:11, letterSpacing:3 }}>
              {submitting ? '保存中...' : '✅ 마대 생성 / 创建麻袋'}
            </DkBtn>
          </>
        )}
      </div>
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
            <div style={{ textAlign:'center', color:G.goldDim, fontSize:11, padding:'16px 0', letterSpacing:1 }}>无可分配的中包袋 / 할당할 수 있는 중간포장이 없습니다</div>
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
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => setWorker(e.target.value)} placeholder="姓名 / 이름" onKeyDown={e => { if (e.key === 'Enter' && !submitting && count > 0) onSubmit(); }} />
        </DkCard>
        <DkBtn onClick={onSubmit} disabled={submitting || count === 0} style={{ padding:18, fontSize:11, letterSpacing:3 }}>
          {submitting ? '保存中...' : `✅ ${count}包装 装袋完成 / 마대 완료`}
        </DkBtn>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Bag Success Screen ──────────────────────────────────────────
const BagSuccessScreen = memo(function BagSuccessScreen({ bag, moData, onNewBag, onHome, containerNo }) {
  const [downloading, setDownloading] = useState(false);
  if (!bag) return null;
  // bag shape: { moNumber, totalBags, totalQty, bags: [{uuid,qrText,qrDataURL,bagSequence,packCount,totalQty,isRemainder}] }
  const bags = bag.bags || [];
  const firstSeq = bags.length ? bags[0].bagSequence : 0;
  const lastSeq  = bags.length ? bags[bags.length - 1].bagSequence : 0;
  const rangeLabel = bags.length === 1 ? `Bag #${firstSeq}` : `Bag #${firstSeq} ~ #${lastSeq}`;

  const handleZIP = async () => {
    if (downloading || bags.length === 0) return;
    setDownloading(true);
    try {
      const qrItems = bags.map(b => ({
        text: b.qrText,
        filename: sanitizeFilename(`${bag.moNumber}_MasterBag_${b.bagSequence}_${b.totalQty}pcs.png`),
        labels: [`${bag.moNumber} / Master Bag #${b.bagSequence}`, `${b.totalQty} 件`],
      }));
      await downloadQRsAsZIP(qrItems, sanitizeFilename(`${bag.moNumber}_MasterBags_${bags.length}bags.zip`));
    } catch (err) { alert('ZIP 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
  };
  const handleExcel = async () => {
    if (!moData || downloading || bags.length === 0) return;
    setDownloading(true);
    try {
      const bagList = bags.map(b => ({ bagNumber: b.bagSequence, qrText: b.qrText, isRemainder: b.isRemainder || false }));
      const fname = bags.length === 1
        ? `${bag.moNumber}_MasterBag_#${firstSeq}.xlsx`
        : `${bag.moNumber}_MasterBag_#${firstSeq}-#${lastSeq}_${bags.length}bags.xlsx`;
      await generateMasterBagExcel(moData, bagList, sanitizeFilename(fname), { containerNo: containerNo || '' });
    } catch (err) { alert('Excel 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
  };
  const handlePDF = async () => {
    if (downloading || bags.length === 0) return;
    setDownloading(true);
    try {
      const qrItems = bags.map(b => ({
        text: b.qrText,
        filename: sanitizeFilename(`${bag.moNumber}_MasterBag_${b.bagSequence}.png`),
      }));
      const fname = bags.length === 1
        ? `${bag.moNumber}_MasterBag_#${firstSeq}.pdf`
        : `${bag.moNumber}_MasterBag_#${firstSeq}-#${lastSeq}_${bags.length}bags.pdf`;
      await downloadQRsAsPDF(qrItems, sanitizeFilename(fname));
    } catch (err) { alert('PDF 생성 실패: ' + (err?.message || String(err))); }
    finally { setDownloading(false); }
  };
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>BAG CREATED</div>
        <div style={{ fontSize:11, color:G.goldDim, marginTop:4 }}>
          {bag.moNumber} · {rangeLabel}{bags.length > 1 ? ` (${bags.length}개 / 个 생성)` : ''}
        </div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        {bags.length === 1 && bags[0].qrDataURL && (
          <DkCard style={{ textAlign:'center', padding:20 }}>
            <img src={bags[0].qrDataURL} alt="QR" style={{ width:'100%', maxWidth:280, margin:'0 auto', display:'block', borderRadius:2 }} />
            <div style={{ fontSize:9, color:G.goldDim, marginTop:12, fontFamily:'monospace', wordBreak:'break-all' }}>{bags[0].qrText}</div>
          </DkCard>
        )}
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>생성된 마대 / 已创建麻袋</div>
          <div style={{ fontSize:12, color:G.cream, marginBottom:8 }}>{bags.length}개 마대 · {bag.totalQty} 件 总计</div>
          {bags.map((b, i) => (
            <div key={b.uuid || i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', fontSize:11, color:G.goldDim, borderTop:'1px solid var(--app-divider)' }}>
              <span><span style={{ color:G.gold }}>Bag #{b.bagSequence}</span> — {b.packCount}팩{b.isRemainder ? ' · 자투리 포함' : ''}</span>
              <span>{b.totalQty} 件</span>
            </div>
          ))}
        </DkCard>
        <DkBtn onClick={handleZIP} disabled={downloading || bags.length === 0}>
          {downloading ? '处理中 / 처리중...' : `📦 QR ZIP 下载 / 다운로드 (${bags.length})`}
        </DkBtn>
        <DkBtn onClick={handleExcel} disabled={downloading || !moData || bags.length === 0}>
          {downloading ? '处理中 / 처리중...' : `📊 Excel 下载 / 다운로드 (${bags.length} sheet)`}
        </DkBtn>
        <DkBtn onClick={handlePDF} disabled={downloading || bags.length === 0}>
          {downloading ? '处理中 / 처리중...' : `📄 PDF 下载 / 다운로드 (${bags.length})`}
        </DkBtn>
        <DkBtn onClick={onNewBag}>➕ 生成新麻袋 / 새 마대</DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── NEW: Bag Detail Screen ───────────────────────────────────────────
const BagDetailScreen = memo(function BagDetailScreen({ detail, onBack, onEditStatus, onDelete, requirePin: reqPin, onViewPack }) {
  const [showPicker, setShowPicker] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [bagPacksData, setBagPacksData] = useState([]);
  const [bagPacksLoading, setBagPacksLoading] = useState(false);

  useEffect(() => {
    if (!detail || !detail.inner_pack_uuids || detail.inner_pack_uuids.length === 0) return;
    let cancelled = false;
    setBagPacksLoading(true);
    (async () => {
      try {
        let moNum = detail.mo_number;
        const res = await getRecordsByCriteria(REPORTS.INNER_PACK, `MO_Number == "${moNum}"`);
        if (cancelled) return;
        const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
        const uuidSet = new Set(detail.inner_pack_uuids);
        const matched = list
          .filter(r => uuidSet.has(r['Pack_UUID']))
          .map(r => ({ uuid: r['Pack_UUID'], pack_sequence: parseInt(r['Pack_Sequence']) || 0, total_qty: r['Total_Qty'] }))
          .sort((a, b) => a.pack_sequence - b.pack_sequence);
        if (!cancelled) setBagPacksData(matched);
      } catch (e) {
        if (!cancelled) setBagPacksData([]);
      } finally {
        if (!cancelled) setBagPacksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [detail]);

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
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{detail.mo_number} · 麻袋包装 / 마대포장</div>
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
          <DkRow label="麻袋UUID / 마대 UUID" value={detail.uuid} mono />
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
            {bagPacksLoading ? (
              <div style={{ fontSize:10, color:G.goldDim, textAlign:'center', padding:'8px 0' }}>加载中 / 로딩...</div>
            ) : bagPacksData.length > 0 ? bagPacksData.map((p, i) => (
              <div key={p.uuid} onClick={() => onViewPack && onViewPack(p.uuid)}
                style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 4px', borderBottom:'1px solid var(--app-divider)', cursor: onViewPack ? 'pointer' : 'default' }}>
                <span style={{ fontSize:11, color:G.cream }}>
                  <span style={{ color:G.goldDim, fontSize:9, marginRight:6 }}>{i + 1}.</span>
                  中包袋 #{p.pack_sequence} / 중간포장 #{p.pack_sequence}
                </span>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:10, color:G.gold }}>{p.total_qty}件</span>
                  {onViewPack && <span style={{ fontSize:14, color:G.goldDim }}>›</span>}
                </div>
              </div>
            )) : detail.inner_pack_uuids.map((uuid, i) => (
              <div key={uuid} style={{ padding:'6px 0', borderBottom:'1px solid var(--app-divider)', fontSize:10, color:G.goldDim, fontFamily:'monospace' }}>
                {i + 1}. {uuid}
              </div>
            ))}
          </DkCard>
        )}
        <DkBtn onClick={async () => {
          const qrUrl = getAppBaseUrl() + '/view/bag/' + detail.uuid;
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
  const [selected, setSelected] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [queryMOData, setQueryMOData] = useState(null);       // moData cached from MO lookup
  const [rowCopies, setRowCopies] = useState({});             // per-uuid copies input

  const getMOData = async (moNum) => {
    if (queryMOData && queryMOData.MO_Number === moNum) return queryMOData;
    const res = await getRecords(MO_REPORT, `MO_Number == "${moNum}"`);
    const md = buildMODataFromRaw(res?.data?.[0]);
    setQueryMOData(md);
    return md;
  };

  const search = async () => {
    const moNum = mo.trim().toUpperCase();
    if (!moNum) { alert('请输入订单号'); return; }
    setLoading(true);
    setSearched(true);
    setSelected(new Set());
    setQueryMOData(null);
    setRowCopies({});
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
          let items = [];
          try {
            const raw = (r['Items_JSON'] || '').toString().trim();
            if (raw) items = JSON.parse(raw.startsWith('[') ? raw : `[${raw}]`);
          } catch (e) { items = []; }
          return {
            uuid: r['Pack_UUID'],
            mo_number: moN,
            pack_sequence: parseInt(r['Pack_Sequence']) || 0,
            total_qty: r['Total_Qty'],
            pack_status: r['Pack_Status'] || 'Created',
            worker: typeof w === 'object' ? (w.display_value || '') : (w || ''),
            created_time: r['Added_Time'] || r['Created_Time'] || '',
            is_remainder: r['Is_Remainder'] === 'true' || r['Is_Remainder'] === true,
            items,
          };
        })
        .sort((a, b) => parseDateRaw(b.created_time) - parseDateRaw(a.created_time));
      setPacks(filtered);
      // Prefetch moData so per-row Excel doesn't refetch
      if (filtered.length > 0) {
        try { await getMOData(filtered[0].mo_number); } catch (e) {}
      }
    } catch (e) {
      alert('查询失败: ' + (e?.message || String(e)));
    } finally {
      setLoading(false);
    }
  };

  const allSelected = packs.length > 0 && packs.every(p => selected.has(p.uuid));
  const toggleAll = () => {
    if (allSelected) { setSelected(new Set()); }
    else { setSelected(new Set(packs.map(p => p.uuid))); }
  };
  const toggleOne = (uuid) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(uuid) ? next.delete(uuid) : next.add(uuid);
      return next;
    });
  };

  const handleBulkExcel = async () => {
    const sel = packs.filter(p => selected.has(p.uuid));
    if (!sel.length) return;
    setBulkLoading(true);
    try {
      const moNum = sel[0].mo_number;
      const moData = await getMOData(moNum);
      const packList = sel
        .slice().sort((a, b) => a.pack_sequence - b.pack_sequence)
        .map(p => ({
          packNumber: p.pack_sequence,
          qrText: getAppBaseUrl() + '/view/inner/' + p.uuid,
          totalQty: p.total_qty,
          isRemainder: p.is_remainder,
          isStandard: !p.is_remainder && (parseInt(p.pack_sequence) || 0) === 0,
          items: p.items,
        }));
      await generateInnerPackExcel(moData, packList, sanitizeFilename(`${moNum}_InnerPack_Selected_${packList.length}items.xlsx`));
      setSelected(new Set());
    } catch (err) { alert('Excel 생성 실패: ' + (err?.message || String(err))); }
    finally { setBulkLoading(false); }
  };

  const handleBulkPDF = async () => {
    const sel = packs.filter(p => selected.has(p.uuid));
    if (!sel.length) return;
    setBulkLoading(true);
    try {
      const moNum = sel[0].mo_number;
      const qrItems = await Promise.all(
        sel.slice().sort((a, b) => a.pack_sequence - b.pack_sequence)
          .map(async p => ({
            text: getAppBaseUrl() + '/view/inner/' + p.uuid,
            filename: sanitizeFilename(`${p.mo_number}_InnerPack_${p.pack_sequence}.png`),
          }))
      );
      await downloadQRsAsPDF(qrItems, sanitizeFilename(`${moNum}_InnerPack_Selected_${qrItems.length}items.pdf`));
      setSelected(new Set());
    } catch (err) { alert('PDF 생성 실패: ' + (err?.message || String(err))); }
    finally { setBulkLoading(false); }
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
          <DkInput label="订单号 / MO 번호" value={mo} onChange={e => setMo(e.target.value)} placeholder="例 / 예: GJ26-1" onKeyDown={e => { if (e.key === 'Enter' && !loading) search(); }} />
          <DkBtn onClick={search} disabled={loading} style={{ marginTop:8, marginBottom:0 }}>{loading ? '查询中...' : '🔍 查询 / 조회'}</DkBtn>
        </DkCard>
        {packs.length > 0 && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 4px', marginBottom:4 }}>
            <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:10, color:G.goldDim }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ accentColor:G.gold }} />
              {selected.size > 0 ? `${selected.size} 선택됨 / 已选` : '全选 / 전체 선택'}
            </label>
            {selected.size > 0 && (
              <div style={{ display:'flex', gap:6 }}>
                <button onClick={handleBulkPDF} disabled={bulkLoading}
                  style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.4)', color:G.goldDim, fontSize:9, padding:'4px 8px', cursor:'pointer', fontFamily:'inherit' }}>
                  {bulkLoading ? '...' : `📄 PDF (${selected.size})`}
                </button>
                <button onClick={handleBulkExcel} disabled={bulkLoading}
                  style={{ background:'rgba(212,175,55,0.15)', border:'1px solid rgba(212,175,55,0.6)', color:G.gold, fontSize:9, padding:'4px 8px', cursor:'pointer', fontFamily:'inherit' }}>
                  {bulkLoading ? '...' : `📊 Excel (${selected.size})`}
                </button>
              </div>
            )}
          </div>
        )}
        {searched && !loading && packs.length === 0 && (
          <div style={{ textAlign:'center', color:G.goldDim, padding:24, fontSize:11, letterSpacing:1 }}>此订单没有包装记录 / 포장 기록 없음</div>
        )}
        {packs.map(p => (
          <DkCard key={p.uuid} style={{ marginBottom:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <label style={{ display:'flex', alignItems:'flex-start', gap:8, flex:1, cursor:'pointer' }}>
                <input type="checkbox" checked={selected.has(p.uuid)} onChange={() => toggleOne(p.uuid)} style={{ marginTop:4, accentColor:G.gold, flexShrink:0 }} />
                <div onClick={() => onSelectPack(p.uuid)} style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <div style={{ fontSize:9, letterSpacing:2, color:G.gold, border:'1px solid rgba(212,175,55,0.4)', padding:'1px 6px' }}>Pack #{p.pack_sequence}</div>
                    <div style={{ fontSize:9, color:G.goldDim, letterSpacing:1 }}>{PACK_STATUS_LABELS[p.pack_status] || p.pack_status}</div>
                  </div>
                  <div style={{ fontSize:11, color:G.cream, marginBottom:2 }}>{p.mo_number} · {p.total_qty} 件</div>
                  <div style={{ fontSize:9, color:G.goldDim }}>{p.worker || '-'} · {formatDate(p.created_time)}</div>
                </div>
              </label>
              <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0, marginLeft:8 }}>
                <button onClick={async e => {
                  e.stopPropagation();
                  const qrUrl = getAppBaseUrl() + '/view/inner/' + p.uuid;
                  const label = `${p.mo_number} / Inner Pack #${p.pack_sequence} / ${p.total_qty} pcs`;
                  const dataURL = await generateQRDataURLWithLabel(qrUrl, label);
                  downloadQRPNG(dataURL, sanitizeFilename(`${p.mo_number}_InnerPack_${p.pack_sequence}_${p.total_qty}pcs.png`));
                }} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.3)', color:G.goldDim, fontSize:9, padding:'5px 8px', cursor:'pointer', fontFamily:'inherit' }}>📷 PNG</button>
                <input
                  type="text"
                  inputMode="numeric"
                  value={rowCopies[p.uuid] ?? '1'}
                  onClick={e => e.stopPropagation()}
                  onChange={e => {
                    const v = e.target.value.replace(/[^\d]/g, '');
                    setRowCopies(prev => ({ ...prev, [p.uuid]: v }));
                  }}
                  style={{ width:40, padding:'4px 4px', background:'transparent', border:'1px solid '+G.border, borderRadius:2, color:G.gold, fontSize:11, textAlign:'center', fontFamily:'inherit', outline:'none' }}
                />
                <span style={{ fontSize:9, color:G.goldDim }}>张 / 장</span>
                <button onClick={async e => {
                  e.stopPropagation();
                  try {
                    const moData = await getMOData(p.mo_number);
                    const qrUrl = getAppBaseUrl() + '/view/inner/' + p.uuid;
                    const n = Math.min(999, Math.max(1, parseInt(rowCopies[p.uuid]) || 1));
                    const item = {
                      packNumber: p.pack_sequence,
                      qrText: qrUrl,
                      totalQty: p.total_qty,
                      isRemainder: p.is_remainder,
                      isStandard: !p.is_remainder && (parseInt(p.pack_sequence) || 0) === 0,
                      items: p.items,
                    };
                    const packList = Array(n).fill(item);
                    await generateInnerPackExcel(
                      moData, packList,
                      sanitizeFilename(`${p.mo_number}_InnerPack_${p.pack_sequence}_${n}copies.xlsx`)
                    );
                  } catch (err) { alert('Excel 생성 실패: ' + (err?.message || String(err))); }
                }} style={{ background:'rgba(212,175,55,0.15)', border:'1px solid rgba(212,175,55,0.6)', color:G.gold, fontSize:9, padding:'5px 8px', cursor:'pointer', fontFamily:'inherit' }}>📊 Excel</button>
              </div>
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
  const [selected, setSelected] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const search = async () => {
    const moNum = mo.trim().toUpperCase();
    if (!moNum) { alert('请输入订单号'); return; }
    setLoading(true);
    setSearched(true);
    setSelected(new Set());
    try {
      const allBags = [];
      let cursor = null;
      let safety = 0;
      while (safety++ < 20) {
        const res = await getRecords(REPORTS.MASTER_BAG, `MO_Number == "${moNum}"`, cursor ? { record_cursor: cursor } : {});
        const data = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
        if (data.length === 0) break;
        allBags.push(...data);
        cursor = res?.record_cursor || null;
        if (!cursor) break;
      }
      const filtered = allBags
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

  const allSelected = bags.length > 0 && bags.every(b => selected.has(b.uuid));
  const toggleAll = () => {
    if (allSelected) { setSelected(new Set()); }
    else { setSelected(new Set(bags.map(b => b.uuid))); }
  };
  const toggleOne = (uuid) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(uuid) ? next.delete(uuid) : next.add(uuid);
      return next;
    });
  };

  const handleBulkExcel = async () => {
    const sel = bags.filter(b => selected.has(b.uuid));
    if (!sel.length) return;
    setBulkLoading(true);
    try {
      const moNum = sel[0].mo_number;
      const res = await getRecords(MO_REPORT, `MO_Number == "${moNum}"`);
      const moData = buildMODataFromRaw(res?.data?.[0]);
      const bagList = sel
        .slice().sort((a, b) => a.bag_sequence - b.bag_sequence)
        .map(b => ({
          bagNumber: b.bag_sequence,
          qrText: getAppBaseUrl() + '/view/bag/' + b.uuid,
        }));
      await generateMasterBagExcel(moData, bagList, sanitizeFilename(`${moNum}_MasterBag_Selected_${bagList.length}items.xlsx`));
      setSelected(new Set());
    } catch (err) { alert('Excel 생성 실패: ' + (err?.message || String(err))); }
    finally { setBulkLoading(false); }
  };

  const handleBulkPDF = async () => {
    const sel = bags.filter(b => selected.has(b.uuid));
    if (!sel.length) return;
    setBulkLoading(true);
    try {
      const moNum = sel[0].mo_number;
      const qrItems = sel
        .slice().sort((a, b) => a.bag_sequence - b.bag_sequence)
        .map(b => ({
          text: getAppBaseUrl() + '/view/bag/' + b.uuid,
          filename: sanitizeFilename(`${b.mo_number}_MasterBag_${b.bag_sequence}.png`),
        }));
      await downloadQRsAsPDF(qrItems, sanitizeFilename(`${moNum}_MasterBag_Selected_${qrItems.length}items.pdf`));
      setSelected(new Set());
    } catch (err) { alert('PDF 생성 실패: ' + (err?.message || String(err))); }
    finally { setBulkLoading(false); }
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
          <DkInput label="订单号 / MO 번호" value={mo} onChange={e => setMo(e.target.value)} placeholder="例 / 예: GJ26-1" onKeyDown={e => { if (e.key === 'Enter' && !loading) search(); }} />
          <DkBtn onClick={search} disabled={loading} style={{ marginTop:8, marginBottom:0 }}>{loading ? '查询中...' : '🔍 查询 / 조회'}</DkBtn>
        </DkCard>
        {bags.length > 0 && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 4px', marginBottom:4 }}>
            <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:10, color:G.goldDim }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ accentColor:G.gold }} />
              {selected.size > 0 ? `${selected.size} 선택됨 / 已选` : '全选 / 전체 선택'}
            </label>
            {selected.size > 0 && (
              <div style={{ display:'flex', gap:6 }}>
                <button onClick={handleBulkPDF} disabled={bulkLoading}
                  style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.4)', color:G.goldDim, fontSize:9, padding:'4px 8px', cursor:'pointer', fontFamily:'inherit' }}>
                  {bulkLoading ? '...' : `📄 PDF (${selected.size})`}
                </button>
                <button onClick={handleBulkExcel} disabled={bulkLoading}
                  style={{ background:'rgba(212,175,55,0.15)', border:'1px solid rgba(212,175,55,0.6)', color:G.gold, fontSize:9, padding:'4px 8px', cursor:'pointer', fontFamily:'inherit' }}>
                  {bulkLoading ? '...' : `📊 Excel (${selected.size})`}
                </button>
              </div>
            )}
          </div>
        )}
        {searched && !loading && bags.length === 0 && (
          <div style={{ textAlign:'center', color:G.goldDim, padding:24, fontSize:11, letterSpacing:1 }}>此订单没有麻袋记录 / 마대 기록 없음</div>
        )}
        {bags.map(b => (
          <DkCard key={b.uuid} style={{ marginBottom:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <label style={{ display:'flex', alignItems:'flex-start', gap:8, flex:1, cursor:'pointer' }}>
                <input type="checkbox" checked={selected.has(b.uuid)} onChange={() => toggleOne(b.uuid)} style={{ marginTop:4, accentColor:G.gold, flexShrink:0 }} />
                <div onClick={() => onSelectBag(b.uuid)} style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <div style={{ fontSize:9, letterSpacing:2, color:G.gold, border:'1px solid rgba(212,175,55,0.4)', padding:'1px 6px' }}>Bag #{b.bag_sequence}</div>
                    <div style={{ fontSize:9, color:G.goldDim, letterSpacing:1 }}>{BAG_STATUS_LABELS[b.bag_status] || b.bag_status}</div>
                  </div>
                  <div style={{ fontSize:11, color:G.cream, marginBottom:2 }}>{b.mo_number} · {b.inner_pack_count} packs · {b.total_qty} 件</div>
                  <div style={{ fontSize:9, color:G.goldDim }}>{b.worker || '-'}{b.destination ? ' → ' + b.destination : ''} · {formatDate(b.created_time)}</div>
                </div>
              </label>
              <div style={{ display:'flex', flexDirection:'column', gap:4, flexShrink:0, marginLeft:8 }}>
                <button onClick={async e => {
                  e.stopPropagation();
                  const qrUrl = getAppBaseUrl() + '/view/bag/' + b.uuid;
                  const label = `${b.mo_number} / Master Bag #${b.bag_sequence} / ${b.total_qty} pcs`;
                  const dataURL = await generateQRDataURLWithLabel(qrUrl, label);
                  downloadQRPNG(dataURL, sanitizeFilename(`${b.mo_number}_MasterBag_${b.bag_sequence}_${b.total_qty}pcs.png`));
                }} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.3)', color:G.goldDim, fontSize:9, padding:'5px 8px', cursor:'pointer', fontFamily:'inherit' }}>📷 PNG</button>
                <button onClick={async e => {
                  e.stopPropagation();
                  try {
                    const res = await getRecords(MO_REPORT, `MO_Number == "${b.mo_number}"`);
                    const moData = buildMODataFromRaw(res?.data?.[0]);
                    const qrUrl = getAppBaseUrl() + '/view/bag/' + b.uuid;
                    await generateSingleMasterBagExcel(moData, { number: b.bag_sequence, qrString: qrUrl });
                  } catch (err) { alert('Excel 생성 실패: ' + (err?.message || String(err))); }
                }} style={{ background:'rgba(212,175,55,0.15)', border:'1px solid rgba(212,175,55,0.6)', color:G.gold, fontSize:9, padding:'5px 8px', cursor:'pointer', fontFamily:'inherit' }}>📊 Excel</button>
              </div>
            </div>
          </DkCard>
        ))}
      </div>
    </DkScreen>
  );
});

// ─── Recent Activity Screen ───────────────────────────────────────────
const ACTIVITY_FILTERS = ['all', 'inner_pack', 'master_bag'];
const ACTIVITY_FILTER_LABELS = { all: '全部 / 전체', inner_pack: '中包袋 / 중간포장', master_bag: '麻袋 / 마대' };

const RecentActivityScreen = memo(function RecentActivityScreen({ onBack }) {
  const [activities, setActivities] = useState(() => getRecentActivities());
  const [filter, setFilter] = useState('all');
  const [redownloadingId, setRedownloadingId] = useState(null);
  const [copiesMap, setCopiesMap] = useState({}); // activity.id -> string input

  const displayed = filter === 'all' ? activities : activities.filter(a => a.type === filter);

  const handleClearAll = () => {
    if (!window.confirm('최근 기록을 모두 삭제하시겠습니까?\n确定清除所有记录?')) return;
    clearActivities();
    setActivities([]);
  };

  const handleRedownload = async (activity) => {
    setRedownloadingId(activity.id);
    const copies = Math.min(999, Math.max(1, parseInt(copiesMap[activity.id]) || 1));
    try {
      const moRes = await getRecords(MO_REPORT, `MO_Number == "${activity.moNumber}"`);
      const moRecord = moRes?.data?.[0];
      if (!moRecord) throw new Error('MO not found: ' + activity.moNumber);
      const moData = buildMODataFromRaw(moRecord);

      if (activity.type === 'inner_pack') {
        const packNums = new Set((activity.packNumbers || []).map(Number));
        let allPacks = [], cursor = null, safety = 0;
        while (safety++ < 50) {
          const pr = await getRecords(REPORTS.INNER_PACK, `MO_Number == "${activity.moNumber}"`, cursor ? { record_cursor: cursor } : {});
          const data = (pr?.code === 3000 && Array.isArray(pr.data)) ? pr.data : [];
          if (!data.length) break;
          allPacks = allPacks.concat(data);
          cursor = pr.record_cursor || null;
          if (!cursor) break;
        }
        const matching = allPacks.filter(r => packNums.has(parseInt(r['Pack_Sequence']) || 0));
        if (!matching.length) throw new Error('해당 포장 기록을 찾을 수 없습니다 / 未找到包装记录');
        const baseList = matching
          .map(r => {
            let items = [];
            try { items = JSON.parse(r['Items_JSON'] || '[]'); } catch (e) {}
            const seq = parseInt(r['Pack_Sequence']) || 0;
            const isRem = r['Is_Remainder'] === 'true' || r['Is_Remainder'] === true;
            return {
              packNumber: seq,
              qrText: getAppBaseUrl() + '/view/inner/' + r['Pack_UUID'],
              totalQty: parseInt(r['Total_Qty']) || 12,
              isRemainder: isRem,
              isStandard: !isRem && seq === 0,
              items,
            };
          })
          .sort((a, b) => a.packNumber - b.packNumber);
        // Expand by copies: each matching record is repeated `copies` times.
        const packList = baseList.flatMap(item => Array(copies).fill(item));
        await generateInnerPackExcel(moData, packList,
          sanitizeFilename(`${activity.moNumber}_InnerPack_Redownload_${baseList.length}x${copies}.xlsx`));
      } else {
        const bagNums = new Set((activity.bagNumbers || []).map(Number));
        let allBags = [], cursor = null, safety = 0;
        while (safety++ < 50) {
          const pr = await getRecords(REPORTS.MASTER_BAG, `MO_Number == "${activity.moNumber}"`, cursor ? { record_cursor: cursor } : {});
          const data = (pr?.code === 3000 && Array.isArray(pr.data)) ? pr.data : [];
          if (!data.length) break;
          allBags = allBags.concat(data);
          cursor = pr.record_cursor || null;
          if (!cursor) break;
        }
        const matching = allBags.filter(r => bagNums.has(parseInt(r['Bag_Sequence']) || 0));
        if (!matching.length) throw new Error('해당 마대 기록을 찾을 수 없습니다 / 未找到麻袋记录');
        const bagList = matching
          .map(r => ({
            bagNumber: parseInt(r['Bag_Sequence']) || 0,
            qrText: getAppBaseUrl() + '/view/bag/' + r['Bag_UUID'],
          }))
          .sort((a, b) => a.bagNumber - b.bagNumber);
        await generateMasterBagExcel(moData, bagList,
          sanitizeFilename(`${activity.moNumber}_MasterBag_Redownload_${bagList.length}bags.xlsx`));
      }
    } catch (err) {
      alert('재다운로드 실패 / 重新下载失败:\n' + (err?.message || String(err)));
    } finally {
      setRedownloadingId(null);
    }
  };

  const fmtTs = (ts) => {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>RECENT ACTIVITY</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>最近记录 / 최근 기록</div>
      </div>
      <div style={{ padding:'16px 20px 40px' }}>
        {/* Filter tabs */}
        <div style={{ display:'flex', gap:6, marginBottom:16, overflowX:'auto' }}>
          {ACTIVITY_FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{
                background: filter === f ? 'rgba(212,175,55,0.2)' : 'transparent',
                border: filter === f ? '1px solid rgba(212,175,55,0.6)' : '1px solid rgba(212,175,55,0.2)',
                color: filter === f ? G.gold : G.goldDim,
                fontSize:9, padding:'5px 12px', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap',
              }}>
              {ACTIVITY_FILTER_LABELS[f]}
            </button>
          ))}
          {activities.length > 0 && (
            <button onClick={handleClearAll}
              style={{ background:'transparent', border:'1px solid rgba(200,60,60,0.4)', color:'rgba(220,80,80,0.8)', fontSize:9, padding:'5px 10px', cursor:'pointer', fontFamily:'inherit', marginLeft:'auto', whiteSpace:'nowrap' }}>
              🗑 全部删除 / 전체 삭제
            </button>
          )}
        </div>

        {displayed.length === 0 && (
          <div style={{ textAlign:'center', color:G.goldDim, padding:40, fontSize:11, letterSpacing:1 }}>
            {activities.length === 0 ? '아직 기록 없음 / 暂无记录' : '해당 유형 없음 / 无该类型记录'}
          </div>
        )}

        {displayed.map(a => {
          const isIP = a.type === 'inner_pack';
          const numList = isIP ? (a.packNumbers || []) : (a.bagNumbers || []);
          const label = isIP ? 'Inner Pack' : 'Master Bag';
          const numLabel = isIP
            ? (numList.length === 1 ? `Pack #${numList[0]}` : `Pack #${numList[0]}–#${numList[numList.length-1]} (${numList.length}个 / 개)`)
            : (numList.length === 1 ? `Bag #${numList[0]}` : `Bag #${numList[0]}–#${numList[numList.length-1]} (${numList.length}个 / 개)`);
          const isLoading = redownloadingId === a.id;
          return (
            <DkCard key={a.id} style={{ marginBottom:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:6 }}>
                    <div style={{ fontSize:9, letterSpacing:2, color:G.gold, border:'1px solid rgba(212,175,55,0.4)', padding:'1px 6px', flexShrink:0 }}>{label}</div>
                    <div style={{ fontSize:9, color:G.goldDim, letterSpacing:1 }}>{a.action === 'batch_created' ? 'BATCH' : 'SINGLE'}</div>
                  </div>
                  <div style={{ fontSize:11, color:G.cream, marginBottom:2, fontWeight:500 }}>{a.moNumber}</div>
                  <div style={{ fontSize:10, color:G.goldDim, marginBottom:2 }}>{numLabel} · {a.pieceCount} pcs</div>
                  <div style={{ fontSize:9, color:G.goldDim }}>{a.creator || '-'} · {fmtTs(a.timestamp)}</div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0, marginLeft:8 }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={copiesMap[a.id] ?? '1'}
                    onChange={e => {
                      const v = e.target.value.replace(/[^\d]/g, '');
                      setCopiesMap(prev => ({ ...prev, [a.id]: v }));
                    }}
                    style={{ width:42, padding:'4px 4px', background:'transparent', border:'1px solid '+G.border, borderRadius:2, color:G.gold, fontSize:11, textAlign:'center', fontFamily:'inherit', outline:'none' }}
                  />
                  <span style={{ fontSize:9, color:G.goldDim }}>张 / 장</span>
                  <button onClick={() => handleRedownload(a)} disabled={isLoading}
                    style={{ background:'rgba(212,175,55,0.15)', border:'1px solid rgba(212,175,55,0.6)', color:G.gold, fontSize:9, padding:'6px 10px', cursor:'pointer', fontFamily:'inherit' }}>
                    {isLoading ? '...' : '📊 重新下载 / 재다운'}
                  </button>
                </div>
              </div>
            </DkCard>
          );
        })}
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
        try {
          const raw = (found['Items_JSON'] || found['items_json'] || '').toString().trim();
          if (raw) items = JSON.parse(raw.startsWith('[') ? raw : `[${raw}]`);
        } catch (e) { items = []; }
        let moNum = found['MO_Number'];
        if (typeof moNum === 'object') moNum = moNum.display_value || '';
        setRecord({
          uuid: found['Pack_UUID'],
          mo_number: moNum,
          sku: getField(found, 'Style_SKU') || getField(found, 'SKU'),
          factory: formatFactory(getField(found, 'Factory')),
          pack_sequence: found['Pack_Sequence'],
          total_qty: found['Total_Qty'],
          items,
          worker: getField(found, 'Worker'),
          created_time: getField(found, 'Added_Time') || getField(found, 'Created_Time'),
          modified_time: getField(found, 'Modified_Time'),
          pack_status: found['Pack_Status'] || 'Created',
          is_remainder: found['Is_Remainder'] === 'true' || found['Is_Remainder'] === true,
          style_image_url: extractImageUrl(found),
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
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>中间包装详情 / 중간포장 상세</div>
            <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>
              {record.mo_number} · {record.is_remainder ? '尾包 / 자투리포장' : '标准中包袋 / 표준중간포장'}
            </div>
            <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{record.factory}</div>
          </div>
          <MOThumbnail url={record.style_image_url} size={64} />
        </div>
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
          <DkRow label="总件数 / 총 수량" value={String(record.total_qty) + ' 件'} />
          <DkRow label="负责人 / 담당자" value={record.worker || '-'} />
          <DkRow label="创建时间 / 생성 시간" value={formatDate(record.created_time) || '-'} />
          <DkRow label="最近修改 / 최근 수정" value={formatDate(record.modified_time) || '-'} />
        </DkCard>
        <ColorSizeMatrix items={record.items} />
        <DkBtnOutline onClick={onHome}>🏠 返回首页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── ViewBagScreen (read-only, URL-accessible) ────────────────────────
const ViewBagScreen = memo(function ViewBagScreen({ uuid, onHome, onViewPack }) {
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
          factory: formatFactory(getField(foundBag, 'Factory')),
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
          style_image_url: extractImageUrl(foundBag),
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
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>麻袋详情 / 마대 상세</div>
            <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{bagRecord.mo_number} · 麻袋包装 / 마대포장</div>
            <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{bagRecord.factory}{bagRecord.destination ? ' → ' + (bagRecord.destination === 'MEX-Guadalajara' ? '墨西哥-과달라하라 / MEX-Guadalajara' : bagRecord.destination) : ''}</div>
          </div>
          <MOThumbnail url={bagRecord.style_image_url} size={64} />
        </div>
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
            {innerPacks.sort((a, b) => (parseInt(a.pack_sequence) || 0) - (parseInt(b.pack_sequence) || 0)).map((p, i) => (
              <div key={p.uuid} onClick={() => onViewPack && onViewPack(p.uuid)}
                style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 4px', borderBottom:'1px solid var(--app-divider)', cursor: onViewPack ? 'pointer' : 'default' }}>
                <span style={{ fontSize:11, color:G.cream }}>
                  <span style={{ color:G.goldDim, fontSize:9, marginRight:6 }}>{i + 1}.</span>
                  {bagRecord.mo_number} 中包袋 #{p.pack_sequence || (i + 1)} / 중간포장 #{p.pack_sequence || (i + 1)}
                </span>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:10, color:G.gold }}>{p.total_qty} 件</span>
                  {onViewPack && <span style={{ fontSize:14, color:G.goldDim }}>›</span>}
                </div>
              </div>
            ))}
          </DkCard>
        )}

        {colorSizeSummary.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>颜色/尺码汇总 / 색상·사이즈 합계</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:4, fontSize:9, color:G.goldDim, letterSpacing:1, marginBottom:8 }}>
              <span>颜色 / 색상</span><span style={{ textAlign:'center' }}>尺码 / 사이즈</span><span style={{ textAlign:'right' }}>合计 / 합계</span>
            </div>
            {colorSizeSummary.map((row, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', padding:'5px 0', borderBottom:'1px solid var(--app-divider)', fontSize:12 }}>
                <span style={{ color:G.cream, display:'inline-flex', alignItems:'center' }}><ColorDot text={row.color} />{row.color}</span>
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
const BatchPackInputScreen = memo(function BatchPackInputScreen({ packMO, onSubmit, onBack }) {
  const [startSeq, setStartSeq] = useState('');
  const [endSeq, setEndSeq]     = useState('');
  const [worker, setWorker]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [existingNums, setExistingNums] = useState(new Set());
  const [rangeError, setRangeError]     = useState(null);

  // Fetch all existing Pack_Sequence numbers for this MO on mount,
  // then pre-fill start/end with max+1 to prevent duplicate creation.
  useEffect(() => {
    if (!packMO?.mo_number) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let all = [], cursor = null, safety = 0;
        while (safety++ < 50) {
          const pr = await getRecords(REPORTS.INNER_PACK, `MO_Number == "${packMO.mo_number}"`, cursor ? { record_cursor: cursor } : {});
          const data = (pr && pr.code === 3000 && Array.isArray(pr.data)) ? pr.data : [];
          if (data.length === 0) break;
          all = all.concat(data);
          cursor = pr.record_cursor || null;
          if (!cursor) break;
        }
        if (cancelled) return;
        const nums = new Set(all.map(p => parseInt(p['Pack_Sequence']) || 0).filter(n => n > 0));
        const maxNum = nums.size > 0 ? Math.max(...nums) : 0;
        const next = String(maxNum + 1);
        setExistingNums(nums);
        setStartSeq(next);
        setEndSeq(next);
      } catch (err) {
        console.error('[BatchPackInput] fetch existing packs failed', err);
        if (!cancelled) { setStartSeq('1'); setEndSeq('1'); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [packMO?.mo_number]);

  const checkOverlap = (s, e, nums) => {
    const sn = parseInt(s), en = parseInt(e);
    if (!sn || !en || sn > en || sn < 1) return null;
    const overlap = [];
    for (let i = sn; i <= en; i++) { if (nums.has(i)) overlap.push(i); }
    return overlap.length > 0 ? `중복 번호 / 重复序号: #${overlap.join(', #')}` : null;
  };

  const handleStartChange = (e) => {
    const v = e.target.value;
    setStartSeq(v);
    setRangeError(checkOverlap(v, endSeq, existingNums));
  };
  const handleEndChange = (e) => {
    const v = e.target.value;
    setEndSeq(v);
    setRangeError(checkOverlap(startSeq, v, existingNums));
  };

  const count = Math.max(0, (parseInt(endSeq) || 0) - (parseInt(startSeq) || 0) + 1);
  const canSubmit = !loading && count > 0 && !rangeError && !!worker.trim();

  const handleSubmit = () => {
    const s = parseInt(startSeq), e = parseInt(endSeq);
    if (!s || !e || s > e || s < 1) { alert('请输入有效的序号范围'); return; }
    if (!worker.trim()) { alert('请输入负责人 / 담당자'); return; }
    if (rangeError) { alert(rangeError); return; }
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
          {loading ? (
            <div style={{ fontSize:11, color:G.goldDim, padding:'8px 0' }}>기존 포장 번호 조회 중... / 查询已有序号...</div>
          ) : (
            <>
              <DkInput label="开始序号 / 시작 번호" value={startSeq} onChange={handleStartChange} type="number" inputMode="numeric" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
              <DkInput label="结束序号 / 종료 번호" value={endSeq} onChange={handleEndChange} type="number" inputMode="numeric" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
              <div style={{ fontSize:12, color:G.gold, marginTop:4, fontWeight:400 }}>共 {count} 包 / 총 {count} 포장</div>
              {rangeError && (
                <div style={{ fontSize:11, color:'#FF6B6B', marginTop:8, fontWeight:500 }}>{rangeError}</div>
              )}
            </>
          )}
        </DkCard>
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => setWorker(e.target.value)} placeholder="姓名 / 이름" onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }} />
        </DkCard>
        {packMO && packMO.standard_assortment && packMO.standard_assortment.length > 0 && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>每包内容 / 포장 구성</div>
            {packMO.standard_assortment.map((it, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:11, color:G.goldDim, borderBottom:'1px solid var(--app-divider)' }}>
                <span style={{ color:G.cream, display:'inline-flex', alignItems:'center' }}><ColorDot text={it.color} />{it.color} · {it.size}</span>
                <span style={{ color:G.gold }}>{it.qty} 件</span>
              </div>
            ))}
          </DkCard>
        )}
        <DkBtn onClick={handleSubmit} disabled={!canSubmit}>
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
        filename: sanitizeFilename(`${result.moNumber}_InnerPack_${it.seq}_${it.totalQty}pcs.png`),
        labels: [`${result.moNumber} / Inner Pack #${it.seq}`, `${it.totalQty} 件`]
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
  const handleExcel = async () => {
    if (downloading || savedItems.length === 0 || !result.moData) return;
    setDownloading(true);
    try {
      const packList = savedItems.map(it => ({ packNumber: it.seq, qrText: it.qrText, totalQty: it.totalQty, isRemainder: false }));
      await generateInnerPackExcel(result.moData, packList);
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
        <DkBtn onClick={handleExcel} disabled={downloading || savedItems.length === 0 || !result.moData}>
          {downloading ? '生成中...' : '📊 Excel 下载标签 / Excel 라벨 다운로드 (.xlsx)'}
        </DkBtn>
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
  const [startSeq, setStartSeq] = useState('');
  const [endSeq, setEndSeq] = useState('');
  const [worker, setWorker] = useState('');
  const [packs, setPacks] = useState(null);
  const [packsLoading, setPacksLoading] = useState(false);

  useEffect(() => {
    if (!bagMO?.mo_number) return;
    let cancelled = false;
    async function load() {
      setPacksLoading(true);
      setPacks(null);
      try {
        const all = [];
        let cursor = null;
        let safety = 0;
        while (safety++ < 50) {
          const pr = await getRecords(REPORTS.INNER_PACK, `MO_Number == "${bagMO.mo_number}"`, cursor ? { record_cursor: cursor } : {});
          const data = (pr && pr.code === 3000 && Array.isArray(pr.data)) ? pr.data : [];
          if (data.length === 0) break;
          all.push(...data);
          cursor = pr?.record_cursor || null;
          if (!cursor) break;
        }
        if (cancelled) return;
        const sorted = all.sort((a, b) => parseInt(a['Pack_Sequence']) - parseInt(b['Pack_Sequence']));
        const created = sorted.filter(p => !p['Assigned_To_Bag'] || p['Assigned_To_Bag'] === '');
        console.log('[Batch Bag] Total:', sorted.length, 'Available:', created.length, 'Bagged:', sorted.length - created.length);
        setPacks(sorted);
        if (created.length > 0) {
          setStartSeq(String(parseInt(created[0]['Pack_Sequence'])));
          setEndSeq(String(parseInt(created[created.length - 1]['Pack_Sequence'])));
        }
      } catch (e) {
        console.error('[Batch Bag] loadPacks error:', e);
        if (!cancelled) setPacks([]);
      } finally {
        if (!cancelled) setPacksLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bagMO?.mo_number]);

  const s = parseInt(startSeq) || 0;
  const e = parseInt(endSeq) || 0;

  const createdPacks = useMemo(() => packs ? packs.filter(p => !p['Assigned_To_Bag'] || p['Assigned_To_Bag'] === '') : [], [packs]);
  const baggedPacks  = useMemo(() => packs ? packs.filter(p => p['Assigned_To_Bag'] && p['Assigned_To_Bag'] !== '') : [], [packs]);

  const inRangeAvailable = useMemo(() => createdPacks.filter(p => { const seq = parseInt(p['Pack_Sequence']); return s > 0 && e >= s && seq >= s && seq <= e; }), [createdPacks, s, e]);
  const inRangeBagged    = useMemo(() => baggedPacks.filter(p => { const seq = parseInt(p['Pack_Sequence']); return s > 0 && e >= s && seq >= s && seq <= e; }), [baggedPacks, s, e]);

  const totalBags = inRangeAvailable.length > 0 ? Math.ceil(inRangeAvailable.length / MASTER_BAG_SIZE) : 0;
  const remainder = inRangeAvailable.length % MASTER_BAG_SIZE;
  const minAvail = createdPacks.length > 0 ? parseInt(createdPacks[0]['Pack_Sequence']) : null;
  const maxAvail = createdPacks.length > 0 ? parseInt(createdPacks[createdPacks.length - 1]['Pack_Sequence']) : null;

  const canSubmit = !!(worker.trim() && s > 0 && e >= s && (packs ? inRangeAvailable.length > 0 : e - s + 1 > 0));

  const handleSubmit = () => {
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

        {/* Overview */}
        {packsLoading ? (
          <DkCard><div style={{ fontSize:10, color:G.goldDim, textAlign:'center', padding:'6px 0' }}>正在加载包装数据... / 로딩 중...</div></DkCard>
        ) : packs && (
          <DkCard>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>包装总览 / 포장 현황</div>
            <DkRow label="总包装 / 전체" value={packs.length + ' 个'} />
            <DkRow label="已装袋 / 마대 포함됨" value={baggedPacks.length + ' 个'} />
            <DkRow label="待装袋 / 미할당" value={createdPacks.length + ' 个'} />
            {minAvail != null && maxAvail != null && (
              <div style={{ fontSize:10, color:G.gold, marginTop:8 }}>
                当前可用范围 / 사용 가능 범위: #{minAvail} ~ #{maxAvail}
              </div>
            )}
          </DkCard>
        )}

        {/* Tile grid */}
        {packs && packs.length > 0 && (
          <DkCard style={{ padding:'14px 12px' }}>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400, display:'flex', gap:12, flexWrap:'wrap' }}>
              包装状态 / 포장 상태
              <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                <span style={{ width:10, height:10, background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.1)', display:'inline-block', borderRadius:1 }} />
                <span style={{ color:G.goldDim }}>已装袋</span>
              </span>
              <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                <span style={{ width:10, height:10, background:'transparent', border:'1px solid rgba(212,175,55,0.4)', display:'inline-block', borderRadius:1 }} />
                <span style={{ color:G.goldDim }}>待装袋</span>
              </span>
              <span style={{ display:'flex', alignItems:'center', gap:3 }}>
                <span style={{ width:10, height:10, background:'rgba(75,139,255,0.2)', border:'1px solid #4B8BFF', display:'inline-block', borderRadius:1 }} />
                <span style={{ color:G.goldDim }}>已选范围</span>
              </span>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(50px, 1fr))', gap:4, maxHeight:272, overflowY:'auto' }}>
              {packs.map(p => {
                const seq = parseInt(p['Pack_Sequence']);
                const isBagged = !!(p['Assigned_To_Bag'] && p['Assigned_To_Bag'] !== '');
                const inRange = s > 0 && e >= s && seq >= s && seq <= e;
                let bg, border, color;
                if (isBagged) {
                  bg = 'rgba(255,255,255,0.04)'; border = 'rgba(255,255,255,0.1)'; color = 'rgba(255,255,255,0.2)';
                } else if (inRange) {
                  bg = 'rgba(75,139,255,0.18)'; border = '#4B8BFF'; color = '#93C5FD';
                } else {
                  bg = 'transparent'; border = 'rgba(212,175,55,0.35)'; color = G.goldDim;
                }
                return (
                  <div key={seq} style={{ border:'1px solid '+border, borderRadius:2, padding:'4px 2px', textAlign:'center', background:bg, transition:'background .12s,border-color .12s' }}>
                    <div style={{ fontSize:10, color, lineHeight:1.2 }}>#{seq}</div>
                    {isBagged && <div style={{ fontSize:7, color:'rgba(255,255,255,0.2)', lineHeight:1 }}>✓</div>}
                  </div>
                );
              })}
            </div>
          </DkCard>
        )}

        {/* Range inputs */}
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:14, fontWeight:400 }}>包装序号范围 / 포장 범위</div>
          <DkInput label="开始包装序号 / 시작 포장 번호" value={startSeq} onChange={ev => setStartSeq(ev.target.value)} type="number" inputMode="numeric" onKeyDown={ev => { if (ev.key === 'Enter') handleSubmit(); }} />
          <DkInput label="结束包装序号 / 종료 포장 번호" value={endSeq} onChange={ev => setEndSeq(ev.target.value)} type="number" inputMode="numeric" onKeyDown={ev => { if (ev.key === 'Enter') handleSubmit(); }} />
          <div style={{ fontSize:12, color:G.gold, marginTop:4, fontWeight:400 }}>
            {packs ? (
              inRangeAvailable.length > 0 ? (
                <>
                  {inRangeAvailable.length} 包装 → {totalBags} 麻袋
                  {remainder !== 0 && <span style={{ color:G.goldDim, fontSize:10 }}> (含1个剩余 {remainder}包)</span>}
                  {inRangeBagged.length > 0 && <span style={{ color:'#F59E0B', fontSize:10, display:'block', marginTop:2 }}>跳过 {inRangeBagged.length} 个已装袋 / {inRangeBagged.length}개 건너뜀</span>}
                </>
              ) : s > 0 && e >= s ? (
                <span style={{ color:'#EF4444', fontSize:11 }}>⚠ 范围内无可装袋包装 / 범위 내 사용 가능한 포장 없음</span>
              ) : null
            ) : (
              s > 0 && e >= s ? `${e - s + 1} 包装 → ${Math.ceil((e - s + 1) / MASTER_BAG_SIZE)} 麻袋` : null
            )}
          </div>
        </DkCard>

        {/* Worker */}
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={ev => setWorker(ev.target.value)} placeholder="姓名 / 이름" onKeyDown={ev => { if (ev.key === 'Enter') handleSubmit(); }} />
        </DkCard>

        {/* Info / status card */}
        <DkCard style={{ fontSize:10, color:G.goldDim, lineHeight:1.9 }}>
          {packs && s > 0 && e >= s && inRangeAvailable.length > 0 ? (
            inRangeBagged.length === 0 ? (
              <div style={{ color:'#6EE7B7' }}>✓ 范围内 {inRangeAvailable.length} 个包装均可装袋 / 범위 내 {inRangeAvailable.length}개 모두 사용 가능</div>
            ) : (
              <div style={{ color:'#F59E0B' }}>⚠ 范围内 {inRangeAvailable.length} 个可装袋, {inRangeBagged.length} 个已装袋将被跳过 / 범위 내 {inRangeAvailable.length}개 사용, {inRangeBagged.length}개 건너뜀</div>
            )
          ) : (
            <>
              <div style={{ fontWeight:400, color:G.gold, marginBottom:4 }}>注意 / 주의사항</div>
              <div>· 系统将自动加载指定范围内的包装</div>
              <div>· 已装袋的包装将被跳过</div>
              <div>· 每 {MASTER_BAG_SIZE} 个包装自动组成一个麻袋</div>
              <div>· 目的地自动设为 MEX-Guadalajara</div>
            </>
          )}
        </DkCard>

        <DkBtn onClick={handleSubmit} disabled={!canSubmit}>
          ▶ 开始批量装袋 / 일괄 마대 생성 ({totalBags || (s > 0 && e >= s ? Math.ceil((e - s + 1) / MASTER_BAG_SIZE) : 0)} 麻袋)
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
        filename: sanitizeFilename(`${result.moNumber}_MasterBag_${it.bagSeq}_${it.totalQty}pcs.png`),
        labels: [
          `${result.moNumber} / Master Bag #${it.bagSeq}`,
          `${it.totalQty} 件 (${it.packCount} packs)`,
          ...(it.isRemainder ? ['(剩余 / 자투리)'] : [])
        ]
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
  const handleExcel = async () => {
    if (downloading || savedItems.length === 0 || !result.moData) return;
    setDownloading(true);
    try {
      const bagList = savedItems.map(it => ({ bagNumber: it.bagSeq, qrText: it.qrText }));
      await generateMasterBagExcel(result.moData, bagList);
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
        <DkBtn onClick={handleExcel} disabled={downloading || savedItems.length === 0 || !result.moData}>
          {downloading ? '生成中...' : '📊 Excel 下载标签 / Excel 라벨 다운로드 (.xlsx)'}
        </DkBtn>
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

const BatchBagPreviewScreen = memo(function BatchBagPreviewScreen({ preview, bagMO, onConfirm, onBack }) {
  const { packs, skippedPacks, expectedRange, startPackSeq, endPackSeq, worker } = preview;
  const fullBags = Math.floor(packs.length / MASTER_BAG_SIZE);
  const remainder = packs.length % MASTER_BAG_SIZE;
  const totalBags = fullBags + (remainder > 0 ? 1 : 0);
  const missingCount = expectedRange - (packs.length + skippedPacks.length);
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>PREVIEW · BATCH BAGS</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{bagMO?.mo_number || '—'}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:12, fontWeight:400 }}>装袋预览 / 마대 미리보기</div>
          <div style={{ fontSize:15, color:G.gold, fontWeight:400, marginBottom:6 }}>
            {packs.length} 包装 → {fullBags > 0 ? `${fullBags} 麻袋` : ''}{remainder > 0 ? (fullBags > 0 ? ' + ' : '') + `1 剩余麻袋 (${remainder}包)` : ''}
          </div>
          <div style={{ fontSize:10, color:G.goldDim }}>负责人: {worker} · 序号 {startPackSeq}–{endPackSeq}</div>
          {skippedPacks.length > 0 && (
            <div style={{ fontSize:10, color:'#F59E0B', marginTop:8 }}>
              ⚠ 跳过 {skippedPacks.length} 个已装袋包装 / {skippedPacks.length}개 이미 마대됨 (건너뜀)
            </div>
          )}
          {missingCount > 0 && (
            <div style={{ fontSize:10, color:'#EF4444', marginTop:4 }}>
              ⚠ 范围内仅找到 {packs.length + skippedPacks.length} 个包装, 缺少 {missingCount} 个
            </div>
          )}
        </DkCard>
        <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:8, fontWeight:400 }}>包装列表 / 포장 목록 ({packs.length})</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:5, maxHeight:300, overflowY:'auto', marginBottom:16, paddingRight:4 }}>
          {packs.map(p => (
            <div key={p['Pack_Sequence']} style={{ border:'1px solid var(--app-border)', borderRadius:2, padding:'6px 4px', textAlign:'center', background:G.card }}>
              <div style={{ fontSize:11, color:G.gold }}>#{p['Pack_Sequence']}</div>
              <div style={{ fontSize:9, color:G.goldDim }}>{p['Total_Qty'] || 12}件</div>
            </div>
          ))}
        </div>
        <DkBtn onClick={onConfirm} disabled={packs.length === 0}>
          ▶ 开始批量装袋 / 일괄 마대 생성 ({totalBags} 麻袋)
        </DkBtn>
        <DkBtnOutline onClick={onBack}>← 返回修改 / 수정</DkBtnOutline>
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
        <div style={{ fontSize:20, color:G.cream, marginTop:6, fontWeight:400, letterSpacing:1 }}>包装查询 / 포장 조회</div>
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
        <div style={{ fontSize:20, color:G.cream, marginTop:6, fontWeight:400, letterSpacing:1 }}>麻袋查询 / 마대 조회</div>
      </div>
      <DkBtn onClick={onTextQuery}>📋 文字查询 / 텍스트 조회</DkBtn>
      <DkBtn onClick={onScanQuery}>🔍 扫码查询 / 스캔 조회</DkBtn>
    </DkScreen>
  );
});

const ProductionLogQuerySubMenu = memo(function ProductionLogQuerySubMenu({ onTextQuery, onScanQuery, onBack }) {
  return (
    <DkScreen style={{ padding:'80px 20px 40px' }}>
      <DkBack onClick={onBack} />
      <div style={{ textAlign:'center', marginBottom:40 }}>
        <IconFactory />
        <div style={{ fontSize:11, letterSpacing:4, color:G.gold, marginTop:16, fontWeight:400 }}>QR 查询 / QR 조회</div>
        <div style={{ fontSize:20, color:G.cream, marginTop:6, fontWeight:400, letterSpacing:1 }}>生产进度查询 / 생산 진척 조회</div>
      </div>
      <DkBtn onClick={onTextQuery}>📋 文字查询 / 텍스트 조회</DkBtn>
      <DkBtn onClick={onScanQuery}>🔍 扫码查询 / 스캔 조회</DkBtn>
    </DkScreen>
  );
});

async function updateRecordWithRetry(report, id, data, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await updateRecord(report, id, data);
      if (result && result.code === 3000) return { success: true };
      console.warn(`[Update] attempt ${attempt} non-3000:`, result?.code);
    } catch (err) {
      console.warn(`[Update] attempt ${attempt} threw:`, err.message);
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
  }
  return { success: false };
}

// ─── Bulk Ship screens ────────────────────────────────────────────────
const BulkShipBagSelectScreen = memo(function BulkShipBagSelectScreen({ bagMO, bags, selected, onToggle, onSelectAll, onClearAll, worker, onWorkerChange, onSubmit, onBack }) {
  const total = bags.length;
  const selectedCount = selected.size;
  const canSubmit = selectedCount > 0 && worker.trim();
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>BULK SHIP · 批量出货 / 일괄 출고</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{bagMO ? bagMO.mo_number : '—'}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>麻袋概况 / 마대 현황</div>
          <DkRow label="已生成麻袋 / 생성된 마대" value={total + ' 个'} />
          <DkRow label="已选 / 선택됨" value={selectedCount + ' / ' + total} />
        </DkCard>
        <DkCard style={{ padding:'14px 12px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
            <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, fontWeight:400 }}>选择麻袋 / 마대 선택</div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={onSelectAll} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.4)', color:G.goldDim, fontSize:9, padding:'3px 8px', cursor:'pointer', fontFamily:'inherit' }}>全选 / 전체</button>
              <button onClick={onClearAll} style={{ background:'transparent', border:'1px solid rgba(212,175,55,0.2)', color:G.goldDim, fontSize:9, padding:'3px 8px', cursor:'pointer', fontFamily:'inherit' }}>清除 / 해제</button>
            </div>
          </div>
          {total === 0 ? (
            <div style={{ fontSize:11, color:'#EF4444', textAlign:'center', padding:'12px 0' }}>⚠ 无待出货麻袋 / 출고 가능한 마대 없음</div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(54px, 1fr))', gap:4, maxHeight:272, overflowY:'auto' }}>
              {bags.map(bag => {
                const isSel = selected.has(bag.record_id);
                return (
                  <div key={bag.record_id} onClick={() => onToggle(bag.record_id)}
                    style={{ border:'1px solid '+(isSel ? G.gold : 'rgba(212,175,55,0.3)'), borderRadius:2, padding:'5px 2px', textAlign:'center', background: isSel ? 'rgba(212,175,55,0.15)' : 'transparent', cursor:'pointer', transition:'background .12s,border-color .12s' }}>
                    <div style={{ fontSize:10, color: isSel ? G.gold : G.goldDim, lineHeight:1.2 }}>#{bag.bag_sequence}</div>
                    <div style={{ fontSize:7, color: isSel ? 'rgba(212,175,55,0.7)' : 'rgba(255,255,255,0.15)' }}>{isSel ? '✓' : '·'}</div>
                  </div>
                );
              })}
            </div>
          )}
        </DkCard>
        <DkCard>
          <DkInput label="负责人 / 담당자 *" value={worker} onChange={e => onWorkerChange(e.target.value)} placeholder="姓名 / 이름" onKeyDown={e => { if (e.key === 'Enter' && canSubmit) onSubmit(); }} />
        </DkCard>
        <DkBtn onClick={onSubmit} disabled={!canSubmit}>
          ▶ 开始批量出货 / 일괄 출고 시작 ({selectedCount} 麻袋)
        </DkBtn>
      </div>
    </DkScreen>
  );
});

const BulkShipProgressScreen = memo(function BulkShipProgressScreen({ progress }) {
  const pct = progress.total > 0 ? Math.round(progress.current / progress.total * 100) : 0;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px', textAlign:'center' }}>
        <div style={{ fontSize:9, letterSpacing:6, color:G.gold, fontWeight:400 }}>BULK SHIPPING...</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:8, fontWeight:400 }}>{progress.current} / {progress.total} 麻袋</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ height:4, background:G.progressTrack, borderRadius:2, marginBottom:14 }}>
            <div style={{ height:'100%', background:G.gold, width:pct+'%', borderRadius:2, transition:'width .3s' }} />
          </div>
          <div style={{ fontSize:11, color:G.goldDim, textAlign:'center' }}>{pct}% · 出货处理中 / 출고 처리 중...</div>
        </DkCard>
        {progress.current > 0 && (
          <div style={{ fontSize:10, color:G.goldDim, textAlign:'center', marginTop:8 }}>已完成: {progress.current} 麻袋</div>
        )}
      </div>
    </DkScreen>
  );
});

const BulkShipDoneScreen = memo(function BulkShipDoneScreen({ result, onHome, onRetriggerActure }) {
  const [actureLoading, setActureLoading] = useState(false);
  const [actureStatus, setActureStatus] = useState(null);
  if (!result) return null;

  const handleRetry = async () => {
    setActureLoading(true);
    setActureStatus(null);
    try {
      const r = await onRetriggerActure();
      setActureStatus(r && r.success ? 'ok' : 'fail');
    } catch { setActureStatus('fail'); }
    setActureLoading(false);
  };

  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px 20px 18px' }}>
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>批量出货完成 / 일괄 출고 완료</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{result.moNumber}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <DkRow label="✅ 成功 / 성공" value={result.succeeded + ' 麻袋'} />
          {result.failed > 0 && <DkRow label="❌ 失败 / 실패" value={String(result.failed)} />}
          <DkRow label="총 포장 수량 / 总包装数" value={result.totalPacks + ' Packs'} />
          <DkRow label="总件数 / 총 수량" value={result.totalQty.toLocaleString() + ' 件'} />
        </DkCard>
        {result.failed > 0 && (
          <div style={{ padding:'10px 14px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', marginBottom:12, fontSize:10, color:'#FCA5A5' }}>
            ⚠ {result.failed} 个麻袋出货失败，请手动检查状态 / {result.failed}개 마대 출고 실패, 수동 확인 필요
          </div>
        )}
        {onRetriggerActure && (
          <div style={{ marginBottom:12 }}>
            <DkBtnOutline onClick={handleRetry} disabled={actureLoading}>
              {actureLoading ? '计算中… / 계산 중…' : '🔄 重新计算实际值 / 실적 재계산'}
            </DkBtnOutline>
            {actureStatus === 'ok' && <div style={{ fontSize:10, color:'#6EE7B7', marginTop:6, textAlign:'center' }}>✅ 实际值已更新 / 실적 업데이트 완료</div>}
            {actureStatus === 'fail' && <div style={{ fontSize:10, color:'#FCA5A5', marginTop:6, textAlign:'center' }}>❌ 更新失败，请查看控制台 / 업데이트 실패, 콘솔 확인</div>}
          </div>
        )}
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

// ─── Reserved (中国仓库保留) screens ──────────────────────────────────
const ReservedInputScreen = memo(function ReservedInputScreen({ reservedMO, onSubmit, onBack }) {
  const [qty, setQty] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [worker, setWorker] = useState('');
  if (!reservedMO) return null;

  const planQty = reservedMO.plan_qty || 0;
  const packedQty = reservedMO.packed_qty || 0;
  const currentReserved = reservedMO.current_reserved || 0;
  const remainingReservable = Math.max(0, planQty - packedQty - currentReserved);
  const qtyNum = parseInt(qty) || 0;
  const qtyOk = qtyNum > 0 && qtyNum <= remainingReservable;
  const canSubmit = qtyOk && worker.trim();

  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'72px 20px 18px', position:'relative' }}>
        <DkBack onClick={onBack} />
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>中国仓库保留 / 중국창고보유</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{reservedMO.mo_number}</div>
        <div style={{ fontSize:10, color:G.goldDim, marginTop:2 }}>{reservedMO.sku}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ fontSize:9, letterSpacing:2, color:G.goldDim, marginBottom:10, fontWeight:400 }}>订单概况 / 오더 현황</div>
          <DkRow label="计划数量 / 계획 수량" value={planQty.toLocaleString() + ' 件'} />
          <DkRow label="已包装 / 포장 완료" value={packedQty.toLocaleString() + ' 件'} />
          <DkRow label="当前保留 / 현재 보관" value={currentReserved.toLocaleString() + ' 件'} />
          <DkRow label="剩余可保留 / 보관 가능" value={<span style={{ color: remainingReservable > 0 ? G.gold : '#EF4444' }}>{remainingReservable.toLocaleString() + ' 件'}</span>} />
        </DkCard>
        <DkCard>
          <DkInput
            label="本次保留数量 / 이번 보관 수량"
            value={qty}
            onChange={e => setQty(e.target.value)}
            type="number"
            inputMode="numeric"
            placeholder={'最多 ' + remainingReservable + ' 件'}
          />
          {qty !== '' && !qtyOk && (
            <div style={{ fontSize:10, color:'#EF4444', marginTop:4 }}>
              {qtyNum <= 0 ? '⚠ 请输入有效数量' : '⚠ 超过可保留数量 / 보관 가능 수량 초과'}
            </div>
          )}
        </DkCard>
        <DkCard>
          <DkInput
            label="保留位置 / 보관 위치"
            value={location}
            onChange={e => setLocation(e.target.value)}
            placeholder="예: 公司仓库 A区 / 회사 창고 A구역"
          />
        </DkCard>
        <DkCard>
          <DkInput
            label="备注 / 비고"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="例 / 예: 下季样品保留"
          />
        </DkCard>
        <DkCard>
          <DkInput
            label="负责人 / 담당자 *"
            value={worker}
            onChange={e => setWorker(e.target.value)}
            placeholder="姓名 / 이름"
            onKeyDown={e => { if (e.key === 'Enter' && canSubmit) onSubmit(qtyNum, location.trim(), notes.trim(), worker.trim()); }}
          />
        </DkCard>
        <DkBtn onClick={() => { if (canSubmit) onSubmit(qtyNum, location.trim(), notes.trim(), worker.trim()); }} disabled={!canSubmit}>
          ✓ 登记保留 / 보관 등록
        </DkBtn>
      </div>
    </DkScreen>
  );
});

const ReservedDoneScreen = memo(function ReservedDoneScreen({ result, onContinue, onHome }) {
  if (!result) return null;
  return (
    <DkScreen style={{ paddingTop:0 }}>
      <div className="overlay-header" style={{ background:'var(--app-header-overlay)', borderBottom:'1px solid var(--app-border)', padding:'20px 20px 18px' }}>
        <div style={{ fontSize:9, letterSpacing:4, color:G.gold, fontWeight:400 }}>登记成功 / 등록 완료</div>
        <div style={{ fontSize:18, color:G.cream, marginTop:6, fontWeight:400 }}>{result.moNumber}</div>
      </div>
      <div style={{ padding:'20px 20px 40px' }}>
        <DkCard>
          <div style={{ textAlign:'center', padding:'16px 0 10px' }}>
            <div style={{ fontSize:32, marginBottom:10 }}>✅</div>
            <div style={{ fontSize:13, color:G.cream, letterSpacing:1 }}>保留登记完成 / 보관 등록 완료</div>
          </div>
          <DkRow label="本次保留 / 이번 보관" value={'+' + result.addQty.toLocaleString() + ' 件'} />
          <DkRow label="累计保留 / 누적 보관" value={result.newReserved.toLocaleString() + ' 件'} />
          <DkRow label="计划总量 / 계획 총량" value={result.planQty.toLocaleString() + ' 件'} />
        </DkCard>
        <DkBtn onClick={onContinue}>继续登记 / 계속 등록</DkBtn>
        <DkBtnOutline onClick={onHome}>🏠 返回主页 / 홈으로</DkBtnOutline>
      </div>
    </DkScreen>
  );
});

async function runActureAutoFill(moNumber, moId, planTotalQty, planGrandTotal) {
  console.log('[Acture Auto-fill] 🚀 START — moNumber:', moNumber, 'moId:', moId);
  console.log('[Acture Auto-fill] Plan values — planTotalQty:', planTotalQty, 'planGrandTotal:', planGrandTotal);

  if (!moId) {
    console.warn('[Acture Auto-fill] ❌ moId is empty, skipping');
    return { success: false, reason: 'no-moId' };
  }
  if (!planTotalQty || planTotalQty === 0) {
    console.warn('[Acture Auto-fill] ❌ planTotalQty is 0, skipping');
    return { success: false, reason: 'planTotalQty=0' };
  }

  const avgUnitPrice = planGrandTotal / planTotalQty;
  console.log('[Acture Auto-fill] avgUnitPrice:', avgUnitPrice);

  let allPacks = [], cursor = null, safety = 0;
  while (safety++ < 50) {
    const pr = await getRecords(REPORTS.INNER_PACK, `MO_Number == "${moNumber}"`, cursor ? { record_cursor: cursor } : {});
    console.log(`[Acture Auto-fill] Pack page ${safety}: code=${pr?.code}, count=${Array.isArray(pr?.data) ? pr.data.length : 'N/A'}, cursor=${pr?.record_cursor || 'none'}`);
    if (!pr || pr.code !== 3000 || !Array.isArray(pr.data)) break;
    allPacks = allPacks.concat(pr.data);
    cursor = pr.record_cursor || null;
    if (!cursor) break;
  }
  console.log('[Acture Auto-fill] Total packs fetched:', allPacks.length);

  if (allPacks.length === 0) {
    console.warn('[Acture Auto-fill] ❌ No packs found for MO:', moNumber);
    return { success: false, reason: 'no-packs' };
  }

  const actTotalQty = allPacks.reduce((s, p) => s + (parseInt(p['Total_Qty']) || 0), 0);
  const actGrandTotal = actTotalQty * avgUnitPrice;
  console.log('[Acture Auto-fill] actTotalQty:', actTotalQty, 'actGrandTotal:', actGrandTotal.toFixed(2));

  const dist = {};
  allPacks.forEach(pack => {
    let items; try { items = JSON.parse(pack['Items_JSON'] || '[]'); } catch (e) { return; }
    items.forEach(item => { const k = `${item.color}|${item.size}`; dist[k] = (dist[k] || 0) + (item.qty || 0); });
  });
  const today = new Date().toISOString().slice(0, 10);
  const linesText = Object.entries(dist).map(([k, q]) => {
    const [color, size] = k.split('|');
    return `Color: ${color} | Size: ${size} | Qty: ${q} | Unit: ¥${avgUnitPrice.toFixed(2)} | Total: ¥${(q * avgUnitPrice).toFixed(2)}`;
  }).join('\n');
  const actNotes = `[Auto ${today}] ${allPacks.length} packs\n${linesText}\nTOTAL: ${actTotalQty}件 / ¥${actGrandTotal.toFixed(2)}`;

  console.log('[Acture Auto-fill] Patching MO record_id:', moId);
  const patchResult = await updateRecordWithRetry(REPORTS.MO, moId, {
    Acture_Total_Quantity: actTotalQty,
    Acture_Grand_Total: parseFloat(actGrandTotal.toFixed(2)),
    Acture_Notes: actNotes
  });
  console.log('[Acture Auto-fill] PATCH result:', patchResult);
  console.log('[Acture Auto-fill] ✅ DONE');
  return { success: true, actTotalQty, actGrandTotal };
}

async function updatePackToBagged(packId, bagUUID, packUUID, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await updateRecord(REPORTS.INNER_PACK, packId, { 'Pack_Status': 'Bagged', 'Assigned_To_Bag': bagUUID });
      if (result && result.code === 3000) {
        console.log(`[Pack Update] ✅ Pack #${String(packUUID).slice(0,8)} → Bagged (attempt ${attempt})`);
        return { success: true, packUUID, packId };
      }
      console.warn(`[Pack Update] ⚠️ Pack ${packUUID} attempt ${attempt} non-3000:`, result?.code);
    } catch (err) {
      console.warn(`[Pack Update] ⚠️ Pack ${packUUID} attempt ${attempt} threw:`, err.message);
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
  }
  console.error(`[Pack Update] ❌ Pack ${packUUID} FAILED after ${maxRetries} attempts`);
  return { success: false, packUUID, packId };
}

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
  const [loadingMsg, setLoadingMsg] = useState('正在读取订单信息...');
  const [submitResult, setSubmitResult] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);
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
  const [standardPack, setStandardPack] = useState(null);
  const [standardCopies, setStandardCopies] = useState(1);
  const [standardWorker, setStandardWorker] = useState('');
  const [standardWorkerSubmitting, setStandardWorkerSubmitting] = useState(false);

  // ── New: Master Bag state ──
  const [bagScannedPacks, setBagScannedPacks] = useState([]);
  const [bagIsRemainder, setBagIsRemainder] = useState(false);
  const [bagWorker, setBagWorker] = useState('');
  const [bagContainerNo, setBagContainerNo] = useState('');
  const [bagMO, setBagMO] = useState(null);
  const [createdBag, setCreatedBag] = useState(null);
  const [scannedBagDetail, setScannedBagDetail] = useState(null);
  const [availablePacks, setAvailablePacks] = useState([]);
  const [availablePacksLoading, setAvailablePacksLoading] = useState(false);

  // ── Qty-based bag create state ──
  const [bagStandardInfo, setBagStandardInfo] = useState({
    totalExpected: 0,
    existingStandardCount: 0,
    available: 0,
    standardExists: false,
  });
  const [bagLeftoverPacks, setBagLeftoverPacks] = useState([]);
  const [bagStandardCount, setBagStandardCount] = useState('');
  const [bagSelectedLeftoverUuids, setBagSelectedLeftoverUuids] = useState(() => new Set());
  const [bagSubmitting, setBagSubmitting] = useState(false);

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
  const [batchBagPreview, setBatchBagPreview] = useState(null);

  // ── Bulk Ship state ──
  const [bulkShipMO, setBulkShipMO] = useState(null);
  const [bulkShipBags, setBulkShipBags] = useState([]);
  const [bulkShipSelected, setBulkShipSelected] = useState(new Set());
  const [bulkShipWorker, setBulkShipWorker] = useState('');
  const [bulkShipProgress, setBulkShipProgress] = useState({ current: 0, total: 0 });
  const [bulkShipResult, setBulkShipResult] = useState(null);

  // ── Reserved state ──
  const [reservedMO, setReservedMO] = useState(null);
  const [reservedResult, setReservedResult] = useState(null);

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


  const fetchLogs = useCallback(async (moNumber) => {
    setLogsLoading(true);
    try {
      const criteria = `MO_Number == "${moNumber}"`;
      const res = await getRecords(LOG_REPORT, criteria, { max_records: 200 });
      setLogs((res && res.code === 3000 && Array.isArray(res.data)) ? res.data : []);
    } catch (err) {
      console.error('[fetchLogs] error:', err?.body?.upstream || err?.body || err?.message || err);
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const fetchMOData = useCallback(async (moNumber, sku, factory) => {
    console.log('[MO Fetch] Querying:', moNumber);
    try {
      const res = await getRecords(MO_REPORT, `MO_Number == "${moNumber}"`);
      console.log('[MO Fetch] code=' + (res && res.code) + ', count=' + (res && res.data ? res.data.length : 0));
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      if (list.length === 0) {
        setCurrentScreen('scan');
        alert('未找到订单号: ' + moNumber + '\n请确认后重新扫描');
        return;
      }
      const r = list[0];
      const status = r['Production_Status'] || '-';
      console.log('[MO Fetch] Production_Status:', status);
      console.log('[MO Fetch] Inner_Pack_Count:', r['Inner_Pack_Count']);
      console.log('[MO Fetch] Master_Bag_Count:', r['Master_Bag_Count']);
      let skuStr = sku || '-';
      const skuRaw = r['Style_SKU'];
      if (skuRaw) {
        if (typeof skuRaw === 'object') skuStr = skuRaw.display_value || skuRaw.Style_SKU || skuStr;
        else if (skuRaw !== '-') skuStr = skuRaw;
      }
      const sl = status.toLowerCase();
      const isShipped = sl.includes('ship') || status.includes('출고') || status.includes('已出货');
      const isCompleted = !isShipped && (sl.includes('complet') || status.includes('완료') || status.includes('完成'));
      if (isShipped) {
        const proceed = window.confirm(
          '⚠ 此订单已出货 / 이 오더는 이미 출고되었습니다\n继续操作可能产生异常记录 / 추가 작업 시 비정상 기록 발생 가능\n\n确认 = 继续 / 계속    取消 = 返回 / 취소'
        );
        if (!proceed) { setCurrentScreen('scan'); return; }
      }
      // ── Field discovery for the order-info card (display-only) ──
      // Factory: from the MO record itself (IKU formatFactory strips "_NN_"),
      // falling back to the scanned QR factory value.
      const factoryVal = formatFactory(getField(r, 'Factory') || factory) || '-';
      // Chinese style name: probe candidate field names.
      const chiStyle = findFieldValue(r, CHINESE_STYLE_NAME_FIELDS);
      // 面料 / 원단: MO.Fabric_Name (primary) → linked Style's Fabric_Name (fallback).
      // Style value is read from the MO response's lookup subfield (no extra call).
      const fabricMO = getField(r, 'Fabric_Name');
      const fabricStyle = readLookupSubfield(r, ['Style_SKU', 'Style', 'Styles', 'Style_Name'], 'Fabric_Name');
      const fabricValue = fabricMO || fabricStyle || '';
      const fabricSource = fabricMO ? 'MO.Fabric_Name' : (fabricStyle ? 'Style.Fabric_Name' : '(none)');
      const styleImageRaw = r['Style_Image'];
      const styleImageUrl = extractImageUrl(r);
      console.log('[MO Fetch] field discovery:', {
        factory_raw: getField(r, 'Factory') || '(empty)',
        chinese_style_name_field: chiStyle.key || '(none found)',
        chinese_style_name_value: chiStyle.value || '(empty)',
        fabric_source: fabricSource,
        fabric_value: fabricValue || '(empty)',
        style_image_raw: styleImageRaw !== undefined
          ? (typeof styleImageRaw === 'string'
              ? styleImageRaw.slice(0, 120)
              : JSON.stringify(styleImageRaw).slice(0, 120))
          : '(field absent)',
        style_image_value: styleImageUrl || '(none extracted)',
      });
      if (!fabricValue) {
        // Neither source returned a value. Most likely the report is missing the
        // column. Report the exact report name so the user can add it in Zoho.
        console.warn(
          '[MO Fetch] 面料/원단 미표시 — Fabric_Name 값 없음.\n' +
          '  ① MO 소스: "' + MO_REPORT + '" 리포트에 Fabric_Name 컬럼 추가 필요\n' +
          '  ② Style 폴백: "' + MO_REPORT + '" 리포트의 Style 연결(lookup) 컬럼에 ' +
          'Fabric_Name 서브필드를 노출하거나, Styles 리포트에서 가져오도록 컬럼 추가 필요'
        );
      }

      const next = {
        mo_number: r['MO_Number'] || moNumber,
        sku: skuStr,
        factory: factoryVal,
        chi_style_name: chiStyle.value || '',
        fabric: fabricValue,
        style_image_url: styleImageUrl,
        order_qty: parseInt(r['Plan_Total_Quantity']) || 0,
        current_status: status,
        plan_notes: r['Plan_Notes'] || '',
        is_shipped: isShipped,
        is_completed: isCompleted,
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
        record_id: found['ID'],
        chi_style_name: found['Chi_Style_Name'] || '',
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

  // ── PATCH Total_Expected on every download — stores last-print count ──
  // No max() guard: the bag screen wants "how many were printed most recently",
  // so each download overwrites the prior value (even if smaller).
  const bumpStandardTotalExpected = useCallback(async (n) => {
    if (!standardPack || !standardPack.recordId) return;
    const N = parseInt(n) || 0;
    try {
      await updateRecord(REPORTS.INNER_PACK, standardPack.recordId, { 'Total_Expected': N });
      setStandardPack(prev => prev ? { ...prev, totalExpected: N } : prev);
    } catch (e) {
      console.warn('[standard pack] Total_Expected PATCH failed', e);
    }
  }, [standardPack]);

  // ── New: Standard Pack — Step A (MO load, gate on Worker input) ──
  const enterStandardPackWorker = useCallback(async (moNumber) => {
    setLoadingMsg('订单加载中... / MO 로딩...');
    setCurrentScreen('loading');
    try {
      const moRes = await getRecords(REPORTS.MO);
      const moList = (moRes && moRes.code === 3000 && Array.isArray(moRes.data)) ? moRes.data : [];
      const found = moList.find(r => r['MO_Number'] === moNumber);
      if (!found) {
        setCurrentScreen('standard_pack_mo_select');
        alert('未找到订单: ' + moNumber);
        return;
      }
      const normalizedMO = {
        mo_number: found['MO_Number'] || moNumber,
        sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-',
        factory: getField(found, 'Factory') || '-',
        order_qty: parseInt(found['Plan_Total_Quantity']) || 0,
        plan_notes: found['Plan_Notes'] || '',
        standard_assortment: parseStandardAssortment(found),
        record_id: found['ID'],
        chi_style_name: found['Chi_Style_Name'] || '',
        standard_assortment_json_raw: found['Standard_Assortment_JSON'] || '',
      };
      setPackMO(normalizedMO);
      setStandardWorker('');
      setCurrentScreen('standard_pack_worker_input');
    } catch (err) {
      setCurrentScreen('standard_pack_mo_select');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  // ── New: Standard Pack — Step B (fetch-or-create with worker) ──
  const confirmStandardPackWorker = useCallback(async (workerName) => {
    if (!packMO || !workerName) return;
    setStandardWorkerSubmitting(true);
    setLoadingMsg('표준 QR 불러오는 중... / 加载标准QR...');
    setCurrentScreen('loading');
    try {
      const moNumber = packMO.mo_number;
      const stdRes = await getRecords(
        REPORTS.INNER_PACK,
        `MO_Number == "${moNumber}"`
      ).catch(err => {
        // Zoho 9280 = "No records found" — normal on first creation
        if (err.status === 400 && err.body?.upstream?.code === 9280) return { code: 3000, data: [] };
        throw err;
      });
      const allPackRecords = (stdRes && stdRes.code === 3000 && Array.isArray(stdRes.data)) ? stdRes.data : [];
      const stdRecords = allPackRecords.filter(r => {
        const ir = r['Is_Remainder'];
        return ir === false || ir === 'false' || ir === 0 || !ir;
      });

      let qrText, uuid, recordId, totalExpected;
      // Normalize Items_JSON: ensure it's a bracketed array string
      const rawItems = (packMO.standard_assortment_json_raw || '').trim();
      const itemsJson = rawItems
        ? (rawItems.startsWith('[') ? rawItems : `[${rawItems}]`)
        : '';

      if (stdRecords.length > 0) {
        const existing = stdRecords[0];
        uuid = existing['Pack_UUID'];
        recordId = existing['ID'];
        totalExpected = parseInt(existing['Total_Expected']) || 0;
        qrText = getAppBaseUrl() + '/view/inner/' + uuid;
        // Update Worker on existing standard record (PATCH)
        const existingWorker = (typeof existing['Worker'] === 'object'
          ? (existing['Worker'].display_value || '')
          : (existing['Worker'] || '')).trim();
        const patch = {};
        if (existingWorker !== workerName) patch['Worker'] = workerName;
        // Backfill Items_JSON if missing
        if ((!existing['Items_JSON'] || String(existing['Items_JSON']).trim() === '') && itemsJson) {
          patch['Items_JSON'] = itemsJson;
        }
        if (recordId && Object.keys(patch).length > 0) {
          try {
            await updateRecord(REPORTS.INNER_PACK, recordId, patch);
          } catch (e) {
            console.warn('[standard pack] PATCH failed', e);
          }
        }
      } else {
        qrText = buildInnerPackQR();
        uuid = qrText.split('/view/inner/')[1];
        totalExpected = 0; // Bumped up by download handlers — reflects actual print count
        const postData = {
          'Pack_UUID':      uuid,
          'Brand':          BRAND,
          'MO_Number':      moNumber,
          'SKU':            packMO.sku,
          'Pack_Sequence':  0,
          'Total_Expected': totalExpected,
          'Total_Qty':      INNER_PACK_SIZE,
          'Is_Remainder':   false,
          'Items_JSON':     itemsJson,
          'Worker':         workerName,
          'Factory':        packMO.factory,
          'Pack_Status':    'Created',
        };
        const r = await submitRecord(FORMS.INNER_PACK, postData);
        if (!r || r.code !== 3000) {
          throw new Error('표준 레코드 생성 실패: ' + JSON.stringify(r));
        }
        recordId = r?.data?.ID || r?.data?.[0]?.ID || null;
      }

      const qrDataURL = await generateQRDataURL(qrText, 512);
      const recommended = packMO.order_qty > 0
        ? Math.ceil(packMO.order_qty / INNER_PACK_SIZE) : 1;
      setStandardCopies(recommended);
      setStandardPack({ uuid, qrText, qrDataURL, recordId, totalExpected });
      setCurrentScreen('standard_pack_qr');
    } catch (err) {
      setCurrentScreen('standard_pack_worker_input');
      alert('표준 QR 처리 실패 / 加载失败: ' + (err?.message || String(err)));
    } finally {
      setStandardWorkerSubmitting(false);
    }
  }, [packMO]);

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
      const orderQty = parseInt(found['Plan_Total_Quantity']) || 0;
      setBagMO({
        mo_number: found['MO_Number'] || moNumber,
        sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-',
        factory: getField(found, 'Factory') || '-',
        order_qty: orderQty,
        chi_style_name: found['Chi_Style_Name'] || '',
        standard_assortment: parseStandardAssortment(found),
      });
      // Reset qty-based create state for this MO
      setBagStandardCount('');
      setBagSelectedLeftoverUuids(new Set());
      setBagStandardInfo({ totalExpected: 0, existingStandardCount: 0, available: 0, standardExists: false });
      setBagLeftoverPacks([]);

      setCurrentScreen('bag_create');
      setAvailablePacksLoading(true);
      setAvailablePacks([]);
      (async () => {
        try {
          // 1) All inner packs for this MO (paginated)
          const allPacks = [];
          let cursor = null;
          let safety = 0;
          while (safety++ < 50) {
            const pr = await getRecords(REPORTS.INNER_PACK, `MO_Number == "${moNumber}"`, cursor ? { record_cursor: cursor } : {});
            const data = (pr && pr.code === 3000 && Array.isArray(pr.data)) ? pr.data : [];
            if (data.length === 0) break;
            allPacks.push(...data);
            cursor = pr?.record_cursor || null;
            if (!cursor) break;
          }
          const seenP = new Set();
          const uniquePacks = allPacks.filter(p => { const id = p['Pack_UUID']; if (seenP.has(id)) return false; seenP.add(id); return true; });

          // 2) Standard record (Is_Remainder == false) — for Total_Expected.
          // No fallback to ceil(orderQty/12): we want the actual printed count.
          // 0 = "QR 미인쇄" notice shown to the operator.
          const stdRecord = uniquePacks.find(p =>
            (p['Is_Remainder'] === false || p['Is_Remainder'] === 'false' || !p['Is_Remainder'])
            && (parseInt(p['Pack_Sequence']) || 0) === 0
          ) || null;
          const totalExpected = stdRecord ? (parseInt(stdRecord['Total_Expected']) || 0) : 0;

          // 3) Existing Master Bags for this MO — sum Inner_Pack_Count
          let existingStandardCount = 0;
          try {
            const allBags = [];
            let cur = null, safe = 0;
            while (safe++ < 50) {
              const br = await getRecords(REPORTS.MASTER_BAG, `MO_Number == "${moNumber}"`, cur ? { record_cursor: cur } : {});
              const bd = (br && br.code === 3000 && Array.isArray(br.data)) ? br.data : [];
              if (bd.length === 0) break;
              allBags.push(...bd);
              cur = br?.record_cursor || null;
              if (!cur) break;
            }
            existingStandardCount = allBags.reduce((s, b) => s + (parseInt(b['Inner_Pack_Count']) || 0), 0);
          } catch (e) {
            console.warn('[Master Bag] existing bag fetch failed', e);
          }

          // 4) Unassigned leftover packs (Is_Remainder == true && !Assigned_To_Bag)
          const leftovers = uniquePacks
            .filter(p =>
              (p['Is_Remainder'] === true || p['Is_Remainder'] === 'true')
              && (!p['Assigned_To_Bag'] || p['Assigned_To_Bag'] === '')
              && (!p['Pack_Status'] || p['Pack_Status'] === 'Created')
            )
            .map(p => {
              let items = [];
              try { items = JSON.parse(p['Items_JSON'] || '[]'); } catch (e) {}
              return {
                uuid: p['Pack_UUID'],
                record_id: p['ID'],
                pack_sequence: parseInt(p['Pack_Sequence']) || 0,
                total_qty: parseInt(p['Total_Qty']) || 0,
                items,
              };
            })
            .sort((a, b) => a.pack_sequence - b.pack_sequence);

          setBagStandardInfo({
            totalExpected,
            existingStandardCount,
            available: Math.max(0, totalExpected - existingStandardCount),
            standardExists: !!stdRecord,
          });
          setBagLeftoverPacks(leftovers);
          // Legacy availablePacks still set for old BagCreateScreen if ever rendered
          setAvailablePacks(uniquePacks
            .filter(p => (!p['Assigned_To_Bag'] || p['Assigned_To_Bag'] === '') && (!p['Pack_Status'] || p['Pack_Status'] === 'Created'))
            .sort((a, b) => (parseInt(a['Pack_Sequence']) || 0) - (parseInt(b['Pack_Sequence']) || 0)));
          setAvailablePacksLoading(false);
        } catch (e) {
          console.error('[Master Bag] fetch context failed', e);
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
      setPackMO({ mo_number: found['MO_Number'] || moNumber, sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-', factory: getField(found, 'Factory') || '-', order_qty: parseInt(found['Plan_Total_Quantity']) || 0, plan_notes: found['Plan_Notes'] || '', standard_assortment: standardAssortment, record_id: found['ID'], chi_style_name: found['Chi_Style_Name'] || '' });
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
      setBagMO({ mo_number: found['MO_Number'] || moNumber, sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-', factory: getField(found, 'Factory') || '-', chi_style_name: found['Chi_Style_Name'] || '', standard_assortment: parseStandardAssortment(found) });
      setCurrentScreen('batch_bag_input');
    } catch (err) {
      setCurrentScreen('batch_bag_mo_select');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  const fetchMODataForBulkShip = useCallback(async (moNumber) => {
    try {
      const moRes = await getRecords(REPORTS.MO);
      const moList = (moRes && moRes.code === 3000 && Array.isArray(moRes.data)) ? moRes.data : [];
      const found = moList.find((r) => r['MO_Number'] === moNumber);
      if (!found) { setCurrentScreen('bulk_ship_mo_select'); alert('未找到订单: ' + moNumber); return; }
      setBulkShipMO({ mo_number: found['MO_Number'] || moNumber, mo_id: found['ID'] || '', plan_grand_total: parseFloat(found['Plan_Grand_Total']) || 0, plan_total_quantity: parseInt(found['Plan_Total_Quantity']) || 0, sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-', factory: getField(found, 'Factory') || '-' });
      const bagRes = await getRecordsByCriteria(REPORTS.MASTER_BAG, `MO_Number == "${moNumber}" && Bag_Status == "Created"`);
      const bagList = (bagRes && bagRes.code === 3000 && Array.isArray(bagRes.data)) ? bagRes.data : [];
      const bags = bagList
        .map(r => {
          let uuids = [];
          try { uuids = JSON.parse(r['Inner_Pack_UUIDs'] || '[]'); } catch (e) {}
          return { record_id: r['ID'], bag_sequence: parseInt(r['Bag_Sequence']) || 0, bag_uuid: r['Bag_UUID'], inner_pack_uuids: uuids, total_qty: parseInt(r['Total_Qty']) || 0 };
        })
        .sort((a, b) => a.bag_sequence - b.bag_sequence);
      setBulkShipBags(bags);
      setBulkShipSelected(new Set(bags.map(b => b.record_id)));
      setBulkShipWorker('');
      setCurrentScreen('bulk_ship_bag_select');
    } catch (err) {
      setCurrentScreen('bulk_ship_mo_select');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  const handleBulkShip = useCallback(async () => {
    const bags = bulkShipBags.filter(b => bulkShipSelected.has(b.record_id));
    if (bags.length === 0) return;
    setBulkShipProgress({ current: 0, total: bags.length });
    setCurrentScreen('bulk_ship_progress');
    let succeeded = 0, failed = 0, totalPacks = 0, totalQty = 0;
    for (let i = 0; i < bags.length; i++) {
      const bag = bags[i];
      setBulkShipProgress({ current: i, total: bags.length });
      try {
        const bagUpd = await updateRecordWithRetry(REPORTS.MASTER_BAG, bag.record_id, { Bag_Status: 'Shipped' });
        if (!bagUpd.success) throw new Error('Bag update failed');
        for (const packUUID of bag.inner_pack_uuids) {
          const packRes = await getRecordsByCriteria(REPORTS.INNER_PACK, `Pack_UUID == "${packUUID}"`);
          const packList = (packRes && packRes.code === 3000 && Array.isArray(packRes.data)) ? packRes.data : [];
          if (packList.length > 0) {
            await updateRecordWithRetry(REPORTS.INNER_PACK, packList[0]['ID'], { Pack_Status: 'Shipped' });
          }
        }
        succeeded++;
        totalPacks += bag.inner_pack_uuids.length;
        totalQty += bag.total_qty;
        console.log(`[Bulk Ship] ✅ Bag #${bag.bag_sequence} → Shipped`);
      } catch (err) {
        failed++;
        console.error(`[Bulk Ship] ❌ Bag #${bag.bag_sequence} failed:`, err.message);
      }
    }
    setBulkShipProgress({ current: bags.length, total: bags.length });

    // ── Auto-fill Acture fields if ALL bags of this MO are now Shipped ──
    console.log('[Bulk Ship] All selected bags processed. Checking full-shipment status for MO:', bulkShipMO?.mo_number);
    try {
      const moNum = bulkShipMO?.mo_number || '';
      const allBagRes = await getRecords(REPORTS.MASTER_BAG, `MO_Number == "${moNum}"`);
      const allBags = (allBagRes?.code === 3000 && Array.isArray(allBagRes.data)) ? allBagRes.data : [];
      const shippedBags = allBags.filter(b => b['Bag_Status'] === 'Shipped');
      const createdBags = allBags.filter(b => b['Bag_Status'] === 'Created');
      console.log(`[Bulk Ship] MO ${moNum}: total=${allBags.length} bags, shipped=${shippedBags.length}, created=${createdBags.length}`);
      if (allBags.length === 0) {
        console.warn('[Bulk Ship] No bags returned from Zoho — cannot determine shipment status');
      } else if (shippedBags.length < allBags.length) {
        console.log(`[Bulk Ship] Not all bags shipped (${shippedBags.length}/${allBags.length}) — skipping Acture auto-fill`);
      } else {
        console.log('[Bulk Ship] ✅ ALL bags Shipped — triggering Acture auto-fill');
        await runActureAutoFill(moNum, bulkShipMO?.mo_id || '', bulkShipMO?.plan_total_quantity || 0, bulkShipMO?.plan_grand_total || 0);
      }
    } catch (autoErr) {
      console.error('[Bulk Ship] Acture trigger check failed:', autoErr?.message || String(autoErr));
      console.error('[Bulk Ship] Acture error stack:', autoErr?.stack);
    }

    setBulkShipResult({ moNumber: bulkShipMO?.mo_number || '', moId: bulkShipMO?.mo_id || '', planTotalQty: bulkShipMO?.plan_total_quantity || 0, planGrandTotal: bulkShipMO?.plan_grand_total || 0, succeeded, failed, totalPacks, totalQty });
    setCurrentScreen('bulk_ship_done');
  }, [bulkShipBags, bulkShipSelected, bulkShipMO]);

  const handleRetriggerActure = useCallback(async () => {
    if (!bulkShipResult) return { success: false, reason: 'no-result' };
    const { moNumber, moId, planTotalQty, planGrandTotal } = bulkShipResult;
    console.log('[Retrigger Acture] Manual trigger — moNumber:', moNumber, 'moId:', moId, 'planTotalQty:', planTotalQty, 'planGrandTotal:', planGrandTotal);
    return await runActureAutoFill(moNumber, moId, planTotalQty, planGrandTotal);
  }, [bulkShipResult]);

  const handleViewPackFromBag = useCallback(async (packUUID) => {
    setLoadingMsg('查询包装信息...');
    setCurrentScreen('loading');
    try {
      const res = await getRecordsByCriteria(REPORTS.INNER_PACK, `Pack_UUID == "${packUUID}"`);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      const found = list[0] || null;
      if (!found) { setCurrentScreen('bag_detail'); alert('未找到此包装'); return; }
      let items = [];
      try { items = JSON.parse(found['Items_JSON'] || '[]'); } catch (e) {}
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
      setPackDetailFrom('bag_detail');
      setCurrentScreen('pack_detail');
    } catch (err) {
      setCurrentScreen('bag_detail');
      alert('查询失败: ' + (err?.message || String(err)));
    }
  }, []);

  const fetchMODataForReserved = useCallback(async (moNumber) => {
    try {
      const res = await getRecords(REPORTS.MO, `MO_Number == "${moNumber}"`);
      const list = (res && res.code === 3000 && Array.isArray(res.data)) ? res.data : [];
      if (list.length === 0) { setCurrentScreen('reserved_mo_select'); alert('未找到订单: ' + moNumber); return; }
      const found = list[0];
      setReservedMO({
        mo_number: found['MO_Number'] || moNumber,
        record_id: found['ID'],
        sku: getField(found, 'Style_SKU') || getField(found, 'SKU') || '-',
        factory: getField(found, 'Factory') || '-',
        plan_qty: parseInt(found['Plan_Total_Quantity']) || 0,
        packed_qty: parseInt(found['Inner_Pack_Total_Qty']) || 0,
        current_reserved: parseInt(found['Reserved_Qty']) || 0,
        reserved_notes: found['Reserved_Notes'] || '',
      });
      setCurrentScreen('reserved_input');
    } catch (err) {
      setCurrentScreen('reserved_mo_select');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, []);

  const handleRegisterReserved = useCallback(async (addQty, location, notes, worker) => {
    if (!reservedMO) return;
    setLoadingMsg('登记中...');
    setCurrentScreen('loading');
    try {
      const newReserved = reservedMO.current_reserved + addQty;
      const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const entry = `[${timestamp}] ${worker}: +${addQty}件${location ? ' @ ' + location : ''}${notes ? ' - ' + notes : ''}`;
      const updatedNotes = reservedMO.reserved_notes ? `${reservedMO.reserved_notes}\n${entry}` : entry;
      const result = await updateRecord(REPORTS.MO, reservedMO.record_id, {
        Reserved_Qty: newReserved,
        Reserved_Notes: updatedNotes,
      });
      if (!result || result.code !== 3000) throw new Error('更新失败: code=' + (result?.code || 'unknown'));
      console.log(`[Reserved] ${reservedMO.mo_number}: +${addQty} (total ${newReserved})`);
      setReservedMO(prev => prev ? { ...prev, current_reserved: newReserved, reserved_notes: updatedNotes } : prev);
      setReservedResult({ moNumber: reservedMO.mo_number, addQty, newReserved, planQty: reservedMO.plan_qty });
      setCurrentScreen('reserved_done');
    } catch (err) {
      setCurrentScreen('reserved_input');
      alert('登记失败: ' + (err?.message || String(err)));
    }
  }, [reservedMO]);

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
        const raw = (found['Items_JSON'] || found['items_json'] || '').toString().trim();
        if (raw) items = JSON.parse(raw.startsWith('[') ? raw : `[${raw}]`);
      } catch (e) { items = []; }
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
      logActivity({
        timestamp: Date.now(),
        type: 'inner_pack',
        action: 'created',
        moNumber: packMO.mo_number,
        moStyleSku: packMO.sku || '',
        packNumbers: [packSequence],
        bagNumbers: null,
        pieceCount: totalQty,
        creator: packWorker.trim(),
      });
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

  const toggleBagLeftover = useCallback((uuid) => {
    setBagSelectedLeftoverUuids(prev => {
      const next = new Set(prev);
      next.has(uuid) ? next.delete(uuid) : next.add(uuid);
      return next;
    });
  }, []);

  // ── Qty-based bag creation with auto-split ──
  // standardCount = N → ceil(N/10) bags POSTed sequentially. Full bags hold
  // PACKS_PER_BAG=10 standard packs each; the last bag absorbs any remainder
  // standard packs (< 10) AND all selected leftover Pack UUIDs.
  const handleCreateBagQty = useCallback(async () => {
    if (!bagMO) { alert('请先选择订单号'); return; }
    const stdN = parseInt(bagStandardCount) || 0;
    const selectedLeftovers = bagLeftoverPacks.filter(p => bagSelectedLeftoverUuids.has(p.uuid));
    if (stdN === 0 && selectedLeftovers.length === 0) {
      alert('표준 또는 자투리 중 하나 이상 입력 / 请至少输入标准或选择零散');
      return;
    }
    if (!bagWorker.trim()) {
      alert('请输入负责人 / 담당자');
      return;
    }

    const PACKS_PER_BAG = 10;
    const primaryMO = bagMO.mo_number;
    const fullBags = Math.floor(stdN / PACKS_PER_BAG);
    const remainderStd = stdN % PACKS_PER_BAG;
    const bagsToCreate = Math.max(1,
      fullBags + (remainderStd > 0 ? 1 : 0) + (stdN === 0 && selectedLeftovers.length > 0 ? 1 : 0)
    );
    // The "no full bags but has remainder/leftovers" case already counted above.
    const effectiveBagsToCreate = stdN === 0
      ? 1  // leftover-only → single bag
      : fullBags + (remainderStd > 0 ? 1 : 0);

    // Determine starting Bag_Sequence = max(existing) + 1.
    let nextSeq = 1;
    try {
      const bagRes = await getRecords(REPORTS.MASTER_BAG, `MO_Number == "${primaryMO}"`);
      if (bagRes && bagRes.code === 3000 && Array.isArray(bagRes.data) && bagRes.data.length > 0) {
        const maxSeq = bagRes.data.reduce((m, b) => Math.max(m, parseInt(b['Bag_Sequence']) || 0), 0);
        nextSeq = maxSeq + 1;
      }
    } catch (e) { /* fall through with nextSeq=1 */ }

    setBagSubmitting(true);
    setLoadingMsg('保存麻袋信息 / 마대 저장중...');
    setCurrentScreen('loading');

    const createdBags = [];
    let failedAt = -1;
    let failedReason = null;

    try {
      for (let i = 0; i < effectiveBagsToCreate; i++) {
        const isLastBag = i === effectiveBagsToCreate - 1;
        const packCount = (isLastBag && remainderStd > 0) ? remainderStd
                        : (stdN === 0 ? 0 : PACKS_PER_BAG);
        const leftoversForThisBag = isLastBag ? selectedLeftovers : [];
        const leftoverQtySum = leftoversForThisBag.reduce((s, p) => s + (parseInt(p.total_qty) || 0), 0);
        const bagTotalQty = packCount * INNER_PACK_SIZE + leftoverQtySum;
        const isRemainderBag = leftoversForThisBag.length > 0;

        const qrText = buildMasterBagQR();
        const uuid = qrText.split('/view/bag/')[1];
        const bagSequence = nextSeq + i;

        const bagData = {
          'Bag_UUID':         uuid,
          'Brand':            BRAND,
          'Bag_Sequence':     bagSequence,
          'MO_Number':        primaryMO,
          'SKU':              bagMO.sku,
          'Factory':          bagMO.factory,
          'Inner_Pack_Count': packCount,
          'Inner_Pack_UUIDs': JSON.stringify(leftoversForThisBag.map(p => p.uuid)),
          'Total_Qty':        bagTotalQty,
          'Is_Remainder':     isRemainderBag,
          'Worker':           bagWorker.trim(),
          'Destination':      'MEX-Guadalajara',
          'Bag_Status':       'Created',
        };

        setLoadingMsg(`保存麻袋 / 마대 저장중 ${i + 1}/${effectiveBagsToCreate}...`);
        const res = await submitRecord(FORMS.MASTER_BAG, bagData);
        if (!res || res.code !== 3000) {
          failedAt = i;
          failedReason = JSON.stringify(res);
          break;
        }

        const qrDataURL = await generateQRDataURL(qrText, 512);
        createdBags.push({
          uuid, qrText, qrDataURL,
          bagSequence,
          packCount,
          totalQty: bagTotalQty,
          isRemainder: isRemainderBag,
          leftoverUuids: leftoversForThisBag.map(p => p.uuid),
        });
      }

      // PATCH all selected leftover packs → Bagged (they belong to the LAST
      // successfully created bag, if it included them).
      if (createdBags.length > 0 && selectedLeftovers.length > 0) {
        const lastBag = createdBags[createdBags.length - 1];
        // Only PATCH if last bag actually carries the leftovers (it does when
        // the loop reached its final iteration without failing).
        if (lastBag.leftoverUuids.length > 0) {
          setLoadingMsg('状态更新中 / 상태 갱신중...');
          const patchFailures = [];
          for (const p of selectedLeftovers) {
            const r = await updatePackToBagged(p.record_id, lastBag.uuid, p.uuid);
            if (!r.success) patchFailures.push(r);
          }
          if (patchFailures.length > 0) {
            alert(`경고: ${patchFailures.length}개 자투리 Pack의 상태 갱신 실패`);
          }
        }
      }

      if (failedAt >= 0) {
        alert(`保存失败 / 저장 실패 (마대 ${failedAt + 1}/${effectiveBagsToCreate}):\n` + failedReason
          + `\n\n성공: ${createdBags.length}개 / 失败 이후 중단`);
      }

      const totalQtySum = createdBags.reduce((s, b) => s + b.totalQty, 0);
      setCreatedBag({
        moNumber: primaryMO,
        totalBags: createdBags.length,
        totalQty: totalQtySum,
        bags: createdBags,
      });

      if (createdBags.length > 0) {
        logActivity({
          timestamp: Date.now(),
          type: 'master_bag',
          action: 'created',
          moNumber: primaryMO,
          moStyleSku: bagMO.sku || '',
          packNumbers: null,
          bagNumbers: createdBags.map(b => b.bagSequence),
          pieceCount: totalQtySum,
          creator: bagWorker.trim(),
        });
        setCurrentScreen('bag_success');
      } else {
        setCurrentScreen('bag_create');
      }
    } catch (err) {
      setCurrentScreen('bag_create');
      alert('保存失败 / 저장 실패: ' + (err?.message || String(err)));
    } finally {
      setBagSubmitting(false);
    }
  }, [bagMO, bagStandardCount, bagSelectedLeftoverUuids, bagLeftoverPacks, bagWorker]);

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
      const bagRes = await getRecords(REPORTS.MASTER_BAG, `MO_Number == "${primaryMO}"`);
      if (bagRes && bagRes.code === 3000 && Array.isArray(bagRes.data)) {
        bagSequence = bagRes.data.length + 1;
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
      const updateResults = [];
      for (const p of bagScannedPacks) {
        updateResults.push(await updatePackToBagged(p.record_id, uuid, p.uuid));
      }
      let failures = updateResults.filter(r => !r.success);
      if (failures.length > 0) {
        console.error('[bag] Failed pack updates:', failures.map(f => f.packUUID));
        const retry = window.confirm(`⚠ 마대 생성됐지만 ${failures.length}개 Pack 상태 갱신 실패\n재시도하시겠습니까? / 再试?`);
        if (retry) {
          for (const f of failures) {
            await updatePackToBagged(f.packId, uuid, f.packUUID, 5);
          }
          failures = [];
        } else {
          alert(`경고: ${failures.length}개 Pack의 Pack_Status가 Bagged로 갱신되지 않았습니다. 다음 마대 생성 시 잘못 노출될 수 있습니다.`);
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
      logActivity({
        timestamp: Date.now(),
        type: 'master_bag',
        action: 'created',
        moNumber: primaryMO,
        moStyleSku: bagMO.sku || '',
        packNumbers: null,
        bagNumbers: [bagSequence],
        pieceCount: totalQty,
        creator: bagWorker.trim(),
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
    if (items.length > 0) {
      logActivity({
        timestamp: Date.now(),
        type: 'inner_pack',
        action: 'batch_created',
        moNumber: packMO.mo_number,
        moStyleSku: packMO.sku || '',
        packNumbers: items.map(it => it.seq),
        bagNumbers: null,
        pieceCount: items.reduce((s, it) => s + (parseInt(it.totalQty) || 0), 0),
        creator: worker,
      });
    }
    setBatchResult({ items, errors, moNumber: packMO.mo_number, worker, lastSeq: endSeq, moData: buildMOData(packMO) });
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
    setBatchResult({ items: [...prevItems, ...newItems], errors: newErrors, moNumber: packMO.mo_number, worker, lastSeq: batchResult.lastSeq, moData: batchResult.moData || buildMOData(packMO) });
    setCurrentScreen('batch_pack_done');
  }, [packMO, batchResult]);

  const handlePreviewBatchBags = useCallback(async ({ startPackSeq, endPackSeq, worker }) => {
    if (!bagMO) return;
    try {
      setLoadingMsg('加载包装数据...');
      setCurrentScreen('loading');
      const bCriteria = `MO_Number == "${bagMO.mo_number}" && Pack_Sequence >= ${startPackSeq} && Pack_Sequence <= ${endPackSeq}`;
      const allPacks = [];
      let bCursor = null;
      let bSafety = 0;
      while (bSafety++ < 50) {
        const pr = await getRecords(REPORTS.INNER_PACK, bCriteria, bCursor ? { record_cursor: bCursor } : {});
        const data = (pr && pr.code === 3000 && Array.isArray(pr.data)) ? pr.data : [];
        console.log(`[Batch Bag Preview] Page ${bSafety}: got ${data.length} records, cursor=${pr?.record_cursor || 'none'}`);
        if (data.length === 0) break;
        allPacks.push(...data);
        bCursor = pr?.record_cursor || null;
        if (!bCursor) break;
      }
      const sorted = allPacks.sort((a, b) => parseInt(a['Pack_Sequence']) - parseInt(b['Pack_Sequence']));
      const unassigned = sorted.filter(p => !p['Assigned_To_Bag'] || p['Assigned_To_Bag'] === '');
      const skippedPacks = sorted.filter(p => p['Assigned_To_Bag'] && p['Assigned_To_Bag'] !== '');
      console.log(`[Batch Bag Preview] Total: ${sorted.length}, Unassigned: ${unassigned.length}, Skipped: ${skippedPacks.length}`);
      if (unassigned.length === 0) {
        setCurrentScreen('batch_bag_input');
        alert('范围内无未装袋包装 / 범위 내 미할당 포장 없음');
        return;
      }
      const expectedRange = endPackSeq - startPackSeq + 1;
      setBatchBagPreview({ packs: unassigned, skippedPacks, expectedRange, startPackSeq, endPackSeq, worker });
      setCurrentScreen('batch_bag_preview');
    } catch (err) {
      setCurrentScreen('batch_bag_input');
      alert('加载失败: ' + (err?.message || String(err)));
    }
  }, [bagMO]);

  const handleConfirmBatchBags = useCallback(async () => {
    if (!bagMO || !batchBagPreview) return;
    const { packs, worker, startPackSeq, endPackSeq } = batchBagPreview;
    try {
      const bagListRes = await getRecords(REPORTS.MASTER_BAG, `MO_Number == "${bagMO.mo_number}"`);
      const existingBags = (bagListRes && bagListRes.code === 3000 && Array.isArray(bagListRes.data))
        ? bagListRes.data : [];
      let nextBagSeq = existingBags.length + 1;
      const bagGroups = [];
      for (let i = 0; i < packs.length; i += MASTER_BAG_SIZE) {
        const group = packs.slice(i, i + MASTER_BAG_SIZE);
        bagGroups.push({ packs: group, bagSeq: nextBagSeq++, isRemainder: group.length < MASTER_BAG_SIZE });
      }
      const items = [], errors = [];
      setBatchBagProgress({ current: 0, total: bagGroups.length, items: [], errors: [] });
      setCurrentScreen('batch_bag_progress');
      for (let i = 0; i < bagGroups.length; i++) {
        const { packs: bPacks, bagSeq, isRemainder } = bagGroups[i];
        try {
          const qrText = buildMasterBagQR();
          const uuid = qrText.split('/view/bag/')[1];
          const totalQty = bPacks.reduce((s, p) => s + (parseInt(p['Total_Qty']) || 12), 0);
          let saved = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              console.log(`[Batch Bag] Bag #${bagSeq} attempt ${attempt}: submitting ${bPacks.length} packs`);
              const res = await submitRecord(FORMS.MASTER_BAG, {
                'Bag_UUID': uuid, 'Brand': BRAND, 'Bag_Sequence': bagSeq, 'MO_Number': bagMO.mo_number,
                'SKU': bagMO.sku, 'Factory': bagMO.factory,
                'Inner_Pack_Count': bPacks.length, 'Inner_Pack_UUIDs': JSON.stringify(bPacks.map(p => p['Pack_UUID'])),
                'Total_Qty': totalQty, 'Is_Remainder': isRemainder, 'Worker': worker,
                'Destination': 'MEX-Guadalajara', 'Bag_Status': 'Created'
              });
              if (!res || res.code !== 3000) throw new Error('code=' + (res && res.code) + ' ' + JSON.stringify(res));
              saved = true;
              console.log(`[Batch Bag] Bag #${bagSeq} saved OK, updating ${bPacks.length} packs...`);
              break;
            } catch (e) {
              console.error(`[Batch Bag] Bag #${bagSeq} attempt ${attempt} failed:`, e.message);
              if (attempt === 3) throw e;
              await new Promise(r => setTimeout(r, 500 * attempt));
            }
          }
          if (saved) {
            const packUpdateResults = [];
            for (const p of bPacks) {
              packUpdateResults.push(await updatePackToBagged(p['ID'], uuid, p['Pack_UUID']));
            }
            const packFailures = packUpdateResults.filter(r => !r.success);
            if (packFailures.length > 0) {
              console.error(`[Batch Bag] Bag #${bagSeq}: ${packFailures.length} pack updates failed:`, packFailures.map(f => f.packUUID));
              errors.push({ bagSeq, error: `Bag created but ${packFailures.length} pack status updates failed` });
            }
            items.push({ bagSeq, uuid, qrText, totalQty, packCount: bPacks.length, isRemainder, savedToZoho: true, packUpdateFailures: packFailures.length });
          }
        } catch (e) {
          console.error(`[Batch Bag] Bag #${bagGroups[i].bagSeq} failed:`, e);
          errors.push({ bagSeq: bagGroups[i].bagSeq, error: e.message || String(e) });
        }
        setBatchBagProgress(p => ({ ...p, current: p.current + 1, items: [...items], errors: [...errors] }));
      }
      if (items.length > 0) {
        logActivity({
          timestamp: Date.now(),
          type: 'master_bag',
          action: 'batch_created',
          moNumber: bagMO.mo_number,
          moStyleSku: bagMO.sku || '',
          packNumbers: null,
          bagNumbers: items.map(it => it.bagSeq),
          pieceCount: items.reduce((s, it) => s + (parseInt(it.totalQty) || 0), 0),
          creator: worker,
        });
      }
      setBatchBagResult({ items, errors, moNumber: bagMO.mo_number, worker, startPackSeq, endPackSeq, moData: buildMOData(bagMO) });
      setCurrentScreen('batch_bag_done');
    } catch (err) {
      setCurrentScreen('batch_bag_preview');
      alert('批量装袋失败: ' + (err?.message || String(err)));
    }
  }, [bagMO, batchBagPreview]);

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

    if (scanMode === 'standard_pack_mo') {
      if (qrType !== 'production_log') { setCameraOpen(false); alert('请扫描生产进度QR (MO QR)'); return; }
      let moNumber = '';
      text.split(/[|\n\r]+/).forEach((part) => { const idx = part.indexOf(':'); if (idx < 0) return; const key = part.substring(0, idx).trim().toUpperCase(); if (key === 'MO') moNumber = part.substring(idx + 1).trim(); });
      if (!moNumber && /^[A-Z]{2}\d{2}-\d+/i.test(text)) moNumber = text;
      if (!moNumber) { setCameraOpen(false); alert('未能识别订单号'); return; }
      flushSync(() => { setCameraOpen(false); });
      enterStandardPackWorker(moNumber);
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

    if (scanMode === 'bulk_ship_mo') {
      if (qrType !== 'production_log') { setCameraOpen(false); alert('请扫描生产进度QR (MO QR)'); return; }
      let moNumber = '';
      text.split(/[|\n\r]+/).forEach((part) => { const idx = part.indexOf(':'); if (idx < 0) return; const key = part.substring(0, idx).trim().toUpperCase(); if (key === 'MO') moNumber = part.substring(idx + 1).trim(); });
      if (!moNumber && /^[A-Z]{2}\d{2}-\d+/i.test(text)) moNumber = text;
      if (!moNumber) { setCameraOpen(false); alert('未能识别订单号'); return; }
      flushSync(() => { setCameraOpen(false); setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); });
      fetchMODataForBulkShip(moNumber);
      return;
    }

    if (scanMode === 'reserved_mo') {
      if (qrType !== 'production_log') { setCameraOpen(false); alert('请扫描生产进度QR (MO QR)'); return; }
      let moNumber = '';
      text.split(/[|\n\r]+/).forEach((part) => { const idx = part.indexOf(':'); if (idx < 0) return; const key = part.substring(0, idx).trim().toUpperCase(); if (key === 'MO') moNumber = part.substring(idx + 1).trim(); });
      if (!moNumber && /^[A-Z]{2}\d{2}-\d+/i.test(text)) moNumber = text;
      if (!moNumber) { setCameraOpen(false); alert('未能识别订单号'); return; }
      flushSync(() => { setCameraOpen(false); setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); });
      fetchMODataForReserved(moNumber);
      return;
    }
  }, [scanMode, bagScannedPacks, fetchMOData, fetchMODataForPack, enterStandardPackWorker, fetchMODataForBag, fetchMODataForBatchPack, fetchMODataForBatchBag, fetchInnerPackDetail, addPackToBag, fetchMasterBagDetail, handleStatusScanUpdate, fetchMODataForBulkShip, fetchMODataForReserved]);

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
    setLogs([]);
    setSubmitResult(null);
    setCurrentScreen('home');
  }, []);

  const handleNextProcess = useCallback(() => {
    setSelectedProcess({ key: '', cn: '' });
    setSubmitResult(null);
    setCurrentScreen('info');
    if (moData && moData.mo_number) setTimeout(() => fetchLogs(moData.mo_number), 200);
  }, [moData, fetchLogs]);


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
            onSelectReserved={() => requirePin(() => { setReservedMO(null); setReservedResult(null); setCurrentScreen('reserved_mo_select'); })}
            onSelectRecentActivity={() => setCurrentScreen('recent_activity')}
          />
        )}

        {/* Production Log screens */}
        {currentScreen === 'scan' && <ScanScreen onScan={() => setCurrentScreen('log_scan_choice')} onUpload={openUpload} onQrQuery={() => setCurrentScreen('log_query_sub_menu')} onBack={() => { setScanMode('production_log'); setCurrentScreen('home'); }} />}
        {currentScreen === 'log_query_sub_menu' && (
          <ProductionLogQuerySubMenu
            onTextQuery={() => setCurrentScreen('log_manual_mo')}
            onScanQuery={() => { setScanMode('production_log'); setCameraOpen(true); }}
            onBack={() => setCurrentScreen('scan')}
          />
        )}
        {currentScreen === 'log_scan_choice' && (
          <LogScanChoiceScreen
            onScan={() => { setScanMode('production_log'); setCameraOpen(true); }}
            onManual={(mo) => { setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); fetchMOData(mo); }}
            onBack={() => setCurrentScreen('scan')}
          />
        )}
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
            selectedKey={selectedProcess.key}
            onSelectProcess={handleSelectProcess}
            onBack={handleBackToScan}
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
            onStandard={() => requirePin(() => setCurrentScreen('standard_pack_mo_select'))}
            onLeftover={() => requirePin(() => setCurrentScreen('pack_mo_select'))}
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
        {currentScreen === 'standard_pack_mo_select' && (
          <PackMOSelectScreen
            onScan={() => { setScanMode('standard_pack_mo'); setCameraOpen(true); }}
            onManual={(mo) => enterStandardPackWorker(mo)}
            onBack={() => setCurrentScreen('pack_menu')}
          />
        )}
        {currentScreen === 'standard_pack_worker_input' && packMO && (
          <StandardPackWorkerInputScreen
            moNumber={packMO.mo_number}
            worker={standardWorker}
            setWorker={setStandardWorker}
            submitting={standardWorkerSubmitting}
            onConfirm={(name) => confirmStandardPackWorker(name)}
            onBack={() => { setPackMO(null); setStandardWorker(''); setCurrentScreen('standard_pack_mo_select'); }}
          />
        )}
        {currentScreen === 'standard_pack_qr' && standardPack && packMO && (
          <StandardPackQRScreen
            standardPack={standardPack}
            packMO={packMO}
            copies={standardCopies}
            setCopies={setStandardCopies}
            worker={standardWorker}
            onLogActivity={logActivity}
            onBumpTotalExpected={bumpStandardTotalExpected}
            onBack={() => { setStandardPack(null); setCurrentScreen('standard_pack_worker_input'); }}
            onHome={() => {
              setPackMO(null); setStandardPack(null); setStandardWorker('');
              window.history.pushState({}, '', '/');
              setCurrentScreen('home');
            }}
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
            moData={packMO ? buildMOData(packMO) : null}
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
              setBagStandardCount(''); setBagSelectedLeftoverUuids(new Set());
              setBagLeftoverPacks([]);
              setCurrentScreen('bag_mo_select');
            })}
            onQueryMenu={() => setCurrentScreen('bag_query_sub_menu')}
            onBulkShip={() => requirePin(() => { setBulkShipMO(null); setBulkShipBags([]); setBulkShipSelected(new Set()); setBulkShipWorker(''); setBulkShipResult(null); setCurrentScreen('bulk_ship_mo_select'); })}
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
          <BagCreateQtyScreen
            bagMO={bagMO}
            info={bagStandardInfo}
            leftoverPacks={bagLeftoverPacks}
            standardCount={bagStandardCount}
            setStandardCount={setBagStandardCount}
            selectedLeftovers={bagSelectedLeftoverUuids}
            toggleLeftover={toggleBagLeftover}
            worker={bagWorker}
            setWorker={setBagWorker}
            containerNo={bagContainerNo}
            setContainerNo={setBagContainerNo}
            onSubmit={handleCreateBagQty}
            onBack={() => {
              setAvailablePacks([]);
              setBagLeftoverPacks([]);
              setBagSelectedLeftoverUuids(new Set());
              setBagStandardCount('');
              setCurrentScreen('bag_mo_select');
            }}
            submitting={bagSubmitting}
            loading={availablePacksLoading}
          />
        )}
        {currentScreen === 'bag_success' && (
          <BagSuccessScreen
            bag={createdBag}
            moData={bagMO ? buildMOData(bagMO) : null}
            containerNo={bagContainerNo}
            onNewBag={() => {
              setBagScannedPacks([]); setCreatedBag(null); setBagIsRemainder(false);
              setBagWorker(''); setBagContainerNo(''); setBagMO(null);
              setBagStandardCount(''); setBagSelectedLeftoverUuids(new Set());
              setBagLeftoverPacks([]);
              setCurrentScreen('bag_mo_select');
            }}
            onHome={() => {
              setBagScannedPacks([]); setCreatedBag(null); setBagIsRemainder(false);
              setBagWorker(''); setBagContainerNo(''); setBagMO(null);
              setBagStandardCount(''); setBagSelectedLeftoverUuids(new Set());
              setBagLeftoverPacks([]);
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
            onViewPack={handleViewPackFromBag}
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

        {currentScreen === 'recent_activity' && (
          <RecentActivityScreen onBack={() => setCurrentScreen('home')} />
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
            onSubmit={handlePreviewBatchBags}
            onBack={() => setCurrentScreen('batch_bag_mo_select')}
          />
        )}
        {currentScreen === 'batch_bag_preview' && batchBagPreview && (
          <BatchBagPreviewScreen
            preview={batchBagPreview}
            bagMO={bagMO}
            onConfirm={handleConfirmBatchBags}
            onBack={() => setCurrentScreen('batch_bag_input')}
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

        {/* Bulk Ship screens */}
        {currentScreen === 'bulk_ship_mo_select' && (
          <BagMOSelectScreen
            onScan={() => { setScanMode('bulk_ship_mo'); setCameraOpen(true); }}
            onManual={(mo) => { setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); fetchMODataForBulkShip(mo); }}
            onBack={() => setCurrentScreen('bag_menu')}
          />
        )}
        {currentScreen === 'bulk_ship_bag_select' && bulkShipMO && (
          <BulkShipBagSelectScreen
            bagMO={bulkShipMO}
            bags={bulkShipBags}
            selected={bulkShipSelected}
            onToggle={(id) => setBulkShipSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; })}
            onSelectAll={() => setBulkShipSelected(new Set(bulkShipBags.map(b => b.record_id)))}
            onClearAll={() => setBulkShipSelected(new Set())}
            worker={bulkShipWorker}
            onWorkerChange={setBulkShipWorker}
            onSubmit={handleBulkShip}
            onBack={() => setCurrentScreen('bulk_ship_mo_select')}
          />
        )}
        {currentScreen === 'bulk_ship_progress' && (
          <BulkShipProgressScreen progress={bulkShipProgress} />
        )}
        {currentScreen === 'bulk_ship_done' && bulkShipResult && (
          <BulkShipDoneScreen
            result={bulkShipResult}
            onHome={() => { setBulkShipMO(null); setBulkShipBags([]); setBulkShipSelected(new Set()); setBulkShipResult(null); setCurrentScreen('home'); }}
            onRetriggerActure={handleRetriggerActure}
          />
        )}

        {/* Reserved (中国仓库保留) screens */}
        {currentScreen === 'reserved_mo_select' && (
          <BagMOSelectScreen
            onScan={() => { setScanMode('reserved_mo'); setCameraOpen(true); }}
            onManual={(mo) => { setLoadingMsg('加载订单数据...'); setCurrentScreen('loading'); fetchMODataForReserved(mo); }}
            onBack={() => setCurrentScreen('home')}
          />
        )}
        {currentScreen === 'reserved_input' && reservedMO && (
          <ReservedInputScreen
            reservedMO={reservedMO}
            onSubmit={handleRegisterReserved}
            onBack={() => setCurrentScreen('reserved_mo_select')}
          />
        )}
        {currentScreen === 'reserved_done' && reservedResult && (
          <ReservedDoneScreen
            result={reservedResult}
            onContinue={() => { setReservedResult(null); setCurrentScreen('reserved_input'); }}
            onHome={() => { setReservedMO(null); setReservedResult(null); setCurrentScreen('home'); }}
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
            onViewPack={(packUUID) => { window.history.pushState({}, '', '/view/inner/' + packUUID); setViewUuid(packUUID); setCurrentScreen('view-inner'); }}
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
