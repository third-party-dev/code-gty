// Geometric drawing for glyphs that must fill their cell exactly: the Powerline
// separators (U+E0B0-E0BF) and the block elements (U+2580-259F). Like native
// Ghostty, kitty, WezTerm and xterm.js (customGlyphs), these are drawn as
// shapes sized to the cell instead of taken from the font, so they line up
// with neighbouring cell backgrounds at any font, size or device pixel ratio.
//
// Wired into ghostty-web's renderer by scripts/build.mjs. Coordinates are CSS
// pixels; every edge is snapped to whole device pixels so adjacent cells share
// edges exactly and no seams appear at fractional scales.

type Ctx = CanvasRenderingContext2D;

const snap = (v: number, dpr: number): number => Math.round(v * dpr) / dpr;

/** fillRect with device-pixel-snapped edges, for cell and row backgrounds. */
export function fillSnapped(ctx: Ctx, x: number, y: number, w: number, h: number, dpr: number): void {
  const x0 = snap(x, dpr), y0 = snap(y, dpr);
  ctx.fillRect(x0, y0, snap(x + w, dpr) - x0, snap(y + h, dpr) - y0);
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  dpr: number;
}

function poly(ctx: Ctx, pts: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
}

function line(ctx: Ctx, b: Box, pts: [number, number][]): void {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = Math.max(1, Math.round((b.h * b.dpr) / 16)) / b.dpr;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();
}

/** Half ellipse with its flat side on x = cx, bulging towards the other edge. */
function halfCircle(ctx: Ctx, b: Box, bulgeRight: boolean, thin: boolean): void {
  const cx = bulgeRight ? b.x0 : b.x1;
  const cy = (b.y0 + b.y1) / 2;
  const [start, end] = bulgeRight ? [-Math.PI / 2, Math.PI / 2] : [Math.PI / 2, (3 * Math.PI) / 2];
  if (!thin) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, b.w, b.h / 2, 0, start, end);
    ctx.closePath();
    ctx.fill();
    return;
  }
  const lw = Math.max(1, Math.round((b.h * b.dpr) / 16)) / b.dpr;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(b.w - lw / 2, 0), Math.max(b.h / 2 - lw / 2, 0), 0, start, end);
  ctx.stroke();
  ctx.restore();
}

function powerline(ctx: Ctx, cp: number, b: Box): boolean {
  const { x0, y0, x1, y1 } = b;
  const my = (y0 + y1) / 2;
  switch (cp) {
    case 0xe0b0: poly(ctx, [[x0, y0], [x1, my], [x0, y1]]); return true;
    case 0xe0b1: line(ctx, b, [[x0, y0], [x1, my], [x0, y1]]); return true;
    case 0xe0b2: poly(ctx, [[x1, y0], [x0, my], [x1, y1]]); return true;
    case 0xe0b3: line(ctx, b, [[x1, y0], [x0, my], [x1, y1]]); return true;
    case 0xe0b4: halfCircle(ctx, b, true, false); return true;
    case 0xe0b5: halfCircle(ctx, b, true, true); return true;
    case 0xe0b6: halfCircle(ctx, b, false, false); return true;
    case 0xe0b7: halfCircle(ctx, b, false, true); return true;
    case 0xe0b8: poly(ctx, [[x0, y0], [x0, y1], [x1, y1]]); return true;
    case 0xe0b9: case 0xe0bf: line(ctx, b, [[x0, y0], [x1, y1]]); return true;
    case 0xe0ba: poly(ctx, [[x1, y0], [x1, y1], [x0, y1]]); return true;
    case 0xe0bb: case 0xe0bd: line(ctx, b, [[x0, y1], [x1, y0]]); return true;
    case 0xe0bc: poly(ctx, [[x0, y0], [x1, y0], [x0, y1]]); return true;
    case 0xe0be: poly(ctx, [[x0, y0], [x1, y0], [x1, y1]]); return true;
  }
  return false;
}

// Quadrants as [upper-left, upper-right, lower-left, lower-right] bits, U+2596-259F.
const QUADRANTS = [0b0010, 0b0001, 0b1000, 0b1011, 0b1001, 0b1110, 0b1101, 0b0100, 0b0110, 0b0111];

function block(ctx: Ctx, cp: number, b: Box): boolean {
  const { x0, y0, x1, y1, dpr } = b;
  // Fractions of the cell, snapped so partial blocks meet their neighbours.
  const fx = (f: number) => snap(x0 + (x1 - x0) * f, dpr);
  const fy = (f: number) => snap(y0 + (y1 - y0) * f, dpr);
  const rect = (ax: number, ay: number, bx: number, by: number) => ctx.fillRect(ax, ay, bx - ax, by - ay);
  if (cp === 0x2580) return rect(x0, y0, x1, fy(1 / 2)), true;
  if (cp >= 0x2581 && cp <= 0x2588) return rect(x0, fy(1 - (cp - 0x2580) / 8), x1, y1), true;
  if (cp >= 0x2589 && cp <= 0x258f) return rect(x0, y0, fx((0x2590 - cp) / 8), y1), true;
  if (cp === 0x2590) return rect(fx(1 / 2), y0, x1, y1), true;
  if (cp >= 0x2591 && cp <= 0x2593) {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * ((cp - 0x2590) / 4);
    rect(x0, y0, x1, y1);
    ctx.globalAlpha = alpha;
    return true;
  }
  if (cp === 0x2594) return rect(x0, y0, x1, fy(1 / 8)), true;
  if (cp === 0x2595) return rect(fx(7 / 8), y0, x1, y1), true;
  if (cp >= 0x2596 && cp <= 0x259f) {
    const q = QUADRANTS[cp - 0x2596];
    const mx = fx(1 / 2), my = fy(1 / 2);
    if (q & 0b1000) rect(x0, y0, mx, my);
    if (q & 0b0100) rect(mx, y0, x1, my);
    if (q & 0b0010) rect(x0, my, mx, y1);
    if (q & 0b0001) rect(mx, my, x1, y1);
    return true;
  }
  return false;
}

/**
 * Draws `text` as a shape filling the cell at (x, y, w, h) in the current
 * fillStyle and returns true, or returns false to let the font draw it.
 */
export function drawSprite(ctx: Ctx, text: string, x: number, y: number, w: number, h: number, dpr: number): boolean {
  if (text.length > 2) return false;
  const cp = text.codePointAt(0) ?? 0;
  if (text.length !== String.fromCodePoint(cp).length) return false;
  const isPowerline = cp >= 0xe0b0 && cp <= 0xe0bf;
  const isBlock = cp >= 0x2580 && cp <= 0x259f;
  if (!isPowerline && !isBlock) return false;
  const x0 = snap(x, dpr), y0 = snap(y, dpr), x1 = snap(x + w, dpr), y1 = snap(y + h, dpr);
  const b: Box = { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, dpr };
  return isPowerline ? powerline(ctx, cp, b) : block(ctx, cp, b);
}
