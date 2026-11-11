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
/**
 * 封面模式的结果。target 是实际命中/改写的位置，给界面回话用——
 * 「改了但看不出变化」比「明确说没找到」难查得多。
 */
export type CoverPlacement = { html: string; target: string };

/**
 * 把一个 <img> 的 src 换成配图。
 * 这是封面模式最常用的一步：封面/头像往往是内嵌 <img>，
 * 只改外层容器的 background 会被这张图整个盖住，看着像没生效。
 */
function replaceImgSrc(html: string, imgIndex: number): string | null {
  const openEnd = html.indexOf(">", imgIndex);
  if (openEnd < 0) return null;
  const openTag = html.slice(imgIndex, openEnd + 1);
  let patched = /\bsrc\s*=\s*["'][^"']*["']/i.test(openTag)
    ? openTag.replace(/\bsrc\s*=\s*["'][^"']*["']/i, 'src="{{image}}"')
    : openTag.replace(/\s*\/?>$/, ' src="{{image}}">');

  // 图片要填满原方块，别按原尺寸缩在角落
  if (/\bstyle\s*=\s*["']/i.test(patched)) {
    patched = patched.replace(
      /(\bstyle\s*=\s*["'])([^"']*)(["'])/i,
      (_m, open: string, css: string, close: string) => {
        const trimmed = css.trim().replace(/;+$/, "");
        const merged = trimmed ? `${trimmed};` : "";
        return `${open}${merged}object-fit:cover;object-position:center;${close}`;
      },
    );
  } else {
    patched = patched.replace(/\s*\/?>$/, ' style="object-fit:cover;object-position:center;">');
  }
  return html.slice(0, imgIndex) + patched + html.slice(openEnd + 1);
}

/**
 * 把配图填进模板里已有的「封面方块」（专辑图、头像、缩略图位）。
 *
 * 按这个顺序试，命中第一个就停：
 *   ① 封面类元素里如果内嵌 <img> → 换它的 src（最常见，也最不容易被盖住）
 *   ② <style> 里有 .cover/.avatar 之类规则的 background → 改规则
 *   ③ 封面类元素本身没有图片只有背景 → 给它补 inline background
 *   ④ 全都没命中 → 如实报告 target 为空，由调用方决定怎么提示
 */
function placeAsCover(html: string): CoverPlacement {
  const imageValue = "url({{image}}) center/cover no-repeat";

  // ① 元素里内嵌 <img>：换 src
  for (const key of COVER_SELECTORS) {
    const elRe = new RegExp(
      `<([a-zA-Z][\\w-]*)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${key}[^"']*["'][^>]*>`,
      "i",
    );
    const elMatch = elRe.exec(html);
    if (!elMatch) continue;
    const afterOpen = elMatch.index + elMatch[0].length;
    // 在开标签之后找最近的 <img>：封面容器里通常就一张
    const imgIndex = html.indexOf("<img", afterOpen);
    if (imgIndex >= 0) {
      // 粗略判断是不是这个容器的子元素：中间不能已经出现闭合的同级大块
      const between = html.slice(afterOpen, imgIndex);
      if (between.length < 1200 && !/<\/(div|section|article)>/i.test(between)) {
        const replaced = replaceImgSrc(html, imgIndex);
        if (replaced) return { html: replaced, target: `.${key} 里的图片` };
      }
    }
  }

  // ② 改 <style> 里的规则
  for (const key of COVER_SELECTORS) {
    const ruleRe = new RegExp(`(\\.${key}[\\w-]*)\\s*\\{([^}]*)\\}`, "i");
    const ruleMatch = ruleRe.exec(html);
    if (!ruleMatch) continue;
    const [whole, selector, body] = ruleMatch;
    if (!/\bbackground(-image)?\s*:/i.test(body)) continue; // 没背景可改，留给 ③

    const nextBody = body.replace(
      /\bbackground(-image)?\s*:[^;]*;?/i,
      `background: ${imageValue};`,
    ) + ";background-size:cover;background-position:center";

    return {
      html: html.slice(0, ruleMatch.index) + `${selector}{${nextBody}}` + html.slice(ruleMatch.index + whole.length),
      target: `样式规则 ${selector}`,
    };
  }

  // ③ 元素本身：补 inline background
  for (const key of COVER_SELECTORS) {
    const elRe = new RegExp(
      `<([a-zA-Z][\\w-]*)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${key}[^"']*["'][^>]*>`,
      "i",
    );
    const elMatch = elRe.exec(html);
    if (!elMatch) continue;
    const openTag = elMatch[0];
    const patched = /\bstyle\s*=\s*["']/i.test(openTag)
      ? openTag.replace(
        /(\bstyle\s*=\s*["'])([^"']*)(["'])/i,
        (_m, open: string, css: string, close: string) => {
          const trimmed = css.trim().replace(/;+$/, "");
          return `${open}${trimmed ? trimmed + ";" : ""}background:${imageValue};background-size:cover;background-position:center;${close}`;
        },
      )
      : openTag.replace(/\s*\/?>$/, ` style="background:${imageValue};background-size:cover;background-position:center;">`);
    return {
      html: html.slice(0, elMatch.index) + patched + html.slice(elMatch.index + openTag.length),
      target: `.${key}`,
    };
  }

  // ④ 一个封面都没找到
  return { html, target: "" };
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
 * 背景模式：把图设成容器的 background-image。
 *
 * 为什么不插一个绝对定位的 <img>：
 *   那样会被容器/卡片自身的不透明背景盖住——图片确实插进去了，
 *   但用户看到的和没插时一模一样（实测：整块没任何变化，极难排查）。
 *   设成 background-image 则天然位于背景层，卡片原有的
 *   background-color 仍然兜底，视觉效果稳定。
 */
function placeAsBackground(html: string): string {
  const imageCss = "background-image:url({{image}});background-size:cover;background-position:center;";
  const insertAt = findContainerInsertPoint(html);

  if (insertAt < 0) {
    // 连 div 都没有：整份包一层带背景的容器
    return `<div style="width:100%;height:100%;${imageCss}">${html}</div>`;
  }

  const tagStart = html.lastIndexOf("<", insertAt - 1);
  if (tagStart < 0) return html;
  const openTag = html.slice(tagStart, insertAt);

  // 已有 background-image 就替换，没有就追加；background-color 保留作兜底
  let patched: string;
  if (/\bbackground-image\s*:/i.test(openTag)) {
    patched = openTag.replace(/\bbackground-image\s*:[^;"']*;?/i, "background-image:url({{image}});");
  } else if (/\bstyle\s*=\s*["']/i.test(openTag)) {
    patched = openTag.replace(
      /(\bstyle\s*=\s*["'])([^"']*)(["'])/i,
      (_m, open: string, css: string, close: string) => {
        const trimmed = css.trim().replace(/;+$/, "");
        return `${open}${trimmed ? trimmed + ";" : ""}${imageCss}${close}`;
      },
    );
  } else {
    patched = openTag.replace(/\s*\/?>$/, ` style="${imageCss}">`);
  }

  return html.slice(0, tagStart) + patched + html.slice(insertAt);
}

/**
 * 把配图摆进模板。返回新 HTML；mode 为 off 或没有图时原样返回。
 *
 * @param html  用户模板（还会再交给 renderWidgetHtml 填充其余占位符）
 * @param mode  摆放位置
 */
export function autoPlaceImage(html: string, mode: WidgetImageMode): string {
  if (mode === "off" || !html.trim()) return html;

  // 封面模式改已有元素，不插新元素
  if (mode === "cover") {
    // 没找到封面位时不要静默退回背景——那样用户看到整张图铺满会以为搞错了。
    // 原样返回，由界面明确提示「没找到封面位」，用户才知道该去改模板。
    return placeAsCover(html).html;
  }

  // 背景模式设容器背景，不插会被遮住的绝对定位图片
  if (mode === "background") return placeAsBackground(html);

  const tag = buildImageTag(mode);
  if (!tag) return html;

  const insertAt = findContainerInsertPoint(html);
  if (insertAt < 0) {
    // 找不到容器：整份模板包一层，绝不猜着动用户结构
    return `<div style="position:relative;width:100%;height:100%;display:flex;flex-direction:column;">${tag}${html}</div>`;
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

/**
 * 封面模式到底命中没有——给设置页回话用。
 *
 * 为什么不复用 autoPlaceImage：那个函数只返回 HTML，界面没法区分
 * 「改了」和「一个封面位都没找到」。而这正好是用户最容易困惑的两种情况，
 * 必须能分开说清楚。
 */
export function describeCoverPlacement(html: string): { placed: boolean; target: string } {
  if (!html.trim()) return { placed: false, target: "" };
  const placed = placeAsCover(html);
  return { placed: Boolean(placed.target), target: placed.target };
}
