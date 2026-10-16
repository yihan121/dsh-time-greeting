# AGENTS.md

你是被叫来安装或检查 `dsh-time-greeting` 的 Agent。这份文档由另一个已经走过
一遍的 Agent 写成，目的是让你不必重走一遍。

如果你的任务只是"帮我装上这个插件"，跳到「最短路径」。
如果装完没反应，跳到「验证」。

---

## 最短路径

```powershell
dsh plugin --profile web add github:yihan121/dsh-time-greeting
```

然后**必须重启 `dsh web`**。

`dsh` 不在 PATH 里时，用安装目录下的完整路径：

```powershell
& '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile web add github:yihan121/dsh-time-greeting
```

---

## 验证它真的在工作

**不要通过检查会话记录来判断。** 注入的消息不保证落盘，因此会话记录里没有它，
不代表它没有送达。见下面「坑 3」。

正确做法：

1. 在 profile 的 `cordis.patch.yml` 里把 `testMode` 设为 `true`
2. 重启 `dsh web`
3. 随便让 Agent 走一步
4. 注入的消息会附带一行：

```
[测试] 这是一次强制注入，标记 <8 位十六进制>。如果你读到了这行，请把它原样说出来。
```

5. **如果 Agent 能复述那个标记，通道就是通的。** 标记是随机的，无法伪造。

验证完记得把 `testMode` 关掉并再重启一次。

---

## 四个会浪费你时间的坑

### 1. 宿主插件不热重载

改完源码或配置、重新安装之后，**正在运行的进程仍然使用旧代码**。

症状：改了半天没有任何变化，你以为改动没生效，其实是进程没换。

**唯一可靠的办法是重启 `dsh web`。**

### 2. 不要 `import @deepseek-ai/dsh-llm`

内核里有这个包，它提供现成的 `createUserMessage()`，看起来可以直接用。

**用不了。** profile 的 `node_modules/@deepseek-ai` 里只有 `cosmokit` 和
`schemastery`；Node 的模块查找从插件目录向上走到根目录即止，找不到 `dsh-llm`。

**而静态 `import` 一个解析不到的包，会让整个模块在求值阶段失败**，
进而使 profile 启动不了——这比功能缺失严重得多。

消息要按 `createUserMessage` 的实际返回形状手工构造：

```js
{
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'time-greeting', form: 'awareness' },
  id: randomUUID(),
}
```

如果你需要确认这个形状，可以直接问内核——把它当 Node 跑：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<DSH 安装目录>\DeepSeek Harness.exe' --expose-internals <脚本>
```

脚本里 `import` 内核的 `app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`，
打印 `createUserMessage({...})` 的返回值即可。

### 3. 消息要 `toSpliced`，不能 `push`

在 `agent/pre-step` 里往 `decision.messages` 追加消息是**不可靠的**。

要插在「最后一条已被认领的消息」之后，和内核自己的上下文插件一致：

```js
const lastClaimed = decision.messages.findLastIndex((m) => claimed.includes(m))
const entered = decision.messages.toSpliced(lastClaimed + 1, 0, note)
return { ...decision, messages: entered }
```

落在已认领区间之后的消息属于后续阶段，不在本步的发送范围内。

### 4. 状态写入要 `await`

每步都更新状态文件。用 `void save()` 这种 fire-and-forget 写法，进程若在写入
完成前退出，时间戳就丢了——下次启动会读到过期数据，量出一个虚高的间隔。

一次几百字节的本地写入，代价可以忽略。**等它。**

---

## 怎么拿到这个仓库的原文

**不要抓 GitHub 的 HTML 页面。** 那需要先剥掉几十个导航栏、页脚、脚本，
既慢又容易漏。

用 raw 地址，直接拿到纯文本原文件：

```
https://raw.githubusercontent.com/yihan121/dsh-time-greeting/main/README.md
https://raw.githubusercontent.com/yihan121/dsh-time-greeting/main/AGENTS.md
https://raw.githubusercontent.com/yihan121/dsh-time-greeting/main/lib/index.js
```

把 `main` 换成某个 commit 的 SHA，就能拿到固定版本，不受后续改动影响。

---

## 这个插件在做什么（如果你要改它）

订阅 `agent/pre-step`，每一步往消息列表里插一条短信，内容是：

```
[时间] 现在是 <日期> <时间>（<时段>）。
[间隔] 距上次对话 <时长>（上次：<日期> <时间>，<时段>）。<跨了/没跨>。
[提示] <一段关于"什么时候该问候"的描述>
```

三段的分工是刻意的：**前两段是事实，第三段是分寸，判断权交给读得到上下文的
那一方。**

这个插件不做条件判定。它给出事实和规范，判断留给读得到上下文的那一方——数值
阈值分不清「隔了一夜的八小时」和「开了三小时的会」。

**改动这个插件时请保持这条边界：不要让它替 Agent 做判断。**

---

## 许可

MIT
