// Geometric drawing for glyphs that must fill their cell exactly: box drawing
// (U+2500-257F), block elements (U+2580-259F), Braille (U+2800-28FF), the
// sextants of Symbols for Legacy Computing (U+1FB00-1FB3B) and the Powerline
// separators (U+E0B0-E0BF). Like native Ghostty, kitty, WezTerm and xterm.js
// (customGlyphs), these are drawn as shapes sized to the cell instead of taken
// from the font, so they line up with their neighbours at any font, size or
// device pixel ratio.
//
// All coordinates are device pixels. Cells are whole device pixels wide and
// tall (see the renderer), so every edge here is already on the pixel grid.

type Ctx = CanvasRenderingContext2D;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Device pixels per CSS pixel, for line thickness. */
  dpr: number;
}

export function isSprite(cp: number): boolean {
  return (
    (cp >= 0x2500 && cp <= 0x259f) ||
    (cp >= 0x2800 && cp <= 0x28ff) ||
    (cp >= 0x1fb00 && cp <= 0x1fb3b) ||
    (cp >= 0xe0b0 && cp <= 0xe0bf)
  );
}

/** Draws `cp` filling the box in the current fillStyle. Returns false if it is not a sprite. */
export function drawSprite(ctx: Ctx, cp: number, b: Box): boolean {
  if (cp >= 0x2500 && cp <= 0x257f) return boxDrawing(ctx, cp, b);
  if (cp >= 0x2580 && cp <= 0x259f) return block(ctx, cp, b);
  if (cp >= 0x2800 && cp <= 0x28ff) return braille(ctx, cp, b);
  if (cp >= 0x1fb00 && cp <= 0x1fb3b) return sextant(ctx, cp, b);
  if (cp >= 0xe0b0 && cp <= 0xe0bf) return powerline(ctx, cp, b);
  return false;
}

function lightWidth(b: Box): number {
  return Math.max(1, Math.round((b.y1 - b.y0) / 16));
}

// ---- box drawing --------------------------------------------------------

// Arms as [up, right, down, left]: 0 none, 1 light, 2 heavy, 3 double.
type Arms = [number, number, number, number];
const BOX: Record<number, Arms> = {};
function def(from: number, list: string): void {
  list.split(' ').forEach((s, i) => {
    if (s !== '-') BOX[from + i] = s.split('').map(Number) as Arms;
  });
}
// U+2500-250F (2504-250B are dashed, handled separately)
def(0x2500, '0101 0202 1010 2020 - - - - - - - - 0110 0210 0120 0220');
def(0x2510, '0011 0012 0021 0022 1100 1200 2100 2200 1001 1002 2001 2002 1110 1210 2110 1120');
def(0x2520, '2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 0111 0112 0211 0212');
def(0x2530, '0121 0122 0221 0222 1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212');
def(0x2540, '2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222');
def(0x2550, '0303 3030 0310 0130 0330 0013 0031 0033 1300 3100 3300 1003 3001 3003 1310 3130');
def(0x2560, '3330 1013 3031 3033 0313 0131 0333 1303 3101 3303 1313 3131 3333');
def(0x2574, '0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010');

// Dashed lines: [vertical, heavy, dashes].
const DASHED: Record<number, [boolean, boolean, number]> = {
  0x2504: [false, false, 3],
  0x2505: [false, true, 3],
  0x2506: [true, false, 3],
  0x2507: [true, true, 3],
  0x2508: [false, false, 4],
  0x2509: [false, true, 4],
  0x250a: [true, false, 4],
  0x250b: [true, true, 4],
  0x254c: [false, false, 2],
  0x254d: [false, true, 2],
  0x254e: [true, false, 2],
  0x254f: [true, true, 2],
};

function boxDrawing(ctx: Ctx, cp: number, b: Box): boolean {
  const { x0, y0, x1, y1 } = b;
  const lw = lightWidth(b);
  const hw = lw * 2;
  const w = x1 - x0;
  const h = y1 - y0;
  // Centre lines, positioned so a line of width t is centred on whole pixels.
  const cx = (t: number) => x0 + Math.floor((w - t) / 2);
  const cy = (t: number) => y0 + Math.floor((h - t) / 2);
  const rect = (ax: number, ay: number, bx: number, by: number) => ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));

  const dashed = DASHED[cp];
  if (dashed) {
    const [vertical, heavy, n] = dashed;
    const t = heavy ? hw : lw;
    const len = vertical ? h : w;
    const seg = len / n;
    const gap = Math.max(1, Math.round(seg / 4));
    for (let i = 0; i < n; i++) {
      const a = Math.round(i * seg);
      const e = Math.round((i + 1) * seg) - gap;
      if (vertical) rect(cx(t), y0 + a, cx(t) + t, y0 + e);
      else rect(x0 + a, cy(t), x0 + e, cy(t) + t);
    }
    return true;
  }

  if (cp >= 0x256d && cp <= 0x2570) {
    // Rounded corners: a quarter ellipse joining the two arms.
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = lw;
    const mx = cx(lw) + lw / 2;
    const my = cy(lw) + lw / 2;
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    if (cp === 0x256d) {
      ctx.moveTo(mx, y1);
      ctx.arcTo(mx, my, x1, my, r);
      ctx.lineTo(x1, my);
    } else if (cp === 0x256e) {
      ctx.moveTo(mx, y1);
      ctx.arcTo(mx, my, x0, my, r);
      ctx.lineTo(x0, my);
    } else if (cp === 0x256f) {
      ctx.moveTo(mx, y0);
      ctx.arcTo(mx, my, x0, my, r);
      ctx.lineTo(x0, my);
    } else {
      ctx.moveTo(mx, y0);
      ctx.arcTo(mx, my, x1, my, r);
      ctx.lineTo(x1, my);
    }
    ctx.stroke();
    ctx.restore();
    return true;
  }

  if (cp >= 0x2571 && cp <= 0x2573) {
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = lw;
    ctx.beginPath();
    if (cp !== 0x2572) {
      ctx.moveTo(x1, y0);
      ctx.lineTo(x0, y1);
    }
    if (cp !== 0x2571) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.restore();
    return true;
  }

  const arms = BOX[cp];
  if (!arms) return false;
  const [up, right, down, left] = arms;
  const thick = (k: number) => (k === 2 ? hw : lw);
  const hasDouble = arms.includes(3);
  // Width of the vertical and horizontal strokes through the centre, so arms
  // overlap them and the joint has no gap.
  const vMax = Math.max(up === 3 ? lw * 3 : thick(up) * (up ? 1 : 0), down === 3 ? lw * 3 : thick(down) * (down ? 1 : 0));
  const hMax = Math.max(left === 3 ? lw * 3 : thick(left) * (left ? 1 : 0), right === 3 ? lw * 3 : thick(right) * (right ? 1 : 0));
  const midX = x0 + w / 2;
  const midY = y0 + h / 2;

  if (!hasDouble) {
    const arm = (k: number, dir: 0 | 1 | 2 | 3) => {
      if (!k) return;
      const t = thick(k);
      if (dir === 0) rect(cx(t), y0, cx(t) + t, Math.ceil(midY + hMax / 2));
      if (dir === 2) rect(cx(t), Math.floor(midY - hMax / 2), cx(t) + t, y1);
      if (dir === 3) rect(x0, cy(t), Math.ceil(midX + vMax / 2), cy(t) + t);
      if (dir === 1) rect(Math.floor(midX - vMax / 2), cy(t), x1, cy(t) + t);
    };
    arm(up, 0);
    arm(right, 1);
    arm(down, 2);
    arm(left, 3);
    return true;
  }

  // Double lines: two light strokes `g` either side of the centre. Each stroke
  // stops at the inner stroke of a perpendicular arm on its own side, or runs
  // to the outer one when that side has no arm, which draws proper corners
  // and junctions (see ╔ ╦ ╬).
  const g = lw;
  const vx = [Math.round(midX - g - lw * 1.5), Math.round(midX + g + lw * 0.5) - lw];
  const hy = [Math.round(midY - g - lw * 1.5), Math.round(midY + g + lw * 0.5) - lw];
  const single = (k: number) => k === 1 || k === 2;
  const vertical = (k: number, toTop: boolean) => {
    if (!k) return;
    if (single(k)) {
      const t = thick(k);
      const end = toTop ? Math.ceil(midY + (hMax ? hy[1] + lw - midY : 0)) : Math.floor(midY - (hMax ? midY - hy[0] : 0));
      if (toTop) rect(cx(t), y0, cx(t) + t, end);
      else rect(cx(t), end, cx(t) + t, y1);
      return;
    }
    for (let side = 0; side < 2; side++) {
      const x = vx[side];
      const perpendicular = side === 0 ? left : right;
      // Stop at the near stroke of a perpendicular double arm, else run to the far one.
      const inner = perpendicular ? (toTop ? hy[0] : hy[1] + lw) : toTop ? hy[1] + lw : hy[0];
      const stop = perpendicular === 1 || perpendicular === 2 ? (toTop ? cy(thick(perpendicular)) : cy(thick(perpendicular)) + thick(perpendicular)) : inner;
      if (toTop) rect(x, y0, x + lw, stop);
      else rect(x, stop, x + lw, y1);
    }
  };
  const horizontal = (k: number, toLeft: boolean) => {
    if (!k) return;
    if (single(k)) {
      const t = thick(k);
      if (toLeft) rect(x0, cy(t), vMax ? vx[1] + lw : Math.ceil(midX), cy(t) + t);
      else rect(vMax ? vx[0] : Math.floor(midX), cy(t), x1, cy(t) + t);
      return;
    }
    for (let side = 0; side < 2; side++) {
      const y = hy[side];
      const perpendicular = side === 0 ? up : down;
      const inner = perpendicular ? (toLeft ? vx[0] : vx[1] + lw) : toLeft ? vx[1] + lw : vx[0];
      const stop = perpendicular === 1 || perpendicular === 2 ? (toLeft ? cx(thick(perpendicular)) : cx(thick(perpendicular)) + thick(perpendicular)) : inner;
      if (toLeft) rect(x0, y, stop, y + lw);
      else rect(stop, y, x1, y + lw);
    }
  };
  // Through-lines (both opposite arms double) are drawn whole.
  if (up === 3 && down === 3 && !left && !right) {
    rect(vx[0], y0, vx[0] + lw, y1);
    rect(vx[1], y0, vx[1] + lw, y1);
    return true;
  }
  if (left === 3 && right === 3 && !up && !down) {
    rect(x0, hy[0], x1, hy[0] + lw);
    rect(x0, hy[1], x1, hy[1] + lw);
    return true;
  }
  vertical(up, true);
  vertical(down, false);
  horizontal(left, true);
  horizontal(right, false);
  return true;
}

// ---- block elements -------------------------------------------------------

// Quadrants as [upper-left, upper-right, lower-left, lower-right] bits, U+2596-259F.
const QUADRANTS = [0b0010, 0b0001, 0b1000, 0b1011, 0b1001, 0b1110, 0b1101, 0b0100, 0b0110, 0b0111];

function block(ctx: Ctx, cp: number, b: Box): boolean {
  const { x0, y0, x1, y1 } = b;
  const fx = (f: number) => Math.round(x0 + (x1 - x0) * f);
  const fy = (f: number) => Math.round(y0 + (y1 - y0) * f);
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
    const mx = fx(1 / 2),
      my = fy(1 / 2);
    if (q & 0b1000) rect(x0, y0, mx, my);
    if (q & 0b0100) rect(mx, y0, x1, my);
    if (q & 0b0010) rect(x0, my, mx, y1);
    if (q & 0b0001) rect(mx, my, x1, y1);
    return true;
  }
  return false;
}

// ---- Braille and sextants ---------------------------------------------------

function braille(ctx: Ctx, cp: number, b: Box): boolean {
  const bits = cp - 0x2800;
  if (!bits) return true;
  const { x0, y0, x1, y1 } = b;
  const w = x1 - x0;
  const h = y1 - y0;
  // Dot n (1-8) -> [column, row].
  const DOTS: [number, number][] = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
    [0, 3],
    [1, 3],
  ];
  const size = Math.max(1, Math.round(Math.min(w / 4, h / 8)));
  for (let i = 0; i < 8; i++) {
    if (!(bits & (1 << i))) continue;
    const [c, r] = DOTS[i];
    const x = Math.round(x0 + (w * (c * 2 + 1)) / 4 - size / 2);
    const y = Math.round(y0 + (h * (r * 2 + 1)) / 8 - size / 2);
    ctx.fillRect(x, y, size, size);
  }
  return true;
}

function sextant(ctx: Ctx, cp: number, b: Box): boolean {
  // U+1FB00 + i is the i-th pattern 1..62, skipping 21 and 42 (the left and
  // right half blocks, which already exist as U+258C and U+2590).
  let pattern = cp - 0x1fb00 + 1;
  if (pattern >= 21) pattern++;
  if (pattern >= 42) pattern++;
  const { x0, y0, x1, y1 } = b;
  const xs = [x0, Math.round((x0 + x1) / 2), x1];
  const ys = [y0, Math.round(y0 + (y1 - y0) / 3), Math.round(y0 + ((y1 - y0) * 2) / 3), y1];
  for (let i = 0; i < 6; i++) {
    if (!(pattern & (1 << i))) continue;
    const c = i % 2;
    const r = (i / 2) | 0;
    ctx.fillRect(xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]);
  }
  return true;
}

// ---- Powerline ------------------------------------------------------------

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
  ctx.lineWidth = lightWidth(b);
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();
}

/** Half ellipse with its flat side on one edge, bulging towards the other. */
function halfCircle(ctx: Ctx, b: Box, bulgeRight: boolean, thin: boolean): void {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const cx = bulgeRight ? b.x0 : b.x1;
  const cy = (b.y0 + b.y1) / 2;
  const [start, end] = bulgeRight ? [-Math.PI / 2, Math.PI / 2] : [Math.PI / 2, (3 * Math.PI) / 2];
  if (!thin) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, w, h / 2, 0, start, end);
    ctx.closePath();
    ctx.fill();
    return;
  }
  const lw = lightWidth(b);
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(w - lw / 2, 0), Math.max(h / 2 - lw / 2, 0), 0, start, end);
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
