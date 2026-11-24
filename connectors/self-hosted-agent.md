# 自己部署的 agent / A self-hosted agent

定时型助手：解读、汇总、深挖；精读只由它做。 / A scheduled assistant: analyses, daily digests, deep dives; deep reads are done only by this kind.

[English](#english)

## 接入之前要知道的

- 接入地址：`https://keepessence.app/mcp`。所有人相同，不是凭据。
- 接入只有一个动作：在 KeepEssence 的允许页上点「允许」。允许页上给这个助手起个名字，勾选它能干的步骤。
- **接入之后，你存入的内容会被送到这只助手运行的地方。** 允许页上会写明是哪里；不想让内容去那里，就不要点「允许」。
- 接好之后它出现在「助手设置」里，随时可以撤销，撤销立即生效。

## 步骤

1. 在它的 MCP 配置里加一个远程服务器，地址填接入地址，传输选 Streamable HTTP，认证选 OAuth。
2. 它打开 KeepEssence 的允许页，点「允许」。
3. 给它设一个定时任务：每次来先问有什么活，认领，做完交回。

## 限制

- 不提供固定凭据（API key、Bearer token）这条路，只有 OAuth。授权一次之后凭据自动续期，不需要你再经手。
- 「有没有活」可以用一个普通的 HTTP 请求问（`GET /v1/assistant/work`），不必经模型。
- 一次认领最多 10 份，30 分钟没交回自动放回。
- 解读、每日摘要、精读报告都按字段交回，超出字段上限的不收。上限见 [契约](../contract/openapi.yaml)。

## 现成的例子

[`examples/scheduled-agent`](../examples/scheduled-agent) 是照这三步做的最小示例：`connect` 做第 1、2 步，`run --every <分钟>` 是第 3 步。怎么跑见 [仓库首页](../README.md#跑一下示例)。

## 怎么深挖

- 加入深挖队列：这只助手下次来取活时先精读这一条，读好了在「笔记」页最上面等你。
- 去深挖时，入口是它交回精读报告时附的一段文字，通常是一个链接。KeepEssence 原样转交。
- 深挖的时候它再去查什么、跑什么，是助手那边的事，KeepEssence 看不到，也不管。
- 聊完说「存成笔记」，助手才存回。没有笔记存回来也没关系。

---

## English

## Before you connect

- Connect address: `https://keepessence.app/mcp`. It is the same for everyone and is not a credential.
- Connecting is one action: pressing Allow on the KeepEssence allow page. On that page you name the assistant and tick the steps it may do.
- **Once connected, what you save is sent to where this assistant runs.** The allow page says where that is; if you do not want your content to go there, do not press Allow.
- After that it is listed in Assistant settings, where you can revoke it at any time. Revoking takes effect at once.

## Steps

1. In its MCP configuration, add a remote server: the connect address, Streamable HTTP as the transport, OAuth for authentication.
2. It opens the KeepEssence allow page. Press Allow.
3. Give it a timetable: each time it comes, it first asks what work there is, claims it, does it and hands it back.

## Limits

- There is no fixed credential (API key, bearer token), only OAuth. After the one approval the credential renews itself and you never handle it again.
- "Is there work" can be asked with a plain HTTP request (`GET /v1/assistant/work`), without a model.
- A claim holds at most 10 pieces and is put back after 30 minutes if nothing is handed back.
- Analyses, daily digests and deep-read reports are handed back as fields; anything over a field's limit is refused. The limits are in the [contract](../contract/openapi.yaml).

## A ready-made example

[`examples/scheduled-agent`](../examples/scheduled-agent) is a minimal agent built on these three steps: `connect` does steps 1 and 2, `run --every <minutes>` is step 3. See the [repository front page](../README.md#跑一下示例) for how to run it.

## How to deep dive

- Add an item to the deep-dive queue: the next time this assistant comes for work it reads the item in depth, and the report waits for you at the top of the Notes page.
- To go and dig in, the way in is the text it attached to its deep-read report, usually a link. KeepEssence passes it on as it is.
- What it looks up or runs during a deep dive happens on the assistant's side; KeepEssence cannot see it and has no part in it.
- When you are done, say "save it as a note"; only then does the assistant save it. Saving no note is fine too.
