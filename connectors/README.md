# connectors：各家产品怎么接

每个产品一页，中文在前，英文在后。内容出自 spec 的 [接入一个助手](https://github.com/KeepEssenceApp/spec/blob/main/product/connect.md)；那一页改了，这里跟着改。
One page per product, Chinese first, English after. Taken from the spec's connect page; when that page changes, these follow.

接入地址 / Connect address：`https://keepessence.app/mcp`

| 产品 | 类 | 能做 | 步骤 |
|---|---|---|---|
| [Claude](claude.md) | 对话型 | 深挖 | 有 |
| [ChatGPT](chatgpt.md) | 对话型 | 深挖 | 有 |
| [Gemini](gemini.md) | 对话型 | 深挖 | 有 |
| [自己部署的 agent](self-hosted-agent.md) | 定时型 | 解读、汇总、深挖 | 有 |
| [Muse](muse.md) | 定时型 | 解读、汇总、深挖 | 待验证 |

## 写这些页的规矩

- 只写查实过的步骤。没查实的产品写「待验证」，不编步骤（规则 D13）。
- 每一页都写明：内容会被送到这只助手运行的地方（规则 D10）。
- 不按品牌给助手开特例：对话型只能深挖，定时型可以解读、汇总、深挖（规则 D11）。
- 新增一个产品：先在 spec 的 `connect.md` 里补上查实过的步骤，再在这里加一页。
