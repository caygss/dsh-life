# 第三方声明（THIRD-PARTY NOTICES）

本仓库自己写的部分按 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布。
下面列出的文件改编自第三方代码，**原始许可仍然有效**，不因本仓库的许可而改变；
对这些文件，你仍按原始许可（MIT）取得权利，包括商业使用。

## 1. DeepSeek Harness —— MIT

| 本仓库文件 | 来源 | 改动 |
|---|---|---|
| `packages/dsh-life-core/model/step-timing.mjs` | `DeepSeek Harness`，commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，`packages/client/ui-chat/src/client/contract/turn-metrics.ts` | 去掉 TypeScript 类型，保留计时公式与 null 语义 |

### MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

新增改编时请在本文件追加一节，写明：本仓库文件、来源项目与版本/commit、改动摘要、完整许可正文。
