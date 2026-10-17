import { KESTREL } from "./kestrel";

/** 机场注册表：加机场 = 加一个文件 + 在这里登记 */
export const AIRPORTS = {
  kestrel: KESTREL,
};

export type AirportId = keyof typeof AIRPORTS;

export function getAirport(id: string) {
  const a = AIRPORTS[id as AirportId];
  if (!a) throw new Error(`未知机场 ${id}`);
  return a;
}
