#!/usr/bin/env node
/**
 * Regenerate src/icon.ts from assets/icon.svg.
 *
 * The icon ships in two forms at runtime:
 *   - Embedded as a `data:image/svg+xml;base64,...` URI in the MCP
 *     `serverInfo.icons` array (works on every transport, no HTTP
 *     route needed).
 *   - Served at `/icon.svg` and `/favicon.ico` by the HTTP transport,
 *     for clients that prefer to fetch a URL.
 *
 * Run: `npm run build:icon` (also chained from `npm run build`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SVG_PATH = join(ROOT, "assets", "icon.svg");
const TS_PATH = join(ROOT, "src", "icon.ts");

const svg = readFileSync(SVG_PATH, "utf8").replace(/\s+$/, "");

const escapedSvg = svg.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const generated = `/**
 * The loomiomcp icon. Placeholder mark: letter L on a tinted circle.
 * Visually neutral — does not reproduce any Loomio trademark.
 *
 * Generated from assets/icon.svg by scripts/build-icon.mjs. **Do not
 * edit this file directly** — edit the SVG and re-run \`npm run
 * build:icon\` (or \`npm run build\`, which chains it).
 */

export const ICON_SVG = \`${escapedSvg}\`;

export const ICON_DATA_URI = \`data:image/svg+xml;base64,\${Buffer.from(ICON_SVG, "utf8").toString("base64")}\`;

export const ICONS = [
  {
    src: ICON_DATA_URI,
    mimeType: "image/svg+xml",
    sizes: ["64x64", "any"],
  },
];
`;

writeFileSync(TS_PATH, generated, "utf8");
console.log(
  `Regenerated ${TS_PATH.replace(`${ROOT}/`, "")} from ${SVG_PATH.replace(`${ROOT}/`, "")}`,
);
