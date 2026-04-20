#!/usr/bin/env node
/**
 * render-og-card.js — One-shot generator for the static social-share image.
 *
 * Renders public/og-card.jpg (1200x630) from an inline SVG. Re-run after
 * editing the SVG below. Sharp is loaded lazily so it can be installed
 * with --no-save when needed.
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'og-card.jpg');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0c4a6e"/>
      <stop offset="100%" stop-color="#0ea5e9"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#sky)"/>
  <path d="M0 430 Q200 360 400 410 Q600 460 800 390 Q1000 320 1200 380 L1200 630 L0 630 Z" fill="#0369a1" opacity="0.65"/>
  <path d="M0 480 Q200 410 400 460 Q600 510 800 440 Q1000 370 1200 430 L1200 630 L0 630 Z" fill="#075985"/>
  <text x="80" y="180" font-family="Noto Sans TC, DM Sans, sans-serif" font-size="92" font-weight="800" fill="#ffffff">城市浪人</text>
  <text x="80" y="252" font-family="Noto Sans TC, DM Sans, sans-serif" font-size="40" font-weight="500" fill="#e0f2fe">台灣衝浪預報 · AI 浪況分析</text>
  <text x="80" y="338" font-family="Noto Sans TC, DM Sans, sans-serif" font-size="30" font-weight="400" fill="#bae6fd">每日更新各浪點預報，問 AI 規劃今天的下水時機</text>
  <text x="1080" y="320" text-anchor="end" font-size="220">🏄</text>
  <text x="80" y="560" font-family="DM Sans, sans-serif" font-size="26" font-weight="600" fill="#e0f2fe">surf-forecast.app</text>
</svg>
`;

await sharp(Buffer.from(svg))
  .jpeg({ quality: 88 })
  .toFile(OUT);

console.log('wrote', OUT);
