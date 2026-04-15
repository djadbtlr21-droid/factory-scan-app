import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pubDir = path.join(here, '..', 'public');
const svgPath = path.join(pubDir, 'icon.svg');

const sizes = [192, 512];

async function main() {
  const svg = await fs.readFile(svgPath);
  for (const size of sizes) {
    const out = path.join(pubDir, `icon-${size}.png`);
    await sharp(svg).resize(size, size).png().toFile(out);
    console.log('wrote', out);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
