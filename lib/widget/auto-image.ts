"use client";

/**
 * 桌面小组件：把配图自动摆进模板。
 *
 * 为什么要这一层：
 *   模板是整段 HTML，用户不该为了「放张图」去手写占位符和 CSS——
 *   那等于逼每个人先学一遍才用得上配图。这里在渲染前按用户选的位置
 *   把图插进模板，用户点一下选图就完事。
 *
 * 插入位置怎么找（按可靠性排序）：
 *   ① 模板里已经有 class="card"/"widget"/"content" 之类的容器 → 插进去；
 *   ② 找到第一个布局容器（flex/grid 的 div）→ 往里插；
 *   ③ 实在找不到 → 直接把原模板整体包一层，绝不去猜着改用户的结构。
 *
 * 关键约束：只插不改。用户的原有标签、class、<style> 一律原样保留，
 * 所以自动摆放不会把已经调好的样式弄坏。
 */

import type { WidgetImageMode } from "./types";

/** 配图块自己的 class，方便用户在附加 CSS 里微调大小/圆角。 */
export const WIDGET_IMAGE_CLASS = "ws-auto-image";

/** 铺满整张卡的背景层：绝对定位 + object-fit，文字靠它上面的原内容压住。 */
const BACKGROUND_LAYER_CSS = [
  "position:absolute",
  "inset:0",
  "width:100%",
  "height:100%",
  "object-fit:cover",
  "z-index:0",
  "pointer-events:none",
].join(";");

/** 图文条：给定宽度方向的 flex 值和高度。 */
function bandStyle(mode: WidgetImageMode): string {
  switch (mode) {
    case "top":
    case "bottom":
      return "width:100%;height:42%;object-fit:cover;flex:0 0 auto";
    case "left":
    case "right":
      return "height:100%;width:42%;object-fit:cover;flex:0 0 auto";
    default:
      return "";
  }
}

/** 构造配图标签。src 交给调用方填（渲染时是 data URL，预览时可以是占位色块）。 */
export function buildImageTag(mode: WidgetImageMode): string {
  if (mode === "off" || mode === "background") {
    // background 单独处理（需要包一层），这里只给 off 兜底
    return "";
  }
  return `<img class="${WIDGET_IMAGE_CLASS}" data-image-mode="${mode}" src="{{image}}" style="${bandStyle(mode)}" alt="">`;
}

/**
 * 封面类元素的选择器关键词。
 * 音乐播放器叫 cover/album/art，头像位叫 avatar，缩略图叫 thumb——
 * 用户模板里基本都是这几个词，按顺序试，先命中先用。
 */
const COVER_SELECTORS = [
  "cover", "album", "artwork", "avatar", "thumb", "photo", "pic",
];

/**
 * 把配图填进模板里已有的「封面方块」。
 *
 * 思路和别的模式不同：不插新元素，而是找到那个本来显示占位图/色块的
 * 元素，把它的 background 换成这张图。这样音乐播放器的封面位、
 * 头像位都能直接被自己的图顶掉，而版式一点不动。
 *
 * 找法（两层）：
 *   ① 模板 <style> 里有 `.cover { background: ... }` 这类规则 → 直接改规则；
 *   ② 没有内联规则 → 找 class 命中的元素，给它补一个 style 背景。
 * 都没命中就退化成背景模式（用户至少能看到图）。
 */
function placeAsCover(html: string): string {
  const imageValue = "url({{image}}) center/cover no-repeat";

  // ① 改 <style> 里的规则：只改命中的第一条，避免把所有同名规则全铺上图
  for (const key of COVER_SELECTORS) {
    const ruleRe = new RegExp(
      `(\\.${key}[\\w-]*)\\s*\\{([^}]*)\\}`,
      "i",
    );
    const ruleMatch = ruleRe.exec(html);
    if (!ruleMatch) continue;
    const [whole, selector, body] = ruleMatch;

    // 已经有了 background-image 就替换掉，没有就追加
    let nextBody: string;
    if (/\bbackground(-image)?\s*:/i.test(body)) {
      nextBody = body.replace(
        /\bbackground(-image)?\s*:[^;]*;?/i,
        `background: ${imageValue};`,
      );
    } else {
      nextBody = `${body.trim().replace(/;*$/, "")};background: ${imageValue};`;
    }
    // 背景图要能裁切进方块，圆角才不会是直角的图
    if (!/background-size\s*:/i.test(nextBody)) nextBody += ";background-size:cover;background-position:center";
    if (!/overflow\s*:/i.test(nextBody)) nextBody += ";overflow:hidden";

    return html.slice(0, ruleMatch.index) + `${selector}{${nextBody}}` + html.slice(ruleMatch.index + whole.length);
  }

  // ② 没有内联规则：给命中的元素补 style
  for (const key of COVER_SELECTORS) {
    const elRe = new RegExp(
      `<([a-zA-Z][\\w-]*)\\b([^>]*\\bclass\\s*=\\s*["'][^"']*\\b${key}[^"']*["'][^>]*)>`,
      "i",
    );
    const elMatch = elRe.exec(html);
    if (!elMatch) continue;
    const openTag = elMatch[0];
    if (/\bstyle\s*=\s*["']/i.test(openTag)) {
      const patched = openTag.replace(
        /(\bstyle\s*=\s*["'])([^"']*)(["'])/i,
        (_m, open: string, css: string, close: string) => {
          const trimmed = css.trim().replace(/;+$/, "");
          return `${open}${trimmed ? trimmed + ";" : ""}background:${imageValue};background-size:cover;background-position:center;${close}`;
        },
      );
      return html.slice(0, elMatch.index) + patched + html.slice(elMatch.index + openTag.length);
    }
    const patched = openTag.replace(/>$/, ` style="background:${imageValue};background-size:cover;background-position:center;">`);
    return html.slice(0, elMatch.index) + patched + html.slice(elMatch.index + openTag.length);
  }

  // ③ 都没命中：退回背景模式，至少能看到图
  return autoPlaceImage(html, "background");
}

/** 找到模板里最外层的一个「内容容器」开标签，返回插入点（标签结束处）。 */
function findContainerInsertPoint(html: string): number {
  // 优先看这几个常见的容器 class（用户模板和内置模板都用得到）
  const preferred = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(card|widget|content|wrap|root|container)\b[^"']*["'][^>]*>/i;
  const preferredMatch = preferred.exec(html);
  if (preferredMatch) return preferredMatch.index + preferredMatch[0].length;

  // 退一步：找任意一个带 flex / grid 的 div（说明它本来就是排版容器）
  const flexLike = /<div\b[^>]*\bstyle\s*=\s*["'][^"']*\b(display\s*:\s*(?:flex|grid))\b[^"']*["'][^>]*>/i;
  const flexMatch = flexLike.exec(html);
  if (flexMatch) return flexMatch.index + flexMatch[0].length;

  // 再退：第一个 div
  const anyDiv = /<div\b[^>]*>/i.exec(html);
  if (anyDiv) return anyDiv.index + anyDiv[0].length;

  return -1;
}

/**
 * 给目标容器的开标签补上「relative + flex 方向」。
 *
 * background 模式需要容器 position:relative 才能让绝对定位的背景层贴合；
 * top/bottom 需要纵向排列，left/right 需要横向排列。
 * 只在容器的 style 里补，不新建包裹层，用户原有布局的其余属性保持不动。
 */
function ensureContainerLayout(html: string, insertAt: number, mode: WidgetImageMode): string {
  // insertAt 指向开标签之后，往前找回这个开标签
  const tagEnd = insertAt;
  const tagStart = html.lastIndexOf("<", tagEnd - 1);
  if (tagStart < 0) return html;
  const tag = html.slice(tagStart, tagEnd);

  const needFlex = mode !== "background";
  const direction = mode === "top" ? "column" : mode === "bottom" ? "column-reverse"
    : mode === "left" ? "row" : mode === "right" ? "row-reverse" : "";

  const extra: string[] = [];
  // 已经有 position 就别覆盖（用户可能故意设了 absolute / fixed）
  if (mode === "background" && !/(^|[;"'\s])position\s*:/i.test(tag)) extra.push("position:relative");
  if (needFlex) {
    if (!/(^|[;"'\s])display\s*:/i.test(tag)) extra.push("display:flex");
    if (direction && !/(^|[;"'\s])flex-direction\s*:/i.test(tag)) extra.push(`flex-direction:${direction}`);
  }
  if (extra.length === 0) return html;

  // 已经有 style 属性：追加到它末尾
  if (/\bstyle\s*=\s*["']/i.test(tag)) {
    const patchedTag = tag.replace(
      /(\bstyle\s*=\s*["'])([^"']*)(["'])/i,
      (_m, open: string, css: string, close: string) => {
        const trimmed = css.trim().replace(/;+$/, "");
        const merged = trimmed ? `${trimmed};${extra.join(";")}` : extra.join(";");
        return `${open}${merged}${close}`;
      },
    );
    return html.slice(0, tagStart) + patchedTag + html.slice(tagEnd);
  }

  // 没有 style：补一个
  const patchedTag = tag.replace(/>$/, ` style="${extra.join(";")};">`);
  return html.slice(0, tagStart) + patchedTag + html.slice(tagEnd);
}

/**
 * 把配图摆进模板。返回新 HTML；mode 为 off 或没有图时原样返回。
 *
 * @param html  用户模板（还会再交给 renderWidgetHtml 填充其余占位符）
 * @param mode  摆放位置
 */
export function autoPlaceImage(html: string, mode: WidgetImageMode): string {
  if (mode === "off" || !html.trim()) return html;

  // 封面模式分两条完全不同的路：改已有元素的背景，而不是插新元素
  if (mode === "cover") return placeAsCover(html);

  const tag = mode === "background"
    ? `<img class="${WIDGET_IMAGE_CLASS}" data-image-mode="background" src="{{image}}" style="${BACKGROUND_LAYER_CSS}" alt="">`
    : buildImageTag(mode);

  if (!tag) return html;

  const insertAt = findContainerInsertPoint(html);
  if (insertAt < 0) {
    // 找不到容器：整份模板包一层，绝不猜着动用户结构
    const layer = mode === "background"
      ? `<img class="${WIDGET_IMAGE_CLASS}" data-image-mode="background" src="{{image}}" style="${BACKGROUND_LAYER_CSS}" alt="">`
      : tag;
    return `<div style="position:relative;width:100%;height:100%;display:flex;flex-direction:column;">${layer}${html}</div>`;
  }

  const withLayout = ensureContainerLayout(html, insertAt, mode);
  // 补完 style 会让开标签变长，插入点要跟着偏移
  const shift = withLayout.length - html.length;
  const at = insertAt + shift;
  return withLayout.slice(0, at) + tag + withLayout.slice(at);
}

/**
 * 判断模板里是不是已经手动写了配图占位符。
 * 写了就说明用户自己安排了位置，设置页应该提示切换到「不自动摆」。
 */
export function templateUsesImagePlaceholder(html: string): boolean {
  return /\{\{\s*(image|imageInner|imageCss)\s*\}\}/.test(html);
}
