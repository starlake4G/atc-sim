/**
 * 游戏内时刻
 *
 * 1 现实秒 = 1 游戏分钟（即 1 现实分钟 = 1 游戏小时），清晨 07:30 开局：
 * 1× 倍速下十分钟对局正好走完 早→午→黄昏→夜 的大半轮。
 *
 * 放在 sim 层是因为"现在几点"是世界状态：昼夜循环（views/daycycle）要按它打光，
 * HUD 要把它显示出来，玩家才能看见"天黑了 → 开灯"的因果，而不是只看到背景在慢慢变。
 */

/** 一整个昼夜对应的仿真秒数 */
export const FULL_DAY_SECONDS = 1440;
/** 开局时刻（小时） */
export const DAY_START_HOUR = 7.5;

/** 仿真秒 → 游戏内小时（0–24，含小数） */
export function dayHour(timeSec: number): number {
  return (DAY_START_HOUR + (timeSec / FULL_DAY_SECONDS) * 24) % 24;
}

/** 游戏内钟表，如 07:30 */
export function clockString(timeSec: number): string {
  const min = Math.floor(dayHour(timeSec) * 60);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
