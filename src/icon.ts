/**
 * The loomiomcp icon. Placeholder mark: letter L on a tinted circle.
 * Visually neutral — does not reproduce any Loomio trademark.
 *
 * Generated from assets/icon.svg by scripts/build-icon.mjs. **Do not
 * edit this file directly** — edit the SVG and re-run `npm run
 * build:icon` (or `npm run build`, which chains it).
 */

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="loomiomcp">
  <!-- Placeholder mark: letter L on a tinted circle. Visually neutral —
       does not reproduce any Loomio trademark. -->
  <circle cx="32" cy="32" r="28" fill="#2563EB"/>
  <path d="M22 16 L22 48 L44 48 L44 42 L28 42 L28 16 Z" fill="#FFFFFF"/>
</svg>`;

export const ICON_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(ICON_SVG, "utf8").toString("base64")}`;

export const ICONS = [
  {
    src: ICON_DATA_URI,
    mimeType: "image/svg+xml",
    sizes: ["64x64", "any"],
  },
];
