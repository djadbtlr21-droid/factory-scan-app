import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import QRCode from 'qrcode';

async function qrToBase64(text) {
  const dataURL = await QRCode.toDataURL(text, {
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 256,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  return dataURL.split(',')[1];
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
// 4 labels per row × 6 label rows = 24 per A4 sheet
// Each label: 2 real cols (text + qr), 7 real rows (6 content + 1 spacer)

const IP_COLS       = 4;
const IP_PAGE       = 24;
const IP_DATA_ROWS  = 6;
const IP_SPACER     = 1;
const IP_LABEL_ROWS = IP_DATA_ROWS + IP_SPACER; // 7
const IP_TEXT_W     = 13;
const IP_QR_W       = 5;
const IP_ROW_H      = 20;  // pt per content row
const IP_SPACER_H   = 4;   // pt for gap row

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
    ws.getColumn(c * 2 + 1).width = IP_TEXT_W;
    ws.getColumn(c * 2 + 2).width = IP_QR_W;
  }

  for (let r = 0; r < 6; r++) {
    for (let s = 0; s < IP_DATA_ROWS; s++) {
      ws.getRow(r * IP_LABEL_ROWS + s + 1).height = IP_ROW_H;
    }
    ws.getRow(r * IP_LABEL_ROWS + IP_DATA_ROWS + 1).height = IP_SPACER_H;
  }

  const lines = [
    `ITEM NO: ${moData.ITEM_NO || ''}`,
    `Q'TY:    12PCS`,
    `SURTIDO: ${moData.SURTIDO || ''}`,
    `SIZE:    ${moData.SIZE_LIST || ''}`,
    `COLOR:   ${moData.COLOR_LIST || ''}`,
    '',
  ];

  for (let i = 0; i < pageItems.length; i++) {
    const { packNumber, qrText } = pageItems[i];
    const labelCol  = i % IP_COLS;
    const labelRow  = Math.floor(i / IP_COLS);
    const textColNo = labelCol * 2 + 1;   // 1-based
    const qrColNo   = textColNo + 1;
    const firstRow  = labelRow * IP_LABEL_ROWS + 1;
    const lastRow   = firstRow + IP_DATA_ROWS - 1;

    lines[5] = `Pack:    #${packNumber}`;

    for (let li = 0; li < IP_DATA_ROWS; li++) {
      const cell = ws.getRow(firstRow + li).getCell(textColNo);
      cell.value = lines[li];
      cell.font  = { size: 7, name: 'Arial', bold: li === 0 || li === 5 };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
    }

    applyLabelBorders(ws, firstRow, lastRow, textColNo, qrColNo);

    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: qrColNo - 1, row: firstRow - 1 },
      br: { col: qrColNo,     row: firstRow - 1 + IP_DATA_ROWS },
      editAs: 'absolute',
    });
  }
}

export async function generateInnerPackExcel(moData, packList) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FactoryScanApp';

  for (let p = 0; p < Math.ceil(packList.length / IP_PAGE); p++) {
    await addInnerPackSheet(wb, packList.slice(p * IP_PAGE, (p + 1) * IP_PAGE), p, moData);
  }

  const buf  = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${moData.MO_Number}_InnerPack_Labels.xlsx`);
}

// ── Master Bag ────────────────────────────────────────────────────────────────
// 2 labels per row × 2 label rows = 4 per A4 sheet
// Each label: 2 real cols, 9 real rows (7 content + 2 spacer)

const MB_COLS       = 2;
const MB_PAGE       = 4;
const MB_DATA_ROWS  = 7;
const MB_SPACER     = 2;
const MB_LABEL_ROWS = MB_DATA_ROWS + MB_SPACER; // 9
const MB_TEXT_W     = 20;
const MB_QR_W       = 14;
const MB_ROW_H      = 36;  // pt per content row
const MB_SPACER_H   = 4;

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
    ws.getColumn(c * 2 + 1).width = MB_TEXT_W;
    ws.getColumn(c * 2 + 2).width = MB_QR_W;
  }

  for (let r = 0; r < 2; r++) {
    for (let s = 0; s < MB_DATA_ROWS; s++) {
      ws.getRow(r * MB_LABEL_ROWS + s + 1).height = MB_ROW_H;
    }
    for (let s = 0; s < MB_SPACER; s++) {
      ws.getRow(r * MB_LABEL_ROWS + MB_DATA_ROWS + s + 1).height = MB_SPACER_H;
    }
  }

  const baseLines = [
    [`PI NO:   `, '_______________'],
    [`C/T NO:  `, '_______________'],
    [`ITEM NO: `, moData.ITEM_NO || ''],
    [`Q'TY:    `, '120PCS'],
    [`SIZE:    `, moData.SIZE_LIST || ''],
    [`COLOR:   `, moData.COLOR_LIST || ''],
    [`Bag No:  `, ''],
  ];

  for (let i = 0; i < pageItems.length; i++) {
    const { bagNumber, qrText } = pageItems[i];
    const labelCol  = i % MB_COLS;
    const labelRow  = Math.floor(i / MB_COLS);
    const textColNo = labelCol * 2 + 1;
    const qrColNo   = textColNo + 1;
    const firstRow  = labelRow * MB_LABEL_ROWS + 1;
    const lastRow   = firstRow + MB_DATA_ROWS - 1;

    baseLines[6][1] = `#${bagNumber}`;

    for (let li = 0; li < MB_DATA_ROWS; li++) {
      const cell = ws.getRow(firstRow + li).getCell(textColNo);
      const [lbl, val] = baseLines[li];
      cell.value = lbl + val;
      cell.font  = { size: 10, name: 'Arial', bold: li === 0 || li === 1 };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
    }

    applyLabelBorders(ws, firstRow, lastRow, textColNo, qrColNo);

    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: qrColNo - 1, row: firstRow },
      br: { col: qrColNo,     row: firstRow - 1 + MB_DATA_ROWS },
      editAs: 'absolute',
    });
  }
}

export async function generateMasterBagExcel(moData, bagList) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FactoryScanApp';

  for (let p = 0; p < Math.ceil(bagList.length / MB_PAGE); p++) {
    await addMasterBagSheet(wb, bagList.slice(p * MB_PAGE, (p + 1) * MB_PAGE), p, moData);
  }

  const buf  = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${moData.MO_Number}_MasterBag_Labels.xlsx`);
}
