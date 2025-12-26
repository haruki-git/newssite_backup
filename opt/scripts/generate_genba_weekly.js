// /opt/tshare-api/scripts/generate_genba_weekly.js
import fs from "fs";
import path from "path";
import "dotenv/config";
import OpenAI from "openai";

const DATA_DIR = "/opt/tshare-api/data";
const QUEUE_FILE = path.join(DATA_DIR, "genba_queue.json");
const SKIP_FILE = path.join(DATA_DIR, "genba_skipped.json");
const EMB_CACHE_FILE = path.join(DATA_DIR, "genba_embeddings.json");

// 出力先
const OUT_DIR = "/var/www/html/posts/genba";

// モデル（2段構え）
const MODEL_DRAFT = process.env.GENBA_MODEL_DRAFT || "gpt-5-mini";
const MODEL_FINAL = process.env.GENBA_MODEL_FINAL || "gpt-5.2";

// embeddings
const EMBED_MODEL = process.env.GENBA_EMBED_MODEL || "text-embedding-3-small";
const DUP_TH = Number(process.env.GENBA_DUP_SIM_THRESHOLD || 0.88);

// === 出力安定化（重要）===
// 1枚HTMLを一撃生成すると途中で切れやすいので、セクション単位で作る
const FINAL_SECTION_TOKENS = Number(process.env.GENBA_FINAL_SECTION_TOKENS || 1800);
const FINAL_SECTION_RETRY_TOKENS = Number(process.env.GENBA_FINAL_SECTION_RETRY_TOKENS || 900);
const MAX_SECTIONS = Number(process.env.GENBA_MAX_SECTIONS || 12); // 念のため上限

function jstNowIso() {
  const ms = Date.now() + 9 * 60 * 60 * 1000;
  return new Date(ms).toISOString().replace("Z", "+09:00");
}
function jstDateString() {
  return jstNowIso().slice(0, 10);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

function normTitle(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[—–-]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim();
}

function extractTitleAndHeads(html) {
  const h1 = (html.match(/<h1[^>]*>(.*?)<\/h1>/is)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .trim();
  const title = (html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] ?? "").trim();
  const heads = Array.from(html.matchAll(/<h3[^>]*>(.*?)<\/h3>/gis))
    .slice(0, 12)
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  return { title: h1 || title, heads };
}

function listExistingSummaries() {
  ensureDir(OUT_DIR);
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".html") && f !== "index.html");
  const items = [];
  for (const f of files) {
    const p = path.join(OUT_DIR, f);
    const html = fs.readFileSync(p, "utf-8");
    const { title, heads } = extractTitleAndHeads(html);
    if (title) items.push({ file: f, title, heads });
  }
  return items;
}

function safeFilename(id) {
  const date = jstDateString();
  const short = String(id || Date.now()).replace(/\D/g, "").slice(-6) || String(Date.now()).slice(-6);
  return `genba_${date}_${short}.html`;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintFromHtml(html) {
  const { title, heads } = extractTitleAndHeads(html);
  const body = stripHtml(html).slice(0, 2200);
  return [`TITLE:${title}`, `H3:${heads.join(" / ")}`, `BODY:${body}`].join("\n");
}

function fingerprintFromDraft(theme, draftText) {
  const clipped = String(draftText || "").slice(0, 2600);
  return `THEME:${theme}\nDRAFT:${clipped}`;
}

function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i],
      y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedText(client, text) {
  const s = String(text || "").trim();
  const input = s.length ? s : " ";
  const r = await client.embeddings.create({
    model: EMBED_MODEL,
    input,
    encoding_format: "float",
  });
  const v = r?.data?.[0]?.embedding;
  if (!Array.isArray(v)) throw new Error("embedding missing/invalid");
  return v;
}

function extractMarkdownTitle(md) {
  const m = String(md || "").match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : "";
}

function removeGenbaMemoPrefixTitleText(t) {
  return String(t || "")
    .replace(/^\s*現場メモ\s*[:：]\s*/i, "")
    .trim();
}

function sanitizeFinalHtml(raw) {
  let html = String(raw || "").trim();
  html = html.replace(/^```html\s*/i, "").replace(/```$/i, "").trim();
  const idx = html.indexOf("<!DOCTYPE html");
  if (idx >= 0) html = html.slice(idx).trim();
  return html;
}

function patchTitleAndH1(html) {
  const h1m = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  const curH1 = h1m ? h1m[1].replace(/<[^>]+>/g, "").trim() : "";
  const newTitleText = removeGenbaMemoPrefixTitleText(curH1);
  if (!newTitleText) return html;
  html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${newTitleText}</title>`);
  html = html.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/i, `$1${newTitleText}$3`);
  return html;
}

function ensureHomeNav(html) {
  const hasHeader = /<header[\s>]/i.test(html);
  if (!hasHeader) return html;
  const headerBlock = html.match(/<header[\s\S]*?<\/header>/i)?.[0];
  if (!headerBlock) return html;
  if (/<nav[\s>]/i.test(headerBlock)) return html;

  const nav = `<nav><a href="/index.html">Home</a></nav>`;
  const patchedHeader = headerBlock.replace(/<\/h1>\s*/i, `</h1>\n${nav}\n`);
  return html.replace(headerBlock, patchedHeader);
}

function appendSkip(job, reason) {
  const arr = readJson(SKIP_FILE, []);
  const list = Array.isArray(arr) ? arr : [];
  list.unshift({
    ...job,
    skippedAtJST: jstNowIso(),
    reason,
  });
  writeJsonAtomic(SKIP_FILE, list.slice(0, 200));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- Responses API helper ----
function getOutputText(resp) {
  if (!resp) return "";
  if (typeof resp.output_text === "string") return resp.output_text;
  // 念のため output 配列も見る（SDK/バージョン差異対策）
  const out = resp.output;
  if (!Array.isArray(out)) return "";
  const parts = [];
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

function logResp(label, resp) {
  const st = resp?.status;
  const inc = resp?.incomplete_details;
  const id = resp?.id;
  if (st || inc || id) {
    console.log(`[${label}] status=${st || "-"} id=${id || "-"} incomplete=${inc ? JSON.stringify(inc) : "null"}`);
  }
}

async function callText(client, { model, input, max_output_tokens, label }) {
  const resp = await client.responses.create({
    model,
    input,
    max_output_tokens,
  });
  logResp(label || model, resp);
  return { resp, text: getOutputText(resp).trim() };
}

// ---- Markdown -> sections parsing ----
function parseMarkdownSections(md) {
  const s = String(md || "");
  const lines = s.split(/\r?\n/);

  // タイトル（# ...）
  const title = removeGenbaMemoPrefixTitleText(extractMarkdownTitle(s)) || "";

  // 投稿日の行は拾うだけ（使わなくてもOK）
  const dateLine = lines.find((l) => /^\s*投稿日[:：]/.test(l))?.trim() || "";

  // "## " 見出しでセクション分割
  // - 「目次」は無視（こちらでHTML目次を作る）
  // - 「チェックリスト」は最後に回す
  const sections = [];
  let cur = null;

  const pushCur = () => {
    if (!cur) return;
    const body = cur.bodyLines.join("\n").trim();
    sections.push({ heading: cur.heading.trim(), body });
    cur = null;
  };

  for (const line of lines) {
    const m = line.match(/^\s*##\s+(.+?)\s*$/);
    if (m) {
      pushCur();
      cur = { heading: m[1], bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  pushCur();

  // 目次・チェックリストを仕分け
  const tocIdx = sections.findIndex((x) => /目次/.test(x.heading));
  if (tocIdx >= 0) sections.splice(tocIdx, 1);

  let checklist = null;
  const clIdx = sections.findIndex((x) => /チェックリスト/.test(x.heading));
  if (clIdx >= 0) {
    checklist = sections.splice(clIdx, 1)[0];
  }

  // 上限
  const mainSections = sections.slice(0, MAX_SECTIONS);

  return { title, dateLine, mainSections, checklist };
}

function sanitizeFragmentHtml(raw) {
  let html = String(raw || "").trim();
  html = html.replace(/^```html\s*/i, "").replace(/```$/i, "").trim();

  // 事故防止：section/h3ごと返してきたら剥がす
  html = html.replace(/^\s*<section[^>]*>\s*/i, "");
  html = html.replace(/\s*<\/section>\s*$/i, "");
  html = html.replace(/^\s*<h3[^>]*>[\s\S]*?<\/h3>\s*/i, "");

  return html.trim();
}

async function renderSectionInnerHtml(client, { heading, bodyMd, published, title, sectionIndex }) {
  const basePrompt =
    `あなたは日本語の技術記事編集者です。\n` +
    `次のMarkdownセクションを、サイト用のHTML断片に変換してください。\n\n` +
    `条件:\n` +
    `- 出力は「このセクションの本文部分」だけ（<section>タグ、<!DOCTYPE>、<html>、<body>、<h3>は出力しない）\n` +
    `- 見出しは既にこちらで <h3>${escapeHtml(heading)}</h3> を置くので、繰り返さない\n` +
    `- 段落は <p>、箇条書きは <ul><li>、手順は <ol><li>\n` +
    `- コードは必ず <pre><code> ... </code></pre>\n` +
    `- 破壊的操作が出る場合は強い注意書きを入れる\n` +
    `- 長くなりすぎない（現場で読める長さ）\n` +
    `- 余計な前置きや「ここから解説します」は書かない\n\n` +
    `記事タイトル: ${title}\n` +
    `投稿日: ${published}\n` +
    `セクション: ${sectionIndex}\n\n` +
    `Markdown:\n` +
    `${bodyMd}\n`;

  // 1回目（通常）
  const { resp, text } = await callText(client, {
    model: MODEL_FINAL,
    input: basePrompt,
    max_output_tokens: FINAL_SECTION_TOKENS,
    label: `final-sec-${sectionIndex}`,
  });

  let frag = sanitizeFragmentHtml(text);
  if (frag && resp?.status !== "incomplete") return frag;

  // incomplete or empty -> 短縮してリトライ
  const retryPrompt =
    basePrompt +
    `\n追加指示:\n` +
    `- 重要点だけに絞って短くまとめる\n` +
    `- 例は1つに絞る\n`;

  const { text: text2 } = await callText(client, {
    model: MODEL_FINAL,
    input: retryPrompt,
    max_output_tokens: FINAL_SECTION_RETRY_TOKENS,
    label: `final-sec-${sectionIndex}-retry`,
  });

  frag = sanitizeFragmentHtml(text2);
  return frag || `<p>（生成に失敗しました。後で追記してください）</p>`;
}

function buildHtmlSkeleton({ title, published, tocItems, sectionsHtml, checklistHtml }) {
  const toc = `<ul>\n${tocItems
    .map((x) => `  <li><a href="#${x.id}">${escapeHtml(x.label)}</a></li>`)
    .join("\n")}\n</ul>`;

  const article = `
    <article class="card">
      <header>
        <h1>${escapeHtml(title)}</h1>
        <nav><a href="/index.html">Home</a></nav>
        <p class="meta">投稿日：${escapeHtml(published)}</p>
      </header>

      <section id="sec-toc">
        <h2>目次</h2>
        ${toc}
      </section>

      ${sectionsHtml.join("\n\n")}

      ${checklistHtml ? checklistHtml : ""}
    </article>
  `.trim();

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <main class="container">
    ${article}
  </main>
</body>
</html>
  `.trim();
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing");
    process.exit(1);
  }

  ensureDir(DATA_DIR);
  ensureDir(OUT_DIR);

  const queue = readJson(QUEUE_FILE, []);
  if (!Array.isArray(queue) || queue.length === 0) {
    console.log("queue is empty. done.");
    return;
  }

  const job = queue[0];
  const theme = String(job?.theme ?? "").trim();
  if (!theme) {
    console.error("invalid queue item (theme empty)");
    appendSkip(job, "theme empty");
    writeJsonAtomic(QUEUE_FILE, queue.slice(1));
    return;
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 既存記事のタイトル/見出し
  const existing = listExistingSummaries();
  const existingTitles = existing.map((x) => x.title).filter(Boolean);
  const existingNorm = new Set(existingTitles.map(normTitle));

  // ---- embeddings cache load & build ----
  const cache = readJson(EMB_CACHE_FILE, { items: [] });
  cache.items = Array.isArray(cache.items) ? cache.items : [];
  const map = new Map(cache.items.map((x) => [x.file, x]));
  const updatedItems = [];

  for (const it of existing) {
    const full = path.join(OUT_DIR, it.file);
    if (!fs.existsSync(full)) continue;

    const html = fs.readFileSync(full, "utf-8");
    const fp = fingerprintFromHtml(html);

    const cur = map.get(it.file);
    if (!cur?.embedding) {
      const vec = await embedText(client, fp);
      map.set(it.file, {
        file: it.file,
        title: it.title || "",
        embedding: vec,
        updatedAtJST: jstNowIso(),
      });
    } else {
      cur.title = it.title || cur.title || "";
      map.set(it.file, cur);
    }
    updatedItems.push(map.get(it.file));
  }
  writeJsonAtomic(EMB_CACHE_FILE, { items: updatedItems });

  async function maxSimilarityForDraft(draftText) {
    const fpDraft = fingerprintFromDraft(theme, draftText);
    const vDraft = await embedText(client, fpDraft);

    let best = { sim: -1, file: "", title: "" };
    for (const x of updatedItems) {
      const v = x?.embedding;
      if (!Array.isArray(v)) continue;
      const sim = cosineSim(vDraft, v);
      if (sim > best.sim) best = { sim, file: x.file, title: x.title || "" };
    }
    return best;
  }

  // -----------------------
  // 1) mini：下書き生成（Markdown）
  // -----------------------
  const draftPrompt =
    `あなたは「IT初心者向けの現場で使える記事」を書く編集者です。\n` +
    `テーマ: ${theme}\n\n` +
    `対象: IT初心者（現場で使える、最初の一歩）\n` +
    `注意: 破壊的操作（削除/上書き/権限変更など）は必ず強い注意書きを入れる。\n\n` +
    `既存記事タイトル（重複禁止）:\n` +
    `${existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "- (なし)"}\n\n` +
    `出力形式（Markdownのみ。余計な前置き禁止）:\n` +
    `1行目: # タイトル（「現場メモ」などの接頭辞は付けない）\n` +
    `次: 投稿日：${jstDateString()}\n` +
    `次: ## 目次（番号付き）\n` +
    `次: 各セクションは ## 見出し\n` +
    `最後: ## チェックリスト（箇条書き）\n\n` +
    `内容は具体例多め。よくある失敗、オプションの意味、現場の判断ポイントも入れる。\n`;

  let draftText = "";
  {
    const { text } = await callText(client, {
      model: MODEL_DRAFT,
      input: draftPrompt,
      max_output_tokens: 2500,
      label: "draft",
    });
    draftText = text.trim();
    if (!draftText) throw new Error("draft is empty");
  }

  // タイトル重複（文字）チェック
  let draftTitle = extractMarkdownTitle(draftText) || theme;
  draftTitle = removeGenbaMemoPrefixTitleText(draftTitle);
  let titleNorm = normTitle(draftTitle);

  // 意味重複チェック
  let best = await maxSimilarityForDraft(draftText);

  const needRetry = existingNorm.has(titleNorm) || best.sim >= DUP_TH;
  if (needRetry) {
    console.log(
      `retry: titleDup=${existingNorm.has(titleNorm)} semanticSim=${best.sim.toFixed(3)} best="${best.title}"`
    );

    const retryPrompt =
      draftPrompt +
      `\n追加指示:\n` +
      `- 既存記事と内容が被らないように、切り口/例/見出し/チェックリストを変える\n` +
      `- 同テーマ連投でも成立するように「別シーン」で書く（例: トラブル一次切り分け、ログ調査、作業前の確認など）\n` +
      (best.title ? `- 特に「${best.title}」と似ないように\n` : "");

    const { text: draftText2 } = await callText(client, {
      model: MODEL_DRAFT,
      input: retryPrompt,
      max_output_tokens: 2500,
      label: "draft-retry",
    });
    if (!draftText2) throw new Error("draft retry is empty");

    const best2 = await maxSimilarityForDraft(draftText2);
    const t2 = removeGenbaMemoPrefixTitleText(extractMarkdownTitle(draftText2) || theme);
    const n2 = normTitle(t2);

    console.log(
      `after retry: semanticSim=${best2.sim.toFixed(3)} best="${best2.title}" titleNormDup=${existingNorm.has(n2)}`
    );

    if (existingNorm.has(n2) || best2.sim >= DUP_TH) {
      appendSkip(job, `duplicate detected (titleDup=${existingNorm.has(n2)} sim=${best2.sim.toFixed(3)} th=${DUP_TH})`);
      writeJsonAtomic(QUEUE_FILE, queue.slice(1));
      console.log("skipped due to duplication. queue pop ok. remaining:", queue.length - 1);
      return;
    }

    draftText = draftText2;
    draftTitle = t2;
    titleNorm = n2;
  }

  // -----------------------
  // 2) 5.2：最終HTML（セクション単位で生成して組み立て）
  // -----------------------
  const filename = safeFilename(job?.id);
  const outPath = path.join(OUT_DIR, filename);
  const published = jstDateString();

  const parsed = parseMarkdownSections(draftText);
  const finalTitle = parsed.title || draftTitle || theme;

  const tocItems = [];
  const sectionsHtml = [];

  const mainSecs = parsed.mainSections;
  for (let i = 0; i < mainSecs.length; i++) {
    const secNo = i + 1;
    const id = `sec-${secNo}`;
    const heading = mainSecs[i].heading;

    tocItems.push({ id, label: heading });

    const inner = await renderSectionInnerHtml(client, {
      heading,
      bodyMd: mainSecs[i].body,
      published,
      title: finalTitle,
      sectionIndex: secNo,
    });

    sectionsHtml.push(`
      <section id="${id}">
        <h3>${escapeHtml(heading)}</h3>
        ${inner}
      </section>
    `.trim());
  }

  // チェックリスト（あれば最後）
  let checklistHtml = "";
  if (parsed.checklist) {
    const id = `sec-${mainSecs.length + 1}`;
    tocItems.push({ id, label: parsed.checklist.heading });

    const inner = await renderSectionInnerHtml(client, {
      heading: parsed.checklist.heading,
      bodyMd: parsed.checklist.body,
      published,
      title: finalTitle,
      sectionIndex: mainSecs.length + 1,
    });

    checklistHtml = `
      <section id="${id}">
        <h3>${escapeHtml(parsed.checklist.heading)}</h3>
        ${inner}
      </section>
    `.trim();
  }

  let html = buildHtmlSkeleton({
    title: finalTitle,
    published,
    tocItems,
    sectionsHtml,
    checklistHtml,
  });

  // 念のため仕上げパッチ
  html = sanitizeFinalHtml(html);
  html = patchTitleAndH1(html);
  html = ensureHomeNav(html);

  // 最低条件チェック
  if (!html.startsWith("<!DOCTYPE html")) throw new Error("final HTML invalid");
  if (!/<link[^>]+href="\/assets\/styles\.css"/i.test(html)) throw new Error("final HTML missing /assets/styles.css link");
  if (!/<\/html>\s*$/i.test(html)) throw new Error("final HTML missing </html>");

  // 保存
  fs.writeFileSync(outPath, html, "utf-8");
  console.log("wrote:", outPath);

  // 新規記事の embedding をキャッシュに追加
  {
    const fpNew = fingerprintFromHtml(html);
    const vNew = await embedText(client, fpNew);
    const newTitle = extractTitleAndHeads(html).title || "";

    const cur = readJson(EMB_CACHE_FILE, { items: [] });
    cur.items = Array.isArray(cur.items) ? cur.items : [];
    cur.items = [
      {
        file: filename,
        title: newTitle,
        embedding: vNew,
        updatedAtJST: jstNowIso(),
      },
      ...cur.items.filter((x) => x.file !== filename),
    ].slice(0, 400);
    writeJsonAtomic(EMB_CACHE_FILE, cur);
  }

  // キューから消す（成功した時だけ）
  writeJsonAtomic(QUEUE_FILE, queue.slice(1));
  console.log("queue pop ok. remaining:", queue.length - 1);
}

main().catch((e) => {
  console.error("ERROR:", e?.stack || String(e));
  process.exit(1);
});
