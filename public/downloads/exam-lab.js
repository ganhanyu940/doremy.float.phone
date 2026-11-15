// exam-lab.js —— 小手机聊天插件：真题分析台（apiVersion 1）
// 安装：聊天 → 设置 → 扩展插件 → 导入插件 → 选择本 .js 文件
// 用法：聊天顶栏点「📄 真题」→ 粘贴题目 → 开始分析 → 拿结论 / 一键接上这个会话
//
// ── 为什么要有这个东西 ────────────────────────────────
// 直接在聊天框粘真题有三个毛病：
//   ① 那份长文本会永久留在聊天历史里，之后每一轮都要重发一遍，
//      一份两万字的真题能让后面每次对话都贵一倍；
//   ② 聊到一半就跑题了，想再回头看结论得往上翻几十屏；
//   ③ 结论躺在对话里，没法复用成下一次的输入。
// 所以这里单独开一个界面做分析：不占聊天历史、结论单独存、
// 需要时把「精简结论」按预算接进当前会话，用完随时摘掉。
//
// ── 两条硬边界（别尝试绕过）──────────────────────────
//  · 插件没有写世界书的权限（ctx 里没有 world 接口）。
//    所以「接进聊天」走的是 ctx.prompts 持久提示词片段——效果一样，
//    但作用域是会话级、且由本插件自己管预算。想进世界书请复制「必背清单」手动录。
//  · 沙盒同环境跑，但没有 PDF 解析能力。PDF 只有两条路：
//    自己用 pdf.js 远程加载（可能被站点 CSP 拦），或从阅读器复制文字粘贴。
//    默认先试 pdf.js，失败立刻降级提示，不假装成功。

export default {
  manifest: {
    id: "exam-lab",
    name: "真题分析台",
    apiVersion: 1,
    version: "1.0.0",
    author: "ganhanyu940",
    description: "单独界面分析真题：不占聊天历史、结论单独存，可把精简结论按预算接进当前会话。",
    permissions: ["ai", "chat.read", "ui", "storage"],
    settings: [
      {
        key: "injectLimit",
        label: "接入会话的 token 预算",
        type: "number",
        default: 2500,
        description: "把结论接进聊天时最多占多少 token。超了自动只留必背清单。建议 2000~4000。"
      },
      {
        key: "showHeader",
        label: "在聊天顶栏显示「📄 真题」入口",
        type: "boolean",
        default: true
      },
      {
        key: "tryPdf",
        label: "选择 PDF 时尝试自动提取文字",
        type: "boolean",
        default: true,
        description: "从 CDN 加载 pdf.js。被站点安全策略拦截时会失败，失败后请从阅读器复制文字。"
      },
      {
        key: "keepCount",
        label: "最多保存多少份真题",
        type: "number",
        default: 20
      }
    ]
  },

  setup(ctx) {
    var KEY = "exam_papers_v1";
    var MAX_RAW = 24000;      // 单份真题原文上限（字符）
    var MAX_CHARS_HARD = 40000;

    // ── 设置 ──
    function numSetting(key, fallback) {
      var v = Number(ctx.system.settings.get(key));
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
    }
    function boolSetting(key, fallback) {
      var v = ctx.system.settings.get(key);
      return v === undefined || v === null ? fallback : v === true;
    }
    function injectLimit() { return Math.max(500, numSetting("injectLimit", 2500)); }
    function keepCount() { return Math.max(3, numSetting("keepCount", 20)); }

    // ── 存储 ──
    function allPapers() {
      var v = ctx.system.storage.get(KEY);
      return Array.isArray(v) ? v : [];
    }
    function savePapers(list) {
      var cap = keepCount();
      ctx.system.storage.set(KEY, list.slice(0, cap));
      notify();
    }
    function findPaper(id) {
      var list = allPapers();
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }
    function removePaper(id) {
      savePapers(allPapers().filter(function (p) { return p.id !== id; }));
    }

    var listeners = new Set();
    function notify() {
      listeners.forEach(function (fn) { try { fn(); } catch (e) { /* 单个监听失败不影响其他 */ } });
    }
    function watch(fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }

    // ── 当前会话（从 chat.header 坑位记住，供面板使用）──
    var currentSessionId = "";
    var currentIsGroup = false;
    /** 已经被本插件注入过提示词的会话集合，用于「摘掉」 */
    var injectedSessions = {};

    // ── 小工具 ──
    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function uid() {
      return "paper-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    }
    function nowIso() { return new Date().toISOString(); }
    function fmtTime(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      var p = function (n) { return String(n).padStart(2, "0"); };
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    function charLen(s) { return Array.from(String(s == null ? "" : s)).length; }

    /** 与宿主 lib/token-counter.ts 同一套口径：中文 1.5 字/token，英文 4 字/token */
    function estimateTokens(text) {
      var t = String(text || "");
      if (!t) return 0;
      var cjk = t.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g);
      var cjkCount = cjk ? cjk.length : 0;
      return Math.ceil(cjkCount / 1.5 + (t.length - cjkCount) / 4);
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand("copy");
          ta.remove();
          return ok;
        } catch (e2) { return false; }
      }
    }

    // ── 样式 ──
    ctx.ui.injectCSS([
      ".el-head{display:flex;align-items:center;gap:6px;padding:4px 10px;margin-top:6px;",
      "font-size:12px;border-radius:999px;cursor:pointer;background:transparent;color:inherit;",
      "border:1px solid color-mix(in srgb,currentColor 18%,transparent);opacity:.75}",
      ".el-head:active{transform:scale(.97)}",
      ".el-head.has{opacity:1;color:#7a5af8;border-color:color-mix(in srgb,#7a5af8 45%,transparent)}",
      ".el-wrap{display:flex;flex-direction:column;max-height:88vh;min-height:320px}",
      ".el-top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px 8px}",
      ".el-title{font-size:15px;font-weight:700}",
      ".el-x{border:none;background:transparent;font-size:13px;opacity:.6;cursor:pointer;padding:4px 6px}",
      ".el-tabs{display:flex;gap:6px;padding:0 16px 10px}",
      ".el-tab{flex:1;font-size:12px;font-weight:700;padding:7px 8px;border-radius:999px;cursor:pointer;",
      "border:none;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;opacity:.7}",
      ".el-tab.on{background:#7a5af8;color:#fff;opacity:1}",
      ".el-body{flex:1;min-height:0;overflow-y:auto;padding:0 16px 14px}",
      ".el-lbl{display:block;font-size:11px;font-weight:700;opacity:.62;margin:10px 0 5px}",
      ".el-in,.el-ta{width:100%;border-radius:10px;padding:9px 11px;font-size:13px;font-family:inherit;",
      "border:1px solid color-mix(in srgb,currentColor 15%,transparent);background:transparent;color:inherit;outline:none}",
      ".el-ta{min-height:160px;resize:vertical;line-height:1.6}",
      ".el-row{display:flex;gap:8px;margin-top:10px}",
      ".el-btn{flex:1;font-size:13px;font-weight:700;padding:10px 12px;border-radius:10px;cursor:pointer;",
      "border:1px solid color-mix(in srgb,currentColor 15%,transparent);background:transparent;color:inherit}",
      ".el-btn.primary{background:#7a5af8;color:#fff;border-color:#7a5af8}",
      ".el-btn:disabled{opacity:.45;cursor:default}",
      ".el-hint{font-size:11px;line-height:1.7;opacity:.6;margin:8px 0 0}",
      ".el-warn{font-size:11.5px;line-height:1.7;padding:8px 10px;border-radius:9px;margin:8px 0 0;",
      "background:color-mix(in srgb,#e0a63c 15%,transparent);color:#b47f10}",
      ".el-card{border-radius:12px;padding:11px 12px;margin-bottom:9px;",
      "background:color-mix(in srgb,currentColor 5%,transparent)}",
      ".el-card-h{font-size:12px;font-weight:800;margin-bottom:5px;opacity:.85}",
      ".el-card-t{font-size:12.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word}",
      ".el-tag{display:inline-block;font-size:10px;font-weight:800;padding:1px 7px;border-radius:6px;margin-right:5px}",
      ".el-must{background:#fde8e8;color:#d9534f}",
      ".el-main{background:#fdf3e0;color:#b47f10}",
      ".el-know{background:color-mix(in srgb,currentColor 10%,transparent);opacity:.75}",
      ".el-paper{display:flex;gap:8px;align-items:flex-start;padding:10px 0;",
      "border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);cursor:pointer}",
      ".el-paper:last-child{border-bottom:none}",
      ".el-paper-main{flex:1;min-width:0}",
      ".el-paper-t{font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".el-paper-s{font-size:11px;opacity:.6;margin-top:2px}",
      ".el-empty{text-align:center;font-size:12.5px;opacity:.55;padding:34px 14px;line-height:1.9}",
      ".el-spin{width:22px;height:22px;border:2.5px solid color-mix(in srgb,currentColor 16%,transparent);",
      "border-top-color:#7a5af8;border-radius:50%;margin:0 auto 10px;animation:elspin .8s linear infinite}",
      "@keyframes elspin{to{transform:rotate(360deg)}}",
      ".el-foot{display:flex;gap:8px;padding:10px 16px 16px;",
      "border-top:1px solid color-mix(in srgb,currentColor 10%,transparent)}",
      ".el-foot .el-btn{font-size:12px}"
    ].join(""));

    // ── 结果解析 ──
    //
    // 用分节纯文本而不是 JSON：模型写 JSON 常漏逗号、混中文引号，
    // 解析极其脆弱；分节文本写错的概率低得多，且失败时还能降级捞。
    function parseAnalysis(raw) {
      var text = String(raw || "").replace(/\r\n/g, "\n").trim();
      if (!text) return null;

      function section(name) {
        var re = new RegExp("@@" + name + "@@\\s*([\\s\\S]*?)(?=@@[A-Z]+@@|$)");
        var m = text.match(re);
        return m ? m[1].trim() : "";
      }

      var out = {
        summary: section("SUMMARY"),
        weak: section("WEAK"),
        cultprit: section("JUDGE"),
        plan: section("PLAN"),
        must: section("MUST"),
        points: []
      };

      var blocks = text.split(/@@POINT@@/).slice(1);
      blocks.forEach(function (block) {
        var body = block.split(/@@END@@/)[0];
        body = body.split(/@@[A-Z]+@@/)[0];
        var p = parsePointBlock(body);
        if (p) out.points.push(p);
      });

      if (!out.summary && !out.weak && !out.plan && !out.must && out.points.length === 0) return null;
      return out;
    }

    function parsePointBlock(body) {
      var fields = {};
      var cur = "";
      String(body).split("\n").forEach(function (line) {
        var t = line.trim().replace(/^[-*·•]\s*/, "");
        if (!t) return;
        var m = t.match(/^(等级|考点|题目|原题|怎么答|答案|为什么考|理由|易错|坑)\s*[：:]\s*([\s\S]*)$/);
        if (m) {
          var k = m[1];
          if (k === "原题" || k === "题目") k = "题目";
          if (k === "答案") k = "怎么答";
          if (k === "理由") k = "为什么考";
          if (k === "坑") k = "易错";
          cur = k;
          fields[k] = m[2].trim();
        } else if (cur) {
          fields[cur] += "\n" + t;
        }
      });
      var title = (fields["考点"] || "").trim();
      if (!title) return null;
      return {
        level: normalizeLevel(fields["等级"]),
        title: title,
        question: (fields["题目"] || "").trim(),
        answer: (fields["怎么答"] || "").trim(),
        why: (fields["为什么考"] || "").trim(),
        trap: (fields["易错"] || "").trim()
      };
    }

    function normalizeLevel(v) {
      var t = String(v || "").trim();
      if (!t) return "";
      if (/必背|必记|必须|核心|重点背/.test(t)) return "必背";
      if (/掌握|理解|熟悉|会/.test(t)) return "掌握";
      if (/了解|知道|次要|一般|不用/.test(t)) return "了解";
      return "";
    }

    function levelClassOf(lv) {
      if (lv === "必背") return "el-must";
      if (lv === "掌握") return "el-main";
      return "el-know";
    }

    // ── 提示词 ──
    var OUTLINE_SPEC = [
      "@@SUMMARY@@",
      "两三句整体判断：这套题主要考了哪几块，难度感受如何",
      "@@WEAK@@",
      "从题目分布推断你可能薄弱的地方，分条写，每条一句话",
      "@@PLAN@@",
      "未来 7 天安排，一天一行，格式：第N天 | 内容 | 大约多少分钟",
      "@@MUST@@",
      "必背清单，一行一条，只写考点名称和一句关键结论，便于复制到别处",
      "@@POINTS@@",
      "@@POINT@@",
      "等级：必背 / 掌握 / 了解，选一个",
      "考点：考点短标题，不超过 20 字",
      "题目：对应的原题（可以简写关键词）",
      "怎么答：能直接写在答题纸上的要点，分条用 ①②③",
      "为什么考：它在这门课里为什么重要，一句话",
      "易错：最容易丢分的地方，一句话；没有就写：无",
      "@@END@@"
    ].join("\n");

    function buildSystemPrompt() {
      return [
        "你是一名考研命题分析助手，专门帮考生分析真题、定位薄弱点、制定复习计划。",
        "你只输出用户要求的分析结果，不寒暄、不解释你的做法、不重复题面。",
        "所有判断都要基于用户给的材料，材料里没有的不要编造。"
      ].join("\n");
    }

    function buildUserPrompt(title, course, raw, focus) {
      return [
        "分析下面这套真题。",
        "",
        "【材料的科目】" + (course || "未注明"),
        "【材料的名称】" + (title || "未命名"),
        focus ? ("【我特别想知道】" + focus) : "",
        "",
        "【分析要求】",
        "1. 逐个考点给等级：必背（要一字不差）、掌握（能说出要点）、了解（有印象即可）。",
        "   宁少勿多——全都标必背等于没标。",
        "2. 薄弱点要基于题目分布推断（哪些章节题多、哪些考点反复出现却只考浅层），",
        "   不要写成空话套话（如「要加强练习」「注意时间管理」）。",
        "3. 7 天计划要具体到考点，每天能落地，总量按每天 60~120 分钟估算。",
        "   不要安排超过考生一天能做完的量。",
        "4. 必背清单要能直接复制去背，不要写解释。",
        "",
        "【输出格式，严格按此，不要加别的】",
        OUTLINE_SPEC,
        "",
        "【真题材料 · 开始】",
        raw,
        "【真题材料 · 结束】",
        "",
        "现在开始输出分析。"
      ].filter(Boolean).join("\n");
    }

    // ── 生成注入文本（按预算裁剪）──
    //
    // 顺序不能改：必背清单最关键，先放；计划其次；逐条解析最占地方，最后放，
    // 预算不够就整段砍掉。这样任何预算下用户都拿到最有用的部分。
    function buildInjectText(paper, budget) {
      var a = paper.analysis || {};
      var parts = [];
      parts.push("【真题分析 · " + (paper.course || "未注明科目") + " · " + (paper.title || "未命名") + "】");

      if (a.summary) parts.push("整体判断：" + a.summary);

      if (a.must) {
        parts.push("必背清单：\n" + a.must);
      }

      if (a.weak) {
        parts.push("我的薄弱点（据题目分布推断）：\n" + a.weak);
      }

      if (a.plan) {
        parts.push("原定 7 天安排：\n" + a.plan);
      }

      var text = parts.join("\n\n");
      if (estimateTokens(text) <= budget) {
        // 还有余量就把逐条解析补上，但只补必背与掌握两项
        var detail = (a.points || []).filter(function (p) {
          return p.level === "必背" || p.level === "掌握";
        }).map(function (p) {
          return "· [" + (p.level || "掌握") + "] " + p.title +
            (p.answer ? "｜" + p.answer.replace(/\n/g, " ") : "");
        }).join("\n");
        if (detail) {
          var withDetail = text + "\n\n考点要点：\n" + detail;
          if (estimateTokens(withDetail) <= budget) return withDetail;
        }
        return text;
      }

      // 超预算：从最不关键的往回收
      var minimal = ["【真题分析 · " + (paper.course || "") + " · " + (paper.title || "") + "】"];
      if (a.must) minimal.push("必背清单：\n" + a.must);
      var m = minimal.join("\n\n");
      if (estimateTokens(m) <= budget) return m;

      // 连必背清单都放不下：硬截断，并明确告诉模型这是截断的
      var cut = "";
      var lines = String(a.must || "").split("\n");
      for (var i = 0; i < lines.length; i++) {
        var next = cut ? cut + "\n" + lines[i] : lines[i];
        if (estimateTokens(next) > budget - 60) break;
        cut = next;
      }
      return "【真题分析 · " + (paper.course || "") + " · " + (paper.title || "") + "】（以下清单因预算限制已截断）\n" + cut;
    }

    // ── 面板：主界面 ──
    var panelOpen = false;

    function openPanel() {
      if (panelOpen) return;
      panelOpen = true;
      var modal = ctx.ui.openModal(function (el, api) {
        el.style.padding = "0";
        el.style.overflow = "hidden";

        var wrap = document.createElement("div");
        wrap.className = "el-wrap";
        el.appendChild(wrap);

        var tab = "new";   // new=新分析 / history=历史
        var busy = false;
        var draft = { title: "", course: "", raw: "", focus: "" };

        function close() {
          panelOpen = false;
          api.close();
        }

        function render() {
          wrap.innerHTML =
            '<div class="el-top"><span class="el-title">真题分析台</span>' +
            '<button class="el-x" data-act="close">关闭</button></div>' +
            '<div class="el-tabs">' +
            '<button class="el-tab' + (tab === "new" ? " on" : "") + '" data-tab="new">新分析</button>' +
            '<button class="el-tab' + (tab === "history" ? " on" : "") + '" data-tab="history">历史 ' + allPapers().length + '</button>' +
            "</div>" +
            '<div class="el-body"></div>' +
            '<div class="el-foot"></div>';

          var body = wrap.querySelector(".el-body");
          var foot = wrap.querySelector(".el-foot");

          if (tab === "new") renderNew(body, foot);
          else renderHistory(body, foot);
        }

        // ── 新分析 ──
        function renderNew(body, foot) {
          var rawLen = charLen(draft.raw);
          body.innerHTML =
            '<label class="el-lbl">科目（可留空）</label>' +
            '<input class="el-in" data-f="course" placeholder="例：教育心理学" value="' + esc(draft.course) + '">' +
            '<label class="el-lbl">这份真题的名称</label>' +
            '<input class="el-in" data-f="title" placeholder="例：2019 年 333 真题 · 第一套" value="' + esc(draft.title) + '">' +
            '<label class="el-lbl">真题内容' +
            '<span style="font-weight:500;opacity:.7">（把 PDF 里的文字复制粘贴进来）</span></label>' +
            '<textarea class="el-ta" data-f="raw" placeholder="粘贴题目文字…&#10;&#10;PDF 里的文字：在阅读器里长按全选 → 复制 → 粘到这里。&#10;拍照的题：先用手机相册里的「提取文字」转成文字再粘。">' + esc(draft.raw) + "</textarea>" +
            '<p class="el-hint">已输入 <b>' + rawLen.toLocaleString("zh-CN") + "</b> 字 · 约 " +
            estimateTokens(draft.raw).toLocaleString("zh-CN") + " token" +
            (rawLen > MAX_RAW ? ' · <span style="color:#d9534f">偏长，建议拆成两半分别分析</span>' : "") + "</p>" +
            '<label class="el-lbl">特别想知道的（可留空）</label>' +
            '<input class="el-in" data-f="focus" placeholder="例：我总在「学习理论」这块丢分，重点看看" value="' + esc(draft.focus) + '">' +
            '<div class="el-row"><button class="el-btn" data-act="pickPdf">从 PDF 提取文字</button></div>' +
            '<p class="el-hint">自动提取依赖从网络加载 PDF 解析库，可能被站点安全策略拦截；失败就直接复制粘贴，效果一样。</p>' +
            '<input type="file" accept="application/pdf,.pdf" class="hidden" data-role="pdfInput" style="display:none">';

          foot.innerHTML =
            '<button class="el-btn" data-act="close2">取消</button>' +
            '<button class="el-btn primary" data-act="run"' + (busy ? " disabled" : "") + ">" +
            (busy ? "分析中…" : "开始分析") + "</button>";

          // 输入同步
          body.querySelectorAll("[data-f]").forEach(function (input) {
            input.addEventListener("input", function () {
              draft[input.getAttribute("data-f")] = input.value;
              if (input.getAttribute("data-f") === "raw") {
                var hint = body.querySelector(".el-hint b");
                if (hint) hint.textContent = charLen(input.value).toLocaleString("zh-CN");
              }
            });
          });

          // PDF 提取
          var pdfInput = body.querySelector('[data-role="pdfInput"]');
          var pickBtn = body.querySelector('[data-act="pickPdf"]');
          if (pickBtn) {
            pickBtn.addEventListener("click", function () {
              if (!boolSetting("tryPdf", true)) {
                ctx.ui.toast("已关闭自动提取；请从阅读器复制文字粘贴");
                return;
              }
              pdfInput.click();
            });
          }
          if (pdfInput) {
            pdfInput.addEventListener("change", function (e) {
              var file = e.target.files && e.target.files[0];
              e.target.value = "";
              if (!file) return;
              extractPdfText(file).then(function (text) {
                if (!text) return;
                draft.raw = text.slice(0, MAX_CHARS_HARD);
                ctx.ui.toast("已提取 " + charLen(draft.raw).toLocaleString("zh-CN") + " 字");
                render();
              }).catch(function (err) {
                ctx.ui.toast("提取失败：" + (err && err.message ? err.message : "未知原因"));
              });
            });
          }

          // 分析进行中：把输入区换成等待态（输入已存进 draft，取消后回来还在）
          if (busy) {
            body.innerHTML = '<div style="text-align:center;padding:50px 14px"><div class="el-spin"></div>' +
              '<div style="font-size:12.5px;opacity:.65">正在分析这套真题…<br>' +
              '<span style="font-size:11px;opacity:.7">通常 10~40 秒，别关这个窗口</span></div></div>';
          }
        }

        // ── 历史 ──
        function renderHistory(body, foot) {
          var list = allPapers();
          if (list.length === 0) {
            body.innerHTML = '<div class="el-empty">还没有分析过真题。<br>到「新分析」粘一份进来试试。</div>';
            foot.innerHTML = '<button class="el-btn" data-act="close2">关闭</button>';
            return;
          }
          body.innerHTML = list.map(function (p) {
            return '<div class="el-paper" data-id="' + esc(p.id) + '">' +
              '<div class="el-paper-main">' +
              '<div class="el-paper-t">' + esc(p.title || "未命名") + "</div>" +
              '<div class="el-paper-s">' + esc(p.course || "未注明科目") + " · " +
              fmtTime(p.createdAt) + " · " +
              ((p.analysis && p.analysis.points) ? p.analysis.points.length : 0) + " 个考点</div>" +
              "</div></div>";
          }).join("");
          foot.innerHTML = '<button class="el-btn" data-act="close2">关闭</button>';

          body.querySelectorAll(".el-paper").forEach(function (row) {
            row.addEventListener("click", function () {
              var p = findPaper(row.getAttribute("data-id"));
              if (p) showResult(p);
            });
          });
        }

        // ── 结果页 ──
        function showResult(paper) {
          var a = paper.analysis || {};
          var html = '<div class="el-top"><span class="el-title">' + esc(paper.title || "分析结果") + "</span>" +
            '<button class="el-x" data-act="back">返回</button></div>' +
            '<div class="el-body">';

          if (a.summary) {
            html += '<div class="el-card"><div class="el-card-h">整体判断</div>' +
              '<div class="el-card-t">' + esc(a.summary) + "</div></div>";
          }
          if (a.weak) {
            html += '<div class="el-card"><div class="el-card-h">薄弱点</div>' +
              '<div class="el-card-t">' + esc(a.weak) + "</div></div>";
          }
          if (a.plan) {
            html += '<div class="el-card"><div class="el-card-h">7 天安排</div>' +
              '<div class="el-card-t">' + esc(a.plan) + "</div></div>";
          }
          if (a.must) {
            html += '<div class="el-card"><div class="el-card-h">必背清单</div>' +
              '<div class="el-card-t">' + esc(a.must) + "</div></div>";
          }

          if ((a.points || []).length) {
            html += '<div class="el-card"><div class="el-card-h">逐条考点（' + a.points.length + "）</div></div>";
            a.points.forEach(function (p) {
              html += '<div class="el-card">' +
                '<div class="el-card-h"><span class="el-tag ' + levelClassOf(p.level) + '">' +
                esc(p.level || "未分级") + "</span>" + esc(p.title) + "</div>" +
                (p.question ? '<div class="el-card-t" style="opacity:.75">题：' + esc(p.question) + "</div>" : "") +
                (p.answer ? '<div class="el-card-t">' + esc(p.answer) + "</div>" : "") +
                (p.why ? '<div class="el-card-t" style="opacity:.7">为什么考：' + esc(p.why) + "</div>" : "") +
                (p.trap && p.trap !== "无" ? '<div class="el-card-t" style="opacity:.7">易错：' + esc(p.trap) + "</div>" : "") +
                "</div>";
            });
          }

          html += "</div>";
          html += '<div class="el-foot">' +
            '<button class="el-btn" data-act="inject">接进聊天</button>' +
            '<button class="el-btn" data-act="copyMust">复制必背清单</button>' +
            '<button class="el-btn" data-act="del">删除</button>' +
            "</div>";

          wrap.innerHTML = html;

          wrap.querySelector('[data-act="back"]').addEventListener("click", function () { render(); });
          wrap.querySelector('[data-act="copyMust"]').addEventListener("click", async function () {
            var text = a.must || "";
            if (!text.trim()) { ctx.ui.toast("这份没有必背清单"); return; }
            var ok = await copyText(text);
            ctx.ui.toast(ok ? "必背清单已复制，可存到世界书或笔记" : "复制失败，可长按选择文字");
          });
          wrap.querySelector('[data-act="inject"]').addEventListener("click", function () {
            injectToSession(paper);
          });
          wrap.querySelector('[data-act="del"]').addEventListener("click", function () {
            if (!window.confirm("删除这份分析？\n删了找不回来。")) return;
            removePaper(paper.id);
            render();
            ctx.ui.toast("已删除");
          });
        }

        // ── 接进当前会话 ──
        function injectToSession(paper) {
          if (!currentSessionId) {
            ctx.ui.toast("请先回到某个聊天里再点这个");
            return;
          }
          var budget = injectLimit();
          var text = buildInjectText(paper, budget);
          var used = estimateTokens(text);
          ctx.prompts.set(text, { sessionId: currentSessionId });
          injectedSessions[currentSessionId] = paper.id;
          notify();
          ctx.ui.toast("已接入当前聊天（约 " + used.toLocaleString("zh-CN") + " token）");
          close();
        }

        // ── 事件 ──
        wrap.addEventListener("click", function (e) {
          var t = e.target;
          if (!t || t.tagName !== "BUTTON") return;
          var act = t.getAttribute("data-act");
          var tabName = t.getAttribute("data-tab");

          if (tabName) { tab = tabName; render(); return; }
          if (act === "close" || act === "close2") { close(); return; }
          if (act === "run") { runAnalysis(); return; }
        });

        // ── 执行分析 ──
        async function runAnalysis() {
          if (busy) return;
          var raw = String(draft.raw || "").trim();
          if (!raw) { ctx.ui.toast("先把真题内容粘进来"); return; }
          if (charLen(raw) > MAX_CHARS_HARD) { ctx.ui.toast("内容太长了，请拆成两半分别分析"); return; }

          busy = true;
          render();

          var toast = ctx.ui.toast("正在分析…", { durationMs: 0 });
          try {
            var result = await ctx.ai.chat({
              system: buildSystemPrompt(),
              prompt: buildUserPrompt(draft.title, draft.course, raw, draft.focus),
              temperature: 0.4,
              maxTokens: 4000
            });

            var parsed = parseAnalysis(result);
            if (!parsed) {
              busy = false;
              render();
              ctx.ui.toast("模型这次没按格式输出，可以再试一次");
              return;
            }

            var paper = {
              id: uid(),
              title: String(draft.title || "").trim() || ("真题 " + fmtTime(nowIso())),
              course: String(draft.course || "").trim(),
              focus: String(draft.focus || "").trim(),
              rawChars: charLen(raw),
              // 原文只留前一段：存整份会让 KV 鼓起来，而重看只需要能认出来是哪份
              rawPreview: raw.slice(0, 600),
              analysis: parsed,
              createdAt: nowIso()
            };

            var list = allPapers();
            list.unshift(paper);
            savePapers(list);

            busy = false;
            draft = { title: "", course: "", raw: "", focus: "" };
            showResult(paper);
          } catch (err) {
            busy = false;
            render();
            ctx.ui.toast("分析失败：" + (err && err.message ? err.message : String(err)));
          } finally {
            toast.close();
          }
        }

        render();
        return function () { panelOpen = false; };
      });
      return modal;
    }

    // ── PDF 提取（尽力而为，失败明确告知）──
    async function extractPdfText(file) {
      if (!boolSetting("tryPdf", true)) throw new Error("已关闭自动提取");
      if (file.size > 20 * 1024 * 1024) throw new Error("PDF 超过 20MB，建议拆分或在阅读器里复制");

      var pdfjs = await loadPdfJs();
      var buf = await file.arrayBuffer();
      var doc = await pdfjs.getDocument({ data: buf }).promise;

      var out = [];
      var maxPages = Math.min(doc.numPages, 60);
      for (var i = 1; i <= maxPages; i++) {
        var page = await doc.getPage(i);
        var content = await page.getTextContent();
        var line = "";
        var lastY = null;
        content.items.forEach(function (item) {
          if (!item || typeof item.str !== "string") return;
          var y = item.transform ? item.transform[5] : null;
          // y 变了视为换行：PDF 的文字流没有换行符，靠坐标还原段落
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
            out.push(line);
            line = "";
          }
          line += item.str;
          if (item.hasEOL) { out.push(line); line = ""; }
          if (y !== null) lastY = y;
        });
        if (line.trim()) out.push(line);
        out.push("");
      }
      try { doc.destroy(); } catch (e) { /* 关闭失败不影响已取到文字 */ }

      var text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!text) throw new Error("这份 PDF 里没有可提取的文字，可能是扫描件；请用相册的「提取文字」");
      if (doc.numPages > maxPages) {
        text += "\n\n（提示：原文共 " + doc.numPages + " 页，只提取了前 " + maxPages + " 页）";
      }
      return text;
    }

    /** 从 CDN 动态加载 pdf.js。站点 CSP 可能拦掉，拦了就抛错让人走复制。 */
    var pdfJsPromise = null;
    function loadPdfJs() {
      if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
      if (pdfJsPromise) return pdfJsPromise;
      pdfJsPromise = new Promise(function (resolve, reject) {
        var src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
        var s = document.createElement("script");
        s.src = src;
        s.onload = function () {
          var lib = window.pdfjsLib;
          if (!lib) { reject(new Error("解析库加载了但不可用")); return; }
          try {
            lib.GlobalWorkerOptions.workerSrc =
              "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
          } catch (e) { /* worker 配不上也先试主线程 */ }
          resolve(lib);
        };
        s.onerror = function () {
          pdfJsPromise = null;
          reject(new Error("加载 PDF 解析库失败（站点可能禁止外部脚本），请直接复制文字粘贴"));
        };
        document.head.appendChild(s);
      });
      return pdfJsPromise;
    }

    // ── 顶栏入口 ──
    ctx.ui.slot("chat.header", function (el, props) {
      if (!boolSetting("showHeader", true)) return;
      currentSessionId = (props && props.sessionId) || currentSessionId;
      currentIsGroup = !!(props && props.isGroup);

      var row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:flex-end;padding:0 8px";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "el-head";
      row.appendChild(btn);
      el.appendChild(row);

      function paint() {
        var n = allPapers().length;
        btn.textContent = n > 0 ? "📄 真题 " + n : "📄 真题分析";
        btn.classList.toggle("has", n > 0);
        btn.title = "打开真题分析台";
      }
      paint();

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        currentSessionId = (props && props.sessionId) || currentSessionId;
        openPanel();
      });

      var off = watch(paint);
      return function () {
        off();
        row.remove();
      };
    });

    // 会话切换时更新 currentSessionId（顶栏坑位会重挂，但多一路更稳）
    ctx.hooks.on("session.opened", function (payload) {
      if (payload && payload.sessionId) {
        currentSessionId = payload.sessionId;
        currentIsGroup = !!payload.isGroup;
      }
    });

    // ── 设置区：显示已接入的会话，可一键摘掉 ──
    ctx.ui.slot("settings.section", function (el) {
      var box = document.createElement("div");
      box.style.cssText = "padding:12px 16px;display:flex;flex-direction:column;gap:8px";
      box.innerHTML =
        '<span class="menu-desc" data-role="cnt"></span>' +
        '<div style="display:flex;gap:10px">' +
        '<button class="ui-btn ui-btn-outline" data-act="open" style="flex:1;min-height:38px;font-weight:600">打开真题分析台</button>' +
        "</div>" +
        '<button class="ui-btn ui-btn-ghost" data-act="clearInject" style="min-height:34px;font-size:12px">摘掉当前聊天的资料</button>';
      el.appendChild(box);

      var cnt = box.querySelector('[data-role="cnt"]');
      function paint() {
        var n = allPapers().length;
        var on = currentSessionId && injectedSessions[currentSessionId];
        cnt.textContent = n > 0
          ? ("已保存 " + n + " 份真题分析" + (on ? "；当前聊天已接入一份（约 " + injectLimit().toLocaleString("zh-CN") + " token 预算）" : ""))
          : "还没有分析过真题；粘一份进来试试";
      }
      paint();

      box.querySelector('[data-act="open"]').addEventListener("click", function () { openPanel(); });
      box.querySelector('[data-act="clearInject"]').addEventListener("click", function () {
        if (!currentSessionId) { ctx.ui.toast("请先进入一个聊天"); return; }
        if (!injectedSessions[currentSessionId]) { ctx.ui.toast("当前聊天没有接入资料"); return; }
        ctx.prompts.clear({ sessionId: currentSessionId });
        delete injectedSessions[currentSessionId];
        paint();
        ctx.ui.toast("已摘掉，聊天恢复原样");
      });

      var off = watch(paint);
      return function () {
        off();
        box.remove();
      };
    });

    ctx.system.log("真题分析台已加载，已有 " + allPapers().length + " 份分析");
  }
};
