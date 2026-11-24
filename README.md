# KeepEssence agents

把助手（agent）接进 KeepEssence：各家产品的连接器指南、插件、自己部署的 agent 示例。
Assistant integrations for KeepEssence: connector guides, plugins and self-hosted agent examples.

状态：还没开工。

## 两类助手

| 类 | 例子 | 能做 |
|---|---|---|
| 对话型 | Claude、ChatGPT、Gemini | 深入对话 |
| 定时型 | 自己部署的 agent、Muse | 解读、汇总、深入对话 |

助手经 MCP（或对应的 REST）取活、交回，用 OAuth 接入。核心内置的分派助手用同一份契约，没有后门；它的代码在 [core](https://github.com/KeepEssenceApp/core)。

## 打算放什么

| 目录 | 内容 |
|---|---|
| `connectors/` | 各家对话型助手的接入步骤和配置 |
| `plugins/` | 给具体产品做的插件 |
| `examples/` | 自己部署的定时型 agent 的最小示例：取活、解读、交回 |

目录按需创建。

## 先读

- [助手](https://github.com/KeepEssenceApp/spec/blob/main/product/assistants.md)：种类、取活和交回、解读的格式、精读与深入对话。
- [接入一个助手](https://github.com/KeepEssenceApp/spec/blob/main/product/connect.md)：各个产品怎么接。
- 接口和 MCP 工具见 [spec/contract](https://github.com/KeepEssenceApp/spec/tree/main/contract)。

## 参与

欢迎为新的 agent 或产品补接入方式。见 [贡献指南](https://github.com/KeepEssenceApp/.github/blob/main/CONTRIBUTING.md)。许可证：[AGPL-3.0](LICENSE)。
