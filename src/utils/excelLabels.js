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
  let result = text.replace(/\s*[（(][^()（）]*[一-鿿][^()（）]*[)）]/g, '');
  result = result.replace(/[一-鿿　-〿]+/g, '');
  result = result.replace(/\s+/g, ' ').trim();
  result = result.replace(/,\s*,/g, ',').replace(/^,|,$/g, '').trim();
  return result;
}

const THIN      = { style: 'thin',   color: { argb: 'FF000000' } };
const MEDIUM    = { style: 'medium', color: { argb: 'FF000000' } };
const GRAY      = { style: 'thin',   color: { argb: 'FFCCCCCC' } };
const NO_BORDER = { style: 'none' };

function formatSizes(input) {
  if (!input) return '';
  if (Array.isArray(input)) return input.filter(Boolean).join(' / ');
  return String(input).split(/\s+/).filter(Boolean).join(' / ');
}

// EMU constants (OOXML: 1px at 96dpi = 9525 EMU, 1pt = 12700 EMU)
const PX_TO_EMU = 9525;

// ── Inner Pack ────────────────────────────────────────────────────────────────
// 4 labels per row, all items on a single sheet (vertical scroll).
// Vertical layout: 5 text rows on top → 4 rows of QR area → caption at bottom.
// Column layout: text(22) | spacer(2) repeated × 4

const IP_COLS        = 4;
const IP_TEXT_ROWS   = 5;   // ITEM NO / Q'TY / SURTIDO / SIZE / COLOR
const IP_QR_ROWS     = 4;   // rows reserved for QR image
const IP_LABEL_ROWS  = IP_TEXT_ROWS + IP_QR_ROWS + 1; // 10 (text + qr + caption)
const IP_CAPTION_IDX = IP_LABEL_ROWS - 1;              // 9
const IP_VSTRIDE     = IP_LABEL_ROWS + 1; // 11 rows between label-group starts
const IP_TEXT_W      = 22;
const IP_SPACER_W    = 2;
const IP_VSPACER_H   = 6;   // pt — spacer row between label rows
const IP_QR_PX       = 114; // px square

// Row heights per label (pt).
const IP_ROW_HEIGHTS = [
  14, // R+0  ITEM NO
  11, // R+1  Q'TY
  11, // R+2  SURTIDO
  11, // R+3  SIZE
  33, // R+4  COLOR
  22, // R+5  QR row 1
  22, // R+6  QR row 2
  22, // R+7  QR row 3
  22, // R+8  QR row 4
  13, // R+9  Caption
];

async function addInnerPackSheet(workbook, allItems, moData) {
  const ws = workbook.addWorksheet('Labels', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1, header: 0, footer: 0 },
    },
  });

  // Column widths: text + spacer per label column
  for (let c = 0; c < IP_COLS; c++) {
    ws.getColumn(c * 2 + 1).width = IP_TEXT_W;
    if (c < IP_COLS - 1) ws.getColumn(c * 2 + 2).width = IP_SPACER_W;
  }

  // Row heights for all label-row groups on one sheet
  const numGroups = Math.ceil(allItems.length / IP_COLS);
  for (let r = 0; r < numGroups; r++) {
    const groupStart = r * IP_VSTRIDE + 1;
    for (let s = 0; s < IP_LABEL_ROWS; s++) {
      ws.getRow(groupStart + s).height = IP_ROW_HEIGHTS[s];
    }
    if (r < numGroups - 1) ws.getRow(groupStart + IP_LABEL_ROWS).height = IP_VSPACER_H;
  }

  const cleanItemNo = stripChinese(moData.ITEM_NO);
  const cleanColors = stripChinese(moData.COLOR_LIST);

  for (let i = 0; i < allItems.length; i++) {
    const { packNumber, qrText, totalQty, isRemainder, isStandard, items } = allItems[i];

    const labelCol     = i % IP_COLS;
    const labelRow     = Math.floor(i / IP_COLS);
    const textColNo    = labelCol * 2 + 1;
    const firstRow     = labelRow * IP_VSTRIDE + 1;
    const captionRowNo = firstRow + IP_CAPTION_IDX;

    // Per-pack data: use Items_JSON for leftover, MO-level for normal/standard
    let lineQty, lineSurtido, lineSize, lineColor, captionQty;
    if (isRemainder && Array.isArray(items) && items.length > 0) {
      captionQty  = parseInt(totalQty) || items.reduce((s, it) => s + (parseInt(it.qty) || 1), 0);
      lineQty     = captionQty + 'PCS';
      const colors = [...new Set(items.map(it => stripChinese(it.color || '')).filter(Boolean))];
      const sizes  = [...new Set(items.map(it => (it.size || '').trim()).filter(Boolean))];
      lineSurtido = colors.length + 'COLOR';
      lineSize    = formatSizes(sizes);
      lineColor   = colors.join(', ');
    } else {
      captionQty  = parseInt(totalQty) || 12;
      lineQty     = captionQty + 'PCS';
      lineSurtido = moData.SURTIDO || '';
      lineSize    = formatSizes(moData.SIZE_LIST);
      lineColor   = cleanColors;
    }

    const textLines = [
      `ITEM NO: ${cleanItemNo}`,
      `Q'TY:    ${lineQty}`,
      `SURTIDO: ${lineSurtido}`,
      `SIZE:    ${lineSize}`,
      `COLOR:   ${lineColor}`,
    ];

    // 5 text rows on top — unified Arial 9, bold only on ITEM NO row
    for (let li = 0; li < IP_TEXT_ROWS; li++) {
      const cell = ws.getRow(firstRow + li).getCell(textColNo);
      cell.value = textLines[li];
      cell.font  = { size: 9, name: 'Arial', bold: li === 0 };
      cell.alignment = li === 4
        ? { vertical: 'top',    horizontal: 'left', wrapText: true, indent: 1 }
        : { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
      cell.border = {
        left:   MEDIUM,
        right:  MEDIUM,
        top:    li === 0 ? MEDIUM : GRAY,
        bottom: GRAY,
      };
    }

    // QR area — 4 placeholder rows with side borders
    for (let qi = 0; qi < IP_QR_ROWS; qi++) {
      const qCell = ws.getRow(firstRow + IP_TEXT_ROWS + qi).getCell(textColNo);
      qCell.border = {
        left:   MEDIUM,
        right:  MEDIUM,
        top:    NO_BORDER,
        bottom: qi === IP_QR_ROWS - 1 ? MEDIUM : NO_BORDER,
      };
    }

    // Caption row at bottom
    const captionCell = ws.getRow(captionRowNo).getCell(textColNo);
    if (isStandard) {
      captionCell.value = `${moData.MO_Number} / Standard / ${captionQty} pcs`;
    } else if (isRemainder) {
      captionCell.value = `${moData.MO_Number} / 尾包#${packNumber} / ${captionQty} pcs`;
    } else {
      captionCell.value = `${moData.MO_Number} / Inner Pack #${packNumber} / ${captionQty} pcs`;
    }
    captionCell.font  = { name: 'Arial', size: 7, bold: true };
    captionCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    captionCell.border = { left: MEDIUM, top: GRAY, bottom: MEDIUM, right: MEDIUM };

    // QR — centered within the QR area
    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: {
        nativeCol:    textColNo - 1,
        nativeColOff: 17 * PX_TO_EMU,
        nativeRow:    firstRow - 1 + IP_TEXT_ROWS,
        nativeRowOff: 2 * PX_TO_EMU,
      },
      ext: { width: IP_QR_PX, height: IP_QR_PX },
      editAs: 'absolute',
    });
  }
}

export async function generateInnerPackExcel(moData, packList, filename) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FactoryScanApp';
  await addInnerPackSheet(wb, packList, moData);
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
// All bags on a single sheet — 4 identical stickers per bag in a 2×2 grid,
// stacked vertically bag by bag (4장 1묶음 구조 유지).
// Column layout: text(35) | qr(22) | spacer(3) | text(35) | qr(22)
// QR (142×142) anchored to ITEM NO row (R+2) via native EMU.

const MB_COLS       = 2;
const MB_DATA_ROWS  = 7;
const MB_LABEL_ROWS = MB_DATA_ROWS + 1; // 8  (7 data + 1 caption)
const MB_VSTRIDE    = MB_LABEL_ROWS + 1; // 9  (8 label rows + 1 intra-bag spacer)
const MB_VSPACER_H  = 12; // pt — spacer between row groups
const MB_TEXT_W     = 35;
const MB_QR_W       = 22;
const MB_SPACER_W   = 3;
const MB_QR_SIZE    = 142; // px square
// Each bag occupies 2 label-row-groups plus 1 inter-bag spacer row
const MB_BAG_STRIDE = 2 * MB_VSTRIDE + 1; // 19

// Row heights — QR spans ITEM NO+Q'TY+SIZE+COLOR (28+22+22+45 = 117pt ≈ 156px)
const MB_ROW_HEIGHTS = [
  20,  // R+0  PI NO
  20,  // R+1  C/T NO
  28,  // R+2  ITEM NO  ← QR anchor top
  22,  // R+3  Q'TY
  22,  // R+4  SIZE
  45,  // R+5  COLOR
  22,  // R+6  Bag No
  22,  // R+7  Caption
];

async function addMasterBagSheet(workbook, bagList, moData) {
  const ws = workbook.addWorksheet('Labels', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1, header: 0, footer: 0 },
    },
  });

  for (let c = 0; c < MB_COLS; c++) {
    ws.getColumn(c * 3 + 1).width = MB_TEXT_W;
    ws.getColumn(c * 3 + 2).width = MB_QR_W;
    if (c < MB_COLS - 1) ws.getColumn(c * 3 + 3).width = MB_SPACER_W;
  }

  // Row heights for all bags on one sheet
  for (let b = 0; b < bagList.length; b++) {
    const bagStart = b * MB_BAG_STRIDE + 1;
    for (let r = 0; r < 2; r++) {
      const groupStart = bagStart + r * MB_VSTRIDE;
      for (let s = 0; s < MB_LABEL_ROWS; s++) {
        ws.getRow(groupStart + s).height = MB_ROW_HEIGHTS[s];
      }
      // Intra-bag spacer between the two row-groups
      if (r < 1) ws.getRow(groupStart + MB_LABEL_ROWS).height = MB_VSPACER_H;
    }
    // Inter-bag spacer after each bag except the last
    if (b < bagList.length - 1) ws.getRow(bagStart + 2 * MB_VSTRIDE).height = MB_VSPACER_H;
  }

  const cleanItemNo = stripChinese(moData.ITEM_NO);
  const cleanColors = stripChinese(moData.COLOR_LIST);

  for (let b = 0; b < bagList.length; b++) {
    const bag      = bagList[b];
    const bagStart = b * MB_BAG_STRIDE + 1;

    const dataLines = [
      [`PI NO:   `, '_______________'],
      [`C/T NO:  `, '_______________'],
      [`ITEM NO: `, cleanItemNo],
      [`Q'TY:    `, '120PCS'],
      [`SIZE:    `, formatSizes(moData.SIZE_LIST)],
      [`COLOR:   `, cleanColors],
      [`Bag No:  `, `#${bag.bagNumber}`],
    ];

    // Generate QR once and reuse across all 4 positions for this bag
    const qrBase64 = await qrToBase64(bag.qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });

    for (let pos = 0; pos < 4; pos++) {
      const labelCol     = pos % MB_COLS;
      const labelRow     = Math.floor(pos / MB_COLS);
      const textColNo    = labelCol * 3 + 1;
      const qrColNo      = textColNo + 1;
      const firstRow     = bagStart + labelRow * MB_VSTRIDE;
      const captionRowNo = firstRow + MB_DATA_ROWS; // R+7

      for (let li = 0; li < MB_DATA_ROWS; li++) {
        const cell = ws.getRow(firstRow + li).getCell(textColNo);
        const [lbl, val] = dataLines[li];
        cell.value = lbl + val;
        cell.font  = { size: 10, name: 'Arial', bold: li === 0 || li === 1 };
        cell.alignment = li === 5
          ? { vertical: 'top',    horizontal: 'left', wrapText: true,  indent: 1 }
          : { vertical: 'middle', horizontal: 'left', wrapText: true,  indent: 1 };
        cell.border = {
          left:   MEDIUM,
          right:  (li < 2 || li === 6) ? THIN : NO_BORDER,
          top:    li === 0 ? MEDIUM : GRAY,
          bottom: GRAY,
        };
        const qCell = ws.getRow(firstRow + li).getCell(qrColNo);
        qCell.border = {
          left:   MEDIUM,
          right:  MEDIUM,
          top:    li === 0 ? MEDIUM : NO_BORDER,
          bottom: li === MB_DATA_ROWS - 1 ? MEDIUM : NO_BORDER,
        };
      }

      ws.mergeCells(captionRowNo, textColNo, captionRowNo, qrColNo);
      const captionCell = ws.getRow(captionRowNo).getCell(textColNo);
      captionCell.value = `${moData.MO_Number} / Master Bag #${bag.bagNumber} / 120 pcs`;
      captionCell.font  = { name: 'Arial', size: 10, bold: true };
      captionCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      captionCell.border = { left: MEDIUM, top: GRAY, bottom: MEDIUM, right: MEDIUM };

      // QR anchored to top of ITEM NO row (R+2) — reuse same imgId for all 4 positions
      ws.addImage(imgId, {
        tl: {
          nativeCol:    qrColNo - 1,
          nativeColOff: 6 * PX_TO_EMU,
          nativeRow:    firstRow - 1 + 2,  // 0-based index of ITEM NO row (R+2)
          nativeRowOff: 5 * PX_TO_EMU,
        },
        ext: { width: MB_QR_SIZE, height: MB_QR_SIZE },
        editAs: 'absolute',
      });
    }
  }
}

export async function generateMasterBagExcel(moData, bagList, filename) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FactoryScanApp';
  await addMasterBagSheet(wb, bagList, moData);
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
