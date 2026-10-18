/** 仿真时间常量。放在独立模块，避免 safety/world 互相 import。 */
export const TICK = 0.1;
/** 1× 即实时。加速只改累积量，不改步长。 */
export const TIME_SCALE = 1;
