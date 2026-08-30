import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 生成扩展的两个图标，**几何形状只定义一次**。
 *
 *   media/icon.svg —— 活动栏视图容器用。必须是单色 + currentColor，
 *                     VS Code 会按主题和选中态给它上色，写死颜色在浅色主题下会看不见。
 *   media/icon.png —— Marketplace 用。必须是位图（商店不接受 SVG），透明底、固定蓝。
 *
 * 为什么要用脚本：这两个文件是同一个形状的两种表达。手写两份的话，改了几何必然
 * 只改得动一处，而且要装进编辑器、发上商店才看得出来对不上。现在它们都从下面
 * 那份 SHAPE 生成，想改造型只有一个地方可改。
 *
 * 颜色也同源：直接写 oklch，与 src/styles/tokens.css 是同一组值，
 * 调色板改了重跑一次即可，不必回去猜「当初用的哪个蓝」。
 *
 * 用法：node scripts/make-icon.mjs
 *
 * 想检查小尺寸下还认不认得出来（商店列表里会缩到 32–48px），可以只出 PNG：
 *   ICON_SIZE=48 ICON_OUT=/tmp/check.png node scripts/make-icon.mjs
 */

// 规范要求至少 128×128；给 2 倍是为了高分屏下不糊
const SIZE = Number(process.env.ICON_SIZE ?? 256);
const SS = 4; // 超采样倍数，用来做抗锯齿

/** 线宽。SVG 里写成 stroke-width，光栅化时是「离路径 STROKE/2 以内就是墨」。 */
const STROKE_WIDTH = 1.6;
const HALF_STROKE = STROKE_WIDTH / 2;

/* ---------------- oklch → sRGB（Björn Ottosson） ---------------- */

function oklch(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return linear.map((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  });
}

/**
 * 颜色。
 *
 * 去掉背景板之后，同一张图既要压在 Marketplace 网页的白底上，也要压在 VS Code
 * 扩展侧栏的深底上。深色主题那支 --blue（L 0.7）在白底上会发虚，浅色主题那支
 * （L 0.55）在深底上又偏闷 —— 取两者中间的 L 0.62，两边都立得住。
 */
const BLUE = oklch(0.62, 0.16, 250);

/* ---------------- 造型：唯一定义，SVG 与 PNG 都从这里生成 ---------------- */

/**
 * 插头，画在 24×24 的坐标系里。
 *
 * 本体的下半圆特意拆成两段 90° 弧：单独一段 180° 弧在 SVG 里 large-arc-flag
 * 取 0 还是 1 是有歧义的，拆开就没有这个问题。
 */
const SHAPE = {
  /** 两根端子。 */
  prongs: [
    [
      [9, 3],
      [9, 8],
    ],
    [
      [15, 3],
      [15, 8],
    ],
  ],
  /** 本体：顶边 → 右短竖 → 下半圆 → 左短竖，闭合。 */
  body: {
    top: [
      [6, 8],
      [18, 8],
    ],
    right: [
      [18, 8],
      [18, 11],
    ],
    left: [
      [6, 11],
      [6, 8],
    ],
    arc: { center: [12, 11], radius: 6 },
  },
  /** 线缆。 */
  cable: [
    [12, 17],
    [12, 21],
  ],
};

/**
 * 点到线段的**无符号**距离。
 *
 * 描边只需要无符号距离：离路径近于半个线宽就是墨，不必判断内外。
 * 这一点很关键 —— 本体是「矩形 ∪ 半圆」，把两者的有符号距离场 min 起来，
 * 在接缝（y=11 那条线）上会得到 0，图上于是凭空多出一道横线。
 * 照着路径本身量距离就没有这个问题。
 */
const segment = (x, y, ax, ay, bx, by) => {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t);
};

/**
 * 点到「下半圆弧」的无符号距离：圆心 (cx,cy)、半径 r，只取 y≥cy 的半圈。
 * 落在这半圈的角度范围内就是 |到圆心的距离 - r|，否则退化成到两个端点的距离。
 */
const lowerArc = (x, y, cx, cy, r) => {
  if (y >= cy) return Math.abs(Math.hypot(x - cx, y - cy) - r);
  return Math.min(Math.hypot(x - (cx - r), y - cy), Math.hypot(x - (cx + r), y - cy));
};

/**
 * 描边覆盖判定。
 *
 * 端子末端 y=8 正好落在本体顶边上、线缆起点 (12,17) 正好落在弧的最低点，
 * 圆头描边一叠就是无缝接合 —— 与浏览器渲染同一份路径的结果一致。
 */
function plugStroke(x, y) {
  const line = ([[ax, ay], [bx, by]]) => segment(x, y, ax, ay, bx, by);
  const { top, right, left, arc } = SHAPE.body;
  const [cx, cy] = arc.center;

  return (
    Math.min(
      line(top),
      line(right),
      line(left),
      lowerArc(x, y, cx, cy, arc.radius),
      ...SHAPE.prongs.map(line),
      line(SHAPE.cable),
    ) - HALF_STROKE
  );
}

/** 把同一份造型写成 SVG 的 path。 */
function svgPaths() {
  const { top, right, arc } = SHAPE.body;
  const [cx, cy] = arc.center;
  const r = arc.radius;
  const vline = ([[ax, ay], [, by]]) => `M${ax} ${ay}V${by}`;

  return [
    ...SHAPE.prongs.map(vline),
    // 顶边 → 右短竖 → 两段弧绕到左边 → 闭合
    `M${top[0][0]} ${top[0][1]}H${top[1][0]}V${right[1][1]}` +
      `A${r} ${r} 0 0 1 ${cx} ${cy + r}` +
      `A${r} ${r} 0 0 1 ${cx - r} ${cy}Z`,
    vline(SHAPE.cable),
  ];
}

/* ---------------- 渲染 ---------------- */

// 描边后的包围盒：本体最宽处是那段弧（x 6→18），端子顶到 y=3、线缆到 y=21，各再外扩 STROKE
const BOX = {
  x0: 6 - HALF_STROKE,
  x1: 18 + HALF_STROKE,
  y0: 3 - HALF_STROKE,
  y1: 21 + HALF_STROKE,
};
// 图形占画布的比例，按长边（这里是高）算。没有背景板兜着，图形就是图标本身，
// 留白该由使用它的地方去加，所以这里给得满。
const CONTENT = 0.9;

const scale = (SIZE * CONTENT) / Math.max(BOX.x1 - BOX.x0, BOX.y1 - BOX.y0);
const offsetX = SIZE / 2 - ((BOX.x0 + BOX.x1) / 2) * scale;
const offsetY = SIZE / 2 - ((BOX.y0 + BOX.y1) / 2) * scale;

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let py = 0; py < SIZE; py += 1) {
  for (let px = 0; px < SIZE; px += 1) {
    let covered = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const x = (px + (sx + 0.5) / SS - offsetX) / scale;
        const y = (py + (sy + 0.5) / SS - offsetY) / scale;
        if (plugStroke(x, y) < 0) covered += 1;
      }
    }

    // 直通 alpha（非预乘）：颜色恒定，只有覆盖率随边缘变化
    const offset = (py * SIZE + px) * 4;
    pixels[offset] = BLUE[0];
    pixels[offset + 1] = BLUE[1];
    pixels[offset + 2] = BLUE[2];
    pixels[offset + 3] = Math.round((covered / (SS * SS)) * 255);
  }
}

/* ---------------- 最小 PNG 编码器 ---------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // 颜色类型 6 = RGBA
// 10..12 = 压缩 / 滤波 / 隔行，全部为 0

// 每条扫描线前面要加一个滤波类型字节，这里一律用 0（不滤波）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const media = resolve(dirname(fileURLToPath(import.meta.url)), '../media');
const pngOut = process.env.ICON_OUT ?? resolve(media, 'icon.png');
writeFileSync(pngOut, png);
console.log(`已生成 ${pngOut}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`);

// 指定了 ICON_OUT 说明是在做小尺寸检查，只出 PNG，别去覆盖仓库里的 SVG
if (process.env.ICON_OUT === undefined) {
  /*
   * 活动栏图标。
   *
   * 必须是 currentColor：VS Code 按主题和选中态给它上色，写死颜色在浅色主题下
   * 会看不见。也正因为它是单色描边，这里不能像 PNG 那样带上品牌蓝。
   */
  const svg = `<!--
  活动栏图标 —— 由 scripts/make-icon.mjs 生成，别手改（造型定义在那个脚本的 SHAPE 里）。
  单色 + currentColor 是硬性要求：VS Code 会按主题给它上色，写死颜色在浅色主题下会看不见。
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">
${svgPaths()
  .map((d) => `  <path d="${d}" />`)
  .join('\n')}
</svg>
`;
  const svgOut = resolve(media, 'icon.svg');
  writeFileSync(svgOut, svg);
  console.log(`已生成 ${svgOut}`);
}
