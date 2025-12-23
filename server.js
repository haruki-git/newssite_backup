// /opt/tshare-api/server.js
import express from "express";
import fs from "fs";
import path from "path";

const app = express();

// --- boot log ---
console.log("boot: server.js loaded");
console.log("boot: has NEWSAPI_KEY =", !!process.env.NEWSAPI_KEY);
console.log("boot: has OPENAI_API_KEY =", !!process.env.OPENAI_API_KEY);

// --------------------
// health
// --------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasNewsKey: !!process.env.NEWSAPI_KEY,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
  });
});

// --------------------
// /api/digest  (キャッシュを返すだけ)
// --------------------
app.get("/api/digest", (req, res) => {
  try {
    const p = "/opt/tshare-api/data/digest.json";
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return res.json({ status: "ok", ...j });
  } catch {
    return res.status(503).json({
      status: "error",
      message: "digest not generated yet (run tshare-digest.service)",
    });
  }
});

// --------------------
// /api/news  (あなたの既存コードそのまま)
// --------------------
app.get("/api/news", async (req, res) => {
  const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
  if (!NEWSAPI_KEY) {
    return res.status(500).json({ status: "error", message: "NEWSAPI_KEY is missing" });
  }

  const pageSize = Number(req.query.pageSize ?? 3);
  const limit = Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 20)) : 3;

  const debug = String(req.query.debug ?? "") === "1";

  // 優先順：DC → インフラ → セキュリティ → AI（現場寄り）
  const queries = [
    // DC（outage縛り弱め）
    `("data center" OR datacenter OR colocation OR "server room" OR "server rack") AND (power OR cooling OR HVAC OR UPS OR generator OR expansion OR capacity OR MW OR hyperscale OR colo OR outage OR downtime OR incident)`,
    // インフラ
    `(infrastructure OR network OR routing OR firewall OR "load balancer" OR BGP OR DNS OR Linux OR systemd OR Kubernetes OR Docker OR DevOps) AND (outage OR incident OR disruption OR reliability OR latency OR performance)`,
    // セキュリティ
    `(cybersecurity OR ransomware OR breach OR CVE OR "zero-day" OR "incident response" OR phishing OR malware) AND (attack OR exploit OR vulnerability OR patch OR mitigation)`,
    // AI（現場に関係ある話に寄せる）
    `(AI OR "artificial intelligence" OR LLM OR "large language model" OR "machine learning") AND (security OR ops OR infrastructure OR datacenter OR reliability OR monitoring OR incident OR vulnerability)`,
  ];

  // ノイズ除外（強すぎない）
  const noise = `
    -sports -football -soccer -premier -match -vs -lineups
    -travel -holiday -christmas
    -celebrity -fashion
    -movie -music
  `.trim().replace(/\s+/g, " ");

  // タイトル正規化（転載重複を落とす）
  function normTitle(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[—–-]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim();
  }

  async function fetchArticles(q, lang) {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", `${q} ${noise}`);
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", "20");
    url.searchParams.set("searchIn", "title,description");
    if (lang) url.searchParams.set("language", lang);

    // まとめ/PR/ノイズ源はドメインで除外（強い）
    url.searchParams.set(
      "excludeDomains",
      [
        "biztoc.com",
        "globenewswire.com",
        "prnewswire.com",
        "businesswire.com",
        "bringatrailer.com",
        "pypi.org",
        "picxstudio.com",
        "101greatgoals.com",
        "independent.co.uk",
      ].join(",")
    );

    const r = await fetch(url, { headers: { "X-Api-Key": NEWSAPI_KEY } });
    const data = await r.json();
    return { statusCode: r.status, data };
  }

  // “残したい”語（最終採用条件）
  const mustCore = /(data\s*center|datacenter|colocation|server\s*room|server\s*rack|ups|generator|cooling|hvac|power|outage|downtime|capacity|hyperscale|network|routing|firewall|bgp|dns|linux|systemd|kubernetes|docker|devops|ransomware|breach|cve|zero-?day|phishing|incident\s*response|malware)/i;

  // AIは「現場文脈」があるときだけ採る
  const mustAI = /(llm|large\s+language\s+model|machine\s+learning|\bai\b).*(security|ops|infrastructure|network|linux|kubernetes|devops|incident|vulnerability|cve|data\s*center|datacenter|reliability|monitoring)/i;

  // 落とす語
  const ban = /(show\s*hn|hacker\s*news|producthunt|nsfw|headshot|image\s*generator|prompt|lineups|premier|football|soccer|match|vs|holiday|christmas)/i;

  async function run(lang) {
    const picked = [];
    const seenUrl = new Set();
    const seenTitle = new Set();
    const usedBuckets = [];
    const stats = [];

    for (const q of queries) {
      if (picked.length >= limit) break;

      const isAIQuery = /(\bAI\b|artificial intelligence|LLM|large language model|machine learning)/i.test(q);

      const { statusCode, data } = await fetchArticles(q, lang);
      if (statusCode !== 200 || data?.status !== "ok") {
        stats.push({ q, fetched: 0, kept: 0, err: `${statusCode}` });
        continue;
      }

      const list = data.articles ?? [];
      let kept = 0;

      for (const a of list) {
        if (picked.length >= limit) break;
        if (!a?.url) continue;
        if (seenUrl.has(a.url)) continue;

        const text = `${a.title || ""} ${a.description || ""}`.trim();
        if (!text) continue;

        if (ban.test(text)) continue;

        if (!isAIQuery) {
          if (!mustCore.test(text)) continue;
        } else {
          if (!mustAI.test(text)) continue;
        }

        const tnorm = normTitle(a.title);
        if (tnorm && seenTitle.has(tnorm)) continue;

        seenUrl.add(a.url);
        if (tnorm) seenTitle.add(tnorm);

        picked.push(a);
        kept++;
      }

      if (kept > 0) usedBuckets.push(q);
      stats.push({ q, fetched: list.length, kept });
    }

    return { picked, usedBuckets, stats };
  }

  try {
    // 1st pass: 英語優先
    const pass1 = await run("en");

    // 0件なら 2nd pass: 言語指定なし（日本語/多言語も拾う）
    if (pass1.picked.length === 0) {
      const pass2 = await run("");
      return res.json({
        status: "ok",
        totalResults: pass2.picked.length,
        articles: pass2.picked,
        usedBuckets: pass2.usedBuckets,
        ...(debug ? { debug: { pass1: pass1.stats, pass2: pass2.stats } } : {}),
      });
    }

    return res.json({
      status: "ok",
      totalResults: pass1.picked.length,
      articles: pass1.picked,
      usedBuckets: pass1.usedBuckets,
      ...(debug ? { debug: { pass1: pass1.stats } } : {}),
    });
  } catch (e) {
    return res.status(500).json({ status: "error", message: String(e) });
  }
});

// --------------------
// listen
// --------------------
app.listen(3000, "127.0.0.1", () => {
  console.log("API listening on http://127.0.0.1:3000");
});
