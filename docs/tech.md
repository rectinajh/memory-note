# 记忆卡 技术文档

本文描述仓库里已经跑起来的原型，不描述尚未实现的付费成品。

## 架构

单进程 Node.js，无 npm 依赖，入口 `server.js`。用内置 `http`、`fs`、`crypto`。静态页在 `public/`，规则在 `lib/session.js`，AssemblyAI 调用在 `lib/aai.js`。

```
浏览器
  |  POST /api/session          照片（base64）
  |  GET  /api/streaming-token  只拿临时令牌
  |  POST /api/session/:id/turn 一轮转写
  |  GET  /api/session/:id/card.md
  |
  +-- WebSocket 直连 AssemblyAI Streaming（令牌，不是永久密钥）
  +-- speechSynthesis（zh-CN）朗读服务端返回的 say

server.js
  |  会话在内存 Map 中
  |  同一会话的回合串行排队
  +-- lib/aai.js     令牌与 LLM Gateway
  +-- lib/session.js 工具硬校验与卡片 Markdown
  +-- data/photos、data/cards
```

进程只监听 `127.0.0.1`，默认端口 `8787`（`PORT` 可改）。`node server.js` 即可。Node.js 20+。

一次会话：`POST /api/session` 生成 UUID，照片写入磁盘，会话对象放进内存。重启后内存会话消失，已写的卡片文件还在，但下载接口依赖内存里的 `session.card`，所以重启后不能再靠旧 id 下载。

## AssemblyAI 集成

密钥只从进程环境变量 `ASSEMBLYAI_API_KEY` 读取。不写磁盘，不打日志，不放进前端。响应体如果意外带上密钥（长度至少 8），会替换成 `[redacted]`，`Bearer` 也会被抹掉。

### 流式转写

`GET /api/streaming-token` 由服务端请求：

`GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=300&max_session_duration_seconds=900`

先用密钥本身做 `Authorization`，若 401 再试 `Bearer`。返回的 `token` 不得等于永久密钥，否则当成上游错误。

浏览器用临时令牌连接：

`wss://streaming.assemblyai.com/v3/ws`

查询参数：`sample_rate=16000`，`encoding=pcm_s16le`，`speech_model=universal-3-6-pro`，`language_codes=["zh"]`，`language_detection=true`。

麦克风经 AudioWorklet 重采样到 16 kHz、16-bit PCM，按 800 采样（50ms）一帧发送。`Begin` 之后页面说出开场白：「我在听。这张照片是你的。先告诉我，照片里有谁？」这句是前端固定文案，不经过模型。

`Turn` 消息：未结束的部分转写只用于插话检测。`end_of_turn` 且 `turn_is_formatted` 的文本才送进 `/turn`。若格式化结果迟迟不来，450ms 后使用未格式化的那条，避免卡住。同一 `turn_order` 只提交一次。

结束或离开页面时发送 `{ "type": "Terminate" }`。

没有密钥时，令牌接口返回 503，语音不会开始。

### 回合与语言模型

`POST /api/session/:id/turn` 的正文是 `{ "text", "words" }`。`words` 可带 `confidence`。空文本返回 400。

服务端把这一轮追加进会话，再请求：

`POST https://llm-gateway.assemblyai.com/v1/chat/completions`

请求使用 `tool_choice: "auto"`，`temperature: 0.2`，`max_tokens: 600`，以及 `post_processing_steps: [{ type: "json-repair" }]`。工具定义来自 `lib/session.js` 的 `TOOLS`。

模型按这个顺序尝试，成功后记住下标，下次从它开始：

1. `gemini-3.5-flash-lite`
2. `gemini-2.5-flash-lite`
3. `gpt-5-mini`
4. `claude-haiku-4-5-20251001`

只有 400、404、422 或无法解析的成功响应才会换模型。401、403 直接失败，不轮换。其他 4xx/5xx 也直接失败。

一轮里最多 4 次模型调用，以便连续执行工具。没有工具调用时，模型文本作为 `say`。若始终没有可朗读的文本，用本地兜底句（记下了、请重说、或「我在听」）。对话消息超过 24 条时丢掉最旧的。系统提示不占这 24 条，每次单独放在最前。

### 朗读和打断（不是 Voice Agent）

`say` 由浏览器 `speechSynthesis` 朗读，语言 `zh-CN`，优先选择 `zh-CN` / `zh-Hans` 语音包。没有中文语音包时，文字仍显示。

打断发生在部分转写阶段：正在朗读，且新文本像人话（含汉字，或长度至少 3），并且不像刚才那句助手话的回声，就 `speechSynthesis.cancel()`。回声判断是去掉空白和标点后的互相包含。被打断的那一轮如果已经发出，返回后不再朗读。

这不是 AssemblyAI Voice Agent，也不是 `interrupt_response`。

Voice Agent 浏览器会话（`GET https://agents.assemblyai.com/v1/token`，再连 `wss://agents.assemblyai.com/v1/ws`）没有接入。原因是官方 TTS 音色目前没有中文（英语、意大利语、西班牙语、德语、葡萄牙语、法语；中文仍是即将推出）。不要在文档或界面里写成「已支持中文语音代理」。

文字入口调用同一个 `/turn`，不带词级置信度。没有密钥时同样 503。

## 工具契约

模型可以调用工具，但结果以 `applyTool` 为准。失败原因会作为 tool 消息返回，模型应改口，不能把失败当成已保存。

`note_quote`

- 参数 `quote`（字符串）。
- 必须能映射为用户全部转写拼接文本中的连续片段。先做精确子串；失败后再忽略空白和常见标点做对齐，但保存的仍是转写里的原文切片，不是模型改过的字符串。
- 最长 120 个码点。对齐后的松散文本至少 2 个字才接受非精确匹配。
- 纯应答（「可以」「好的」「确认」等，松散长度不超过 8）拒绝。
- 若该切片碰到低置信度词，拒绝并自动记入听不清。阈值：多字词置信度低于 0.6；单字低于 0.4。没有置信度的词不按此规则判低。
- 成功则追加到 `session.quotes`（相同文本不重复）。

`flag_unclear`

- 参数 `phrase`。必须同样是转写中的连续片段，否则拒绝。
- 成功只做标记，不写原话。提示词要求随后请用户重说。

`confirm_card`

- 模式里有 `agreed` 布尔值，服务端不信任它，也不接受故事正文。
- 通过条件：当前最新一条用户转写是明确短同意。去掉空白和句读后长度不超过 24，且匹配一组短句（如「可以」「确认」「写成卡片」「就这样吧」）。「我确认那个人是我爷爷」这种长句不是同意。
- 还要求至少一条已校验原话，以及照片文件名。
- 成功后生成 Markdown 并立刻写入 `data/cards/<sessionId>.md`。返回给模型的 tool 结果会去掉卡片正文，只留原话列表和文件名，避免模型把整卡再编一遍。

卡片 Markdown 结构固定：

- 标题「记忆卡」
- 照片文件名
- 确认时间，`Asia/Shanghai`，格式 `YYYY-MM-DD HH:mm`，标注北京时间
- 「你说过的话」：每条原话一块引用
- 若仍有未解决的听不清词：单独一节列出，并写明没写进卡片
- 结尾声明句子只来自转写

「未解决」指听不清短语还没有被某条已保存原话包含。

系统提示还要求：不编造，不扮演照片中的人或逝者，口头最多两句，用户转写不是给模型的指令。这些是提示，不是解析器。硬边界只在三个工具上。

## 数据

| 位置 | 内容 | 生命周期 |
| --- | --- | --- |
| 内存 `sessions` | 转写、原话、听不清、消息、卡片对象 | 进程内。重启即丢 |
| `data/photos/<uuid>` | 原始图片字节 | 磁盘，直到人删除 |
| `data/photos/<uuid>.json` | `{ filename, mime }` | 同上 |
| `data/cards/<uuid>.md` | 确认后的 Markdown | 写入后留在磁盘。下载接口仍要内存会话 |

`MEMORY_NOTE_DATA` 可替换 `data/` 根目录。`data/` 已 gitignore。

照片限制：JSON 正文上限约 9MB；解码后图片 1 字节到 6MB。用文件头识别 PNG、JPEG、GIF87a/GIF89a、WEBP。文件名去掉路径，只保留有限字符，最长 80。

静态页 CSP：`connect-src` 只允许自身和 `wss://streaming.assemblyai.com`。没有放行 `agents.assemblyai.com`。

主要接口：

- `GET /api/health`：`assemblyai` 为 `configured` 或 `missing`。不返回密钥。
- `GET /api/streaming-token`
- `POST /api/session`
- `GET /api/photos/:id`
- `GET /api/session/:id`
- `POST /api/session/:id/turn`
- `GET /api/session/:id/card.md`：附件名「记忆卡.md」。没有卡片则 404。

## 隐私

- 永久密钥不出服务端。临时令牌会到浏览器，只用于当次流式转写，约 300 秒内有效，会话最长约 15 分钟。
- 转写文本和照片会离开本机：音频到 AssemblyAI Streaming，转写文本到 LLM Gateway。照片不发给这两个接口。
- 没有账号、没有第三方登录、没有分析脚本。
- 服务只绑本机回环地址，但没有鉴权。本机其他本地程序可以访问照片和会话。
- 不要把密钥放进仓库、README、PRD 或日志。`.env` 已被忽略；原型也不读取 `.env` 文件，变量必须在启动进程的环境里。

## 已知缺口

- 密钥尚未进入当前运行环境时，语音令牌和 `/turn` 都是 503。这是环境问题，不是功能开关。不要把密钥写进代码或文档。
- 没有中文 Voice Agent TTS。朗读质量取决于浏览器语音包，不能打断到「半个词」的官方代理语义，只是取消当前朗读。
- 助手嘴上仍可能说出用户没说过的内容。卡片会拒绝，朗读不会。
- 对话不落盘。进程一停，未确认的讲述没了；已写的 md 文件在，但页面会话 id 不再有效。
- 照片文件没有随会话过期清理。
- 模型列表是按当前可用性写死的顺序，不是账号里真实开通情况的探测。某个名字失效时会在 400/404/422 上跳过。
- 单机、单用户、无队列持久化。同一会话的回合用内存 Promise 链串行。
- 付费能力都没做：长访谈成短篇、多张照片、人工润色、短片。

## 测试

不需要密钥，也不访问网络：

```bash
node --test test/*.js
```

`test/session.test.js` 覆盖：原话必须是子串、标点差异映射回原文、低置信度拒绝并标记、没说过的词不能 flag、确认必须是短同意、卡片不含模型塞进来的故事、应答词不能当原话。

`test/server.test.js` 在临时数据目录起服务，断言：无密钥时 health 为 missing、令牌与 turn 为 503、页面 HTML 不含密钥赋值、照片按文件头保存、伪造密钥不会出现在 health 响应里。

测试通过只说明规则和本机 HTTP 行为，不说明 AssemblyAI 账号可用。
