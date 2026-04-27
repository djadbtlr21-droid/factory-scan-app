import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { QR_PREFIX } from './config.js';

export function buildInnerPackQR() {
  return window.location.origin + '/view/inner/' + uuidv4();
}

export function buildMasterBagQR() {
  return window.location.origin + '/view/bag/' + uuidv4();
}

export function parseInnerPackQR(text) {
  if (!text) return null;
  const urlMatch = text.match(/\/view\/inner\/([0-9a-f-]{36})$/i);
  if (urlMatch) return urlMatch[1];
  if (text.startsWith(QR_PREFIX.INNER)) return text.substring(QR_PREFIX.INNER.length);
  return null;
}

export function parseMasterBagQR(text) {
  if (!text) return null;
  const urlMatch = text.match(/\/view\/bag\/([0-9a-f-]{36})$/i);
  if (urlMatch) return urlMatch[1];
  if (text.startsWith(QR_PREFIX.BAG)) return text.substring(QR_PREFIX.BAG.length);
  return null;
}

export function detectQRType(text) {
  if (!text) return 'unknown';
  const t = text.trim();
  if (/\/view\/inner\/[0-9a-f-]{36}$/i.test(t)) return 'inner_pack';
  if (/\/view\/bag\/[0-9a-f-]{36}$/i.test(t)) return 'master_bag';
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

export function sanitizeFilename(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

export async function generateQRDataURLWithLabel(text, label, size = 512, border = false) {
  const qrDataURL = await generateQRDataURL(text, size);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const labelH = 60;
      const pad = border ? 8 : 0;
      const canvas = document.createElement('canvas');
      canvas.width = size + pad * 2;
      canvas.height = size + labelH + pad * 2;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (border) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
      }
      ctx.drawImage(img, pad, pad, size, size);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, canvas.width / 2, pad + size + labelH / 2);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = qrDataURL;
  });
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
