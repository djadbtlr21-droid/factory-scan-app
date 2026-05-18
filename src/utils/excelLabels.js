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
// Column layout: text(22) | qr(11) | spacer(2) | text(22) | qr(11) | spacer(2) | text(22) | qr(11)
// label group col: labelCol * 3 + 1 (text), labelCol * 3 + 2 (qr)

const IP_COLS      = 3;
const IP_PAGE      = 15;
const IP_DATA_ROWS = 6;
const IP_SPACER    = 1;
const IP_LABEL_ROWS = IP_DATA_ROWS + IP_SPACER; // 7
const IP_TEXT_W    = 22;
const IP_QR_W      = 11;
const IP_SPACER_W  = 2;
const IP_ROW_H     = 20;
const IP_SPACER_H  = 6;
const IP_QR_SIZE   = 68; // px, must equal height

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

  for (let r = 0; r < 5; r++) {
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
    const textColNo = labelCol * 3 + 1;
    const qrColNo   = textColNo + 1;
    const firstRow  = labelRow * IP_LABEL_ROWS + 1;
    const lastRow   = firstRow + IP_DATA_ROWS - 1;

    lines[5] = `Pack:    #${packNumber}`;

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

    applyLabelBorders(ws, firstRow, lastRow, textColNo, qrColNo);

    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    if (IP_QR_SIZE !== IP_QR_SIZE) throw new Error('QR ext not square!'); // always equal; guard pattern
    ws.addImage(imgId, {
      tl: { col: qrColNo - 1 + 0.1, row: firstRow - 1 + 0.1 },
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
    [{ packNumber: pack.number, qrText: pack.qrString }],
    `${moData.MO_Number}_InnerPack_#${pack.number}.xlsx`,
  );
}

// ── Master Bag ────────────────────────────────────────────────────────────────
// 2 labels per row × 2 label rows = 4 per A4 sheet
// Column layout: text(35) | qr(22) | spacer(3) | text(35) | qr(22)
// label group col: labelCol * 3 + 1 (text), labelCol * 3 + 2 (qr)

const MB_COLS       = 2;
const MB_PAGE       = 4;
const MB_DATA_ROWS  = 7;
const MB_SPACER     = 2;
const MB_LABEL_ROWS = MB_DATA_ROWS + MB_SPACER; // 9
const MB_TEXT_W     = 35;
const MB_QR_W       = 22;
const MB_SPACER_W   = 3;
const MB_ROW_H      = 36;
const MB_SPACER_H   = 4;
const MB_QR_SIZE    = 151; // px, must equal height

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
    const textColNo = labelCol * 3 + 1;
    const qrColNo   = textColNo + 1;
    const firstRow  = labelRow * MB_LABEL_ROWS + 1;
    const lastRow   = firstRow + MB_DATA_ROWS - 1;

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

    applyLabelBorders(ws, firstRow, lastRow, textColNo, qrColNo);

    const qrBase64 = await qrToBase64(qrText);
    const imgId    = workbook.addImage({ base64: qrBase64, extension: 'png' });
    ws.addImage(imgId, {
      tl: { col: qrColNo - 1 + 0.1, row: firstRow - 1 + 0.1 },
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
