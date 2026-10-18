/**
 * 被测站点地址：命令行 > 环境变量 BASE_URL > 默认 5173。
 * 六个 UI 回归脚本原本各自硬编码 5174（只有 5173 被占用、vite 顺延端口时才会碰巧通过），
 * 这里统一收口，避免换机器就 ERR_CONNECTION_REFUSED。
 */
export const testBase = process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:5173";
