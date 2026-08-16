import { isIos } from "./platform";
import { renewalPlan, type Settings } from "./store";

// チェックリスト画像の生成
// 画面のDOM(期間パネル + タイムライン)を読み取り、Canvasに描き直してPNGとして保存する。
// html2canvas等の外部ライブラリは使わず、同一オリジンの画像(cloud.png)のみ利用するためcanvasは汚染されない。

const FONT_FAMILY = '"Zen Maru Gothic", system-ui, sans-serif';
const SCALE = 2;
const WIDTH = 720;
const PAD = 32;
const TIMELINE_X = PAD + 25; // 縦線の中心
const CONTENT_X = PAD + 56; // 本文の左端
const BOX = 16; // チェックボックスの一辺
const BOX_GAP = 12;
const TEXT_X = CONTENT_X + BOX + BOX_GAP;
const TEXT_MAX = WIDTH - PAD - TEXT_X;

const COLOR = {
  primary: "#83caf3",
  accent: "#ff6f00",
  text: "#1a1a1a",
  white: "#fff",
  checked: "#5397bf",
  disabled: "#dad5d5",
} as const;

const font = (weight: number, size: number) =>
  `${weight} ${size}px ${FONT_FAMILY}`;

type Run = { text: string; font: string; color: string };

type BodyItem =
  | { kind: "h2"; text: string }
  | { kind: "note"; text: string }
  | {
      kind: "check";
      lines: string[];
      checked: boolean;
      disabled: boolean;
    };

type Block =
  | { kind: "year"; text: string }
  | { kind: "step"; month: string; body: BodyItem[] };

type Item =
  | {
      t: "text";
      x: number;
      y: number;
      text: string;
      font: string;
      color: string;
    }
  | { t: "runs"; cx: number; baseline: number; runs: Run[] }
  | { t: "pill"; x: number; y: number; text: string }
  | { t: "circle"; cx: number; cy: number; month: string }
  | {
      t: "check";
      x: number;
      y: number;
      checked: boolean;
      disabled: boolean;
    }
  | { t: "line"; y1: number; y2: number }
  | { t: "cloud"; x: number; y: number; w: number; h: number };

/** span内の<br>を改行として取り出す */
function spanLines(span: Element): string[] {
  return span.innerHTML
    .split(/<br\b[^>]*>/i)
    .map((s) =>
      s
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

/** タイムラインのDOMから描画に必要な情報を読み取る */
function readBlocks(timeline: HTMLElement): Block[] {
  const blocks: Block[] = [];

  for (const el of Array.from(timeline.children)) {
    if (el.classList.contains("year-pill")) {
      const text = el.textContent?.trim();
      if (text) blocks.push({ kind: "year", text });
      continue;
    }
    if (!el.classList.contains("step")) continue;

    const month = el.querySelector(".marker .num")?.textContent?.trim() ?? "";
    const stepBody = el.querySelector(".step-body");
    if (!stepBody) continue;

    const body: BodyItem[] = [];
    for (const child of Array.from(stepBody.children)) {
      if (child.tagName === "H2") {
        body.push({ kind: "h2", text: child.textContent?.trim() ?? "" });
        continue;
      }
      if (child.tagName === "P") {
        body.push({ kind: "note", text: child.textContent?.trim() ?? "" });
        continue;
      }
      // label.check 単体か、.check-row(label + ？ボタン)のどちらか
      const label = child.matches("label.check")
        ? child
        : child.querySelector("label.check");
      const input = label?.querySelector("input");
      const span = label?.querySelector("span");
      if (!label || !input || !span) continue;

      body.push({
        kind: "check",
        lines: spanLines(span),
        checked: input.checked,
        disabled: input.disabled,
      });
    }
    blocks.push({ kind: "step", month, body });
  }

  return blocks;
}

/** 日本語は単語境界がないため1文字ずつ折り返す */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text];

  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    if (line && ctx.measureText(line + char).width > maxWidth) {
      lines.push(line);
      line = char;
    } else {
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 描画に使う全テキスト(Google Fontsはunicode-rangeで分割されるため実テキストを渡して読み込ませる) */
function collectText(blocks: Block[], header: string[]): string {
  const parts = [...header];
  for (const block of blocks) {
    if (block.kind === "year") {
      parts.push(block.text);
      continue;
    }
    parts.push(block.month);
    for (const item of block.body) {
      parts.push(item.kind === "check" ? item.lines.join("") : item.text);
    }
  }
  return parts.join("");
}

async function ensureFonts(text: string): Promise<void> {
  if (!document.fonts) return;
  try {
    await Promise.all(
      [500, 700, 900].map((weight) =>
        document.fonts.load(font(weight, 20), text),
      ),
    );
    await document.fonts.ready;
  } catch {
    // フォント読み込みに失敗してもフォールバックフォントで描画する
  }
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function runsWidth(ctx: CanvasRenderingContext2D, runs: Run[]): number {
  return runs.reduce((width, run) => {
    ctx.font = run.font;
    return width + ctx.measureText(run.text).width;
  }, 0);
}

/** 期間(雲)とチェックリストのレイアウトを計算する */
function layout(
  ctx: CanvasRenderingContext2D,
  blocks: Block[],
  header: { title: string; expiry: string; period: [Run[], Run[]] },
  cloud: HTMLImageElement | null,
): { items: Item[]; height: number } {
  const items: Item[] = [];
  let y = PAD;

  items.push({
    t: "text",
    x: PAD,
    y,
    text: header.title,
    font: font(900, 22),
    color: COLOR.white,
  });
  y += 32;

  items.push({
    t: "text",
    x: PAD,
    y,
    text: header.expiry,
    font: font(700, 18),
    color: COLOR.text,
  });
  y += 34;

  // 雲(次回の更新期間)
  const cloudW = 364;
  const cloudH = Math.round((cloudW * 497) / 760);
  const cloudX = Math.round((WIDTH - cloudW) / 2);
  if (cloud) items.push({ t: "cloud", x: cloudX, y, w: cloudW, h: cloudH });

  const cloudCx = cloudX + cloudW / 2;
  const titleSize = 21;
  const periodLineH = 44;
  const blockH = titleSize + 6 + periodLineH * 2;
  let cloudTextY = y + (cloudH - blockH) / 2;
  items.push({
    t: "runs",
    cx: cloudCx,
    baseline: cloudTextY + titleSize,
    runs: [
      {
        text: "次回の更新期間は",
        font: font(900, titleSize),
        color: COLOR.text,
      },
    ],
  });
  cloudTextY += titleSize + 6;
  for (const runs of header.period) {
    items.push({ t: "runs", cx: cloudCx, baseline: cloudTextY + 32, runs });
    cloudTextY += periodLineH;
  }
  y += cloudH + 20;

  // タイムライン
  const lineTop = y + 10;
  let lineBottom = lineTop;

  for (const block of blocks) {
    if (block.kind === "year") {
      items.push({ t: "pill", x: PAD, y, text: block.text });
      y += 22 + 12;
      continue;
    }

    const stepTop = y;
    items.push({
      t: "circle",
      cx: TIMELINE_X,
      cy: stepTop + 20,
      month: block.month,
    });

    block.body.forEach((item, index) => {
      if (item.kind === "h2") {
        if (index > 0) y += 24;
        items.push({
          t: "text",
          x: CONTENT_X,
          y,
          text: item.text,
          font: font(900, 20),
          color: COLOR.text,
        });
        y += 28 + 12;
        return;
      }
      if (item.kind === "note") {
        items.push({
          t: "text",
          x: CONTENT_X,
          y,
          text: item.text,
          font: font(500, 16),
          color: COLOR.text,
        });
        y += 24;
        return;
      }

      items.push({
        t: "check",
        x: CONTENT_X,
        y: y + 5,
        checked: item.checked,
        disabled: item.disabled,
      });

      ctx.font = font(700, 20);
      const color = item.checked || item.disabled ? COLOR.checked : COLOR.text;
      const lines = item.lines.flatMap((line) => wrapText(ctx, line, TEXT_MAX));
      for (const line of lines) {
        items.push({
          t: "text",
          x: TEXT_X,
          y,
          text: line,
          font: font(700, 20),
          color,
        });
        y += 26;
      }
      y += 14;
    });

    lineBottom = y - 20;
    y = y + 40;
  }

  items.unshift({ t: "line", y1: lineTop, y2: lineBottom });

  // フッター
  const footerY = y - 12;
  items.push({
    t: "text",
    x: PAD,
    y: footerY,
    text: "精神障害者手帳 更新リマインダー",
    font: font(700, 13),
    color: COLOR.white,
  });

  return { items, height: footerY + 20 + PAD };
}

function draw(
  ctx: CanvasRenderingContext2D,
  items: Item[],
  height: number,
  cloud: HTMLImageElement | null,
): void {
  ctx.fillStyle = COLOR.primary;
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.textBaseline = "top";

  for (const item of items) {
    switch (item.t) {
      case "line": {
        ctx.fillStyle = COLOR.white;
        roundedRect(ctx, TIMELINE_X - 2, item.y1, 4, item.y2 - item.y1, 2);
        ctx.fill();
        break;
      }
      case "cloud": {
        if (cloud) ctx.drawImage(cloud, item.x, item.y, item.w, item.h);
        break;
      }
      case "text": {
        ctx.font = item.font;
        ctx.fillStyle = item.color;
        ctx.textAlign = "left";
        ctx.fillText(item.text, item.x, item.y);
        break;
      }
      case "runs": {
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        let x = item.cx - runsWidth(ctx, item.runs) / 2;
        for (const run of item.runs) {
          ctx.font = run.font;
          ctx.fillStyle = run.color;
          ctx.fillText(run.text, x, item.baseline);
          x += ctx.measureText(run.text).width;
        }
        ctx.textBaseline = "top";
        break;
      }
      case "pill": {
        ctx.font = font(900, 14);
        // textBaseline:"top"の基準位置はiOS Safariとその他で異なり、年のテキストが下寄りになる。
        // 字形の実測値(ink box)で中央に揃えることでブラウザ差をなくす。
        // measureTextのactualBoundingBoxは現在のtextBaselineが基準なので、計測前に切り替える。
        ctx.textBaseline = "alphabetic";
        const m = ctx.measureText(item.text);
        const w = m.width + 20;
        const h = 22;
        ctx.fillStyle = COLOR.white;
        roundedRect(ctx, item.x, item.y, w, h, 10);
        ctx.fill();
        ctx.fillStyle = COLOR.primary;
        ctx.textAlign = "left";
        const ascent = m.actualBoundingBoxAscent || 10;
        const descent = m.actualBoundingBoxDescent || 0;
        ctx.fillText(item.text, item.x + 10, item.y + (h + ascent - descent) / 2);
        ctx.textBaseline = "top";
        break;
      }
      case "circle": {
        ctx.fillStyle = COLOR.white;
        ctx.beginPath();
        ctx.arc(item.cx, item.cy, 25, 0, Math.PI * 2);
        ctx.fill();

        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        const runs: Run[] = [
          { text: item.month, font: font(900, 22), color: COLOR.text },
          { text: "月", font: font(900, 12), color: COLOR.text },
        ];
        let x = item.cx - runsWidth(ctx, runs) / 2;
        for (const run of runs) {
          ctx.font = run.font;
          ctx.fillStyle = run.color;
          ctx.fillText(run.text, x, item.cy + 8);
          x += ctx.measureText(run.text).width;
        }
        ctx.textBaseline = "top";
        break;
      }
      case "check": {
        ctx.fillStyle = item.disabled ? COLOR.disabled : COLOR.white;
        ctx.fillRect(item.x, item.y, BOX, BOX);
        if (!item.checked) break;
        ctx.strokeStyle = COLOR.accent;
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(item.x + 3, item.y + 8);
        ctx.lineTo(item.x + 7, item.y + 12);
        ctx.lineTo(item.x + 13, item.y + 4);
        ctx.stroke();
        break;
      }
    }
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      blob ? resolve(blob) : reject(new Error("画像の生成に失敗しました"));
    }, "image/png");
  });
}

async function save(blob: Blob, fileName: string): Promise<void> {
  // iOSはダウンロードよりも共有シート経由の方が写真アプリに保存しやすい
  const file = new File([blob], fileName, { type: "image/png" });
  if (isIos() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      // キャンセル時はダウンロードにフォールバックしない
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 期間とチェックリストをPNG画像として保存する */
export async function downloadChecklistImage(
  timeline: HTMLElement,
  settings: Settings,
): Promise<void> {
  const plan = renewalPlan(settings);
  const blocks = readBlocks(timeline);

  const periodRun = (
    ym: { year: number; month: number },
    suffix: string,
  ): Run[] => [
    { text: String(ym.year), font: font(900, 38), color: COLOR.accent },
    { text: "年", font: font(900, 21), color: COLOR.accent },
    { text: String(ym.month), font: font(900, 38), color: COLOR.accent },
    { text: "月", font: font(900, 21), color: COLOR.accent },
    { text: suffix, font: font(900, 21), color: COLOR.text },
  ];
  const header = {
    title: "更新チェックリスト",
    expiry: `現在の有効期限：${settings.expiryYear}年${settings.expiryMonth}月`,
    period: [periodRun(plan.start, "から"), periodRun(plan.end, "まで")] as [
      Run[],
      Run[],
    ],
  };

  const [cloud] = await Promise.all([
    loadImage("/images/cloud.png"),
    ensureFonts(
      collectText(blocks, [
        header.title,
        header.expiry,
        "次回の更新期間はからまで年月精神障害者手帳 更新リマインダー",
      ]),
    ),
  ]);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasを利用できません");

  const { items, height } = layout(ctx, blocks, header, cloud);

  canvas.width = WIDTH * SCALE;
  canvas.height = height * SCALE;
  ctx.scale(SCALE, SCALE);
  draw(ctx, items, height, cloud);

  const blob = await canvasToBlob(canvas);
  const month = String(settings.expiryMonth).padStart(2, "0");
  await save(blob, `renewal-checklist-${settings.expiryYear}-${month}.png`);
}
