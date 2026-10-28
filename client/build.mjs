// Build do cliente da versão externa (Bun.build + Tailwind), com a
// mesma configuração do build canônico do SDK: bundle de produção,
// assets com hash em assets/ e correção dos URLs de assets importados.
import { cp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";
const PDFJS_ASSET_ROOT = "./assets/pdfjs/";

await rm(OUTDIR, { force: true, recursive: true });
const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("buildClient() failed; see logged diagnostics");
}
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));
let needsPdfjsAssets = false;
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  needsPdfjsAssets ||= text.includes(PDFJS_ASSET_ROOT);
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}
if (needsPdfjsAssets) {
  await cp(join(import.meta.dir, "pdfjs-assets"), join(OUTDIR, "assets", "pdfjs"), { recursive: true });
}
console.log("client build OK:", OUTDIR);
