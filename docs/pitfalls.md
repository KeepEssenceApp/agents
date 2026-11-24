# 踩过的坑

做这个仓库时真的绊到过的事。新的往下加。

## 刷新凭据会轮换，两个进程同时刷新会互相作废

核心每次刷新都换一把新的刷新凭据，旧的只能用一次；严格的实现看到旧的被再用一次，会把这次授权发出的凭据全部作废。两份 agent 同时醒来、同时发现访问凭据过期，就会撞上。

做法（`examples/scheduled-agent/src/oauth.ts`、`credentials.ts`）：刷新在文件锁里做；拿到锁之后先重读文件，别人已经刷新过就直接用，不再发请求。写文件用「写临时文件再改名」，免得另一个进程读到半截。

MCP SDK 在收到 401 时会自己去刷新，那条路不经过我们的锁。所以在 `tokens()` 里提前刷新（过期前 2 分钟），让 SDK 基本碰不到 401。

## SDK 选 scope 的顺序

`@modelcontextprotocol/sdk` 的 `auth()` 选 scope 的顺序是：调用时传的 `scope` → 受保护资源元数据里的 `scopes_supported` → `clientMetadata.scope`。只在 `clientMetadata` 里写「只要 deep_dive」不管用：核心的元数据列了全部步骤，SDK 会全都要。要少要，就在调用 `auth()` 时传 `scope`。

## 回环地址的端口每次不同，所以每次 connect 都重新注册

`connect` 监听一个随机的回环端口，回调地址跟着变；动态注册时登记的回调地址是上一次的端口。核心按登记的地址精确比对，所以每次 `connect` 都重新注册一个客户端，不复用上一次的。新的凭据先放在内存里，全部成功才写进文件，再撤销被换下来的那一把。

回环地址意味着浏览器要和 agent 在同一台机器上。agent 在服务器上时，用 `ssh -L <端口>:127.0.0.1:<端口>` 把那个端口转到本机，或者在本机 `connect` 之后把凭据文件拷过去（权限保持 0600）。

## 文件权限：`mode` 参数会被 umask 削掉

`writeFileSync(path, data, { mode: 0o600 })` 的 `mode` 受 umask 影响，而且只在新建文件时生效。写完再 `chmod` 一次才保险。

## 「60 个字」数的是字符，不是 UTF-16 单元

契约的 `maxLength` 按 Unicode 字符数。`"😀".length` 是 2。截断和计数都用 `Array.from(text)`。

## 失败的那一份放回之后，同一轮里会马上再领到

一份活做失败了要立刻放回，不让它白等 30 分钟。但放回之后同一轮再认领，领到的还是它，会原地打转。做法：一个认领里有没做完的，这一类这一轮就不再认领，留给下一轮。

## 交回之后认领还在不在，契约没说

`submit_result` 交回一部分之后，认领里剩下的几份是自动放回，还是继续占着到过期，契约没写。示例的做法是两样都不依赖：能交的一次交完，剩下的显式 `release_claim`，放回失败也不当错误。

## 一条不合格的结果会连累整批

`submit_result` 遇到字段不合格是整个请求 400（`invalid_result`），不是逐条给结果。示例里所有结果交回之前都按契约的上限裁过；万一还是被拒，就改成一条一条交，免得一条坏的拖住另外九条。

## 本机的 8796 端口可能已经有人用

`dev/fake-core.mjs` 缺省用 8796。这台开发机上有别的程序占着它，表现是 `connect` 报「Invalid OAuth error response … {"detail":"Not Found"}」：请求发到了别人的服务上。换端口：`PORT=8896 node dev/fake-core.mjs`。测试不受影响，它们用随机端口。

## `rm` 和 `cp` 在这台机器上会问一句

shell 里 `rm`、`cp` 被设成了要确认，脚本里用会卡住不动，直到超时。用 `command rm -f`、`command cp -f`。

## 对着本地的 core 跑

- core 的开发端口是 8801，不是 8791（8791 上是别的程序）。
- core 的 `wrangler.toml` 里配了正式域名的路由，`wrangler dev` 会把请求的主机名换成它，于是 core 认为这不是本机，对写请求一律回「只接受 HTTPS」。启动时加 `--local-upstream localhost:<端口>`。
- 本地不会自己跑定时任务，要手动触发：`curl "http://localhost:<端口>/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`。`npm run e2e:core` 设了 `CORE_CRON_URL` 就会替你触发。
- core 配了 `LLM_API_KEY` 时，触发定时任务会让内置助手去调真的模型。跑测试时不要带它：另起一份，`--var LLM_API_KEY:`，再把 `LLM_BASE_URL` 指到一个不通的地址。
- 没有分派助手时，条目要等 10 分钟由 core 补上初筛的缺省值，之后才出现在解读的活里。所以整条链路至少跑 10 分钟，`E2E_TIMEOUT_SECONDS` 设 780。
- 每日摘要在用户时区 21:00 之后才到期。脚本登录时挑一个此刻是 22 点的时区。
- 接好之后要在设置里把这只助手选作解读、汇总、精读助手（`PATCH /v1/settings` 的 `roles`，填助手的 id），不然汇总和精读的活不归它。

## 工具清单按步骤过滤

core 的 `tools/list` 只列出这只助手被允许的步骤能用的工具；没列出来的工具硬调，会被拒绝（`forbidden`）。所以检查脚本不能要求清单里有全部工具。对话型助手拿不到 `search_digests_and_notes`。
