import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import QRCode from 'qrcode';

async function qrToBase64(text) {
  const dataURL = await QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 300,
  });
  return dataURL.split(',')[1];
}

function stripChinese(text) {
  if (!text) return '';
  // Remove parenthetical groups containing Chinese characters (half-width and full-width parens)
  let result = text.replace(
    /\s*[（(][^()（）]*[一-鿿][^()（）]*[)）]/g,
    ''
  );
  // Remove standalone CJK characters and CJK punctuation
  result = result.replace(/[一-鿿　-〿]+/g, '');
  // Collapse whitespace
  result = result.replace(/\s+/g, ' ').trim();
  // Clean up dangling commas from removed segments
  result = result.replace(/,\s*,/g, ',').replace(/^,|,$/g, '').trim();
  return result;
}

const THIN = { style: 'thin', color: { argb: 'FF000000' } };

function applyLabelBorders(ws, topRow, bottomRow, textCol, qrCol) {
  for (let r = topRow; r <= bottomRow; r++) {
    const tc = ws.getRow(r).getCell(textCol);
    const qc = ws.getRow(r).getCell(qrCol);
    tc.border = {
      left:   THIN,
      top:    r === topRow    ? THIN : undefined,
      bottom: r === bottomRow ? THIN : undefined,
      right:  THIN,
    };
    qc.border = {
      left:   undefined,
      top:    r === topRow    ? THIN : undefined,
      bottom: r === bottomRow ? THIN : undefined,
      right:  THIN,
    };
  }
}

// ── Inner Pack ────────────────────────────────────────────────────────────────
// 3 labels per row × 5 label rows = 15 per A4 sheet
// Column layout: text(22) | qr(14) | spacer(2) | text(22) | qr(14) | spacer(2) | text(22) | qr(14)
// Label group: IP_LABEL_ROWS rows per label + 1 vertical spacer row between groups

const IP_COLS       = 3;
const IP_PAGE       = 15;
const IP_DATA_ROWS  = 6;
const IP_LABEL_ROWS = 7;   // 6 data + 1 caption
const IP_VSTRIDE    = IP_LABEL_ROWS + 1; // 8 — rows between group starts (includes spacer)
const IP_TEXT_W     = 22;
const IP_QR_W       = 14;  // widened from 11 to fit 90px QR with margin
const IP_SPACER_W   = 2;
const IP_QR_SIZE    = 90;  // px square — enlarged from 68
const IP_VSPACER_H  = 10;  // pt — vertical spacer row between label groups

// Per-row heights within each label group (7 rows)
const IP_ROW_HEIGHTS = [
  32, // R+0  ITEM NO  — tall for wrap
  16, // R+1  Q'TY
  16, // R+2  SURTIDO
  16, // R+3  SIZE
  32, // R+4  COLOR    — tall for wrap
  16, // R+5  Pack #
  18, // R+6  caption
];

async function addInnerPackSheet(workbook, pageItems, pageIdx, moData) {
  const ws = workbook.addWorksheet(`Page ${pageIdx + 1}`, {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      margins: { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1, header: 0, footer: 0 },
    },
  });

  for (let c = 0; c < IP_COLS; c++) {
    ws.getColumn(c * 3 + 1).width = IP_TEXT_W;
    ws.getColumn(c * 3 + 2).width = IP_QR_W;
    if (c < IP_COLS - 1) ws.getColumn(c * 3 + 3).width = IP_SPACER_W;
  }

  // Set row heights for each label group, with vertical spacer rows between groups
  for (let r = 0; r < 5; r++) {
    const groupStart = r * IP_VSTRIDE + 1;
    for (let s = 0; s < IP_LABEL_ROWS; s++) {
      ws.getRow(groupStart + s).height = IP_ROW_HEIGHTS[s];
    }
    if (r < 4) ws.getRow(groupStart + IP_LABEL_ROWS).height = IP_VSPACER_H;
  }

  const cleanItemNo = stripChinese(moData.ITEM_NO);
  const cleanColors = stripChinese(moData.COLOR_LIST);

  for (let i = 0; i < pageItems.length; i++) {
    const { packNumber, qrText, totalQty, isRemainder, items } = pageItems[i];

    const labelCol     = i % IP_COLS;
    const labelRow     = Math.floor(i / IP_COLS);
    const textColNo    = labelCol * 3 + 1;
    const qrColNo      = textColNo + 1;
    const firstRow     = labelRow * IP_VSTRIDE + 1;  // accounts for vertical spacers
    const captionRowNo = firstRow + IP_DATA_ROWS;

    // Per-pack data: leftover packs use Items_JSON, normal packs use MO-level data
    let lineQty, lineSurtido, lineSize, lineColor, captionQty;
    if (isRemainder && Array.isArray(items) && items.length > 0) {
      captionQty  = parseInt(totalQty) || items.reduce((s, it) => s + (parseInt(it.qty) || 1), 0);
      lineQty     = captionQty + 'PCS';
      const colors = [...new Set(items.map(it => stripChinese(it.color || '')).filter(Boolean))];
      const sizes  = [...new Set(items.map(it => (it.size || '').trim()).filter(Boolean))];
      lineSurtido = colors.length + 'COLOR';
      lineSize    = sizes.join(' ');
      lineColor   = colors.join(', ');
    } else {
      captionQty  = parseInt(totalQty) || 12;
      lineQty     = captionQty + 'PCS';
      lineSurtido = moData.SURTIDO || '';
      lineSize    = moData.SIZE_LIST || '';
      lineColor   = cleanColors;
    }

    const lines = [
      `ITEM NO: ${cleanItemNo}`,
      `Q'TY:    ${lineQty}`,
      `SURTIDO: ${lineSurtido}`,
      `SIZE:    ${lineSize}`,
      `COLOR:   ${lineColor}`,
      `Pack:    #${packNumber}`,
    ];

    for (let li = 0; li < IP_DATA_ROWS; li++) {
      const cell = ws.getRow(firstRow + li).getCell(textColNo);
      cell.value = lines[li];
      cell.font  = {
        size: li === 4 ? 8 : 9,
        name: 'Arial',
        bold: li === 0 || li === 5,
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'left',
        wrapText: true,
        indent: 1,
      };
    }

    // Outer border spans data rows + caption row
    applyLabelBorders(ws, firstRow, captionRowNo, textColNo, qrColNo);

    // Caption: merged cell, uses actual qty + leftover marker if applicable
    ws.mergeCells(captionRowNo, textColNo, captionRowNo, qrColNo);
    const captionCell = ws.getRow(captionRowNo).getCell(textColNo);
    captionCell.value = isRemainder
      ? `${moData.MO_Number} / Inner Pack #${packNumber} / ${captionQty} pcs (자투리)`
      : `${moData.MO_Number} / Inner Pack #${packNumber} / ${captionQty} pcs`;
    captionCell.font  = { name: 'Arial', size: 8, bold: true };
    captionCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    captionCell.border = { left: THIN, bottom: THIN, right: THIN };

    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: qrColNo - 1 + 0.05, row: firstRow - 1 + 0.5 },
      ext: { width: IP_QR_SIZE, height: IP_QR_SIZE },
      editAs: 'absolute',
    });
  }
}

export async function generateInnerPackExcel(moData, packList, filename) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FactoryScanApp';

  for (let p = 0; p < Math.ceil(packList.length / IP_PAGE); p++) {
    await addInnerPackSheet(wb, packList.slice(p * IP_PAGE, (p + 1) * IP_PAGE), p, moData);
  }

  const buf  = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, filename || `${moData.MO_Number}_InnerPack_Labels.xlsx`);
}

export async function generateSingleInnerPackExcel(moData, pack) {
  await generateInnerPackExcel(
    moData,
    [{
      packNumber:  pack.number,
      qrText:      pack.qrString,
      totalQty:    pack.totalQty,
      isRemainder: pack.isRemainder || false,
      items:       pack.items || null,
    }],
    `${moData.MO_Number}_InnerPack_#${pack.number}.xlsx`,
  );
}

// ── Master Bag ────────────────────────────────────────────────────────────────
// 2 labels per row × 2 label rows = 4 per A4 sheet
// Column layout: text(35) | qr(28) | spacer(3) | text(35) | qr(28)
// Label row structure: 7 data rows + 1 caption row + 2 spacer rows = 10 rows

const MB_COLS       = 2;
const MB_PAGE       = 4;
const MB_DATA_ROWS  = 7;
const MB_SPACER     = 2;
const MB_LABEL_ROWS = MB_DATA_ROWS + 1 + MB_SPACER; // 10
const MB_TEXT_W     = 35;
const MB_QR_W       = 28;  // widened from 22 to fit 180px QR with margin
const MB_SPACER_W   = 3;
const MB_QR_SIZE    = 180; // px square — enlarged from 151

// Per-row heights within each label group (10 rows)
const MB_ROW_HEIGHTS = [
  20, // R+0  PI NO
  20, // R+1  C/T NO
  44, // R+2  ITEM NO  — tall for wrap
  22, // R+3  Q'TY
  22, // R+4  SIZE
  44, // R+5  COLOR    — tall for wrap
  22, // R+6  Bag No
  22, // R+7  caption
  12, // R+8  spacer   — increased from 4 to 12
  12, // R+9  spacer   — increased from 4 to 12
];

async function addMasterBagSheet(workbook, pageItems, pageIdx, moData) {
  const ws = workbook.addWorksheet(`Page ${pageIdx + 1}`, {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      margins: { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1, header: 0, footer: 0 },
    },
  });

  for (let c = 0; c < MB_COLS; c++) {
    ws.getColumn(c * 3 + 1).width = MB_TEXT_W;
    ws.getColumn(c * 3 + 2).width = MB_QR_W;
    if (c < MB_COLS - 1) ws.getColumn(c * 3 + 3).width = MB_SPACER_W;
  }

  for (let r = 0; r < 2; r++) {
    for (let s = 0; s < MB_LABEL_ROWS; s++) {
      ws.getRow(r * MB_LABEL_ROWS + s + 1).height = MB_ROW_HEIGHTS[s];
    }
  }

  const cleanItemNo = stripChinese(moData.ITEM_NO);
  const cleanColors = stripChinese(moData.COLOR_LIST);

  const baseLines = [
    [`PI NO:   `, '_______________'],
    [`C/T NO:  `, '_______________'],
    [`ITEM NO: `, cleanItemNo],
    [`Q'TY:    `, '120PCS'],
    [`SIZE:    `, moData.SIZE_LIST || ''],
    [`COLOR:   `, cleanColors],
    [`Bag No:  `, ''],
  ];

  for (let i = 0; i < pageItems.length; i++) {
    const { bagNumber, qrText } = pageItems[i];
    const labelCol     = i % MB_COLS;
    const labelRow     = Math.floor(i / MB_COLS);
    const textColNo    = labelCol * 3 + 1;
    const qrColNo      = textColNo + 1;
    const firstRow     = labelRow * MB_LABEL_ROWS + 1;
    const captionRowNo = firstRow + MB_DATA_ROWS; // R+7

    baseLines[6][1] = `#${bagNumber}`;

    for (let li = 0; li < MB_DATA_ROWS; li++) {
      const cell = ws.getRow(firstRow + li).getCell(textColNo);
      const [lbl, val] = baseLines[li];
      cell.value = lbl + val;
      cell.font  = {
        size: li === 5 ? 8 : 10,
        name: 'Arial',
        bold: li === 0 || li === 1,
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'left',
        wrapText: true,
        indent: 1,
      };
    }

    // Outer border spans data rows + caption row
    applyLabelBorders(ws, firstRow, captionRowNo, textColNo, qrColNo);

    // Caption: merged cell
    ws.mergeCells(captionRowNo, textColNo, captionRowNo, qrColNo);
    const captionCell = ws.getRow(captionRowNo).getCell(textColNo);
    captionCell.value = `${moData.MO_Number} / Master Bag #${bagNumber} / 120 pcs`;
    captionCell.font  = { name: 'Arial', size: 10, bold: true };
    captionCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    captionCell.border = { left: THIN, bottom: THIN, right: THIN };

    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: qrColNo - 1 + 0.05, row: firstRow - 1 + 0.5 },
      ext: { width: MB_QR_SIZE, height: MB_QR_SIZE },
      editAs: 'absolute',
    });
  }
}

export async function generateMasterBagExcel(moData, bagList, filename) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FactoryScanApp';

  for (let p = 0; p < Math.ceil(bagList.length / MB_PAGE); p++) {
    await addMasterBagSheet(wb, bagList.slice(p * MB_PAGE, (p + 1) * MB_PAGE), p, moData);
  }

  const buf  = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, filename || `${moData.MO_Number}_MasterBag_Labels.xlsx`);
}

export async function generateSingleMasterBagExcel(moData, bag) {
  await generateMasterBagExcel(
    moData,
    [{ bagNumber: bag.number, qrText: bag.qrString }],
    `${moData.MO_Number}_MasterBag_#${bag.number}.xlsx`,
  );
}
