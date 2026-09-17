'use strict';

const THEMES = Object.freeze(['classic', 'cyan', 'green', 'amber', 'magenta', 'white']);
const DEFAULT_THEME = 'classic';
const COLOR_KEYS = Object.freeze(['body', 'bg', 'text', 'textDim', 'ink']);

/*
 * RGB565 values are the wire contract, so the table records the colors after
 * bit-replication to RGB888 rather than the unquantized design targets. The
 * three ratios are text/bg, textDim/bg, and body/bg respectively.
 *
 * theme    body            bg              text            textDim         ink             ratios
 * classic  0xBD51 #BDAA8C  0x0000 #000000  0xFFFF #FFFFFF  0x8410 #848284  0x0000 #000000  21.00 5.51 9.29
 * cyan     0x05D9 #00BACE  0x0000 #000000  0xFFFF #FFFFFF  0x8410 #848284  0x0000 #000000  21.00 5.51 8.91
 * green    0x45CB #42BA5A  0x0000 #000000  0xFFFF #FFFFFF  0x8410 #848284  0x0000 #000000  21.00 5.51 8.40
 * amber    0xD4A0 #D69600  0x0000 #000000  0xFFFF #FFFFFF  0x8410 #848284  0x0000 #000000  21.00 5.51 8.22
 * magenta  0xC254 #C649A5  0x0000 #000000  0xFFFF #FFFFFF  0x8410 #848284  0x0000 #000000  21.00 5.51 4.90
 * white    0xBDF7 #BDBEBD  0x0000 #000000  0xFFFF #FFFFFF  0x8410 #848284  0x0000 #000000  21.00 5.51 11.26
 */
const PALETTES = Object.freeze({
  classic: Object.freeze({ body: 0xbd51, bg: 0x0000, text: 0xffff, textDim: 0x8410, ink: 0x0000 }),
  cyan: Object.freeze({ body: 0x05d9, bg: 0x0000, text: 0xffff, textDim: 0x8410, ink: 0x0000 }),
  green: Object.freeze({ body: 0x45cb, bg: 0x0000, text: 0xffff, textDim: 0x8410, ink: 0x0000 }),
  amber: Object.freeze({ body: 0xd4a0, bg: 0x0000, text: 0xffff, textDim: 0x8410, ink: 0x0000 }),
  magenta: Object.freeze({ body: 0xc254, bg: 0x0000, text: 0xffff, textDim: 0x8410, ink: 0x0000 }),
  white: Object.freeze({ body: 0xbdf7, bg: 0x0000, text: 0xffff, textDim: 0x8410, ink: 0x0000 }),
});

function isTheme(id) {
  return THEMES.includes(id);
}

function paletteFor(id) {
  return isTheme(id) ? { ...PALETTES[id] } : null;
}

function rgb565ToRgb888(v) {
  const r5 = (v >> 11) & 0x1f;
  const g6 = (v >> 5) & 0x3f;
  const b5 = v & 0x1f;
  return {
    r: (r5 << 3) | (r5 >> 2),
    g: (g6 << 2) | (g6 >> 4),
    b: (b5 << 3) | (b5 >> 2),
  };
}

function linearChannel(c8) {
  const cs = c8 / 255;
  return cs <= 0.04045 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(v) {
  const { r, g, b } = rgb565ToRgb888(v);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

function contrastRatio(a, b) {
  const aLuminance = relativeLuminance(a);
  const bLuminance = relativeLuminance(b);
  const lighter = Math.max(aLuminance, bLuminance);
  const darker = Math.min(aLuminance, bLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null) return 'null';
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Fall through to a type label for cyclic or otherwise unserializable data.
  }
  return `<${typeof value}>`;
}

function ratioFailure(label, actual, required) {
  return {
    ok: false,
    reason: `${label} is ${actual.toFixed(2)}:1; V1 requires at least ${required}:1.`,
  };
}

function validatePalette(colors) {
  if (
    colors === null ||
    typeof colors !== 'object' ||
    Array.isArray(colors) ||
    Object.getPrototypeOf(colors) !== Object.prototype
  ) {
    return { ok: false, reason: 'colors must be a non-null plain object.' };
  }

  const keys = Object.keys(colors);
  const missing = COLOR_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(colors, key));
  if (missing.length > 0) {
    return { ok: false, reason: `Palette is missing required key(s): ${missing.join(', ')}.` };
  }

  const unknown = keys.filter((key) => !COLOR_KEYS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `Palette has unknown key(s): ${unknown.join(', ')}.` };
  }

  for (const key of COLOR_KEYS) {
    const value = colors[key];
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      return {
        ok: false,
        reason: `${key} must be an integer from 0 to 65535; received ${describeValue(value)}.`,
      };
    }
  }

  if (colors.bg !== 0x0000) {
    return { ok: false, reason: `bg must be 0 (0x0000) in V1; received ${colors.bg}.` };
  }

  const textContrast = contrastRatio(colors.text, colors.bg);
  if (textContrast < 4.5) return ratioFailure('text contrast against bg', textContrast, '4.5');

  const dimContrast = contrastRatio(colors.textDim, colors.bg);
  if (dimContrast < 3.0) {
    return ratioFailure('textDim contrast against bg', dimContrast, '3.0');
  }

  // Body colors need enough luminance to read on black, but also enough
  // distance from white highlights and selection outlines. A 3.0:1 black
  // floor matches the non-text accessibility target; 1.4:1 against white
  // preserves a visible edge without making light, friendly pals impossible.
  const bodyBlackContrast = contrastRatio(colors.body, 0x0000);
  if (bodyBlackContrast < 3.0) {
    return ratioFailure('body contrast against black', bodyBlackContrast, '3.0');
  }

  const bodyWhiteContrast = contrastRatio(colors.body, 0xffff);
  if (bodyWhiteContrast < 1.4) {
    return ratioFailure('body contrast against white', bodyWhiteContrast, '1.4');
  }

  // Ink is used for small facial and outline details over the body. Requiring
  // 2.0:1 is intentionally stronger than mere color difference so those
  // details survive RGB565 quantization and the M5Dial's small round display.
  const inkContrast = contrastRatio(colors.ink, colors.body);
  if (inkContrast < 2.0) {
    return ratioFailure('ink contrast against body', inkContrast, '2.0');
  }

  return { ok: true };
}

module.exports = {
  THEMES,
  DEFAULT_THEME,
  PALETTES,
  isTheme,
  paletteFor,
  rgb565ToRgb888,
  relativeLuminance,
  contrastRatio,
  validatePalette,
};
