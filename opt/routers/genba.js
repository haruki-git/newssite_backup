// 4) テーマキュー API（Expressに追加）
// あなたのExpress本体ファイル名がここでは不明なので、追加するルータファイルを作って、既存の app に app.use(...) を1行足す方式にします。

import express from "express";
import { FILES, readJson, writeJsonAtomic, nowJstIso, safeText } from "../scripts/common_genba.js";

const router = express.Router();

router.get("/themes", async (_req, res) => {
  const q = await readJson(FILES.QUEUE, []);
  res.json({ status: "ok", items: q });
});

router.post("/themes", async (req, res) => {
  const theme = safeText(req.body?.theme || "");
  if (!theme) return res.status(400).json({ status: "ng", message: "theme is required" });

  const q = await readJson(FILES.QUEUE, []);
  q.push({
    id: `t_${Date.now()}`,
    theme,
    createdAtJST: nowJstIso(),
  });
  await writeJsonAtomic(FILES.QUEUE, q);

  res.json({ status: "ok", queued: true, size: q.length });
});

export default router;
