import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function loadTs(relativePath, filename) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleBox = { exports: {} };
  vm.runInNewContext(compiled, {
    module: moduleBox, exports: moduleBox.exports,
    JSON, Array, String, RegExp, Math, Object,
  }, { filename });
  return moduleBox.exports;
}

const { autoPlaceImage, templateUsesImagePlaceholder, WIDGET_IMAGE_CLASS } =
  loadTs("../lib/widget/auto-image.ts", "auto-image.cjs");

// ── 占位符检测 ──
assert.equal(templateUsesImagePlaceholder('<img src="{{image}}">'), true);
assert.equal(templateUsesImagePlaceholder("{{ imageInner }}"), true);
assert.equal(templateUsesImagePlaceholder('style="{{imageCss}}"'), true);
assert.equal(templateUsesImagePlaceholder("<div>{{text}}</div>"), false);

// ── off 模式必须完全不动模板 ──
const plain = '<div class="card"><div class="text">{{text}}</div></div>';
assert.equal(autoPlaceImage(plain, "off"), plain);

// ── 空模板不炸 ──
assert.equal(autoPlaceImage("", "background"), "");

// ── 背景模式：插进 .card，补 position:relative，原内容一字不少 ──
const bg = autoPlaceImage(plain, "background");
assert.ok(bg.includes(WIDGET_IMAGE_CLASS), "背景模式应插入配图 img");
assert.ok(bg.includes("position:relative"), "容器应补 position:relative");
assert.ok(bg.includes('<div class="text">{{text}}</div>'), "原有子结构必须原样保留");
assert.ok(bg.indexOf(WIDGET_IMAGE_CLASS) < bg.indexOf("class=\"text\""), "背景层应在内容之前");
// 只插一个 img
assert.equal(bg.split(WIDGET_IMAGE_CLASS).length - 1, 1);

// ── 条带模式：补 flex 与方向，且不覆盖已有 display ──
const existingFlex = '<div class="card" style="display:flex;gap:8px"><span>x</span></div>';
const top = autoPlaceImage(existingFlex, "top");
assert.ok(top.includes("flex-direction:column"), "上方条带需要纵向排列");
assert.equal(top.split("display:flex").length - 1, 1, "不应重复添加 display:flex");
assert.ok(top.includes("gap:8px"), "原有样式必须保留");

const left = autoPlaceImage(existingFlex, "left");
assert.ok(left.includes("flex-direction:row"), "左侧条带需要横向排列");

const bottom = autoPlaceImage(existingFlex, "bottom");
assert.ok(bottom.includes("flex-direction:column-reverse"));

// ── 没有 style 属性时要补一个，不能写坏标签 ──
const noStyle = '<div class="widget"><p>hi</p></div>';
const noStyleOut = autoPlaceImage(noStyle, "top");
assert.ok(/<div class="widget" style="[^"]+">/.test(noStyleOut), "应把 style 补进开标签");
assert.ok(noStyleOut.includes("<p>hi</p>"));

// ── 没有容器时整份包一层，不猜着改结构 ──
const bare = "<p>只有一段话</p>";
const wrapped = autoPlaceImage(bare, "top");
assert.ok(wrapped.startsWith("<div"), "无容器时应包一层");
assert.ok(wrapped.includes(bare), "原模板必须完整保留");

// ── 已有的 position 不被覆盖 ──
const positioned = '<div class="card" style="position:absolute;top:0">x</div>';
const posOut = autoPlaceImage(positioned, "background");
assert.ok(posOut.includes("position:absolute"), "用户设的 position 不能被覆盖");
assert.ok(!posOut.includes("position:relative"), "不应再追加 position:relative");

// ── 占位符原样保留，等 renderWidgetHtml 去填 ──
assert.ok(bg.includes("{{image}}"), "自动插入的 img 应输出 {{image}} 占位符");

// ── 封面模式：改已有 .cover 规则的背景，不插新元素 ──
const music = `<html><head><style>
  .cover { width: 20%; aspect-ratio: 1; flex: none; background: linear-gradient(140deg, #eeeeee, #c5c5c5); display: grid; place-items: center; color: #777; }
</style></head><body><div class="card"><div class="cover">♪</div><p>{{text}}</p></div></body></html>`;
const cover = autoPlaceImage(music, "cover");
assert.ok(cover.includes("url({{image}})"), "封面规则里应填入配图");
assert.ok(!cover.includes("linear-gradient(140deg"), "原占位渐变应被图片顶掉");
assert.ok(cover.includes("aspect-ratio: 1"), "封面尺寸必须保留");
assert.ok(cover.includes("width: 20%"), "封面宽度必须保留");
assert.ok(cover.includes("place-items: center"), "封面布局必须保留");
assert.ok(!cover.includes(WIDGET_IMAGE_CLASS), "封面模式不应插入独立 img");
assert.ok(cover.includes("{{text}}"), "其余占位符不受影响");
// 只改一处规则
assert.equal(cover.split("url({{image}})").length - 1, 1);

// ── 封面模式：没有内联规则时给元素补 style ──
const inlineCover = '<div class="card"><div class="cover"></div></div>';
const inlineOut = autoPlaceImage(inlineCover, "cover");
assert.ok(inlineOut.includes("url({{image}})"), "无规则时应补到元素 style");
assert.ok(/class="cover" style="[^"]*url/.test(inlineOut));

// ── 封面模式：什么封面都找不到时退回背景，不能丢图 ──
const noCover = '<div class="card"><p>只有文字</p></div>';
const fallback = autoPlaceImage(noCover, "cover");
assert.ok(fallback.includes(WIDGET_IMAGE_CLASS), "找不到封面应退回背景模式");

console.log("Widget auto-image placement tests passed.");
