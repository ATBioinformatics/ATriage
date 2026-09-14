# ATriage 1.0

个人规则驱动的行动列表。React / TypeScript + Go + SQLite，独立应用，当前不接入 FAI。

## 启动

需要 Node.js 24 和 Go 1.26。双击 **启动 ATriage.cmd**，首次会安装前端依赖、构建页面与后端，随后打开 http://127.0.0.1:8091 。再次启动会检测已有服务。后端在后台运行，日志位于 `backend/server.log` 和 `backend/server-error.log`。

手动开发：在 `backend` 运行 `go run .`；在 `frontend` 运行 `npm ci`、`npm run dev`，访问 http://127.0.0.1:5190 。生产构建后 Go 直接提供页面，无需 Vite。

## MiMo API 配置

登录后，点击左侧 **AI API 配置**，只需粘贴 MiMo API Key 并保存。ATriage 自动识别两种官方 Key：`sk-` 开头的按量付费 Key 使用 `https://api.xiaomimimo.com/v1`；`tp-` 开头的 Token Plan Key 自动识别可用的官方区域节点；模型固定为 `mimo-v2.5-pro`。保存时会发出一次极短的验证请求，只有验证成功才保存。

Token Plan 会先连接中国节点；若套餐实际属于新加坡或欧洲节点，ATriage 会自动尝试其余两个官方节点。MiMo 官方说明：按量付费与 Token Plan 的 Key、Base URL 与模型设置以控制台为准。[MiMo Quick Start](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)

API Key 只从浏览器发给本机 ATriage 服务；服务使用本机自动生成的 AES-GCM 密钥加密后写入 `backend/data/atriage.db`，浏览器不会保存或回显 Key。`backend/data/atriage-secret.key` 必须与数据库一起保留；遗失后只需重新粘贴 API Key。对于公共电脑或多人共用同一 Windows 账号，不建议保存个人 Key。

旧的服务器级 `.env` 配置仍可作为开发者默认设置；正常使用不需要创建 `.env` 或填写模型名、URL。

没有配置或请求失败时，使用明确标注的基础规则排序：重要程度 → 截止时间 → 创建时间。基础规则不会理解个人规则文本，不会假装使用 AI。配置 MiMo 后，用户规则和待办内容会发送到 MiMo 用于生成排序建议。

## 使用

1. 注册邮箱、密码、称呼，设置角色、关注目标、规则文本和时区。角色只用于默认偏好，不赋予其他用户数据权限。
2. 一句话创建任务，可补充截止日期、时间、重要程度、说明。仅日期按任务时区的当天结束计算。
3. 新任务先保存，再获取 AI 建议。新任务可以插入列表，已有任务的相对顺序保持不变。
4. 拖拽左侧手柄，或输入数字排名后按 Enter / 离开输入框。改变顺序不会改变重要程度。
5. “查看 AI 重排建议”只预览；点“应用”才改变列表。旧版本建议无法应用。编辑任务和改变规则不会自动重排。
6. 完成和“不做”分别归档，可恢复到末尾。“考虑他人 / AI 协助”只是记录意向，不会发送或执行。

临近截止表示未来 24 小时，逾期只对未完成任务显示。系统不预测工作量是否来得及，不发邮件或系统推送。

## 数据与边界

- 数据在 `backend/data/atriage.db`，数据库写入磁盘，账号间隔离。备份时先正常停止后端，再复制整个 `backend/data` 文件夹，保留 SQLite 辅助文件。
- 密码使用 bcrypt，服务端会话 cookie 为 HttpOnly / SameSite Strict，有效期七天。首版没有邮件验证及自助找回密码，请保存密码。
- 公网部署需 HTTPS、反向代理、`COOKIE_SECURE=true`，并设置合适的 `ADDR`；默认只监听本机。
- 上限为每账号 200 条待办、2000 条总任务；任务标题 300 字，备注 3000 字，个人规则 4000 字。模型请求有 25 秒超时及每账号每分钟 10 次限制。
- 应用没有永久删除接口。需要整理开发文件时，先移至项目下固定的 `.recovery-trash` 文件夹。

## 验证

后端：`cd backend` 后运行 `go test ./... -count=1`。

前端：`cd frontend` 后运行 `npm run build` 和 `npm test`。

后端测试使用独立临时数据库和模拟模型服务，涵盖账号隔离、登录退出、持久化、顺序版本、人工保护、过时 AI 结果、非法 AI 输出和日期时区。真实模型调用需要配置后验证，模拟测试不能证明外部模型可用。

## API

所有写入使用 JSON，除注册登录外均需同源会话。`GET /api/state` 返回版本、个人设置、任务及活动顺序；每次写入携带 `version`，冲突返回 409，由界面刷新后允许重试。

- `POST /api/register`, `/api/login`, `/api/logout`
- `PUT /api/profile`：`{version, profile}`
- `POST /api/tasks`, `PUT /api/tasks`：`{version, task}`
- `PUT /api/order`：`{version, order}`，必须是当前全部待办 ID 的排列
- `POST /api/suggest`：`{version, taskId?}`，指定新任务时仅尝试插入该任务；不指定时返回重排预览
- `GET /api/health`：服务身份与 AI 是否配置，不暴露凭据
