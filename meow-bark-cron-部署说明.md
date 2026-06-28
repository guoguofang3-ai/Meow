# 喵喵机 Bark Cron Worker 部署说明

这个文件配套 `meow-bark-cron-worker.js` 使用。

## 先说结论

确定可用：

- Bark 推送。
- Cloudflare Cron 定时触发。
- Bark 通知自定义图标。
- `/test` 手动测试。
- 角色主动消息：Cron 调用模型生成一条角色微信消息，Bark 推送到手机，并存入待收箱；喵喵机下次打开会拉取进微信聊天。

只是预留，不等于已经能用：

- App 使用时间 / 手机活动查询。
- 喵喵机里确实有 `read_phone_activity` 工具入口，但它依赖外部服务提供数据。
- Worker 不能直接读取 iPhone 屏幕使用时间；它只能接收某个采集源 POST 过来的记录。

所以：现在可以先部署 Bark + 自定义图标 + Cron。App 使用时间这块先放着，等后面确定采集方式再接。

## Cloudflare 变量

在 Worker 的 `Settings -> Variables and secrets` 里添加：

```text
BARK_KEY = 你的 Bark key
BARK_ICON_URL = https://raw.githubusercontent.com/guoguofang3-ai/Meow/main/icon-192.png
```

`BARK_ICON_URL` 可选。不填时，Worker 会默认用喵喵机仓库里的 `icon-192.png`。

如果换图标后 Bark 没立刻变，可以在 URL 后面加版本号：

```text
https://raw.githubusercontent.com/guoguofang3-ai/Meow/main/icon-192.png?v=2
```

如果以后要启用 App 使用时间记录，再加：

```text
REPORT_TOKEN = 自己生成的一串长密码
```

如果要启用“角色每次 Cron 主动发消息 + Bark 推送”，再加：

```text
PROACTIVE_ENABLED = true
PROACTIVE_COOLDOWN_HOURS = 6
PROACTIVE_ROLE_NAME = 角色名，比如 喵喵酱
PROACTIVE_ROLE_PROMPT = 角色简短人设，比如 温柔、有点黏人、会监督我别刷太久小红书
PROACTIVE_USER_NAME = 你的称呼，可选
CHAT_API_URL = 你的聊天 API 地址，例如 https://api.example.com/v1/chat/completions
CHAT_API_KEY = 你的聊天 API Key
CHAT_MODEL = 你的模型名
```

`PROACTIVE_COOLDOWN_HOURS = 6` 会让 Worker 即使 Cron 配得更频繁，也最多每 6 小时生成一次角色消息。

## 粘贴 Worker 代码

1. 进入 Cloudflare 的 `meow-bark-cron` Worker。
2. 点 `Edit code`。
3. 用 `meow-bark-cron-worker.js` 的内容覆盖原代码。
4. 点 `Deploy`。

## 测试 Bark

打开：

```text
https://你的-worker.workers.dev/test
```

如果手机弹出通知，说明 Bark 已接通。

测试主动消息：

```text
https://你的-worker.workers.dev/proactive/test?token=你的REPORT_TOKEN
```

如果配置正确，手机会收到一条由角色生成的 Bark 通知。然后打开喵喵机，喵喵机会从：

```text
GET /proactive/pending
POST /proactive/pending/ack
```

拉取并确认这些待收消息，把它们写进当前角色的微信聊天。

## Cron 表达式

测试阶段：

```text
*/5 * * * *
```

稳定后建议改回每 2 小时：

```text
0 */2 * * *
```

Cloudflare 的 Cron 新建或修改后可能需要等待一段时间才开始触发。页面也会提示新 Worker 最多可能 30 分钟后才显示事件。

## 自定义 Bark 图标

Worker 会读取这个变量：

```text
BARK_ICON_URL
```

可以填任何公网图片地址。比如：

```text
https://raw.githubusercontent.com/guoguofang3-ai/Meow/main/icon-512.png
```

注意：Bark 会缓存图标。换图后不变时，加 `?v=2`、`?v=3` 这种版本号。

## 关于 App 使用时间

喵喵机 `Meow.html` 里目前有这些东西：

- API 设置里的 `手机活动查询` 配置位。
- `read_phone_activity` 工具 schema。
- 微信和 Claude 的工具调用链路里都有这个工具。
- 请求格式大致是：
  - `GET {活动服务地址}/activity`
  - `GET {活动服务地址}/activity/summary`
  - Header: `Authorization: Bearer {REPORT_TOKEN}`

但这不代表它已经能自动读取 iPhone。它只是一个“插座”。

要让它真的有数据，需要额外采集源，例如：

- iOS 快捷指令把记录 POST 到 Worker。
- 你已有的手机活动采集服务把记录 POST 到 Worker。
- 其他常驻服务定时上传数据。

## 预留接口

`meow-bark-cron-worker.js` 里预留了：

```text
POST /report
GET /activity
GET /activity/summary
```

这三个接口需要绑定 Cloudflare KV 才能保存记录。现在如果只是做 Bark 定时提醒，可以先不配 KV。

## 如果以后要启用 App 使用时间记录

需要再做：

1. Cloudflare 创建 Workers KV namespace，比如 `MEOW_ACTIVITY`。
2. 在 Worker 的 `Settings -> Bindings` 里添加 KV binding：

```text
Variable name: ACTIVITY_KV
KV namespace: MEOW_ACTIVITY
```

3. 配置 `REPORT_TOKEN`。
4. 找到一个采集源，把记录 POST 到：

```text
https://你的-worker.workers.dev/report
```

5. 在喵喵机 `API 设置 -> 手机活动查询` 里填：

```text
活动服务地址 = https://你的-worker.workers.dev
REPORT_TOKEN = Cloudflare 里的同一串 token
```

在这之前，不建议打开喵喵机里的手机活动查询工具，否则角色调用时只会查到空数据或报错。
