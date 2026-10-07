/**
 * 读取 backend/.env（如果存在），把里面的配置塞进 process.env。
 *
 * 为什么单独放一个文件：ESM 里 import 会先于模块正文执行，
 * 所以「先加载 .env」这件事必须靠一个被 import 的模块来做，
 * 否则 fetch.js 里读 process.env 时 .env 还没加载。
 *
 * 规则很简单：一行一个 KEY=VALUE，# 开头是注释。
 * 已经存在的环境变量不会被覆盖（部署时以系统环境变量为准）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

try {
  const text = readFileSync(join(here, '.env'), 'utf-8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 允许用引号把值包起来（值里有空格时）
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
} catch {
  // 没有 .env 文件是正常情况（比如线上用系统环境变量），直接跳过
}
