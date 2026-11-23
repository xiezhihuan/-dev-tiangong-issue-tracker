import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.js';
import { logger } from './log.js';
import { tidyOcr } from './text.js';

const log = logger('ocr');
export interface Ocr { recognize(file: string): Promise<string> }

const MODEL = path.join(ROOT, 'models');
/** 检测模型会把长边压到 1920，长截图需切片才能看清小字。 */
const SLICE = 1800, OVERLAP = 240;

/**
 * 本地 OCR（PP-OCRv6 tiny，模型随项目分发，不联网）。
 * 依赖是可选安装的；不可用时返回 null，系统其余功能不受影响。
 */
export async function createOcr(): Promise<Ocr | null> {
  try {
    const { PaddleOcrService } = await import('ppu-paddle-ocr');
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const svc = new PaddleOcrService({
      model: { detection: path.join(MODEL, 'PP-OCRv6_tiny_det.ort'), recognition: path.join(MODEL, 'PP-OCRv6_tiny_rec.ort'), charactersDictionary: path.join(MODEL, 'ppocrv6_tiny_dict.txt') },
    });
    await svc.initialize();
    log.info('OCR 已就绪');
    return {
      async recognize(file) {
        const img = await loadImage(await fs.readFile(file));
        if (img.width * img.height > 120_000_000) throw new Error('图片过大');
        const out: string[] = [];
        for (const { y, h, from, to } of slices(img.height)) {
          const c = createCanvas(img.width, h);
          const g = c.getContext('2d');
          g.fillStyle = '#fff';
          g.fillRect(0, 0, img.width, h); // 透明 PNG 铺白底
          g.drawImage(img, 0, y, img.width, h, 0, 0, img.width, h);
          const png = await c.encode('png');
          const r = await svc.recognize(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, { noCache: true });
          for (const line of r.lines) {
            const items = line.filter((it) => { const mid = y + it.box.y + it.box.height / 2; return mid >= from && mid < to; });
            if (items.length) out.push(items.map((it) => it.text).join(' '));
          }
        }
        return tidyOcr(out.join('\n'));
      },
    };
  } catch (e) {
    log.warn(`OCR 不可用，截图将只保存不识别：${(e as Error).message}`);
    return null;
  }
}

/**
 * 长图切片。相邻切片有重叠，重叠区从中线划分归属 [from, to)：
 * 每行文字按中心点只归一个切片，既不重复也不遗漏（按文字内容去重会误删反复出现的昵称等）。
 */
export function slices(height: number): { y: number; h: number; from: number; to: number }[] {
  const out: { y: number; h: number; from: number; to: number }[] = [];
  for (let y = 0; ; y += SLICE - OVERLAP) {
    const h = Math.min(SLICE, height - y), last = y + h >= height;
    out.push({ y, h, from: y === 0 ? 0 : y + OVERLAP / 2, to: last ? Infinity : y + h - OVERLAP / 2 });
    if (last) return out;
  }
}
