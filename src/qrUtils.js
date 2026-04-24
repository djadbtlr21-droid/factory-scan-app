import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { QR_PREFIX } from './config.js';

export function buildInnerPackQR() {
  return QR_PREFIX.INNER + uuidv4();
}

export function buildMasterBagQR() {
  return QR_PREFIX.BAG + uuidv4();
}

export function parseInnerPackQR(text) {
  if (!text || !text.startsWith(QR_PREFIX.INNER)) return null;
  return text.substring(QR_PREFIX.INNER.length);
}

export function parseMasterBagQR(text) {
  if (!text || !text.startsWith(QR_PREFIX.BAG)) return null;
  return text.substring(QR_PREFIX.BAG.length);
}

export function detectQRType(text) {
  if (!text) return 'unknown';
  const t = text.trim();
  if (t.startsWith(QR_PREFIX.INNER)) return 'inner_pack';
  if (t.startsWith(QR_PREFIX.BAG)) return 'master_bag';
  if (/^MO:|^[A-Z]{2}\d{2}-/i.test(t)) return 'production_log';
  return 'unknown';
}

export async function generateQRDataURL(text, size = 512) {
  return await QRCode.toDataURL(text, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: size,
    color: { dark: '#000000', light: '#FFFFFF' }
  });
}

export function downloadQRPNG(dataURL, filename) {
  const link = document.createElement('a');
  link.href = dataURL;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function downloadQRsAsZIP(qrItems, zipFilename) {
  const zip = new JSZip();
  for (const item of qrItems) {
    const dataURL = await generateQRDataURL(item.text);
    const base64 = dataURL.split(',')[1];
    zip.file(item.filename, base64, { base64: true });
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = zipFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function downloadQRsAsPDF(qrItems, pdfFilename) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 10;
  const cols = 4;
  const rows = 6;
  const cellW = (pageWidth - margin * 2) / cols;
  const cellH = (pageHeight - margin * 2) / rows;
  const qrSize = Math.min(cellW, cellH) - 8;

  let col = 0, row = 0;
  for (let i = 0; i < qrItems.length; i++) {
    const item = qrItems[i];
    const dataURL = await generateQRDataURL(item.text, 256);
    const x = margin + col * cellW + (cellW - qrSize) / 2;
    const y = margin + row * cellH + 2;
    pdf.addImage(dataURL, 'PNG', x, y, qrSize, qrSize);
    pdf.setFontSize(7);
    const captionY = y + qrSize + 3;
    pdf.text(item.filename.replace('.png', ''), x + qrSize / 2, captionY, { align: 'center' });

    col++;
    if (col >= cols) { col = 0; row++; }
    if (row >= rows && i < qrItems.length - 1) {
      pdf.addPage();
      col = 0; row = 0;
    }
  }
  pdf.save(pdfFilename);
}
