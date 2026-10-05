# RunningHub 云端工作流接入实施计划（独立 RunningHub 节点方案）

## Context

接入 RunningHub 平台（云端 ComfyUI 托管）的工作流 API。经讨论确定的方案：
- **新建独立的 RunningHub 画布生成节点**（不动 ComfyGenNode，本地链路零风险）
- **不需要下载工作流文件到本地**：工作流本体始终在 RunningHub 云端，本地只存一张很小的"登记卡"（rhWorkflowId + 参数映射），存在 settings.json
- **apiKey 在设置 → API 界面输入**；端点默认 `https://www.runninghub.cn` 固定预填，留高级输入框可覆盖（镜像/代理场景），平时不用动
- 参数映射 = **手动登记**：从 api-detail 页 Playground 抄 nodeId/fieldName/类型（结构化表单，非手写 JSON）

### 必要的后端适配层（协议差异决定，不可省）

| 本地 ComfyUI | RunningHub |
|---|---|
| 提交完整工作流 JSON | 只提交参数映射 nodeInfoList（工作流图在云端） |
| ComfyUI 侧自定义节点主动推图回来 | 拿 taskId 轮询 `/openapi/v2/query` |
| 结果即时在本地 | 结果 URL **24h 失效，必须立即下载转存** |
| 无鉴权 | Bearer apiKey（key 不能进浏览器，必须后端代发） |
| — | webhook 需公网不可用 → 后端轮询 |

适配层把 RunningHub 结果转成项目内部统一的 `new-image` / `new-video` WS 消息，前端回流机制与本地通道同构。

## 改动清单

### 后端（2 新建 + 2 小改）

1. **`utils/runninghub.js`（新建）** — RunningHub API 客户端：
   - `submitWorkflow(apiKey, rhWorkflowId, nodeInfoList)` → POST `/run/workflow/{id}`
   - `uploadMedia(apiKey, dataUri)` → POST `/openapi/v2/media/upload/binary`（IMAGE 槽位用）
   - `queryTask(apiKey, taskId)` → POST `/openapi/v2/query`
   - 轮询器：5s 间隔、30 分钟上限；SUCCESS → 图片下载转 base64 / 视频下载存 `data/videos/` → 推 `new-image` / `new-video`（带 target、prompt，格式与 comfy.js L87-99 一致）；FAILED → 推 `generation-failed`（新消息类型 {target, message}）
2. **`routes/runninghub.js`（新建，薄路由）** — `createRunningHubRouter({ clients })`：
   - `GET /api/runninghub/workflows`：登记表列表（供节点下拉，不含 apiKey）
   - `POST /api/runninghub/run`：body `{ workflowId, values, images(dataURI), target, positive, negative }` → IMAGE 槽位上传 RH → 组装 nodeInfoList → 提交 → 轮询器接管 → 立即返回 `{ taskId }`
3. **`routes/settings.js`**：默认结构加 `runninghub: { apiKey: '', endpoint: '', workflows: [] }`（endpoint 空 = 用默认 www.runninghub.cn）
4. **`server.js`**：挂载路由（仿 `createComfyRouter` 依赖注入）

### 前端

5. **`js/utils/NodeTypes.js`**：加 `SOURCE.RUNHUB_GEN_NODE: 'runhub-gen-node'` + `isRunHubGenNode()`，归入 `isGenNode`/`isPanelNode`/`hasDomPorts` 集合（注释"两类生图节点"更新为三类）
6. **`js/canvas/nodes/RunningHubGenNode.js`（新建）** — 仿 ComfyGenNode 结构：
   - 面板：标题栏 + 输入端口 + 工作流下拉（`/api/runninghub/workflows`）+ 动态参数容器（按登记卡渲染：`string`→输入框、`list`→下拉、`image`→提示"取节点连线图片"）+ 生成按钮
   - `generate()`：collectPrompt / collectImages（复用 ImagePipeline 连线收集，与 ComfyGenNode 同机制）→ `POST /api/runninghub/run`（target: this.id）→ 创建占位图 + 无进展看门狗
   - `receiveGeneratedImage()`：占位图 FIFO 替换（仿 ComfyGenNode L491-519）
   - `receiveGeneratedVideo(videoUrl, promptMeta)`：占位图位置落视频（委托 CanvasVideoManager）
   - 失败处理：收 `generation-failed` 清占位图、复位按钮、通知
   - 存档：toJSON/反序列化走面板节点既有链路，工作流选中按 workflowId 恢复
7. **`js/canvas/CanvasContextMenu.js`**：加 `addRunHubGenNode(pos)`（仿 L226 `addComfyGenNode`）+ 右键菜单项
8. **`js/canvas/CanvasClipboard.js`（L309 附近）与 `js/components/save/ProjectSerializer.js`（L427 附近）**：反序列化分支加 RunningHubGenNode
9. **`js/api/LumenSocket.js`**：`new-video` 分支（L211）加 target 定向路由；新增 `generation-failed` 分支
10. **`js/components/settings/SettingsApiPanel.js`**：API 面板加「RunningHub 云端工作流」区块：apiKey 输入框 + API 地址高级输入框（预填默认）+ 工作流登记列表（名称 / rhWorkflowId / 参数映射子行：nodeId、fieldName、label、类型、list 选项）→ 保存写 `settings.runninghub`
11. **`css/node.css`**：`.runhub-gen-node` 样式（沿用 `.image-gen-node`/`.comfy-gen-node` 布局基础，少量补充）

### 二期（本次不做）
- pi 工具 `canvas_run_rh_workflow`；自动拉取工作流参数列表；RH 节点参数值入存档

## 验证

1. `node --check` 两个新后端文件；重启后端（start-server.bat）
2. 设置 → API：填 apiKey，登记 api-detail `2037445392186482690`（图生视频）工作流与参数映射
3. 画布右键新建 RunningHub 节点 → 下拉选工作流 → 连提示词/图片 → 生成 → 后端日志出现提交/轮询轨迹 → 视频落回节点占位图（双击可播）
4. 错 key / 断网：节点收 generation-failed，占位图清除、按钮复位
5. 本地 ComfyGenNode 链路回归：行为不变；jest 存档/剪贴板用例通过
