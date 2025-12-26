// 既存記事サマリ集約スクリプト
// 既存の「現場で使える」(index.html list-workに載ってる手動記事)
// 自動生成記事（/var/www/html/posts/genba/*.html）
// をまとめて data/genba_manifest.json にします。

import fs from "fs/promises";
import path from "path";
import { PATHS, FILES, readText, writeJsonAtomic, extractWorkPostHrefs, safeText } from "./common_genba.js";

function extractTitle(html) {
  const m1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m1) return safeText(m1[1].replace(/<[^>]+>/g, ""));
  const m2 = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m2 ? safeText(m2[1]) : "";
}

function extractPublishedDate(html) {
  // あなたの形式: 投稿日：YYYY-MM-DD
  const m = html.match(/投稿日：\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  return m ? m[1] : "";
}

function extractTocLabels(html) {
  // <h3>目次</h3> の直後の <ul> の <a>ラベル を拾う簡易
  const toc = [];
  const block = html.match(/<h3[^>]*>\s*目次\s*<\/h3>[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
  const ul = block ? block[1] : "";
  const re = /<a[^>]*>([\s\S]*?)<\/a>/gi;
  let x;
  while ((x = re.exec(ul))) toc.push(safeText(x[1].replace(/<[^>]+>/g, "")));
  return toc.slice(0, 30);
}

function extractSummary(html) {
  // 最初の <p> からざっくり200〜350字程度
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!m) return "";
  const t = safeText(m[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""));
  return t.slice(0, 360);
}

async function listGenbaAutoPosts() {
  const dir = PATHS.POSTS_DIR;
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join(dir, f));
}

async function readPostAsManifestItem(filePath, source) {
  const html = await readText(filePath);
  const title = extractTitle(html);
  const published = extractPublishedDate(html);
  const toc = extractTocLabels(html);
  const summary = extractSummary(html);

  // web root基準のURLに変換
  const rel = path.relative(PATHS.WEB_ROOT, filePath).replaceAll(path.sep, "/");
  const url = "/" + rel;

  return {
    source,                 // "manual" | "auto"
    title,
    publishedAt: published,
    url,
    filePath,
    toc,
    summary,
    updatedAtJST: new Date().toISOString(),
  };
}

async function main() {
  const indexHtml = await readText(PATHS.INDEX_HTML);
  const hrefs = extractWorkPostHrefs(indexHtml);

  const manualPaths = hrefs
    .map((h) => path.join(PATHS.WEB_ROOT, h))
    .filter((p) => p.endsWith(".html"));

  const autoPaths = await listGenbaAutoPosts();

  const items = [];
  for (const p of manualPaths) {
    try {
      items.push(await readPostAsManifestItem(p, "manual"));
    } catch (e) {
      console.error("[manifest] skip manual:", p, e?.message || e);
    }
  }
  for (const p of autoPaths) {
    try {
      items.push(await readPostAsManifestItem(p, "auto"));
    } catch (e) {
      console.error("[manifest] skip auto:", p, e?.message || e);
    }
  }

  // URLで重複排除
  const uniq = [];
  const seen = new Set();
  for (const it of items) {
    if (!it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    uniq.push(it);
  }

  await writeJsonAtomic(FILES.MANIFEST, uniq);
  console.log(`[manifest] wrote ${uniq.length} items -> ${FILES.MANIFEST}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
