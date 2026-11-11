"use client";

/**
 * 桌面小组件：从图库选一张配图。
 *
 * 为什么必须压缩成 data URL：
 *   原生离屏渲染时 blockNetworkLoads=true（模板里的 http 图片一律不加载，
 *   否则一张慢图会把整次渲染卡死），所以配图必须自带数据。
 *   而 data URL 会随整份 HTML 过一次 JS 桥、再贴进 RemoteViews，
 *   Binder 传输有约 1MB 上限——原图动辄几 MB，直接塞进去桌面就只剩应用图标。
 *   这里统一按长边压到 720px、JPEG 0.82，通常 60~150KB，留足余量。
 *
 * 为什么不复用 avatar.ts 的 downscaleToDataUrl：
 *   那个是给 38px 圆形小头像用的（强行居中裁成正方形、256px），
 *   配图往往是整张背景或竖图，裁成正方形等于把构图毁了。这里保留原始长宽比。
 */

/** 压图后的长边像素。720 在 300dp 宽的小组件上按 2~3 倍屏看也够清楚。 */
const MAX_EDGE = 720;

/** JPEG 质量。0.82 在 720px 下通常只占 60~150KB。 */
const QUALITY = 0.82;

/** 压图后的 data URL 字符上限，留足给模板和头像的余量（Binder 总上限约 1MB）。 */
const MAX_DATA_URL_CHARS = 900_000;

export type PickedImageResult =
  | { ok: true; dataUrl: string; bytes: number }
  | { ok: false; reason: string };

/** 读文件成 data URL 的最薄一层包装（Image 不能直接吃 File）。 */
function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 把用户选的图片文件压成适合小组件的 data URL。
 *
 * 只做一件事，失败时返回原因字符串由调用方提示——
 * 静默失败会让用户以为「选了没反应」，这比报错更难排查。
 */
export async function pickWidgetImage(file: File): Promise<PickedImageResult> {
  if (!file.type.startsWith("image/")) {
    return { ok: false, reason: "这不是图片文件" };
  }

  const source = await readAsDataUrl(file);
  if (!source) return { ok: false, reason: "读不出这个文件，换一张试试" };

  const dataUrl = await new Promise<string | null>(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const widest = Math.max(image.width, image.height) || 1;
        // 本来就不大就别放大了，免得白白变大文件
        const scale = Math.min(1, MAX_EDGE / widest);
        const targetW = Math.max(1, Math.round(image.width * scale));
        const targetH = Math.max(1, Math.round(image.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }
        // 保留长宽比，居中绘制（scale=1 时等于原样缩放到目标框）
        ctx.drawImage(image, 0, 0, targetW, targetH);
        resolve(canvas.toDataURL("image/jpeg", QUALITY));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = source;
  });

  if (!dataUrl) return { ok: false, reason: "这张图画不出来（格式可能不支持），换一张试试" };

  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    return {
      ok: false,
      reason: "压完还是太大，换一张小一点或简单一点的图",
    };
  }

  return { ok: true, dataUrl, bytes: dataUrl.length };
}

/** 人话显示体积，给设置页的提示用。 */
export function describeImageSize(chars: number): string {
  const bytes = Math.round(chars * 0.75); // base64 → 实际字节数约 3/4
  if (bytes < 1024) return bytes + " B";
  return (bytes / 1024).toFixed(0) + " KB";
}
