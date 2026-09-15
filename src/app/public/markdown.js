(function markdownModule(root) {
  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  }

  function safeHref(value) {
    const trimmed = String(value || "").trim();
    if (/^(https?:\/\/|mailto:|\/|#)/i.test(trimmed)) return escapeHtml(trimmed);
    return "#";
  }

  function inline(value) {
    const code = [];
    let output = escapeHtml(value).replace(/`([^`]+)`/g, (_match, content) => {
      const marker = `\u0000CODE${code.length}\u0000`;
      code.push(`<code>${content}</code>`);
      return marker;
    });
    output = output
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
        const target = safeHref(href.replace(/&amp;/g, "&"));
        return `<a href="${target}" rel="noopener noreferrer">${label}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
    return output.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => code[Number(index)]);
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const output = [];
    let paragraph = [];
    let list = null;
    let inFence = false;
    let fenceLanguage = "";
    let fenceLines = [];

    function flushParagraph() {
      if (paragraph.length) output.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
      paragraph = [];
    }
    function flushList() {
      if (!list) return;
      output.push(
        `<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.type}>`,
      );
      list = null;
    }

    for (const line of lines) {
      const fence = line.match(/^```\s*([\w+-]*)\s*$/);
      if (fence) {
        flushParagraph();
        flushList();
        if (inFence) {
          const languageClass = fenceLanguage
            ? ` class="language-${escapeHtml(fenceLanguage)}"`
            : "";
          output.push(
            `<pre><code${languageClass}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`,
          );
          inFence = false;
          fenceLines = [];
          fenceLanguage = "";
        } else {
          inFence = true;
          fenceLanguage = fence[1] || "";
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length;
        output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const type = ordered ? "ol" : "ul";
        if (list && list.type !== type) flushList();
        if (!list) list = { type, items: [] };
        list.items.push((unordered || ordered)[1]);
        continue;
      }
      const quote = line.match(/^>\s?(.+)$/);
      if (quote) {
        flushParagraph();
        flushList();
        output.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        continue;
      }
      flushList();
      paragraph.push(line);
    }
    if (inFence) output.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
    flushParagraph();
    flushList();
    return output.join("\n");
  }

  const api = { escapeHtml, renderMarkdown, safeHref };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NoteVerseMarkdown = api;
})(typeof window !== "undefined" ? window : globalThis);
