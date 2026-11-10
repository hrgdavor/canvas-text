// src/metrics.js
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(w, h);
  }
  let c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function fontString(spec, dpr, bold = false, italic = false) {
  let style = italic ? "italic " : "";
  let weight = bold ? "bold " : "";
  return `${style}${weight}${Math.round(spec.size * dpr)}px ${spec.family}`;
}
function measureFont(spec, dpr) {
  let canvas = makeCanvas(1, 1);
  let cx = canvas.getContext("2d");
  cx.font = fontString(spec, dpr);
  let m = cx.measureText("M");
  let advanceDev = Math.round(m.width);
  let cellWidthDev = advanceDev;
  let lineHeightDev = Math.round(spec.size * dpr * 1.2);
  let baselineDev = Math.round(spec.size * dpr * 0.8);
  return {
    spec,
    dpr,
    cellWidthDev,
    lineHeightDev,
    baselineDev,
    advanceDev,
    cellWidth: cellWidthDev / dpr,
    lineHeight: lineHeightDev / dpr
  };
}

// src/atlas.js
var rtlText = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
var rtlBoundsMirrored = undefined;
var EMPTY_GLYPH = { u: 0, v: 0, w: 0, h: 0, ox: 0, oy: 0, cells: 1, colored: false };
function fontVariant(bold, italic) {
  return (bold ? 1 : 0) | (italic ? 2 : 0);
}
var colorGlyph = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\ufe0f/u;
var LIGATURE_CHARS = new Uint8Array(128);
for (let ch of "!#$%&()*+-./:;<=>?@[\\]^_{|}~")
  LIGATURE_CHARS[ch.charCodeAt(0)] = 1;
var LIGATURE_PROBE = "=> -> != == <= >= && || // :: ++ |> <!--";
var PROBE = -1;
var shapes = new Map;

class GlyphAtlas {
  constructor(metrics, maxTextureSize = 4096, maskColor = "#fff") {
    this.metrics = metrics;
    this.maxSize = Math.min(4096, maxTextureSize);
    this.size = Math.min(1024, this.maxSize);
    this.maskColor = maskColor;
    this.canvas = makeCanvas(this.size, this.size);
    this.cx = this.canvas.getContext("2d");
    this.cx.textBaseline = "alphabetic";
    this.ascii = [[], [], [], []];
    this.other = [new Map, new Map, new Map, new Map];
    this.cellCache = new Map;
    this.ligs = [new Map, new Map, new Map, new Map];
    this.ligFont = [];
    this.ligaturesWanted = 0;
    this.ligatureVersion = 0;
    this.shapes = [];
    this.ligCanvas = null;
    this.ligCx = null;
    this.ligatures = false;
    this.padY = Math.ceil(metrics.lineHeightDev * 0.2);
    this.slotH = Math.ceil(metrics.lineHeightDev) + this.padY * 2;
    this.penX = 0;
    this.penY = 0;
    this.dirty = null;
    this.generation = 0;
    this.sizeVersion = 0;
    this.uploadedTexels = 0;
  }
  cellsOf(g) {
    let code = g.charCodeAt(0);
    if (g.length == 1 && code < 768)
      return 1;
    let cached = this.cellCache.get(g);
    if (cached != null)
      return cached;
    let cells = this.measureCells(g);
    this.cellCache.set(g, cells);
    return cells;
  }
  measureCells(text) {
    this.cx.font = fontString(this.metrics.spec, this.metrics.dpr);
    let ratio = this.cx.measureText(text).width / this.metrics.advanceDev;
    let whole = Math.round(ratio);
    return whole > 0 && Math.abs(ratio - whole) < 0.02 * whole ? whole : Math.max(0.25, ratio);
  }
  asciiGlyph(variant, code) {
    let table = this.ascii[variant];
    return table[code] ?? (table[code] = this.rasterize(variant, String.fromCharCode(code), 1));
  }
  glyph(variant, g) {
    if (g.length == 1) {
      let code = g.charCodeAt(0);
      if (code < 128)
        return this.asciiGlyph(variant, code);
    }
    let map = this.other[variant];
    let found = map.get(g);
    if (!found)
      map.set(g, found = this.rasterize(variant, g, this.cellsOf(g)));
    return found;
  }
  shape(key, w, h, draw, colored = false) {
    let map = this.other[0], fullKey = "\x02" + key;
    let found = map.get(fullKey);
    if (found)
      return found;
    w = Math.min(this.maxSize, Math.ceil(w));
    h = Math.ceil(h);
    while ((w > this.size || h > this.size) && this.size < this.maxSize)
      this.grow();
    if (this.penX + w > this.size) {
      this.penX = 0;
      this.penY += this.slotH;
    }
    let rowH = Math.max(this.slotH, h);
    if (this.penY + rowH > this.size) {
      if (this.size < this.maxSize)
        this.grow();
      else
        this.clear();
      return this.shape(key, w, h, draw, colored);
    }
    let x = this.penX, y = this.penY;
    this.penX += w;
    if (rowH > this.slotH) {
      this.penX = 0;
      this.penY += rowH;
    }
    let cx = this.cx;
    cx.save();
    cx.beginPath();
    cx.rect(x, y, w, h);
    cx.clip();
    cx.translate(x, y);
    cx.fillStyle = cx.strokeStyle = this.maskColor;
    try {
      draw(cx);
    } finally {
      cx.restore();
    }
    this.markDirty(x, y, x + w, y + h);
    found = { u: x, v: y, w, h, ox: 0, oy: 0, cells: 0, colored };
    map.set(fullKey, found);
    return found;
  }
  prewarm(variants, deadline) {
    for (let v of variants) {
      let table = this.ascii[v];
      for (let code = 33;code < 127; code++) {
        if (table[code])
          continue;
        if (performance.now() > deadline)
          return false;
        table[code] = this.rasterize(v, String.fromCharCode(code), 1);
      }
    }
    return true;
  }
  shapedCells(text) {
    return this.measureCells(text);
  }
  shapedGlyph(variant, text, cells) {
    let map = this.other[variant], key = "\x01" + text;
    let found = map.get(key);
    if (!found) {
      if (variant & 2) {
        this.cx.font = fontString(this.metrics.spec, this.metrics.dpr, (variant & 1) > 0, true);
        let ratio = this.cx.measureText(text).width / (cells * this.metrics.advanceDev);
        if (Math.abs(ratio - 1) > 0.05)
          variant = variant & ~2;
      }
      map.set(key, found = this.rasterize(variant, text, cells));
    }
    return found;
  }
  ligature(variant, text, from, to) {
    if (!this.ligaturesOf(variant) || (to - from) * this.metrics.cellWidthDev > this.maxSize)
      return null;
    let key;
    if (to - from <= 8) {
      key = 0;
      for (let i = from;i < to; i++)
        key = key * 95 + text.charCodeAt(i) - 32;
    } else {
      key = text.slice(from, to);
    }
    let found = this.ligs[variant].get(key);
    if (found === undefined) {
      let run = typeof key == "string" ? key : text.slice(from, to), known = this.shapesOf(variant);
      let differs = known.get(key);
      if (differs == null)
        known.set(key, differs = this.shapesDifferently(variant, run));
      found = differs ? this.rasterizeRun(variant, run) : null;
      this.ligs[variant].set(key, found);
    }
    return found;
  }
  ligaturesOf(variant) {
    let has = this.ligFont[variant];
    if (has == null) {
      has = this.shapesOf(variant).get(PROBE);
      if (has == null) {
        this.ligaturesWanted |= 1 << variant;
        return false;
      }
      this.ligFont[variant] = has;
    }
    return has;
  }
  probeLigatures() {
    let found = false;
    for (let v = 0;v < 4; v++) {
      if (!(this.ligaturesWanted & 1 << v))
        continue;
      let variant = v;
      let known = this.shapesOf(variant), has = known.get(PROBE);
      if (has == null)
        known.set(PROBE, has = this.shapesDifferently(variant, LIGATURE_PROBE));
      this.ligFont[v] = has;
      if (has)
        found = true;
    }
    this.ligaturesWanted = 0;
    if (found)
      this.ligatureVersion++;
    return found;
  }
  shapesOf(variant) {
    let found = this.shapes[variant];
    if (!found) {
      let id = variant + this.metrics.spec.family;
      let shared = shapes.get(id);
      if (!shared)
        shapes.set(id, shared = new Map);
      found = this.shapes[variant] = shared;
    }
    return found;
  }
  static fontsChanged() {
    shapes.clear();
  }
  shapesDifferently(variant, text) {
    let m = this.metrics, size = Math.max(24, Math.round(m.spec.size * m.dpr));
    let w = Math.ceil(text.length * size * 0.75 + size * 2), h = Math.ceil(size * 1.6), base = Math.round(size * 1.2);
    let canvas = this.ligCanvas;
    if (!canvas || canvas.width < w || canvas.height < h * 2) {
      canvas = this.ligCanvas = makeCanvas(Math.max(w, canvas?.width ?? 0), Math.max(h * 2, canvas?.height ?? 0));
      this.ligCx = canvas.getContext("2d", { willReadFrequently: true });
    }
    let cx = this.ligCx;
    if (!cx)
      return false;
    cx.font = fontString({ ...m.spec, size }, 1, (variant & 1) > 0, (variant & 2) > 0);
    cx.fillStyle = "#000";
    cx.textBaseline = "alphabetic";
    w = Math.min(canvas.width, Math.ceil(cx.measureText(text).width) + size * 2);
    cx.clearRect(0, 0, w, h * 2);
    cx.fillText(text, size, base);
    for (let i = 0, x = size;i < text.length; i++) {
      let ch = text[i];
      if (ch != " ")
        cx.fillText(ch, x, h + base);
      x += cx.measureText(ch).width;
    }
    let data = cx.getImageData(0, 0, w, h * 2).data, half = w * h * 4, changed = 0;
    for (let i = 3;i < half; i += 4)
      if (Math.abs(data[i] - data[i + half]) > 64 && ++changed > 2)
        return true;
    return false;
  }
  rasterizeRun(variant, text) {
    let m = this.metrics, n = text.length;
    this.cx.font = fontString(m.spec, m.dpr, (variant & 1) > 0, (variant & 2) > 0);
    let advance = this.cx.measureText(text).width / n;
    let shift = Math.round((n - 1) * (m.cellWidthDev - advance) / 2);
    let g = this.rasterize(variant, text, n);
    return shift ? { ...g, ox: g.ox + shift / m.dpr } : g;
  }
  rasterize(variant, g, cells) {
    if (g == " " || g == " ")
      return { ...EMPTY_GLYPH, cells };
    let m = this.metrics;
    let cx = this.cx;
    cx.font = fontString(m.spec, m.dpr, (variant & 1) > 0, (variant & 2) > 0);
    let ink = cx.measureText(g), { actualBoundingBoxLeft: inkLeft, actualBoundingBoxRight: inkRight } = ink;
    if (rtlText.test(g)) {
      if (rtlBoundsMirrored === undefined) {
        let alef = cx.measureText("א");
        rtlBoundsMirrored = alef.actualBoundingBoxRight < alef.actualBoundingBoxLeft;
      }
      if (rtlBoundsMirrored) {
        inkLeft -= ink.width;
        inkRight += ink.width;
      }
    }
    let left = Math.floor(-inkLeft) - 1;
    let right = Math.ceil(inkRight) + 1;
    if (!(right > left + 2))
      return { ...EMPTY_GLYPH, cells };
    let w = Math.min(this.maxSize, right - left), h = this.slotH;
    while (w > this.size && this.size < this.maxSize)
      this.grow();
    if (this.penX + w > this.size) {
      this.penX = 0;
      this.penY += h;
    }
    if (this.penY + h > this.size) {
      if (this.size < this.maxSize)
        this.grow();
      else
        this.clear();
      return this.rasterize(variant, g, cells);
    }
    let x = this.penX, y = this.penY;
    this.penX += w;
    cx.fillStyle = this.maskColor;
    cx.save();
    cx.beginPath();
    cx.rect(x, y, w, h);
    cx.clip();
    cx.fillText(g, x - left, y + this.padY + m.baselineDev);
    cx.restore();
    this.markDirty(x, y, x + w, y + h);
    return { u: x, v: y, w, h, ox: left / m.dpr, oy: -this.padY / m.dpr, cells, colored: colorGlyph.test(g) };
  }
  markDirty(x0, y0, x1, y1) {
    let d = this.dirty;
    if (!d) {
      this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else {
      let nx = Math.min(d.x, x0), ny = Math.min(d.y, y0);
      d.w = Math.max(d.x + d.w, x1) - nx;
      d.h = Math.max(d.y + d.h, y1) - ny;
      d.x = nx;
      d.y = ny;
    }
  }
  grow() {
    let old = this.canvas;
    this.size *= 2;
    this.canvas = makeCanvas(this.size, this.size);
    this.cx = this.canvas.getContext("2d");
    this.cx.textBaseline = "alphabetic";
    this.cx.drawImage(old, 0, 0);
    this.sizeVersion++;
  }
  clear() {
    this.cx.clearRect(0, 0, this.size, this.size);
    this.penX = this.penY = 0;
    for (let i = 0;i < this.ascii.length; i++) {
      this.ascii[i] = [];
      this.other[i] = new Map;
      this.ligs[i] = new Map;
    }
    this.ligFont = [];
    this.shapes = [];
    this.ligaturesWanted = 0;
    this.generation++;
    this.dirty = null;
  }
  get source() {
    return this.canvas;
  }
  get usedHeight() {
    return Math.min(this.size, this.penY + this.slotH);
  }
  markAllDirty() {
    if (this.penY || this.penX)
      this.markDirty(0, 0, this.size, this.usedHeight);
  }
  takeDirty() {
    let d = this.dirty;
    if (!d)
      return null;
    this.dirty = null;
    d.w = Math.min(d.w, this.size - d.x);
    d.h = Math.min(d.h, this.size - d.y);
    this.uploadedTexels += d.w * d.h;
    return d;
  }
  readPremultiplied(r) {
    let img = this.cx.getImageData(r.x, r.y, r.w, r.h);
    let data = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    for (let i = 0;i < data.length; i += 4) {
      let a = data[i + 3];
      if (a == 0) {
        data[i] = data[i + 1] = data[i + 2] = 0;
      } else if (a < 255) {
        data[i] = (data[i] * a + 127) / 255;
        data[i + 1] = (data[i + 1] * a + 127) / 255;
        data[i + 2] = (data[i + 2] * a + 127) / 255;
      }
    }
    return data;
  }
}

// src/instances.js
class InstanceBuffer {
  constructor(stride, capacity = 1024) {
    this.stride = stride;
    this.buffer = new ArrayBuffer(capacity * stride * 4);
    this.f32 = new Float32Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
    this.u16 = new Uint16Array(this.buffer);
    this.count = 0;
    this.dirtyFrom = 0;
  }
  get capacity() {
    return this.f32.length / this.stride;
  }
  get byteLength() {
    return this.count * this.stride * 4;
  }
  reset() {
    this.count = 0;
    this.dirtyFrom = 0;
  }
  touch(index) {
    if (index < this.dirtyFrom)
      this.dirtyFrom = index;
  }
  markClean() {
    this.dirtyFrom = this.count;
  }
  alloc(n) {
    let need = this.count + n;
    if (need > this.capacity) {
      let cap = this.capacity;
      while (cap < need)
        cap *= 2;
      let next = new ArrayBuffer(cap * this.stride * 4);
      new Uint32Array(next).set(this.u32.subarray(0, this.count * this.stride));
      this.buffer = next;
      this.f32 = new Float32Array(next);
      this.u32 = new Uint32Array(next);
      this.u16 = new Uint16Array(next);
    }
    let at = this.count * this.stride;
    this.touch(this.count);
    this.count = need;
    return at;
  }
}
var GLYPH_STRIDE = 5;
var RECT_STRIDE = 5;
function pushRect(buf, x, y, w, h, color) {
  if (w <= 0 || h <= 0 || color >>> 24 == 0)
    return;
  let at = buf.alloc(1);
  let f = buf.f32;
  f[at] = x;
  f[at + 1] = y;
  f[at + 2] = w;
  f[at + 3] = h;
  buf.u32[at + 4] = color;
}
function pushGlyph(buf, x, y, g, color) {
  let at = buf.alloc(1);
  buf.f32[at] = x;
  buf.f32[at + 1] = y;
  let h = (at + 2) * 2;
  buf.u16[h] = g.u;
  buf.u16[h + 1] = g.v;
  buf.u16[h + 2] = g.w;
  buf.u16[h + 3] = g.h;
  buf.u32[at + 4] = g.colored ? 0 : color;
}

// src/color.js
function packRGBA(r, g, b, a = 255) {
  return (a << 24 | b << 16 | g << 8 | r) >>> 0;
}
function unpackRGBA(c) {
  return [c & 255, c >>> 8 & 255, c >>> 16 & 255, c >>> 24 & 255];
}
function parseColor(css) {
  if (css[0] === "#") {
    let h = css.slice(1);
    if (h.length === 3) {
      return packRGBA(parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16));
    }
    if (h.length === 6) {
      return packRGBA(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
    }
    if (h.length === 8) {
      return packRGBA(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16));
    }
  }
  let canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  let cx = canvas.getContext("2d");
  if (cx) {
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    let [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
    return packRGBA(r, g, b, a);
  }
  return packRGBA(255, 255, 255);
}
function colorToCSS(c) {
  let [r, g, b, a] = unpackRGBA(c);
  if (a === 255)
    return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${a / 255})`;
}

// src/ansi.js
var COLORS16 = [
  "#000000",
  "#cd3131",
  "#0b6e0b",
  "#b58900",
  "#3b71dd",
  "#b23ac7",
  "#35938c",
  "#e6e6e6",
  "#555555",
  "#ff5555",
  "#55ff55",
  "#ffff55",
  "#5555ff",
  "#ff55ff",
  "#55ffff",
  "#ffffff"
];
var COLORS256 = [];
for (let c of COLORS16)
  COLORS256.push(c);
for (let r = 0;r < 6; r++)
  for (let g = 0;g < 6; g++)
    for (let b = 0;b < 6; b++) {
      const v = (n) => n == 0 ? 0 : n == 1 ? 85 : 85 + (n - 2) * 51;
      COLORS256.push(`rgb(${v(r)},${v(g)},${v(b)})`);
    }
for (let i = 0;i < 24; i++) {
  let v = 8 + i * 10;
  COLORS256.push(`rgb(${v},${v},${v})`);
}
function parseAnsi(text, defaultStyle) {
  let state = {
    fg: null,
    bg: null,
    bold: defaultStyle?.bold ?? false,
    italic: defaultStyle?.italic ?? false,
    underline: defaultStyle?.underline ?? false,
    strike: defaultStyle?.strike ?? false,
    inverse: defaultStyle?.inverse ?? false
  };
  let runs = [];
  let current = "";
  let i = 0;
  const push = (text) => {
    if (text) {
      runs.push({
        text,
        style: {
          fg: state.fg ? parseColor(state.fg) : defaultStyle?.fg ?? packRGBA(200, 200, 200),
          bg: state.bg ? parseColor(state.bg) : defaultStyle?.bg ?? 0,
          bold: state.bold,
          italic: state.italic,
          underline: state.underline,
          strike: state.strike,
          inverse: state.inverse
        }
      });
    }
  };
  while (i < text.length) {
    let ch = text[i];
    if (ch === "\x1B") {
      if (i + 1 < text.length && text[i + 1] === "[") {
        let j = i + 2;
        let params = "";
        while (j < text.length && (text[j] >= "0" && text[j] <= "9" || text[j] === ";")) {
          params += text[j];
          j++;
        }
        if (j < text.length && text[j] === "m") {
          push(current);
          current = "";
          applySgr(params, state);
          i = j + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  push(current);
  return runs;
}
function applySgr(params, state) {
  let parts = params ? params.split(";") : ["0"];
  for (let p of parts) {
    let n = p === "" ? 0 : parseInt(p, 10);
    switch (n) {
      case 0:
        state.fg = null;
        state.bg = null;
        state.bold = state.italic = state.underline = state.strike = state.inverse = false;
        break;
      case 1:
        state.bold = true;
        break;
      case 3:
        state.italic = true;
        break;
      case 4:
        state.underline = true;
        break;
      case 5:
        state.strike = true;
        break;
      case 7:
        state.inverse = true;
        break;
      case 21:
        state.underline = true;
        break;
      case 22:
        state.bold = false;
        break;
      case 23:
        state.italic = false;
        break;
      case 24:
        state.underline = false;
        break;
      case 27:
        state.inverse = false;
        break;
      case 29:
        state.strike = false;
        break;
      case 30:
      case 31:
      case 32:
      case 33:
      case 34:
      case 35:
      case 36:
      case 37:
        state.fg = COLORS16[n - 30];
        break;
      case 39:
        state.fg = null;
        break;
      case 40:
      case 41:
      case 42:
      case 43:
      case 44:
      case 45:
      case 46:
      case 47:
        state.bg = COLORS16[n - 40];
        break;
      case 49:
        state.bg = null;
        break;
    }
  }
  if (parts.length >= 3 && (parts[0] === "38" || parts[0] === "48")) {
    let isFg = parts[0] === "38";
    if (parts[1] === "5" && parts.length >= 3) {
      let idx = parseInt(parts[2], 10);
      if (idx >= 0 && idx < 256) {
        let c = COLORS256[idx];
        if (isFg)
          state.fg = c;
        else
          state.bg = c;
      }
    } else if (parts[1] === "2" && parts.length >= 5) {
      let r = parseInt(parts[2], 10), g = parseInt(parts[3], 10), b = parseInt(parts[4], 10);
      let c = `rgb(${r},${g},${b})`;
      if (isFg)
        state.fg = c;
      else
        state.bg = c;
    }
  }
}
function parseAnsiResolved(text, defaultStyle) {
  return parseAnsi(text, defaultStyle);
}
function stripAnsi(text) {
  if (text.indexOf("\x1B") < 0)
    return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    let ch = text[i];
    if (ch === "\x1B") {
      if (i + 1 < text.length && text[i + 1] === "[") {
        let j = i + 2;
        while (j < text.length && (text[j] >= "0" && text[j] <= "9" || text[j] === ";"))
          j++;
        if (j < text.length && text[j] === "m") {
          i = j + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function expandTabs(text) {
  if (text.indexOf("\t") < 0)
    return text;
  let out = "";
  let col = 0;
  for (let ch of text) {
    if (ch === "\t") {
      let n = 8 - col % 8;
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// src/scene.js
class Scene {
  constructor(options) {
    this.atlas = options.atlas;
    this.metrics = options.metrics;
    this.glyphBuf = options.glyphBuf;
    this.rectBuf = options.rectBuf;
    this.background = options.background ?? 0;
    this.lines = [];
    this.plain = [];
    this.version = 0;
  }
  setText(text) {
    this.lines = text.split(`
`);
    this.plain = this.lines.map((line) => expandTabs(stripAnsi(line)).replace(/\r/g, ""));
    this.version++;
  }
  build(firstRow, lastRow, selection, selectionColor) {
    let m = this.metrics;
    let cellW = m.cellWidth;
    let lh = m.lineHeight;
    let buf = this.glyphBuf;
    let rbuf = this.rectBuf;
    buf.reset();
    rbuf.reset();
    if (selection) {
      let selColor = selectionColor ?? 3955340;
      for (let row = firstRow;row <= lastRow; row++) {
        if (row < selection.startLine || row > selection.endLine)
          continue;
        let line = this.plain[row];
        if (line == null)
          continue;
        let colStart = row === selection.startLine ? selection.startCol : 0;
        let colEnd = row === selection.endLine ? selection.endCol : line.length;
        colStart = Math.max(0, Math.min(colStart, line.length));
        colEnd = Math.max(0, Math.min(colEnd, line.length));
        if (colEnd <= colStart) {
          if (row === selection.endLine)
            continue;
          colStart = line.length;
          colEnd = line.length + 1;
        }
        let x = colStart * cellW;
        let w = (colEnd - colStart) * cellW;
        pushRect(rbuf, x, row * lh, w, lh, selColor);
      }
    }
    for (let row = firstRow;row <= lastRow; row++) {
      let line = this.lines[row];
      if (line == null)
        continue;
      let y = row * lh;
      let runs = parseAnsiResolved(line);
      let col = 0;
      for (let run of runs) {
        let style = run.style;
        let variant = fontVariant(style.bold, style.italic);
        let fg = typeof style.fg === "number" ? style.fg : 13421772;
        for (let i = 0;i < run.text.length; i++) {
          let ch = run.text[i];
          if (ch === "\t") {
            col = Math.ceil((col + 1) / 8) * 8;
            continue;
          }
          if (ch === "\r" || ch === `
`)
            continue;
          let x = col * cellW;
          let g = this.atlas.glyph(variant, ch);
          pushGlyph(buf, x, y, g, fg);
          if (style.underline) {
            pushRect(rbuf, x, y + lh - Math.max(1, lh * 0.12), cellW, 1, fg);
          }
          if (style.strike) {
            pushRect(rbuf, x, y + lh * 0.45, cellW, 1, fg);
          }
          col++;
        }
      }
    }
    return { glyphCount: buf.count, rectCount: rbuf.count };
  }
}

// src/spline.js
var INFLEXION = 0.35;
var START_TENSION = 0.5;
var END_TENSION = 1;
var P1 = START_TENSION * INFLEXION;
var P2 = 1 - END_TENSION * (1 - INFLEXION);
var SAMPLES = 100;
var DECELERATION_RATE = Math.log(0.78) / Math.log(0.9);
var GRAVITY_EARTH = 9.80665;
var INCHES_PER_METER = 39.37;
var SCROLL_FRICTION = 0.015;
var SPLINE_POSITION = new Float64Array(SAMPLES + 1);
(function build() {
  let xMin = 0;
  for (let i = 0;i < SAMPLES; i++) {
    let alpha = i / SAMPLES;
    let xMax = 1, x = 0, coef = 0;
    for (;; ) {
      x = xMin + (xMax - xMin) / 2;
      coef = 3 * x * (1 - x);
      let tx = coef * ((1 - x) * P1 + x * P2) + x * x * x;
      if (Math.abs(tx - alpha) < 0.00001)
        break;
      if (tx > alpha)
        xMax = x;
      else
        xMin = x;
    }
    SPLINE_POSITION[i] = coef * ((1 - x) * START_TENSION + x) + x * x * x;
  }
  SPLINE_POSITION[SAMPLES] = 1;
})();
function splinePosition(t) {
  if (t >= 1)
    return 1;
  if (t <= 0)
    return 0;
  let index = Math.floor(SAMPLES * t);
  let tInf = index / SAMPLES, tSup = (index + 1) / SAMPLES;
  let dInf = SPLINE_POSITION[index], dSup = SPLINE_POSITION[index + 1];
  return dInf + (t - tInf) * (dSup - dInf) / (tSup - tInf);
}
function splineVelocity(t) {
  if (t >= 1 || t < 0)
    return 0;
  let index = Math.floor(SAMPLES * t);
  return (SPLINE_POSITION[index + 1] - SPLINE_POSITION[index]) * SAMPLES;
}
function computeFling(velocity, dpr) {
  let physicalCoeff = GRAVITY_EARTH * INCHES_PER_METER * (160 * dpr) * 0.84;
  let v = Math.abs(velocity) * dpr;
  if (v < 1)
    return { distance: 0, duration: 0, velocity: 0 };
  let l = Math.log(INFLEXION * v / (SCROLL_FRICTION * physicalCoeff));
  let duration = 1000 * Math.exp(l / (DECELERATION_RATE - 1));
  let distance = SCROLL_FRICTION * physicalCoeff * Math.exp(DECELERATION_RATE / (DECELERATION_RATE - 1) * l);
  return { distance: Math.sign(velocity) * distance / dpr, duration, velocity };
}

class VelocityTracker {
  t = [];
  x = [];
  static horizon = 100;
  static maxSamples = 20;
  reset() {
    this.t.length = this.x.length = 0;
  }
  add(time, pos) {
    let n = this.t.length;
    if (n && time - this.t[n - 1] > 40)
      this.reset();
    this.t.push(time);
    this.x.push(pos);
    if (this.t.length > VelocityTracker.maxSamples) {
      this.t.shift();
      this.x.shift();
    }
  }
  velocity(now) {
    let n = this.t.length;
    if (n < 2)
      return 0;
    let newest = this.t[n - 1];
    if (now - newest > 40)
      return 0;
    let start = n - 1;
    while (start > 0 && newest - this.t[start - 1] <= VelocityTracker.horizon)
      start--;
    let count = n - start;
    if (count < 2)
      return 0;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
    for (let i = start;i < n; i++) {
      let ti = (this.t[i] - newest) / 1000, xi = this.x[i];
      let t2 = ti * ti;
      s0 += 1;
      s1 += ti;
      s2 += t2;
      s3 += t2 * ti;
      s4 += t2 * t2;
      y0 += xi;
      y1 += xi * ti;
      y2 += xi * t2;
    }
    if (count == 2) {
      let dt = (this.t[n - 1] - this.t[n - 2]) / 1000;
      return dt > 0 ? (this.x[n - 1] - this.x[n - 2]) / dt : 0;
    }
    let det = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    let D = det(s0, s1, s2, s1, s2, s3, s2, s3, s4);
    if (Math.abs(D) < 0.000000000001) {
      let dt = (this.t[n - 1] - this.t[start]) / 1000;
      return dt > 0 ? (this.x[n - 1] - this.x[start]) / dt : 0;
    }
    let Db = det(s0, y0, s2, s1, y1, s3, s2, y2, s4);
    return Db / D;
  }
}

// src/scroll.js
var TOUCH_SLOP = 8;
var MAX_FLING = 8000;
var FLYWHEEL_CHECK = 40;
var MIN_BOOST = 350;
var MAX_BOOST = 3;
function axisPos(f, t) {
  return f.start + f.distance * splinePosition(t / f.duration);
}
class ScrollController {
  constructor(host) {
    this.host = host;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.pointerId = -1;
    this.startX = 0;
    this.startY = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.dragging = false;
    this.lockX = false;
    this.lockY = false;
    this.stoppedFling = false;
    this.vx = new VelocityTracker;
    this.vy = new VelocityTracker;
    this.flingStart = 0;
    this.stepTime = 0;
    this.flingY = null;
    this.flingX = null;
    this.flywheel = false;
    this.flywheelTimer = null;
    this.accumulatedY = 0;
    this.accumulatedX = 0;
    this.wheelTimer = null;
    this.onDown = (e) => this.pointerDown(e);
    this.onMove = (e) => this.pointerMove(e);
    this.onUp = (e) => this.pointerUp(e);
    this.onCancel = (e) => this.pointerCancel(e);
    this.onWheel = (e) => this.wheel(e);
    let dom = host.surface;
    dom.style.touchAction = "none";
    dom.addEventListener("pointerdown", this.onDown);
    dom.addEventListener("pointermove", this.onMove);
    dom.addEventListener("pointerup", this.onUp);
    dom.addEventListener("pointercancel", this.onCancel);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
  }
  step(time) {
    if (!this.flingY && !this.flingX)
      return;
    let t = time - this.flingStart;
    if (this.flingY) {
      if (t >= this.flingY.duration) {
        this.scrollTop = this.flingY.start + this.flingY.distance;
        this.flingY = null;
      } else {
        this.scrollTop = axisPos(this.flingY, t);
      }
    }
    if (this.flingX) {
      if (t >= this.flingX.duration) {
        this.scrollLeft = this.flingX.start + this.flingX.distance;
        this.flingX = null;
      } else {
        this.scrollLeft = axisPos(this.flingX, t);
      }
    }
    this.clamp();
    this.host.requestFrame();
  }
  pointerDown(e) {
    if (e.pointerType === "mouse")
      return;
    if (this.pointerId != -1)
      return;
    this.pointerId = e.pointerId;
    this.startX = this.lastX = e.clientX;
    this.startY = this.lastY = e.clientY;
    this.dragging = false;
    this.lockX = this.lockY = false;
    this.vx.reset();
    this.vy.reset();
    this.host.surface.setPointerCapture(e.pointerId);
  }
  pointerMove(e) {
    if (e.pointerId != this.pointerId)
      return;
    let dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    if (!this.dragging) {
      if (Math.abs(dx) < TOUCH_SLOP && Math.abs(dy) < TOUCH_SLOP)
        return;
      this.dragging = true;
      this.lockX = Math.abs(dx) > Math.abs(dy);
      this.lockY = !this.lockX;
      this.stopFling();
    }
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.vx.add(e.timeStamp, this.scrollLeft);
    this.vy.add(e.timeStamp, this.scrollTop);
    if (this.lockY)
      this.scrollTop -= dy;
    if (this.lockX)
      this.scrollLeft -= dx;
    this.clamp();
    this.host.noteInput(e.timeStamp);
    this.host.requestFrame();
    if (this.flingY && this.flywheelTimer == null) {
      this.flywheel = true;
      this.flywheelTimer = setTimeout(() => {
        this.flywheelTimer = null;
        this.flywheel = false;
      }, FLYWHEEL_CHECK);
    }
  }
  pointerUp(e) {
    if (e.pointerId != this.pointerId)
      return;
    this.pointerId = -1;
    this.dragging = false;
    this.host.surface.releasePointerCapture(e.pointerId);
    let vy = this.vy.velocity(e.timeStamp);
    let vx = this.vx.velocity(e.timeStamp);
    this.startFling(vy, vx);
  }
  pointerCancel(e) {
    if (e.pointerId != this.pointerId)
      return;
    this.pointerId = -1;
    this.dragging = false;
    try {
      this.host.surface.releasePointerCapture(e.pointerId);
    } catch {}
    this.stopFling();
  }
  wheel(e) {
    e.preventDefault();
    let unit = 1 / this.host.dpr;
    let dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    this.stopFling();
    this.scrollTop += dy;
    this.scrollLeft += dx;
    this.clamp();
    this.host.noteInput(e.timeStamp);
    this.host.requestFrame();
    if (this.wheelTimer != null)
      clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
    }, 150);
  }
  stopFling() {
    if (this.flingY)
      this.accumulatedY += this.flingY.distance * splinePosition((performance.now() - this.flingStart) / this.flingY.duration) - (this.scrollTop - this.flingY.start);
    if (this.flingX)
      this.accumulatedX += this.flingX.distance * splinePosition((performance.now() - this.flingStart) / this.flingX.duration) - (this.scrollLeft - this.flingX.start);
    this.flingY = this.flingX = null;
    this.flingStart = 0;
    this.stoppedFling = true;
  }
  startFling(vy, vx) {
    let dpr = this.host.dpr;
    let fy = computeFling(-vy * this.host.scrollSpeed, dpr);
    let fx = computeFling(-vx * this.host.scrollSpeed, dpr);
    if (this.flywheel && Math.abs(vy) > MIN_BOOST && Math.abs(fy.distance) > MIN_BOOST) {
      this.accumulatedY += fy.distance;
    }
    if (this.flywheel && Math.abs(vx) > MIN_BOOST && Math.abs(fx.distance) > MIN_BOOST) {
      this.accumulatedX += fx.distance;
    }
    let maxAccum = MAX_BOOST * MAX_FLING * dpr;
    if (Math.abs(this.accumulatedY) > maxAccum)
      this.accumulatedY = Math.sign(this.accumulatedY) * maxAccum;
    if (Math.abs(this.accumulatedX) > maxAccum)
      this.accumulatedX = Math.sign(this.accumulatedX) * maxAccum;
    if (Math.abs(fy.distance) > 1 || Math.abs(this.accumulatedY) > 1) {
      let dist = fy.distance + this.accumulatedY;
      let dur = fy.duration;
      if (this.flywheel && Math.abs(dist) > Math.abs(fy.distance)) {
        dur *= Math.abs(dist) / Math.abs(fy.distance);
      }
      this.flingY = { start: this.scrollTop, distance: dist, duration: dur };
      this.accumulatedY = 0;
    }
    if (Math.abs(fx.distance) > 1 || Math.abs(this.accumulatedX) > 1) {
      let dist = fx.distance + this.accumulatedX;
      let dur = fx.duration;
      if (this.flywheel && Math.abs(dist) > Math.abs(fx.distance)) {
        dur *= Math.abs(dist) / Math.abs(fx.distance);
      }
      this.flingX = { start: this.scrollLeft, distance: dist, duration: dur };
      this.accumulatedX = 0;
    }
    if (this.flingY || this.flingX) {
      this.flingStart = performance.now();
      this.stoppedFling = false;
      this.host.requestFrame();
    }
  }
  clamp() {
    this.scrollTop = Math.max(0, Math.min(this.host.maxScrollTop, this.scrollTop));
    this.scrollLeft = Math.max(0, Math.min(this.host.maxScrollLeft, this.scrollLeft));
  }
  get flinging() {
    return this.flingY != null || this.flingX != null;
  }
  destroy() {
    if (this.flywheelTimer != null)
      clearTimeout(this.flywheelTimer);
    if (this.wheelTimer != null)
      clearTimeout(this.wheelTimer);
    let dom = this.host.surface;
    dom.removeEventListener("pointerdown", this.onDown);
    dom.removeEventListener("pointermove", this.onMove);
    dom.removeEventListener("pointerup", this.onUp);
    dom.removeEventListener("pointercancel", this.onCancel);
    dom.removeEventListener("wheel", this.onWheel);
  }
}

// src/view.js
var WORD_CHARS = /[\w$@.\-]/;
function wordRange(text, col) {
  col = Math.max(0, Math.min(col, text.length));
  let start = col, end = col;
  while (start > 0 && WORD_CHARS.test(text[start - 1]))
    start--;
  while (end < text.length && WORD_CHARS.test(text[end]))
    end++;
  if (start === end)
    end = Math.min(text.length, col + 1);
  return { start, end };
}

class CanvasText {
  constructor(options) {
    this.canvas = options.canvas;
    this.font = options.font ?? "Consolas, 'Cascadia Code', monospace";
    this.size = options.size ?? 14;
    this.background = options.background ?? packRGBA(30, 30, 30);
    this.backendKind = options.backend ?? "auto";
    this.scrollSpeed = options.scrollSpeed ?? 1;
    this.metrics = null;
    this.atlas = null;
    this.backend = null;
    this.glyphBuf = new InstanceBuffer(5);
    this.rectBuf = new InstanceBuffer(5);
    this.scene = null;
    this.scroller = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.destroyed = false;
    this._raf = 0;
    this._needsRender = false;
    this._lines = [];
    this._plain = [];
    this.selStart = null;
    this.selEnd = null;
    this._selecting = false;
    this._dragged = false;
    this._downX = 0;
    this._downY = 0;
    this._clickCount = 0;
    this._lastClickTime = 0;
    this._lastClickPos = null;
    this._pointerX = 0;
    this._pointerY = 0;
    this._autoRaf = 0;
    this.selectionColor = options.selectionColor ?? packRGBA(60, 90, 140);
    this.onClick = options.onClick ?? null;
  }
  async createBackend() {
    throw new Error('canvas-text: no backend is bundled. Import "canvas-text" for both ' + 'backends with fallback, or "canvas-text/webgl2" / "canvas-text/webgpu" ' + "for a single one.");
  }
  async init() {
    this.dpr = window.devicePixelRatio || 1;
    this.metrics = measureFont({ family: this.font, size: this.size }, this.dpr);
    this.atlas = new GlyphAtlas(this.metrics, 4096);
    this.scene = new Scene({
      atlas: this.atlas,
      metrics: this.metrics,
      glyphBuf: this.glyphBuf,
      rectBuf: this.rectBuf,
      background: this.background
    });
    this.backend = await this.createBackend();
    this.resize();
    this.scroller = new ScrollController({
      surface: this.canvas,
      dpr: this.dpr,
      maxScrollTop: 0,
      maxScrollLeft: 0,
      scrollSpeed: this.scrollSpeed,
      requestFrame: () => {
        this._needsRender = true;
      },
      noteInput: () => {}
    });
    this.canvas.style.cursor = "text";
    this.canvas.addEventListener("pointerdown", this._onPointerDown);
  }
  _posToLineCol(x, y) {
    let m = this.metrics;
    let s = this.scroller;
    let line = Math.floor((y + s.scrollTop) / m.lineHeight);
    let col = Math.floor((x + s.scrollLeft) / m.cellWidth);
    line = Math.max(0, line);
    col = Math.max(0, col);
    if (this._plain.length && line > this._plain.length - 1)
      line = this._plain.length - 1;
    let text = this._plain[line];
    if (text != null && col > text.length)
      col = text.length;
    return { line, col };
  }
  _posToLineColClient(clientX, clientY) {
    let rect = this.canvas.getBoundingClientRect();
    return this._posToLineCol(clientX - rect.left, clientY - rect.top);
  }
  _onPointerDown = (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0)
      return;
    if (!this.metrics || !this.scroller)
      return;
    let pos = this._posToLineColClient(e.clientX, e.clientY);
    this.selStart = pos;
    this.selEnd = pos;
    this._selecting = true;
    this._dragged = false;
    this._downX = e.clientX;
    this._downY = e.clientY;
    this._pointerX = e.clientX;
    this._pointerY = e.clientY;
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    e.preventDefault();
    this._needsRender = true;
  };
  _onPointerMove = (e) => {
    if (!this._selecting)
      return;
    this._pointerX = e.clientX;
    this._pointerY = e.clientY;
    if (Math.abs(e.clientX - this._downX) > 3 || Math.abs(e.clientY - this._downY) > 3) {
      this._dragged = true;
    }
    if (this._dragged) {
      let pos = this._posToLineColClient(e.clientX, e.clientY);
      if (!this.selEnd || pos.line !== this.selEnd.line || pos.col !== this.selEnd.col) {
        this.selEnd = pos;
        this._needsRender = true;
      }
      if (!this._autoRaf)
        this._autoRaf = requestAnimationFrame(this._autoScroll);
    }
  };
  _autoScroll = () => {
    this._autoRaf = 0;
    if (!this._selecting || !this.scroller)
      return;
    let rect = this.canvas.getBoundingClientRect();
    let up = this._pointerY < rect.top ? this._pointerY - rect.top : 0;
    let down = this._pointerY > rect.bottom ? this._pointerY - rect.bottom : 0;
    let left = this._pointerX < rect.left ? this._pointerX - rect.left : 0;
    let right = this._pointerX > rect.right ? this._pointerX - rect.right : 0;
    let dy = up || down, dx = left || right;
    if (!dy && !dx)
      return;
    let speed = (d) => Math.min(60, Math.max(2, Math.abs(d) * 0.5));
    this.scroller.scrollTop += Math.sign(dy) * speed(dy);
    this.scroller.scrollLeft += Math.sign(dx) * speed(dx);
    this.scroller.clamp();
    this.selEnd = this._posToLineColClient(this._pointerX, this._pointerY);
    this._needsRender = true;
    this._autoRaf = requestAnimationFrame(this._autoScroll);
  };
  posAt(clientX, clientY) {
    return this._posToLineColClient(clientX, clientY);
  }
  getLine(line) {
    return this._plain[line] ?? "";
  }
  _onPointerUp = () => {
    this._selecting = false;
    if (this._autoRaf)
      cancelAnimationFrame(this._autoRaf);
    this._autoRaf = 0;
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    if (!this._dragged)
      this._resolveClick();
    this._needsRender = true;
  };
  _resolveClick() {
    let pos = this.selStart;
    if (!pos)
      return;
    let now = performance.now();
    let last = this._lastClickPos;
    let sameSpot = !!last && last.line === pos.line && Math.abs(last.col - pos.col) <= 1;
    this._clickCount = now - this._lastClickTime < 500 && sameSpot ? this._clickCount + 1 : 1;
    this._lastClickTime = now;
    this._lastClickPos = pos;
    if (this.onClick) {
      this.onClick({
        line: pos.line,
        col: pos.col,
        text: this._plain[pos.line] ?? "",
        count: this._clickCount
      });
    }
    if (this._clickCount < 2)
      return;
    let text = this._plain[pos.line] ?? "";
    if (this._clickCount === 2) {
      let r = wordRange(text, pos.col);
      this.selStart = { line: pos.line, col: r.start };
      this.selEnd = { line: pos.line, col: r.end };
    } else {
      this.selStart = { line: pos.line, col: 0 };
      this.selEnd = { line: pos.line, col: text.length };
    }
  }
  clearSelection() {
    this.selStart = null;
    this.selEnd = null;
    this._needsRender = true;
  }
  getSelection() {
    if (!this.selStart || !this.selEnd)
      return null;
    let a = this.selStart, b = this.selEnd;
    let start, end;
    if (a.line < b.line || a.line === b.line && a.col <= b.col) {
      start = a;
      end = b;
    } else {
      start = b;
      end = a;
    }
    return { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
  }
  getSelectedText() {
    let sel = this.getSelection();
    if (!sel)
      return "";
    let parts = [];
    for (let line = sel.startLine;line <= sel.endLine; line++) {
      let text = this._plain[line] ?? "";
      if (line === sel.startLine && line === sel.endLine) {
        parts.push(text.slice(sel.startCol, sel.endCol));
      } else if (line === sel.startLine) {
        parts.push(text.slice(sel.startCol));
      } else if (line === sel.endLine) {
        parts.push(text.slice(0, sel.endCol));
      } else {
        parts.push(text);
      }
    }
    return parts.join(`
`);
  }
  async copySelection() {
    let text = this.getSelectedText();
    if (text)
      await navigator.clipboard.writeText(text);
  }
  setText(text) {
    if (!this.scene || !this.metrics)
      return;
    this.scene.setText(text);
    this._lines = this.scene.lines;
    this._plain = this.scene.plain;
    this._updateMaxScroll();
    this._needsRender = true;
  }
  _updateMaxScroll() {
    if (!this.scroller || !this.metrics)
      return;
    let totalHeight = this._plain.length * this.metrics.lineHeight;
    let totalWidth = 0;
    for (let line of this._plain) {
      if (line.length > totalWidth)
        totalWidth = line.length;
    }
    let contentWidth = totalWidth * this.metrics.cellWidth;
    this.scroller.host.maxScrollTop = Math.max(0, totalHeight - this.height);
    this.scroller.host.maxScrollLeft = Math.max(0, contentWidth - this.width);
  }
  resize() {
    if (!this.backend)
      return;
    let rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = window.devicePixelRatio || 1;
    this.backend.resize(this.width, this.height, this.dpr);
    this._updateMaxScroll();
    this._needsRender = true;
  }
  render() {
    if (this.destroyed || !this.backend || !this.scene || !this.metrics || !this.atlas || !this.scroller)
      return;
    let m = this.metrics;
    this.scroller.step(performance.now());
    let scrollY = this.scroller.scrollTop;
    let firstRow = Math.floor(scrollY / m.lineHeight);
    let lastRow = firstRow + Math.ceil(this.height / m.lineHeight) + 1;
    let sel = this.getSelection();
    this.scene.build(firstRow, lastRow, sel, this.selectionColor);
    let offsetX = -this.scroller.scrollLeft;
    let offsetY = -scrollY;
    let passes = [
      { kind: "rect", buffer: this.rectBuf, first: 0, count: this.rectBuf.count, offsetX, offsetY },
      { kind: "glyph", buffer: this.glyphBuf, first: 0, count: this.glyphBuf.count, offsetX, offsetY }
    ];
    this.backend.syncAtlas(this.atlas);
    this.backend.render(this.background, passes);
  }
  start() {
    if (this.destroyed)
      return;
    const loop = () => {
      if (this.destroyed)
        return;
      this.render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
  destroy() {
    this.destroyed = true;
    this.stop();
    if (this._autoRaf)
      cancelAnimationFrame(this._autoRaf);
    this._autoRaf = 0;
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    this.scroller?.destroy();
    this.backend?.destroy();
    this.glyphBuf.reset();
    this.rectBuf.reset();
  }
}

// src/webgpu.js
var shared = `
struct U { viewport: vec2f, offset: vec2f, atlas: vec2f, dpr: f32, pad: f32, clip: vec4f }
@group(0) @binding(0) var<uniform> u: U;
fn corner(vi: u32) -> vec2f { return vec2f(f32(vi & 1u), f32(vi >> 1u)); }
fn snap(p: vec2f) -> vec2f { return floor(p * u.dpr + 0.5); }
fn toClip(p: vec2f) -> vec4f {
  return vec4f(p.x / u.viewport.x * 2.0 - 1.0, 1.0 - p.y / u.viewport.y * 2.0, 0.0, 1.0);
}
fn clipped(p: vec4f) -> bool {
  return p.x < u.clip.x || p.y < u.clip.y || p.x >= u.clip.z || p.y >= u.clip.w;
}
`;
var glyphWGSL = shared + `
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) texel: vec2u,
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) color: vec4f
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) pos: vec2f,
              @location(1) uv: vec2u, @location(2) size: vec2u, @location(3) color: vec4f) -> VOut {
  let c = corner(vi);
  let s = vec2f(size);
  let origin = snap(pos) + snap(u.offset);
  var out: VOut;
  out.pos = toClip(origin + c * s);
  out.texel = uv;
  out.local = c * s;
  out.color = color;
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (clipped(in.pos)) { discard; }
  let t = textureLoad(tex, in.texel + vec2u(in.local), 0);
  if (in.color.a == 0.0) { return t; }
  return vec4f(in.color.rgb, 1.0) * (t.a * in.color.a);
}
`;
var rectWGSL = shared + `
struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) color: vec4f) -> VOut {
  let c = corner(vi);
  let off = snap(u.offset);
  let a = snap(rect.xy) + off;
  let b = max(snap(rect.xy + rect.zw) + off, a + 1.0);
  var out: VOut;
  out.pos = toClip(mix(a, b, c));
  out.color = vec4f(color.rgb * color.a, color.a);
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (clipped(in.pos)) { discard; }
  return in.color;
}
`;
var UNIFORM_SLOT = 256;
var UNIFORM_FLOATS = 12;
var NO_CLIP = 1e7;
var blend = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }
};

class WebGPUBackend {
  static async requestDevice() {
    let gpu = globalThis.navigator?.gpu;
    if (!gpu)
      return null;
    let adapter = await gpu.requestAdapter({ powerPreference: "low-power" });
    return adapter ? adapter.requestDevice() : null;
  }
  static async create(canvas, device = WebGPUBackend.requestDevice()) {
    let dev = await device;
    return dev && new WebGPUBackend(canvas, dev, navigator.gpu.getPreferredCanvasFormat());
  }
  constructor(canvas, device, format) {
    this.kind = "webgpu";
    this.canvas = canvas;
    this.device = device;
    this.lost = false;
    this.onLost = null;
    this.onRestored = null;
    this.maxTextureSize = device.limits.maxTextureDimension2D;
    this.destroyed = false;
    this.format = format;
    this.context = canvas.getContext("webgpu");
    if (!this.context)
      throw new Error("canvas-text: WebGPU canvas context unavailable");
    this.context.configure({ device, format, alphaMode: "opaque" });
    device.lost.then(() => {
      if (this.destroyed)
        return;
      this.lost = true;
      this.onLost?.(true);
    });
    this.glyphLayout = device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_FLOATS * 4 }
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
    ] });
    this.rectLayout = device.createBindGroupLayout({ entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_FLOATS * 4 }
      }
    ] });
    let glyphModule = device.createShaderModule({ code: glyphWGSL });
    this.glyphPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.glyphLayout] }),
      vertex: { module: glyphModule, entryPoint: "vs", buffers: [{
        arrayStride: GLYPH_STRIDE * 4,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 8, format: "uint16x2" },
          { shaderLocation: 2, offset: 12, format: "uint16x2" },
          { shaderLocation: 3, offset: 16, format: "unorm8x4" }
        ]
      }] },
      fragment: { module: glyphModule, entryPoint: "fs", targets: [{ format, blend }] },
      primitive: { topology: "triangle-strip" }
    });
    let rectModule = device.createShaderModule({ code: rectWGSL });
    this.rectPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.rectLayout] }),
      vertex: { module: rectModule, entryPoint: "vs", buffers: [{
        arrayStride: RECT_STRIDE * 4,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x4" },
          { shaderLocation: 1, offset: 16, format: "unorm8x4" }
        ]
      }] },
      fragment: { module: rectModule, entryPoint: "fs", targets: [{ format, blend }] },
      primitive: { topology: "triangle-strip" }
    });
    this.slots = 0;
    this.uniformData = new Float32Array(0);
    this.indirectData = new Uint32Array(0);
    this.uniforms = null;
    this.indirect = null;
    this.rectGroup = null;
    this.glyphGroup = null;
    this.bundle = null;
    this.colorAttachment = { view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" };
    this.passDescriptor = { colorAttachments: [this.colorAttachment] };
    this.buffers = new WeakMap;
    this.bundleKey = [];
    this.allocSlots(16);
  }
  allocSlots(slots) {
    this.uniforms?.destroy();
    this.indirect?.destroy();
    this.slots = slots;
    this.uniformData = new Float32Array(slots * UNIFORM_SLOT / 4);
    this.indirectData = new Uint32Array(slots * 4);
    this.indirectData.fill(4294967295);
    this.uniforms = this.device.createBuffer({ size: slots * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.indirect = this.device.createBuffer({ size: slots * 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    this.rectGroup = this.device.createBindGroup({ layout: this.rectLayout, entries: [
      { binding: 0, resource: { buffer: this.uniforms, size: UNIFORM_FLOATS * 4 } }
    ] });
    this.glyphGroup = this.makeGlyphGroup();
    this.bundle = null;
  }
  makeGlyphGroup() {
    if (!this.texture)
      return null;
    return this.device.createBindGroup({ layout: this.glyphLayout, entries: [
      { binding: 0, resource: { buffer: this.uniforms, size: UNIFORM_FLOATS * 4 } },
      { binding: 1, resource: this.texture.createView() }
    ] });
  }
  resize(width, height, dpr) {
    this.width = Math.round(width * dpr);
    this.height = Math.round(height * dpr);
    this.dpr = dpr;
    if (this.canvas.width == this.width && this.canvas.height == this.height)
      return false;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    return true;
  }
  createTexture(size) {
    return this.device.createTexture({
      size: [size, size],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
    });
  }
  syncAtlas(atlas) {
    if (this.lost)
      return;
    let tex = this.texture;
    if (!tex || atlas != this.atlas || tex.width > atlas.size) {
      tex?.destroy();
      this.texture = this.createTexture(atlas.size);
      atlas.markAllDirty();
      this.onTextureChanged();
    } else if (tex.width < atlas.size) {
      let next = this.createTexture(atlas.size);
      let encoder = this.device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: tex }, { texture: next }, [tex.width, tex.height]);
      this.device.queue.submit([encoder.finish()]);
      tex.destroy();
      this.texture = next;
      this.onTextureChanged();
    }
    this.atlas = atlas;
    let d = atlas.takeDirty();
    if (d && d.w > 0 && d.h > 0) {
      this.device.queue.copyExternalImageToTexture({ source: atlas.source, origin: { x: d.x, y: d.y } }, { texture: this.texture, origin: { x: d.x, y: d.y }, premultipliedAlpha: true }, { width: d.w, height: d.h });
    }
  }
  onTextureChanged() {
    this.glyphGroup = this.makeGlyphGroup();
    this.bundle = null;
  }
  upload(buf) {
    let state = this.buffers.get(buf);
    let from = buf.dirtyFrom;
    if (!state || state.bytes < buf.byteLength) {
      state?.buffer.destroy();
      let size = Math.max(256, buf.buffer.byteLength);
      state = { buffer: this.device.createBuffer({ size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }), bytes: size };
      this.buffers.set(buf, state);
      this.bundle = null;
      from = 0;
    }
    if (from < buf.count) {
      let w = buf.stride * 4;
      this.device.queue.writeBuffer(state.buffer, from * w, buf.buffer, from * w, (buf.count - from) * w);
    }
    buf.markClean();
    return state.buffer;
  }
  render(background, passes) {
    if (this.lost)
      return;
    if (passes.length > this.slots)
      this.allocSlots(Math.max(passes.length, this.slots * 2));
    let data = this.uniformData;
    let ind = this.indirectData;
    let slot = UNIFORM_SLOT / 4;
    let atlasSize = this.texture?.width ?? 1;
    let key = this.bundleKey, keyChanged = key.length != passes.length * 2, countsChanged = false;
    for (let i = 0;i < passes.length; i++) {
      let p = passes[i];
      let gpuBuffer = this.upload(p.buffer);
      if (key[i * 2] !== gpuBuffer || key[i * 2 + 1] !== p.kind)
        keyChanged = true;
      key[i * 2] = gpuBuffer;
      key[i * 2 + 1] = p.kind;
      let o = i * slot;
      data.set([this.width, this.height, p.offsetX, p.offsetY, atlasSize, atlasSize, this.dpr], o);
      let c = p.clip;
      if (c) {
        let { x: cx, y: cy, w: cw, h: ch } = c;
        data.set([Math.round(cx * this.dpr), Math.round(cy * this.dpr), Math.round((cx + cw) * this.dpr), Math.round((cy + ch) * this.dpr)], o + 8);
      } else {
        data.set([-NO_CLIP, -NO_CLIP, NO_CLIP, NO_CLIP], o + 8);
      }
      let count = p.kind == "glyph" && !this.glyphGroup ? 0 : p.count;
      if (ind[i * 4 + 1] != count || ind[i * 4] != 4) {
        ind[i * 4] = 4;
        ind[i * 4 + 1] = count;
        ind[i * 4 + 2] = 0;
        ind[i * 4 + 3] = 0;
        countsChanged = true;
      }
      if (p.first != 0)
        throw new RangeError("canvas-text: WebGPU passes must start at instance 0");
    }
    key.length = passes.length * 2;
    let queue = this.device.queue;
    if (!this.uniforms || !this.indirect)
      throw new Error("canvas-text: buffers not allocated");
    queue.writeBuffer(this.uniforms, 0, data.buffer, 0, passes.length * UNIFORM_SLOT);
    if (countsChanged)
      queue.writeBuffer(this.indirect, 0, ind.buffer, 0, passes.length * 16);
    if (keyChanged || !this.bundle)
      this.bundle = this.record(passes);
    let [r, g, b] = unpackRGBA(background);
    let clear = this.colorAttachment.clearValue;
    clear.r = r / 255;
    clear.g = g / 255;
    clear.b = b / 255;
    this.colorAttachment.view = this.context.getCurrentTexture().createView();
    let encoder = this.device.createCommandEncoder();
    let pass = encoder.beginRenderPass(this.passDescriptor);
    pass.executeBundles([this.bundle]);
    pass.end();
    queue.submit([encoder.finish()]);
  }
  record(passes) {
    let enc = this.device.createRenderBundleEncoder({ colorFormats: [this.format] });
    let current = null;
    for (let i = 0;i < passes.length; i++) {
      let p = passes[i];
      let glyph = p.kind == "glyph";
      if (glyph && !this.glyphGroup)
        continue;
      let pipeline = glyph ? this.glyphPipeline : this.rectPipeline;
      if (pipeline != current)
        enc.setPipeline(current = pipeline);
      enc.setBindGroup(0, glyph ? this.glyphGroup : this.rectGroup, [i * UNIFORM_SLOT]);
      let state = this.buffers.get(p.buffer);
      if (!state)
        throw new Error("canvas-text: buffer not uploaded");
      enc.setVertexBuffer(0, state.buffer);
      if (!this.indirect)
        throw new Error("canvas-text: indirect buffer not allocated");
      enc.drawIndirect(this.indirect, i * 16);
    }
    return enc.finish();
  }
  destroy() {
    this.destroyed = true;
    this.onLost = this.onRestored = null;
    this.texture?.destroy();
    this.uniforms?.destroy();
    this.indirect?.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }
}
// src/entries/webgpu.js
class CanvasText2 extends CanvasText {
  async createBackend() {
    let gpu = await WebGPUBackend.create(this.canvas);
    if (!gpu)
      throw new Error("canvas-text/webgpu: WebGPU is not available in this browser");
    return gpu;
  }
}
export {
  CanvasText2 as CanvasText,
  GLYPH_STRIDE,
  GlyphAtlas,
  InstanceBuffer,
  RECT_STRIDE,
  Scene,
  ScrollController,
  VelocityTracker,
  WebGPUBackend,
  colorToCSS,
  computeFling,
  expandTabs,
  fontString,
  fontVariant,
  makeCanvas,
  measureFont,
  packRGBA,
  parseAnsi,
  parseAnsiResolved,
  parseColor,
  pushGlyph,
  pushRect,
  splinePosition,
  splineVelocity,
  stripAnsi,
  unpackRGBA
};
