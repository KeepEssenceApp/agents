# Claude

对话型助手：只做深挖。 / A chat assistant: deep dives only.

[English](#english)

## 接入之前要知道的

- 接入地址：`https://keepessence.app/mcp`。所有人相同，不是凭据。
- 接入只有一个动作：在 KeepEssence 的允许页上点「允许」。允许页上给这个助手起个名字，勾选它能干的步骤。
- **接入之后，你存入的内容会被送到这只助手运行的地方。** 允许页上会写明是哪里；不想让内容去那里，就不要点「允许」。
- 接好之后它出现在「助手设置」里，随时可以撤销，撤销立即生效。

## 步骤

1. 打开 Claude 的 Connectors，点 Add → Add custom connector。
2. 名字填 KeepEssence，地址粘贴接入地址，点 Continue。
3. 认证保持它自动检测到的选项，点 Add，再点 Connect。
4. 浏览器打开 KeepEssence 的允许页，点「允许」。

## 限制

- 各套餐都能接；免费套餐只能有一个自定义连接器。
- Claude 第一次存回笔记时会问你是否允许。
- 允许页上只有「深挖」这一步可选。

## 怎么深挖

- 从助手那边：对它说「深入今天每日摘要里讲某某的那条」。它从 KeepEssence 取到那一条，开始聊。
- 从 KeepEssence 这边：在一份解读或每日摘要的一条上点「深挖」，选现在去深挖，再选用谁。能自动打开的，KeepEssence 打开那个助手并填好开场话；不能的，复制开场话过去发出。
- 对话型助手做不了精读。加入深挖队列的条目由定时型助手精读。
- 深挖的时候可以让助手再去查，或者做它那边预先配好的事。那是助手那边的事，KeepEssence 看不到，也不管。
- 聊完说「存成笔记」，助手才存回。助手不能存的，回 KeepEssence 点「把结果贴回来」。没有笔记存回来也没关系。

---

## English

## Before you connect

- Connect address: `https://keepessence.app/mcp`. It is the same for everyone and is not a credential.
- Connecting is one action: pressing Allow on the KeepEssence allow page. On that page you name the assistant and tick the steps it may do.
- **Once connected, what you save is sent to where this assistant runs.** The allow page says where that is; if you do not want your content to go there, do not press Allow.
- After that it is listed in Assistant settings, where you can revoke it at any time. Revoking takes effect at once.

## Steps

1. Open Connectors in Claude and choose Add → Add custom connector.
2. Enter KeepEssence as the name, paste the connect address, and press Continue.
3. Leave authentication on the option it detected, press Add, then Connect.
4. Your browser opens the KeepEssence allow page. Press Allow.

## Limits

- Every plan can connect; the free plan allows one custom connector.
- The first time Claude saves a note, it asks whether you allow it.
- On the allow page, deep dive is the only step on offer.

## How to deep dive

- From the assistant: tell it "dig into the item about such-and-such in today's daily digest". It fetches that item from KeepEssence and the conversation starts.
- From KeepEssence: press Deep dive on an analysis or on an item in a daily digest, choose to go now, and choose which assistant. Where it can, KeepEssence opens that assistant with the opening line filled in; where it cannot, copy the opening line and send it there.
- A chat assistant cannot do a deep read. Items added to the deep-dive queue are read in depth by a scheduled assistant.
- During a deep dive you can ask the assistant to look things up, or to do what it is set up to do on its side. That happens on the assistant's side; KeepEssence cannot see it and has no part in it.
- When you are done, say "save it as a note"; only then does the assistant save it. If the assistant cannot save, go back to KeepEssence and press "Paste the result back". Saving no note is fine too.
