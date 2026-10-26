// Renders the README banners and the GitHub social preview in docs/assets/ from one template.
//   CHROME=/path/to/chrome bun scripts/render-assets.ts [outDir]
// CHROME is a Chrome or Chromium binary; it renders each page with its --headless --screenshot flags.
// The pages use the Lato font, which must be installed for the output to match the committed files.
// Chrome's --force-device-scale-factor draws 2x text edges slightly unlike Playwright, which made the
// committed banners; the 1x social preview comes out identical.
// The social preview reaches GitHub only by a manual upload (see docs/assets/README.md).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CHIPS, FACTS, IMAGES, NAME, TAGLINE, assetText } from "./lib/brand.ts";

const chrome = process.env.CHROME;
if (!chrome) {
  console.error("Set CHROME to a Chrome or Chromium binary.");
  process.exit(1);
}
const outDir = resolve(process.argv[2] ?? "docs/assets");

const BASE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{overflow:hidden}
  body{font-family:Lato,'Ubuntu Sans',sans-serif;color:#e8ecf8;
    background:radial-gradient(1200px 700px at 85% -10%,rgba(94,234,212,.16),transparent 60%),
      radial-gradient(900px 600px at -10% 110%,rgba(139,92,246,.20),transparent 60%),#070b18;}
  .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:40px 40px;
    mask-image:radial-gradient(ellipse at center,#000 30%,transparent 80%)}
  .grad{background:linear-gradient(90deg,#5eead4,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent}
`;

const THEME_CSS = {
  dark: `body{color:#e8ecf8;background:radial-gradient(900px 400px at 90% -20%,rgba(94,234,212,.18),transparent 60%),
        radial-gradient(700px 400px at -5% 120%,rgba(139,92,246,.22),transparent 60%),#070b18}
       .tag{color:#aab3cc}.chip{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.12);color:#c9d1e8}
       .facts{color:#8a93ad}`,
  light: `body{color:#0f172a;background:radial-gradient(900px 400px at 90% -20%,rgba(20,184,166,.16),transparent 60%),
        radial-gradient(700px 400px at -5% 120%,rgba(139,92,246,.14),transparent 60%),#f8fafc}
       .grid{background-image:linear-gradient(rgba(15,23,42,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.05) 1px,transparent 1px)}
       .grad{background:linear-gradient(90deg,#0d9488,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent}
       .tag{color:#334155}.chip{background:rgba(255,255,255,.8);border-color:rgba(15,23,42,.12);color:#334155}
       .facts{color:#64748b}`,
};

const mark = (
  size: number,
) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>
      <rect x="6" y="14" width="52" height="36" rx="7" fill="none" stroke="url(#g)" stroke-width="4.5"/>
      <path d="M9 18 L32 35 L55 18" fill="none" stroke="url(#g)" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="54" cy="14" r="7" fill="#5eead4"/></svg>`;

const chips = CHIPS.map((c) => `<span class="chip">${c}</span>`).join("");

const banner = (theme: keyof typeof THEME_CSS) => `<!doctype html><html><head><style>${BASE_CSS}
    html,body{width:1280px;height:320px}
    ${THEME_CSS[theme]}
    .row{position:absolute;inset:0;display:flex;align-items:center;gap:40px;padding:0 72px}
    h1{font-size:76px;font-weight:900;letter-spacing:-.02em;line-height:1}
    .tag{font-size:26px;margin-top:12px}
    .chips{display:flex;gap:10px;margin-top:22px}
    .chip{font-size:16px;font-weight:700;padding:7px 14px;border-radius:999px;border:1px solid}
  </style></head><body><div class="grid"></div><div class="row">${mark(150)}
    <div><h1 class="grad">${NAME}</h1><div class="tag">${TAGLINE}</div>
    <div class="chips">${chips}</div></div></div></body></html>`;

const socialPreview = `<!doctype html><html><head><style>${BASE_CSS}
    html,body{width:1280px;height:640px}
    ${THEME_CSS.dark}
    .wrap{position:absolute;inset:0;padding:96px 96px;display:flex;flex-direction:column;justify-content:center}
    h1{font-size:110px;font-weight:900;letter-spacing:-.02em;line-height:1;margin-top:28px}
    .tag{font-size:38px;margin-top:22px;max-width:1000px;line-height:1.2;text-wrap:balance}
    .chips{display:flex;gap:12px;margin-top:36px;flex-wrap:wrap}
    .chip{font-size:22px;font-weight:700;padding:9px 18px;border-radius:999px;border:1px solid}
    .facts{position:absolute;left:96px;right:96px;bottom:48px;display:flex;justify-content:space-between;font-size:22px}
    .facts b{color:#c9d1e8}
  </style></head><body><div class="grid"></div><div class="wrap">${mark(120)}
    <h1 class="grad">${NAME}</h1><div class="tag">${TAGLINE}</div>
    <div class="chips">${chips}</div></div>
    <div class="facts"><span>${FACTS}</span><b>github.com/bompus/${NAME}</b></div></body></html>`;

// Banners are 1280x320 pages at 2x (2560x640 files); the social preview is 1280x640 at 1x.
const pages = [
  { file: "banner-dark.png", html: banner("dark"), width: 1280, height: 320, scale: 2 },
  { file: "banner-light.png", html: banner("light"), width: 1280, height: 320, scale: 2 },
  { file: "social-preview.png", html: socialPreview, width: 1280, height: 640, scale: 1 },
];

const work = mkdtempSync(join(tmpdir(), "swarmail-assets-"));
try {
  for (const page of pages) {
    const htmlPath = join(work, page.file.replace(/\.png$/, ".html"));
    writeFileSync(htmlPath, page.html);
    const out = join(outDir, page.file);
    const run = Bun.spawnSync([
      chrome,
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(work, "profile")}`,
      `--window-size=${page.width},${page.height}`,
      `--force-device-scale-factor=${page.scale}`,
      `--screenshot=${out}`,
      `file://${htmlPath}`,
    ]);
    // Thrown, not process.exit, so the finally block still removes the work directory.
    if (run.exitCode !== 0) {
      throw new Error(`Chrome exited ${run.exitCode} on ${page.file}:\n${run.stderr.toString()}`);
    }
    console.log(`wrote ${out}`);
  }
  // Beside the images, so `bun run check` can tell when the text or an image has changed since they were drawn.
  const images = Object.fromEntries(
    IMAGES.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(outDir, file)))
        .digest("hex"),
    ]),
  );
  writeFileSync(
    join(outDir, "source.json"),
    JSON.stringify({ ...assetText(), images }, null, 2) + "\n",
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
