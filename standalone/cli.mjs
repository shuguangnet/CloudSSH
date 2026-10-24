#!/usr/bin/env node
// `cssh` 入口。保持极薄：真正的实现在 ./cli/main.mjs，
// 这样测试可以直接 import 各模块而不触发参数解析。
//
// 用相对路径 + import.meta.url 而不是硬编码路径，`npm i -g` 之后
// 符号链接指向的地方也能正确解析。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
await import(join(here, 'cli', 'main.mjs'));
