// Optional per-instance theme tokens (theme.json) -> CSS custom properties.
// The core ships no colours; without a theme the UI uses the browser's system colours.
import fs from 'node:fs';

export const THEME_TOKENS = [
  'bg', 'fg', 'muted', 'surface', 'border', 'accent', 'accent-fg', 'link', 'warn',
  'font-body', 'font-heading', 'font-mono', 'radius', 'max-width',
];
const SAFE_VALUE = /^[#(),.%\w\s"'+-]{1,120}$/;

export function loadThemeCss(file) {
  if (!file) return '';
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw new Error(`theme ${file}: ${err.message}`);
  }
  return themeCss(data);
}

export function themeCss(data) {
  const tokens = data && typeof data === 'object' ? (data.tokens ?? data) : {};
  const lines = [];
  for (const name of THEME_TOKENS) {
    const v = tokens[name];
    if (typeof v !== 'string' || !SAFE_VALUE.test(v) || /url\s*\(|expression|\\|[;{}<>]/i.test(v)) continue;
    lines.push(`  --bt-${name}: ${v};`);
  }
  return lines.length ? `:root {\n${lines.join('\n')}\n}\n` : '';
}
