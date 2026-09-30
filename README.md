# 记忆卡

对着一张旧照片，用你自己的话慢慢讲。助手只追问，不编造，也不扮演照片里的人。你明确说「确认」或「可以」之后，才生成一张私有故事卡，下载 Markdown 即可离开。没有账号，没有动态，也不是纪念馆。

## 启动

需要 Node.js 20 或更新版本。没有 npm 依赖。

在启动这个进程的环境里设置 AssemblyAI 密钥。不要写进文件，不要贴进仓库：

```bash
export ASSEMBLYAI_API_KEY="你的密钥"
cd /workspace/memory-note
node server.js
```

浏览器打开 <http://127.0.0.1:8787>。换端口：`PORT=9000 node server.js`。数据目录可用 `MEMORY_NOTE_DATA` 改到别处，默认是项目下的 `data/`。

页面如果提示没有 `ASSEMBLYAI_API_KEY`，说明当前 node 进程没读到变量。关掉进程，在同一个终端里 export 之后重新执行 `node server.js`。密钥只留在服务端内存里，页面、日志和仓库都不会打印它。

自测不需要密钥：

```bash
node --test test/*.js
```

## 怎么用

1. 选择一张 jpg、png、webp 或 gif，不超过 6MB。服务端按文件头判断类型，不看扩展名。
2. 按「开始讲述」，允许麦克风，然后说话。接通后助手会先问：照片里有谁。
3. 你可以随时插话。浏览器会停掉正在朗读的那句。
4. 听不清的词会标出来，不会写进卡片。助手应请你再说一遍。
5. 它问你要不要写成卡片时，用短句明确说「确认」或「可以」。长句子不算同意。
6. 卡片出现后下载 Markdown。里面是照片文件名、确认时间（北京时间），以及校验过的原话。听不清、还没重说的词会列在「没写进去的词」。

没有麦克风时，展开「改用文字」。文字走同一套服务端工具，不是另一套假卡片。文字回合同样需要密钥，否则返回 503。

按「结束」或离开页面时，浏览器会发送 `Terminate`，把实时转写会话关掉。

## 什么是真的，什么没有接上

已经接上：

- 服务端用密钥调用 `GET https://streaming.assemblyai.com/v3/token`，申请一次性短期令牌（300 秒内必须拿去建连，会话最长 900 秒）。浏览器只用这个令牌。
- 浏览器连接 `wss://streaming.assemblyai.com/v3/ws`，模型 `universal-3-6-pro`，`language_codes=["zh"]`，并打开语言检测，音频是 16 kHz、16-bit PCM。
- 每一轮结束的转写发回本机。服务端调用 AssemblyAI LLM Gateway `https://llm-gateway.assemblyai.com/v1/chat/completions` 做工具调用。模型按顺序尝试：`gemini-3.5-flash-lite`、`gemini-2.5-flash-lite`、`gpt-5-mini`、`claude-haiku-4-5-20251001`。某个模型返回 400、404 或 422 时才换下一个。
- 三个工具都在服务端执行，不信任模型自报的结果：`note_quote` 必须是用户转写的连续原话；`flag_unclear` 只标记转写里出现过的词；`confirm_card` 只在用户这一轮是明确短同意时写卡。卡片正文不接收模型编写的故事。

没有接上：

- AssemblyAI Voice Agent（`agents.assemblyai.com`）没有用来讲话。官方朗读音色目前没有中文，中文音色是即将推出，不是已经可用。这个原型不用英文音色念中文。
- 中文朗读用的是浏览器 `speechSynthesis`（`zh-CN`）。打断是页面自己做的：实时转写里出现不像回声的新话时调用 `speechSynthesis.cancel()`。这不是 Voice Agent 的 `interrupt_response`。电脑如果没装中文语音包，文字仍会显示，只是可能没有声音。
- 口头追问的用词靠提示词约束。硬校验保护的是卡片，不是每一句朗读。助手如果说了你没说过的名字，那一句不会进入卡片，你也不必确认。
- 当前已知阻塞：密钥还没有进入这个运行环境时，申请令牌和每一轮提问都返回 503。上传照片仍然可以。不要把密钥写进任何文件来绕过。

## 隐私

不要把密钥提交进 git。`.env` 和 `data/` 已在 `.gitignore` 里。这是只监听 `127.0.0.1` 的单机原型，没有登录。同一台电脑上能打开这个地址的人，都能访问已上传的照片。进行中的对话只在进程内存里，重启即丢；已确认的 Markdown 留在 `data/cards/`。

产品范围和付费设想见 `docs/prd.md`。接口和工具规则见 `docs/tech.md`。
