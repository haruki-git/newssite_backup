(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function setLabelsByDir() {
    const dir = $("langDir").value; // en2ja / ja2en
    // 今回は見た目ラベルは固定（英語/日本語）で運用してもOKだけど、
    // 入力の意味が逆になるのが気になるなら、placeholderを切り替える。
    if (dir === "en2ja") {
      $("enText").placeholder = "英語のエラー文、変数名の説明など";
      $("jaText").placeholder = "ここに日本語訳が出ます";
    } else {
      $("enText").placeholder = "日本語の文章（英訳したい内容）";
      $("jaText").placeholder = "ここに英訳が出ます";
    }
  }

  function getTextsByDir() {
    const dir = $("langDir").value;
    if (dir === "en2ja") {
      return { src: $("enText").value?.trim() ?? "", src_lang: "en", target_lang: "ja" };
    } else {
      // ja2en の場合も入力は enText 側を使う（UIを増やさないため）
      return { src: $("enText").value?.trim() ?? "", src_lang: "ja", target_lang: "en" };
    }
  }

  async function translate() {
    const status = $("translateStatus");
    const out = $("jaText");

    const { src, src_lang, target_lang } = getTextsByDir();

    if (!src) {
      status.textContent = "入力欄にテキストを入れてください。";
      out.value = "";
      return;
    }

    status.textContent = "翻訳中...";
    out.value = "";

    try {
      // 後でPython(FastAPI)側に /api/translate を作る。
      // その時、src_lang/target_lang を見て翻訳するだけでOK。
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: src, src_lang, target_lang })
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`APIエラー: ${res.status} ${body}`);
      }

      const data = await res.json();
      out.value = data.translated ?? "";
      status.textContent = "";
    } catch (e) {
      status.textContent =
        "※翻訳APIはまだ未接続です。後でPython(FastAPI)+Nginxで /api/translate を用意すると動きます。\n" +
        `詳細: ${String(e.message || e)}`;
    }
  }

  function swapTranslate() {
    const a = $("enText").value;
    $("enText").value = $("jaText").value;
    $("jaText").value = a;

    // 方向も反転
    const dir = $("langDir").value;
    $("langDir").value = (dir === "en2ja") ? "ja2en" : "en2ja";
    setLabelsByDir();
  }

  function clearAll() {
    $("enText").value = "";
    $("jaText").value = "";
    $("translateStatus").textContent = "";
  }

  window.addEventListener("DOMContentLoaded", () => {
    $("btnTranslate").addEventListener("click", translate);
    $("btnClearTranslate").addEventListener("click", clearAll);

    const swapBtn = $("btnSwapTranslate");
    if (swapBtn) swapBtn.addEventListener("click", swapTranslate);

    $("langDir").addEventListener("change", setLabelsByDir);
    setLabelsByDir();
  });
})();
