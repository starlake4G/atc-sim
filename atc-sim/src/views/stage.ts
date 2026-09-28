/**
 * 主舞台尺寸
 *
 * 游戏画面按 1600×900 的虚拟分辨率排版，再用 transform: scale 整体贴合窗口 ——
 * 比例永远是 16:9，UI 不需要为每种窗口宽度重排（否则 HUD 和侧栏会互相挤出去）。
 *
 * 视图层要读这个缩放比做两件事：
 *   1. 放大位图后备尺寸（否则放大后发虚）
 *   2. 把鼠标事件的屏幕像素换算回未缩放的舞台像素（否则点选会偏）
 */

export const STAGE_W = 1600;
export const STAGE_H = 900;

let scale = 1;

export function getStageScale(): number {
  return scale;
}

export function setStageScale(s: number): void {
  scale = s;
}

/** 缩放后的设备像素比，上限 3 防止 4K 全屏把后备缓冲撑爆 */
export function scaledPixelRatio(): number {
  return Math.min(3, (window.devicePixelRatio || 1) * scale);
}
