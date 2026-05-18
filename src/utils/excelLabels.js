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

const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const GRAY = { style: 'thin', color: { argb: 'FFCCCCCC' } };

// EMU constants (OOXML: 1px at 96dpi = 9525 EMU, 1pt = 12700 EMU)
const PX_TO_EMU = 9525;

// ── Inner Pack ────────────────────────────────────────────────────────────────
// 3 labels per row × 5 label-row groups = 15 per A4 sheet
// Column layout: text(22) | qr(14) | spacer(2) | ... repeated × 3
// QR (80×80) anchored to SIZE row (R+3) via native EMU — spans SIZE+COLOR+Pack

const IP_COLS       = 3;
const IP_PAGE       = 15;  // 3 cols × 5 rows
const IP_DATA_ROWS  = 6;
const IP_LABEL_ROWS = 7;   // 6 data + 1 caption
const IP_VSTRIDE    = IP_LABEL_ROWS + 1; // 8 rows between group starts
const IP_TEXT_W     = 22;
const IP_QR_W       = 12;
const IP_SPACER_W   = 2;
const IP_QR_SIZE    = 80;  // px square
const IP_VSPACER_H  = 10;  // pt — spacer row between groups

// Normal row heights — QR spans SIZE+COLOR+Pack visually (16+32+16 = 64pt ≈ 85px)
const IP_ROW_HEIGHTS = [
  24, // R+0  ITEM NO
  16, // R+1  Q'TY
  16, // R+2  SURTIDO
  16, // R+3  SIZE     ← QR anchor top
  32, // R+4  COLOR
  16, // R+5  Pack
  18, // R+6  Caption
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

  // 5 label groups, 4 vertical spacer rows between them
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
    const firstRow     = labelRow * IP_VSTRIDE + 1;
    const captionRowNo = firstRow + IP_DATA_ROWS; // R+6

    // Per-pack data: use Items_JSON for leftover, MO-level for normal
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
      // COLOR row (li===4): top-align so wrapped text sits above the QR
      cell.alignment = li === 4
        ? { vertical: 'top',    horizontal: 'left', wrapText: true,  indent: 1 }
        : { vertical: 'middle', horizontal: 'left', wrapText: true,  indent: 1 };
      // Text col: outer-black left/right, black top for first row, gray elsewhere
      cell.border = {
        left:   THIN,
        right:  THIN,
        top:    li === 0 ? THIN : GRAY,
        bottom: GRAY,
      };
      // QR col: li<3 (ITEM NO/Q'TY/SURTIDO) not overlapped — add borders
      //         li>=3 (SIZE/COLOR/Pack) overlapped by QR — outer right only
      const qCell = ws.getRow(firstRow + li).getCell(qrColNo);
      if (li < 3) {
        qCell.border = { right: THIN, top: li === 0 ? THIN : GRAY, bottom: GRAY };
      } else {
        qCell.border = { right: THIN };
      }
    }

    ws.mergeCells(captionRowNo, textColNo, captionRowNo, qrColNo);
    const captionCell = ws.getRow(captionRowNo).getCell(textColNo);
    captionCell.value = isRemainder
      ? `${moData.MO_Number} / Inner Pack #${packNumber} / ${captionQty} pcs (자투리)`
      : `${moData.MO_Number} / Inner Pack #${packNumber} / ${captionQty} pcs`;
    captionCell.font  = { name: 'Arial', size: 8, bold: true };
    captionCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    captionCell.border = { left: THIN, top: GRAY, bottom: THIN, right: THIN };

    // QR anchored to top of SIZE row (R+3) via native EMU — spans SIZE+COLOR+Pack
    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: {
        nativeCol:    qrColNo - 1,
        nativeColOff: 5 * PX_TO_EMU,
        nativeRow:    firstRow - 1 + 3,  // 0-based index of SIZE row (R+3)
        nativeRowOff: 5 * PX_TO_EMU,
      },
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
// 2 labels per row × 2 label-row groups = 4 per A4 sheet
// Column layout: text(35) | qr(28) | spacer(3) | text(35) | qr(28)
// QR (150×150) anchored to Q'TY row (R+3) via native EMU — spans Q'TY+SIZE+COLOR+Bag No

const MB_COLS       = 2;
const MB_PAGE       = 4;
const MB_DATA_ROWS  = 7;
const MB_LABEL_ROWS = MB_DATA_ROWS + 1; // 8
const MB_TEXT_W     = 35;
const MB_QR_W       = 22;
const MB_SPACER_W   = 3;
const MB_QR_SIZE    = 142; // px square

// Normal row heights — QR spans ITEM NO+Q'TY+SIZE+COLOR (28+22+22+45 = 117pt ≈ 156px)
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
      // COLOR row (li===5): top-align so wrapped text sits above the QR
      cell.alignment = li === 5
        ? { vertical: 'top',    horizontal: 'left', wrapText: true,  indent: 1 }
        : { vertical: 'middle', horizontal: 'left', wrapText: true,  indent: 1 };
      // Text col: outer-black left/right, black top for first row, gray elsewhere
      cell.border = {
        left:   THIN,
        right:  THIN,
        top:    li === 0 ? THIN : GRAY,
        bottom: GRAY,
      };
      // QR col: li<2 (PI NO/C/T NO) and li===6 (Bag No) not overlapped — add borders
      //         li=2..5 (ITEM NO/Q'TY/SIZE/COLOR) overlapped by QR — outer right only
      const qCell = ws.getRow(firstRow + li).getCell(qrColNo);
      if (li < 2 || li === 6) {
        qCell.border = { right: THIN, top: li === 0 ? THIN : GRAY, bottom: GRAY };
      } else {
        qCell.border = { right: THIN };
      }
    }

    ws.mergeCells(captionRowNo, textColNo, captionRowNo, qrColNo);
    const captionCell = ws.getRow(captionRowNo).getCell(textColNo);
    captionCell.value = `${moData.MO_Number} / Master Bag #${bagNumber} / 120 pcs`;
    captionCell.font  = { name: 'Arial', size: 10, bold: true };
    captionCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    captionCell.border = { left: THIN, top: GRAY, bottom: THIN, right: THIN };

    // QR anchored to top of ITEM NO row (R+2) via native EMU — spans ITEM NO+Q'TY+SIZE+COLOR
    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: {
        nativeCol:    qrColNo - 1,
        nativeColOff: 5 * PX_TO_EMU,
        nativeRow:    firstRow - 1 + 2,  // 0-based index of ITEM NO row (R+2)
        nativeRowOff: 5 * PX_TO_EMU,
      },
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
