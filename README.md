# KeepEssence agents

把助手（agent）接进 KeepEssence：各家产品的连接器指南、插件、自己部署的 agent 示例。
Assistant integrations for KeepEssence: connector guides, plugins and self-hosted agent examples.

状态：v1.0 内测。定时型助手的示例和对话型助手的检查脚本能跑，接入指南照 spec 写好；插件还没有。

## 两类助手

| 类 | 例子 | 能做 |
|---|---|---|
| 对话型 | Claude、ChatGPT、Gemini | 深挖 |
| 定时型 | 自己部署的 agent、Muse | 解读、汇总、深挖 |

助手经 MCP 取活、交回，用 OAuth 接入。接入地址对所有人相同：`https://keepessence.app/mcp`。核心内置的分派助手用同一份契约，没有后门；它的代码在 [core](https://github.com/KeepEssenceApp/core)。

接入一只助手，就是同意把你存入的内容送到这只助手运行的地方。允许页上会写明是哪里。

## 这里有什么

| 目录 | 内容 |
|---|---|
| [`connectors/`](connectors) | 各家产品的接入步骤，每个产品一页，中英文：Claude、ChatGPT、Gemini、自己部署的 agent、Muse（待验证） |
| [`examples/scheduled-agent/`](examples/scheduled-agent) | 自己部署的定时型助手的最小示例：问活、认领、解读、汇总、精读、交回。Node 22 + TypeScript，拿去改 |
| [`examples/chat-assistant-check/`](examples/chat-assistant-check) | 扮成一只对话型助手，验证深挖那几个工具是通的 |
| [`plugins/`](plugins) | 给具体产品做的插件。现在是空的 |
| [`dev/fake-core.mjs`](dev/fake-core.mjs) | 契约里助手那一侧的一个假核心，开发和测试用，数据都在内存里 |
| [`contract/`](contract) | 契约的一份副本。来源在 [spec/contract](https://github.com/KeepEssenceApp/spec/tree/main/contract)，不在这里改 |
| [`docs/pitfalls.md`](docs/pitfalls.md) | 踩过的坑 |

## 跑一下示例

要 Node 22。

```
npm install
```

### 先对着假核心试

不用账号，不用模型。假核心会直接「允许」，真的核心会打开允许页等你点。

```
node dev/fake-core.mjs --seed          # 一个终端：假核心，带几条编出来的内容，端口 8796

export KEEPESSENCE_MCP_URL=http://127.0.0.1:8796/mcp
export MODEL=stub                      # 不调模型，每次输出相同
cd examples/scheduled-agent
npx tsx src/cli.ts connect             # 一次性：打印允许页的地址并打开浏览器
npx tsx src/cli.ts run-once            # 问活、认领、做、交回
npx tsx src/cli.ts run-once            # 没活了：什么都不输出
```

看结果：`curl -s http://127.0.0.1:8796/__dev/state`。8796 被占用时换一个：`PORT=8896 node dev/fake-core.mjs --seed`。

### 接真的

```
cd examples/scheduled-agent
export MODEL_BASE_URL=...  MODEL_API_KEY=...  MODEL_NAME=...
npx tsx src/cli.ts connect             # 浏览器打开 KeepEssence 的允许页，起名字，点「允许」
npx tsx src/cli.ts run --every 15      # 每 15 分钟来一次；或者用 cron 定时跑 run-once
```

`connect` 只做一次。之后凭据自动续期，不需要人（规则 D9）。在「助手设置」里撤销之后，它会停下并提示重新 `connect`。接好之后，要在「助手设置」里把它选作解读助手、汇总助手或精读助手，核心才会把活分给它。

| 环境变量 | 作用 | 缺省 |
|---|---|---|
| `KEEPESSENCE_MCP_URL` | 接入地址 | `https://keepessence.app/mcp` |
| `MODEL` | `anthropic`：兼容 Anthropic Messages 的端点；`openai`：兼容 OpenAI chat 的端点；`stub`：不联网的假模型 | `anthropic` |
| `MODEL_BASE_URL` | 模型端点。`anthropic` 填到主机为止（不带 `/v1`）；`openai` 填到 `/v1` | 各自的官方地址 |
| `MODEL_API_KEY`、`MODEL_NAME` | 模型的凭据和名字 | 无，必填（`stub` 除外） |
| `KEEPESSENCE_STEPS` | `connect` 时申请哪几步 | `analysis digest deep_read` |
| `KEEPESSENCE_AGENT_NAME` | 允许页上显示的名字，用户可以在允许页上改 | `Scheduled agent` |
| `KEEPESSENCE_DEEP_DIVE_ENTRY` | 随精读报告交回的一段文字：用户怎么找这只助手深挖，通常是一个链接。`{item_id}` 会被换成条目的标识 | 不交回 |
| `KEEPESSENCE_CONFIG_DIR` | 凭据文件放哪 | `~/.config/keepessence-agent` |
| `KEEPESSENCE_NO_BROWSER` | 设了就只打印地址，不开浏览器 | 不设 |

凭据文件是 `credentials-<主机>.json`，权限 0600，里面只有 OAuth 发下来的东西。没有固定凭据这条路。模型的凭据只从环境变量读，不写进任何文件。

### 它每一轮做什么

1. 用一个普通的 HTTP 请求问有没有活（`GET /v1/assistant/work`）。没有就结束：不开 MCP 会话，不碰模型，不输出。
2. 有活：按解读、汇总、精读的顺序，每一类认领（一次最多 10 份），经 MCP 工具取规则和上下文，调模型，按契约的字段和上限交回，同时报用量。
3. 认领快到期而活还没做完就续期；做不完的立刻放回，不让它白等 30 分钟。

多久来一次、同时来几份都一样正确：每一轮都从核心说的「现在有什么活」出发，自己不记任何进度；一份活只在认领之后才动；同一个认领重复交回用的是同一个幂等键。两份同时跑时，凭据文件的刷新在文件锁里做。

用哪种语言写，看规则里的 `lang`。提示词在 [`src/prompts.ts`](examples/scheduled-agent/src/prompts.ts)，改成你自己的就从这里开始。

### 示例没做的

- 深挖：示例只做无人值守的三步。和用户对话是你自己的 agent 的事；把入口填进 `KEEPESSENCE_DEEP_DIVE_ENTRY`，用户就能从精读报告找过来。
- 精读时上网去查：示例只在用户自己的每日摘要、笔记和相关条目里查。
- 初筛：那是内置的分派助手的活。

## 验证对话型助手这条路

```
cd examples/chat-assistant-check
npx tsx check.ts            # 第一次会走一遍允许页；--no-note 不留下笔记
```

它只申请「深挖」一步，然后：列出可深挖的、取一条的上下文、登记一次深挖、存回一份笔记（标题写明是检查用的），再确认不属于它的工具（认领、取解读的规则）会被拒绝。每一步打印 PASS 或 FAIL，有 FAIL 时退出码是 1。

## 测试

```
npm run typecheck
npm test
```

测试对着假核心跑，用随机端口，不调真的模型。对着本地起的 [core](https://github.com/KeepEssenceApp/core) 跑同一条链路：`npm run e2e:core`，说明在 [`dev/e2e-core.ts`](dev/e2e-core.ts) 开头。

## 先读

- [助手](https://github.com/KeepEssenceApp/spec/blob/main/product/assistants.md)：种类、取活和交回、解读的格式、精读与深挖。
- [接入一个助手](https://github.com/KeepEssenceApp/spec/blob/main/product/connect.md)：各个产品怎么接。
- 接口和 MCP 工具见 [spec/contract](https://github.com/KeepEssenceApp/spec/tree/main/contract)。

## 参与

欢迎为新的 agent 或产品补接入方式。接入指南只写查实过的步骤，没查实的写「待验证」。见 [贡献指南](https://github.com/KeepEssenceApp/.github/blob/main/CONTRIBUTING.md)。许可证：[AGPL-3.0](LICENSE)。
