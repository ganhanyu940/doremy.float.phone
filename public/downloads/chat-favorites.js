// chat-favorites.js —— 小手机聊天插件：消息收藏（apiVersion 1）
// 安装：聊天 → 设置 → 扩展插件 → 导入插件 → 选择本 .js 文件
// 用法：聊天气泡下方点「☆ 收藏」；聊天顶栏「★ 收藏」打开收藏夹（搜索 / 复制 / 删除 / 导出）
//
// 设计说明（改之前先读）
//  · 只在「有文字的」气泡下加星标：图片、红包、语音这些气泡没有可收藏的正文，
//    硬塞一个星标只会让界面变吵。
//  · 插件私有数据走 ctx.system.storage（按插件 id 分桶，卸载时一并清除），
//    不碰聊天主存储，收藏本身也不会写进聊天记录、不会被 AI 看见。
//  · 收藏上限默认 500 条，超出丢最早的——KV 里塞无上限的数组迟早拖慢启动。
//  · 不是所有版本的长按菜单都会渲染插件项，所以主入口放在气泡下方（坑位一定生效），
//    长按菜单项作为第二条路径同时注册，哪条能出来用哪条。

export default {
  manifest: {
    id: "chat-favorites",
    name: "消息收藏",
    apiVersion: 1,
    version: "1.0.0",
    author: "ganhanyu940",
    description: "把喜欢的、讲得好的消息收起来。气泡下点 ☆ 收藏，顶栏「收藏」里搜索、复制、导出。",
    permissions: ["chat.read", "ui", "storage"],
    settings: [
      { key: "showStar", label: "在消息下方显示收藏星标", type: "boolean", default: true },
      { key: "showHeader", label: "在聊天顶栏显示收藏入口", type: "boolean", default: true },
      { key: "limit", label: "最多收藏条数", type: "number", default: 500, description: "超出后自动丢弃最早的收藏" }
    ]
  },

  setup(ctx) {
    var KEY = "chat_favorites_v1";
    var LIMIT_DEFAULT = 500;

    // ── 设置 ──
    function setting(key, fallback) {
      var v = ctx.system.settings.get(key);
      return v === undefined || v === null ? fallback : v;
    }
    function limit() {
      var n = Number(setting("limit", LIMIT_DEFAULT));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : LIMIT_DEFAULT;
    }

    // ── 存储 ──
    function all() {
      var v = ctx.system.storage.get(KEY);
      return Array.isArray(v) ? v : [];
    }
    function persist(list) {
      ctx.system.storage.set(KEY, list);
      notify();
    }
    function findIndexById(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
      return -1;
    }
    function hasFav(id) {
      return findIndexById(all(), id) >= 0;
    }

    /** 订阅式刷新：气泡星标、顶栏计数、设置区都靠它更新 */
    var listeners = new Set();
    function notify() {
      listeners.forEach(function (fn) {
        try { fn(); } catch (e) { /* 单个监听失败不影响其他 */ }
      });
    }

    // ── 小工具 ──
    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function fmtTime(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      var p = function (n) { return String(n).padStart(2, "0"); };
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // 壳里 / 非 https 场景 clipboard 会被拒，退回老办法
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand("copy");
          ta.remove();
          return ok;
        } catch (e2) {
          return false;
        }
      }
    }

    /** 收藏时记下"是谁说的、在哪个会话"，之后在收藏夹里才有上下文 */
    function resolveWho(sessionId) {
      try {
        var s = ctx.data.sessions.get(sessionId);
        if (!s) return "";
        if (s.isGroup) return s.groupName || "群聊";
        var cid = s.characterId || s.contactId;
        var ch = cid ? ctx.data.characters.get(cid) : null;
        return s.alias || (ch && ch.name) || "";
      } catch (e) {
        return "";
      }
    }

    // ── 收藏 / 取消 ──
    function toggleFavorite(msg, sessionId) {
      var list = all();
      var idx = findIndexById(list, msg.id);
      if (idx >= 0) {
        list.splice(idx, 1);
        persist(list);
        return false;
      }
      list.unshift({
        id: msg.id,
        sessionId: sessionId || msg.sessionId || "",
        who: resolveWho(sessionId || msg.sessionId || ""),
        role: msg.role || "assistant",
        content: String(msg.content || ""),
        at: msg.createdAt || "",
        savedAt: new Date().toISOString()
      });
      var cap = limit();
      if (list.length > cap) list = list.slice(0, cap);
      persist(list);
      return true;
    }

    // ── 样式 ──
    ctx.ui.injectCSS([
      ".chat-fav-star{display:inline-flex;align-items:center;gap:3px;margin-top:3px;padding:1px 8px;",
      "font-size:11px;line-height:1.8;border-radius:999px;cursor:pointer;",
      "border:1px solid color-mix(in srgb,currentColor 16%,transparent);background:transparent;",
      "color:inherit;opacity:.5;transition:opacity .15s ease,color .15s ease}",
      ".chat-fav-star:active{transform:scale(.96)}",
      ".chat-fav-star.is-on{opacity:1;color:#eab308;border-color:color-mix(in srgb,#eab308 45%,transparent)}",
      ".chat-fav-header{display:flex;align-items:center;gap:6px;padding:4px 10px;margin-top:6px;",
      "font-size:12px;border-radius:999px;cursor:pointer;background:transparent;color:inherit;",
      "border:1px solid color-mix(in srgb,currentColor 18%,transparent);opacity:.75}",
      ".chat-fav-header:active{transform:scale(.97)}",
      ".chat-fav-header.has{opacity:1;color:#eab308;border-color:color-mix(in srgb,#eab308 45%,transparent)}",
      ".cf-wrap{display:flex;flex-direction:column;max-height:88vh;min-height:220px}",
      ".cf-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px 10px}",
      ".cf-title{font-size:15px;font-weight:700}",
      ".cf-close{border:none;background:transparent;font-size:13px;opacity:.6;cursor:pointer;padding:4px 6px}",
      ".cf-search{margin:0 16px 10px;padding:9px 12px;font-size:13px;border-radius:10px;",
      "border:1px solid color-mix(in srgb,currentColor 15%,transparent);background:transparent;color:inherit;outline:none}",
      ".cf-list{flex:1;min-height:0;overflow-y:auto;padding:0 10px 4px;display:flex;flex-direction:column;gap:8px}",
      ".cf-item{border-radius:12px;padding:10px 12px;background:color-mix(in srgb,currentColor 5%,transparent)}",
      ".cf-meta{display:flex;align-items:center;justify-content:space-between;font-size:11px;opacity:.6;margin-bottom:4px;gap:8px}",
      ".cf-who{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cf-text{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:5.2em;overflow:hidden;position:relative}",
      ".cf-item.expanded .cf-text{max-height:none}",
      ".cf-tools{display:flex;gap:8px;margin-top:8px}",
      ".cf-tools button{font-size:11.5px;padding:4px 10px;border-radius:999px;cursor:pointer;",
      "border:1px solid color-mix(in srgb,currentColor 16%,transparent);background:transparent;color:inherit}",
      ".cf-tools button.danger{color:var(--c-danger,#e05252);border-color:color-mix(in srgb,var(--c-danger,#e05252) 35%,transparent)}",
      ".cf-foot{display:flex;gap:8px;padding:10px 16px 16px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent)}",
      ".cf-foot button{flex:1;font-size:12.5px;padding:9px 10px;border-radius:10px;cursor:pointer;",
      "border:1px solid color-mix(in srgb,currentColor 16%,transparent);background:transparent;color:inherit;font-weight:600}",
      ".cf-empty{text-align:center;font-size:12.5px;opacity:.55;padding:34px 16px;line-height:1.9}"
    ].join(""));

    // ── 收藏夹浮层 ──
    function openList() {
      var modal = ctx.ui.openModal(function (el, api) {
        el.style.padding = "0";
        el.style.overflow = "hidden";

        var wrap = document.createElement("div");
        wrap.className = "cf-wrap";
        wrap.innerHTML =
          '<div class="cf-head"><span class="cf-title">消息收藏</span>' +
          '<button class="cf-close" data-act="close">关闭</button></div>' +
          '<input class="cf-search" placeholder="搜索内容或名字…">' +
          '<div class="cf-list"></div>' +
          '<div class="cf-foot">' +
          '<button data-act="export">复制全部</button>' +
          '<button data-act="clear" class="danger">清空</button>' +
          "</div>";
        el.appendChild(wrap);

        var listBox = wrap.querySelector(".cf-list");
        var searchInput = wrap.querySelector(".cf-search");
        var keyword = "";

        function render() {
          var list = all();
          var kw = keyword.trim().toLowerCase();
          var shown = kw
            ? list.filter(function (it) {
                return String(it.content || "").toLowerCase().indexOf(kw) >= 0
                  || String(it.who || "").toLowerCase().indexOf(kw) >= 0;
              })
            : list;

          if (list.length === 0) {
            listBox.innerHTML = '<div class="cf-empty">还没有收藏。<br>在喜欢的消息下面点「☆ 收藏」，它就会出现在这里。</div>';
            return;
          }
          if (shown.length === 0) {
            listBox.innerHTML = '<div class="cf-empty">没有匹配「' + esc(keyword) + "」的收藏。</div>";
            return;
          }

          var html = "";
          shown.forEach(function (it) {
            html += '<div class="cf-item" data-id="' + esc(it.id) + '">' +
              '<div class="cf-meta"><span class="cf-who">' + esc(it.who || (it.role === "user" ? "我" : "TA")) + "</span>" +
              '<span class="cf-time">' + esc(fmtTime(it.at || it.savedAt)) + "</span></div>" +
              '<div class="cf-text" data-act="toggle">' + esc(it.content) + "</div>" +
              '<div class="cf-tools">' +
              '<button data-act="copy">复制</button>' +
              '<button data-act="remove" class="danger">删除</button>' +
              "</div></div>";
          });
          listBox.innerHTML = html;
        }

        listBox.addEventListener("click", async function (e) {
          var target = e.target;
          if (!target || target.tagName !== "BUTTON") return;
          var itemEl = target.closest(".cf-item");
          if (!itemEl) return;
          var id = itemEl.getAttribute("data-id");
          var act = target.getAttribute("data-act");
          var list = all();
          var idx = findIndexById(list, id);
          if (idx < 0) return;

          if (act === "copy") {
            var ok = await copyText(list[idx].content || "");
            ctx.ui.toast(ok ? "已复制" : "复制失败，可长按文字手动选择");
            return;
          }
          if (act === "remove") {
            list.splice(idx, 1);
            persist(list);
            ctx.ui.toast("已从收藏里移除");
            render();
          }
        });

        // 点正文展开/收起（长消息默认只露 5 行）
        listBox.addEventListener("click", function (e) {
          var t = e.target;
          if (t && t.classList && t.classList.contains("cf-text")) t.parentElement.classList.toggle("expanded");
        });

        searchInput.addEventListener("input", function () {
          keyword = searchInput.value || "";
          render();
        });

        wrap.addEventListener("click", async function (e) {
          var t = e.target;
          if (!t || t.tagName !== "BUTTON") return;
          var act = t.getAttribute("data-act");
          if (act === "close") { api.close(); return; }
          if (act === "export") {
            var list = all();
            if (list.length === 0) { ctx.ui.toast("还没有收藏"); return; }
            var text = list.map(function (it) {
              return "【" + (it.who || (it.role === "user" ? "我" : "TA")) + "】" +
                fmtTime(it.at || it.savedAt) + "\n" + String(it.content || "").trim();
            }).join("\n\n——\n\n");
            var ok = await copyText(text);
            ctx.ui.toast(ok ? "全部 " + list.length + " 条已复制" : "复制失败");
            return;
          }
          if (act === "clear") {
            if (all().length === 0) { ctx.ui.toast("已经是空的"); return; }
            if (!window.confirm("清空全部收藏？\n清空后找不回来。")) return;
            persist([]);
            ctx.ui.toast("已清空收藏");
            render();
          }
        });

        render();
      });
      return modal;
    }

    // ── 气泡下方星标（主入口） ──
    ctx.ui.slot("message.footer", function (el, props) {
      if (!setting("showStar", true)) return;
      var msg = props && props.message;
      if (!msg || !msg.id) return;
      if (msg.role === "system") return;
      if (!String(msg.content || "").trim()) return;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-fav-star";

      function paint() {
        var on = hasFav(msg.id);
        btn.textContent = on ? "★ 已收藏" : "☆ 收藏";
        btn.classList.toggle("is-on", on);
        btn.title = on ? "取消收藏这条消息" : "收藏这条消息";
      }
      paint();

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var added = toggleFavorite(msg, props.sessionId);
        paint();
        ctx.ui.toast(added ? "已收藏" : "已取消收藏");
      });

      el.appendChild(btn);
      listeners.add(paint);
      return function () {
        listeners.delete(paint);
        btn.remove();
      };
    });

    // ── 聊天顶栏入口 ──
    ctx.ui.slot("chat.header", function (el) {
      if (!setting("showHeader", true)) return;

      var row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:flex-end;padding:0 8px";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-fav-header";
      row.appendChild(btn);
      el.appendChild(row);

      function paint() {
        var n = all().length;
        btn.textContent = n > 0 ? "★ 收藏 " + n : "☆ 收藏";
        btn.classList.toggle("has", n > 0);
        btn.title = "打开消息收藏";
      }
      paint();

      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openList();
      });

      listeners.add(paint);
      return function () {
        listeners.delete(paint);
        row.remove();
      };
    });

    // ── 长按菜单（第二条路径，有的版本不一定渲染插件项） ──
    ctx.ui.messageAction({
      id: "chat-favorites-toggle",
      label: "收藏 / 取消收藏这条消息",
      filter: function (msg) {
        return !!msg && !!msg.id && msg.role !== "system" && !!String(msg.content || "").trim();
      },
      onSelect: function (msg, helpers) {
        var added = toggleFavorite(msg, msg.sessionId);
        helpers.toast(added ? "已收藏" : "已取消收藏");
      }
    });

    // ── 插件设置区：一眼看到条数 + 快捷入口 ──
    ctx.ui.slot("settings.section", function (el) {
      var box = document.createElement("div");
      box.style.cssText = "padding:12px 16px;display:flex;flex-direction:column;gap:10px";
      box.innerHTML =
        '<span class="menu-desc" data-role="cnt"></span>' +
        '<div style="display:flex;gap:10px">' +
        '<button class="ui-btn ui-btn-outline" data-act="open" style="flex:1;min-height:38px;font-weight:600">打开收藏夹</button>' +
        "</div>";
      el.appendChild(box);

      var cnt = box.querySelector('[data-role="cnt"]');
      function paint() {
        var n = all().length;
        cnt.textContent = n > 0
          ? "已收藏 " + n + " 条（上限 " + limit() + " 条）"
          : "还没有收藏；在聊天气泡下方点「☆ 收藏」即可";
      }
      paint();

      box.querySelector('[data-act="open"]').addEventListener("click", function () { openList(); });

      listeners.add(paint);
      return function () {
        listeners.delete(paint);
        box.remove();
      };
    });

    ctx.system.log("消息收藏已加载，当前收藏 " + all().length + " 条");
  }
};
