// Display-only helpers for the scan-result pages.
// Pure functions (no JSX) so this stays a plain .js module.

// ── Factory name formatting ─────────────────────────────────────────────────
// Reuses the IKU-dashboard pattern: strip a leading "_NN_" index prefix.
//   "_01_宁军" → "宁军"   "_12_某工厂" → "某工厂"   "宁军" → "宁军"
export function formatFactory(raw) {
  if (!raw) return '';
  return String(raw).replace(/^_\d+_/, '').trim();
}

// ── Zoho field reader (self-contained mirror of App.jsx getField) ────────────
function readField(rec, key) {
  const v = rec ? rec[key] : undefined;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.display_value !== undefined) return String(v.display_value);
    if (v.zc_display_value !== undefined) return String(v.zc_display_value);
    if (v[key] !== undefined) return String(v[key]);
    return '';
  }
  return String(v);
}

// Probe a record for the first non-empty value among candidate field names.
// Returns { key, value } so callers can console-report which field hit.
export function findFieldValue(rec, candidates) {
  for (const key of candidates) {
    const val = readField(rec, key);
    if (val && val !== '-') return { key, value: val };
  }
  return { key: null, value: '' };
}

// Read a subfield from a Zoho lookup/connection field on a record.
// Zoho returns lookup columns either flattened ("Lookup.subKey") or as a
// nested object ({ subKey, display_value, ID }). Tries both shapes across the
// candidate lookup field names and returns the first non-empty string value.
// Used for the Style fallback (MO record's linked Style → Fabric_Name).
export function readLookupSubfield(rec, lookupKeys, subKey) {
  if (!rec) return '';
  for (const lk of lookupKeys) {
    const flat = rec[lk + '.' + subKey];
    if (flat != null && flat !== '') {
      return typeof flat === 'object' ? String(flat.display_value || '') : String(flat);
    }
    const obj = rec[lk];
    if (obj && typeof obj === 'object' && obj[subKey] != null && obj[subKey] !== '') {
      const v = obj[subKey];
      return typeof v === 'object' ? String(v.display_value || '') : String(v);
    }
  }
  return '';
}

// Candidate field names (most-specific first) for probing.
export const CHINESE_STYLE_NAME_FIELDS = [
  'Chi_Style_Name', 'Chinese_Style_Name', 'Style_Name_CN', 'CN_Name',
  'Chinese_Name', 'Style_CN', 'Style_Name_Chinese',
];
export const FABRIC_FIELDS = [
  'Fabric', 'Fabric_Name', 'Fabric_Info', 'Fabric_Type', 'Fabric_Detail',
  'Material', 'Material_Name', 'Composition',
];

// ── Color dot keyword mapping ───────────────────────────────────────────────
// NOT AI — a keyword dictionary. Text is lowercased, then matched by substring
// (partial match), so "D/MOCHA" → mocha, "花灰" → gray, etc.
// Order matters: more-specific compound keywords come BEFORE single-char ones
// (e.g. ivory "米白" before white "白"; indigo "牛仔蓝" before blue "蓝";
// pink "粉" before red "红" so "粉红" resolves to pink).
const COLOR_MAP = [
  { keys: ['black', '黑', '블랙'],                       color: '#1a1a1a' },
  { keys: ['ivory', 'cream', '米白', '아이보리'],         color: '#f5f0e1', outline: true },
  { keys: ['white', '白', '화이트'],                     color: '#ffffff', outline: true },
  { keys: ['beige', '米色', '베이지'],                   color: '#d6c4a8' },
  { keys: ['gray', 'grey', '灰', '花灰', '그레이'],       color: '#9ca3af' },
  { keys: ['mocha', '摩卡', '모카'],                     color: '#8b6f5c' },
  { keys: ['indigo', '牛仔蓝', '인디고'],                 color: '#4f6d8f' },
  { keys: ['navy', '藏青', '네이비'],                    color: '#1e3a5f' },
  { keys: ['blue', '蓝', '블루'],                        color: '#3b6ea5' },
  { keys: ['brown', '棕', '브라운'],                     color: '#7b5b3a' },
  { keys: ['pink', '粉', '핑크'],                        color: '#e8a0b4' },
  { keys: ['red', '红', '레드'],                         color: '#c0392b' },
  { keys: ['green', '绿', '그린'],                       color: '#4a7c59' },
  { keys: ['yellow', '黄', '옐로우'],                    color: '#e3c14f' },
  { keys: ['orange', '橙', '오렌지'],                    color: '#e08a3c' },
  { keys: ['purple', '紫', '퍼플'],                      color: '#7d5ba6' },
  { keys: ['charcoal', '炭', '차콜'],                    color: '#3d3d3d' },
  { keys: ['khaki', '卡其', '카키'],                     color: '#8a8265' },
];

const NEUTRAL_DOT = { color: '#d1d5db', outline: false, neutral: true };

// Resolve a color text → dot descriptor { color, outline, neutral }.
//   outline: needs a visible ring (light colors: white/ivory)
//   neutral: no keyword matched → neutral gray with a dashed ring
export function resolveColorDot(text) {
  if (!text) return NEUTRAL_DOT;
  const t = String(text).toLowerCase();
  for (const entry of COLOR_MAP) {
    if (entry.keys.some((k) => t.includes(k.toLowerCase()))) {
      return { color: entry.color, outline: !!entry.outline, neutral: false };
    }
  }
  return NEUTRAL_DOT;
}
