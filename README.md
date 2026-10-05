# LumenLight（流光）

AI 绘画工作台：画布 + ComfyUI 工作流（本地 / RunningHub 云端）+ LLM 对话绘图 + 本地资产库 + LoRA 管理器 + agent 智能体（pi 内核）与 MCP 扩展（画布任务自动化）。

## 项目结构

```
lumen-light/
├─ .trae/                              # Trae IDE 项目配置
│  ├─ documents/
│  │  └─ runninghub-integration.md     # RunningHub 集成设计文档（Trae 生成）
│  └─ skills/
│     └─ 配色美学/
│        └─ SKILL.md                   # 项目深色主题配色规范
│
├─ .vscode/                            # VS Code 工作区配置
│  └─ settings.json                    # 编辑器项目级设置
│
├─ Real-ESRGAN/                        # 本地高清放大工具（免安装绿色版）
│  └─ realesrgan-ncnn-vulkan-v0.2.0/
│     ├─ realesrgan-ncnn-vulkan.exe    # Real-ESRGAN 可执行文件（Vulkan GPU 加速）
│     ├─ models/                       # 放大模型（x4plus、x4plus-anime、动画视频模型等）
│     ├─ vcomp140.dll / vcomp140d.dll  # VC++ 运行库
│     ├─ README.md                     # 上游工具说明
│     └─ 说明.txt                      # 使用说明
│
├─ css/                                # 前端样式文件
│  ├─ image-toolbar.css                # 图片工具栏样式（含编组工具栏按钮样式——
│  │                                   #   颜色/布局/解组按钮的宿主）
│  ├─ image-editor.css                 # 图像编辑器灯箱基础样式（遮罩/舞台/光标/
│  │                                   #   确认框/忙碌转圈遮罩）
│  ├─ image-studio.css                 # 图像编辑器 ImageStudio 布局样式（PS 式四栏：
│  │                                   #   左工具栏/舞台/右侧工具栏/色板+图层面板，
│  │                                   #   面板宽度可拖拽；含顶栏「文件」菜单与字体
│  │                                   #   下拉、PS 式内嵌取色器、文字选项与就地
│  │                                   #   编辑框、画布选图弹窗（多选瀑布流网格）、
│  │                                   #   图层选中框覆盖层、磁吸粉线、历史面板、
│  │                                   #   移动工具全域输入（.moving 绘制面放行））
│  ├─ asset-library.css                # 本地资产库窗口样式
│  ├─ lora-manager.css                 # LoRA 管理器样式（复用收藏页全屏弹窗骨架：
│  │                                   #   左文件夹栏/右封面网格 + 信息窗/投递弹窗/
│  │                                   #   删除确认/画布选图浮层；触发词备注块为
│  │                                   #   凹陷层 #0f0f12，《配色美学》色板取色；
│  │                                   #   工具行右侧筛选排序下拉+搜索框控件组
│  │                                   #   .lora-toolbar-right，触发器抬到 40px 同高）
│  ├─ llm-chat.css                     # AI 对话界面样式
│  ├─ llm-system-prompt.css            # 系统提示词弹窗样式
│  ├─ llm-skills.css                   # pi 技能库弹窗样式（查阅/启停/上传）
│  ├─ lumen-dropdown.css               # 通用自定义下拉组件样式（触发器/菜单/选项）
│  ├─ node.css                         # 提示词节点与画布右键菜单样式
│  ├─ prompt-autocomplete.css          # 提示词自动补全样式
│  ├─ prompt-panel.css                 # 提示词面板样式
│  ├─ recipe-manager.css               # 提示词收藏页面样式（含工具行右侧筛选排序
│  │                                   #   下拉+搜索框控件组 .recipe-toolbar-right，
│  │                                   #   与 lora-manager.css 同款布局）
│  ├─ recipe-models-sidebar.css        # 收藏页模型标签侧栏样式
│  ├─ save-manager.css                 # 存档管理器样式
│  ├─ save-tag-dialog.css              # 保存提示词弹窗样式
│  ├─ settings.css                     # 设置界面样式
│  ├─ side-toolbar.css                 # 侧边工具栏样式
│  ├─ style.css                        # 全局基础样式（含画布撤销/重做轻提示）
│  ├─ tag-detail-dialog.css            # 收藏详情弹窗样式
│  ├─ top-toolbar.css                  # 顶部工具栏样式
│  ├─ workflow-manager.css             # 工作流管理器样式
│  ├─ workflow-editor.css              # 工作流编辑器样式（节点图/节点内嵌控件）
│  └─ help.css                         # 使用教程页样式（help.html 专用）
│
├─ data/                               # 应用运行数据（后端读写）
│  ├─ assets/                          # 用户资产（图片工具栏「添加到资产」保存的
│  │                                   #   图片，内容哈希命名去重 + index.json 展示名
│  │                                   #   sidecar；资产库内置标签「我的资产」的数据源，
│  │                                   #   首次保存自动创建）
│  ├─ autosave/                        # 实时保存恢复槽位（后端自动生成，内容寻址图片资产
│  │                                   #   assets/ + 恢复元数据 project.json，.gitignore 已排除）
│  ├─ pi/                              # pi 智能体运行数据（自动生成）：sessions/ 会话、
│  │                                   #   session-map.json 存档↔会话映射、settings.json 权限分级
│  │                                   #   （MCP 工具门禁同源）、agent.log 进程生命周期日志、
│  │                                   #   workspace/ pi 专用可写区（临时脚本与产物白名单）、
│  │                                   #   skills/ pi 技能库（lumen-skills 扩展按需加载，
│  │                                   #   含画布出图流程 SOP、anima 质量提示词注入等；
│  │                                   #   单 .md 与 Agent Skills 文件夹两形态）、
│  │                                   #   guard.json 写门禁规则表（白名单+特征词）
│  ├─ videos/                          # 视频工作区（LLM 生成 / Comfy 回传 / 本地上传的
│  │                                   #   临时落点；保存画布时归档进存档 videos/ 并自动清理）
│  ├─ webbridge/                       # 网页桥接专用浏览器数据（profile/ 登录态与缓存、
│  │                                   #   server.log 日志；首次启动桥接时自动生成）
│  ├─ lora-meta.json                   # LoRA 元数据（LoRA 管理器读写：置顶 pinned、
│  │                                   #   触发词 triggers、备注 notes——均按 lora
│  │                                   #   相对路径做 key；删除 lora 时同步清理）
│  ├─ workflow-layouts.json            # 工作流编辑器节点布局 sidecar（拖拽位置与视图
│  │                                   #   缩放平移 + 忽略节点（bypass）清单，按 workflow id
│  │                                   #   分键；API 格式模板本身不含坐标，布局/运行时状态
│  │                                   #   单独存避免污染模板）
│  ├─ rh-snapshots.json                # RunningHub 快照 diff 基准（按 workflows/ 里的
│  │                                   #   快照 id 分键，存拉取原版全文；编辑器写回快照时
│  │                                   #   以此算字段 diff 生成编辑器覆盖——镜像存条目
│  │                                   #   editorOverrides，画布节点直连提交时按资源 id 反查）
│  ├─ skills/                          # 用户自定义技能（一个技能一个 .md，或
│  │                                   #   Agent Skills 文件夹 <id>/SKILL.md；放入即生效）
│  │  ├─ README.md                     # 技能文件格式说明与编写建议
│  │  ├─ optimize-prompt.md            # 优化提示词（自提示词节点内置技能迁移）
│  │  └─ nl-to-danbooru.md             # 自然语言转 Danbooru 格式标签
│  ├─ prompts.json                     # 系统提示词库（首次保存自动创建）
│  └─ settings.json                    # 持久化设置：多厂商 API 配置（api.providers）
│                                      #   与用途绑定（api.bindings：对话/技能/生图各用
│                                      #   哪个模型）；RunningHub 配置（runninghub：
│                                      #   apiKey/endpoint/旧工作流登记卡 workflows——
│                                      #   登记卡模式已退役只读保留，画布节点直连后
│                                      #   仅旧存档节点仍按卡提交）；
│                                      #   MCP 服务器（mcp.servers：用户自挂的 MCP）；
│                                      #   ComfyUI 根目录（comfy.root：comfy 原生
│                                      #   工具下载模型落盘的定位依据）
│
├─ image/                              # 项目图片资源
│  ├─ 1.png
│  ├─ 2.png                            # 生成反馈动画用的两张 832×1216 图片
│  └─ help/                            # 使用教程配图（help.html 引用，共 12 张）
│
├─ js/                                 # 浏览器端 JavaScript 源码
│  ├─ api/                             # 前端 API 与通信封装
│  │  └─ LumenSocket.js                # Lumen WebSocket 客户端（接收 ComfyUI 生成图片/视频、
│  │                                   #   画布桥接命令执行器（drop_image 支持 dataUrl
│  │                                   #   或公网图片直链——直链经后端代理取图；
│  │                                   #   drop_video 引用 data/videos/ 已落盘视频）、
│  │                                   #   pi 事件转发、心跳）
│  │
│  ├─ canvas/                          # 画布核心模块
│  │  ├─ nodes/                        # 画布节点本体（一个节点一个文件）
│  │  │  ├─ BaseCanvasNode.js          # 节点基类（几何/生命周期/两种布局模式/
│  │  │  │                             #   标题 #NNN 全局编号——构造时从画布计数器
│  │  │  │                             #   分配、随存档持久化、删除不复用防顶替）
│  │  │  ├─ PromptNode.js              # 提示词节点（DOM 面板，支持参考图缩略图、
│  │  │  │                             #   @图片N 引用与中文提示词补全）
│  │  │  ├─ PromptSkillBar.js          # 提示词节点技能栏（技能下拉+模型下拉+执行；
│  │  │  │                             #   技能=内置+data/skills/ 用户技能，模型全局
│  │  │  │                             #   记忆，默认第一序聊天模型，调 /api/llm/chat）
│  │  │  ├─ TextNode.js                # 文本节点（画布备注/注释，无端口不可连线）
│  │  │  ├─ LoraNode.js                # LoRA 节点（可堆叠 LoRA 组合，串在提示词链路中
│  │  │  │                             #   作用于下游 Comfy 生图；提交时后端图拼接注入，
│  │  │  │                             #   追加在模板 lora 之后——补充/无模板 lora 场景）
│  │  │  ├─ ImageGenNode.js            # 生图节点（收集上游提示词链并调用生图 API；
│  │  │  │                             #   生成行=数量步进器（CountStepper，1-8 并发）
│  │  │  │                             #   +生成按钮+停止 X（常驻两态，中止本轮并发
│  │  │  │                             #   请求，后端断连同步掐断上游））
│  │  │  ├─ ComfyGenNode.js            # Comfy 生图节点（选工作流动态调参，提交 ComfyUI；
│  │  │  │                             #   含模板内嵌 lora 的文件/启用管理；停止 X
│  │  │  │                             #   与 API 生图节点同款——GenStopControl）
│  │  │  └─ RunningHubGenNode.js       # RunningHub 云端生成节点（第三条生成链路，工作流/
│  │  │                                #   应用双模式：节点上输平台 ID 点「拉取」动态
│  │  │                                #   布局参数行，模板随存档持久化+localStorage
│  │  │                                #   最近缓存；应用模式多实例档位下拉；提交平台→
│  │  │                                #   轮询→结果转存回流，与本地 Comfy 链路同构；
│  │  │                                #   旧登记卡在「已登记」分组兼容旧存档）
│  │  ├─ Canvas.js                     # 画布主控制器（生命周期与核心状态、
│  │  │                                #   节点编号计数器 allocNodeSeq/syncNodeSeq
│  │  │                                #   ——只增不减，存档恢复做下限同步）
│  │  ├─ CanvasClipboard.js            # 画布剪贴板（拖放/粘贴上传图片与视频、Ctrl+C/X/V）
│  │  ├─ CanvasConnections.js          # 图片连线管理（端口、贝塞尔连线、命中检测）
│  │  ├─ NodeTextMirror.js             # 节点文本镜像层（@引用高亮 + 自绘光标，多节点共用）
│  │  ├─ CanvasContextMenu.js          # 画布右键节点菜单（新建组 + 添加提示词/
│  │  │                                #   生图/LoRA 节点等；新建组在有选中元素时
│  │  │                                #   自动包住，否则按画布内容量级自适应尺寸）
│  │  ├─ CanvasVideoManager.js         # 画布视频管理器（首帧封面 + 双击就地播放器，
│  │  │                                #   播放器跟随视口变换，ESC/点击外部关闭；
│  │  │                                #   本地视频文件导入共享入口 addVideoFile）
│  │  ├─ CanvasHistory.js              # 画布撤销/重做（Ctrl+Z / Ctrl+Shift+Z、
│  │  │                                #   Ctrl+Y；命令栈上限 50 步，移动/缩放/
│  │  │                                #   删除/新增/连线/编组全可回退；位图删除
│  │  │                                #   后持引用按原下标放回（id 不变连线免
│  │  │                                #   重映射），节点删除走 toJSON 重建（新旧
│  │  │                                #   id 经映射表换算，连线重做仍指向正确
│  │  │                                #   对象，#NNN 编号保留）；视频文件清理
│  │  │                                #   延迟到命令淘汰，存档切换/新建画布清栈）
│  │  ├─ CanvasHitTester.js            # 画布命中检测与光标决策（纯几何判定层）
│  │  ├─ CanvasInteraction.js          # 鼠标及键盘交互（选择、拖拽、缩放、平移、
│  │  │                                #   连线；编组的标题栏拖动/边缘缩放/删除也
│  │  │                                #   在此路由，手势派发 canvasGroupDragStart/End；
│  │  │                                #   组与图片选中互斥在此双向收口；Ctrl+Z/Y
│  │  │                                #   撤销/重做快捷键与手势提交入栈在此收口）
│  │  ├─ ImageProxyCache.js             # 图片显示代理缓存（低分辨率档位下缩小查看画
│  │  │                                #   降采样副本、放大自动切回原图；纯函数决策 +
│  │  │                                #   空闲分片构建；只影响绘制，原始图片不受影响）
│  │  ├─ CanvasRenderer.js             # 画布内容渲染（连线、图片、控制点、框选、
│  │  │                                #   视口剔除与代理绘制接入；编组组体绘制——
│  │  │                                #   圆角轮廓/标题栏色带/选中描边）
│  │  ├─ ImageManager.js               # 画布图片管理（添加、选择、删除、命中检测；
│  │  │                                #   删除视频对象时即时清理工作区文件）
│  │  ├─ GroupManager.js               # 画布编组管理器（右键新建组；标题栏双击改名、
│  │  │                                #   拖标题整组联动、四边手柄缩放只改边界；
│  │  │                                #   成员按几何包含实时判定，组不存成员清单；
│  │  │                                #   组体画在 canvas 最底层，Delete 只删组壳；
│  │  │                                #   标题栏尺寸创建时定格（titleNS，调整组
│  │  │                                #   宽高不变）、配色下拉，选中派发
│  │  │                                #   canvasGroupSelected 事件供工具栏联动）
│  │  ├─ GroupLayout.js                # 编组成员布局算法（宫格/水平/垂直，纯函数
│  │  │                                #   只移动不缩放，阅读顺序排序、⌈√n⌉ 列宫格，
│  │  │                                #   输出归一化坐标供 GroupToolbar 应用）
│  │  └─ Viewport.js                   # 视口缩放与平移管理（坐标转换、自适应边界）
│  │
│  ├─ components/                      # 前端 UI 组件与功能控制器
│  │  ├─ save/                         # 存档子模块（从 SaveManager 拆出）
│  │  │  ├─ ProjectSerializer.js       # 存档序列化器（画布状态 <-> project.json；
│  │  │  │                             #   视频封面 .png 命名、videoUrl 恢复与回写；
│  │  │  │                             #   编组序列化为顶层 groups 字段（几何 + 标题
│  │  │  │                             #   + color/titleNS，无引用换算）；节点 seqId
│  │  │  │                             #   与计数器 nodeSeq 随存档持久化）
│  │  │  ├─ SaveModal.js               # 存档相关模态框 UI（打开/保存/另存为等）
│  │  │  ├─ CanvasChangeWatcher.js     # 画布变更捕获器（hook draw + 全局事件，
│  │  │  │                             #   RealtimeSaveManager 共用）
│  │  │  └─ RealtimeSaveManager.js     # 实时保存管理器（变更增量写入本地磁盘
│  │  │                                #   data/autosave/：图片按内容哈希上传一次，
│  │  │                                #   轻量元数据 2s 防抖 + 5s 强制落盘 + 内容
│  │  │                                #   比对去重；启动时磁盘有未收尾会话则弹窗
│  │  │                                #   询问恢复；成功只刷新时间戳(HH:MM:SS)）
│  │  ├─ settings/                     # 设置面板子模块
│  │  │  ├─ SettingsApiPanel.js        # API 设置面板（内置提供商 + 自定义 OpenAI 兼容
│  │  │                             #   厂商的自由添加/删除、端点、Key、模型列表）
│  │  │  ├─ SettingsGeneralPanel.js    # 通用设置面板（画布缩放锚点显隐、画布显示
│  │  │  │                             #   质量、提示词补全开关、权限分级与
│  │  │  │                             #   agent 底层模型选择）
│  │  │  ├─ SettingsRembgPanel.js      # 抠图模型面板（模型下载/续传/删除）
│  │  │  ├─ SettingsMcpPanel.js        # MCP 服务器面板（用户自挂 MCP：登记卡片/
│  │  │  │                             #   连接状态/工具清单启停/ComfyUI 认领/
│  │  │  │                             #   资源与提示词预览，保存即差量应用）
│  │  │  └─ SettingsWebBridgePanel.js  # 网页桥接面板（桥接站点选择/浏览器路径/
│  │  │                                #   专用浏览器启动与关闭/状态轮询）
│  │  ├─ AssetLibrary.js               # 本地资产库窗口（左侧工具栏文件夹按钮：
│  │  │                                #   标签绑定本地文件夹、内置标签「我的资产」
│  │  │                                #   （/api/assets 数据源，可删可自动恢复）、
│  │  │                                #   缩略网格、拖拽入画布、双击灯箱预览；
│  │  │                                #   FSA API+webkitdirectory 降级）
│  ├─ LoraManager.js                   # LoRA 管理器（顶栏「LoRA」按钮：复用收藏页
│  │                                   #   全屏弹窗骨架——左文件夹/右封面网格（整卡
│  │                                   #   3:4、一行 5 个），sidecar 预览图+渐变占位；
│  │                                   #   筛选排序下拉（LumenDropdown 图标按钮模式：
│  │                                   #   置顶优先/添加时间 新→旧/旧→新/仅看置顶，
│  │                                   #   选择存 localStorage，时间用 mtime 近似）；
│  │                                   #   星标置顶；纸飞机投递到画布 LoRA 节点
│  │                                   #   （标题带 #NNN 编号）或右侧 Comfy 面板
│  │                                   #   loraStack（追加语义）；点封面开信息窗——
│  │                                   #   画布/本地上传封面、触发词/备注编辑、
│  │                                   #   删除确认（源文件+预览+元数据）、打开
│  │                                   #   所在文件夹；ComfyUI 目录未配置时自动
│  │                                   #   检测——运行进程命令行反推并写回配置；
│  │                                   #   数据源 /api/lora，见 routes/lora.js）
│  ├─ CountStepper.js                  # 数量步进器行为层（上下箭头/键入/钳制，
│  │                                   #   画布 Comfy 生图节点与面板运行行共用）
│  ├─ GenStopControl.js                # 生成任务停止控件（任务级 X 按钮 + 每轮一个
│  │                                   #   AbortController 内核；面板 ■停止为无头
│  │                                   #   模式聚合逐个 abort，生图节点 X 挂生成
│  │                                   #   按钮右侧仅生成中显示；AbortError 判别
│  │                                   #   静态方法供错误分支分流）
│  ├─ Controls.js                   # 左下角视图控制（自适应屏幕、缩放指示）
│  │  ├─ GenerationFeedback.js         # 面板侧生成占位图门面（FIFO 队列语义）
│  │  ├─ PlaceholderManager.js         # 全局生成占位图管理器（归属/句柄/动画/落图）
│  │  ├─ ImageToolbar.js               # 图片选中浮动工具栏（含「编辑」入口——
│  │  │                                #   直接打开 ImageStudio 图像编辑器——与
│  │  │                                #   「添加到资产」（POST /api/assets 存
│  │  │                                #   data/assets/）、下载、高清放大等按钮）
│  │  ├─ GroupToolbar.js                # 编组选中工具栏（样式复用 image-toolbar.css，
│  │  │                                #   显隐经 canvasGroupSelected 事件驱动；
│  │  │                                #   「标题栏颜色」「布局」下拉（宫格/水平/
│  │  │                                #   垂直排列成员并重_fit 组矩形）+「解组」
│  │  │                                #   按钮——删组壳保留成员）
│  │  ├─ image-studio/                 # ImageStudio 功能区子模块（主类保留状态/
│  │  │                                #   打开关闭/绘制/视图变换 + 同名薄代理，
│  │  │                                #   子模块持有宿主实例读写其状态）
│  │  │  ├─ StudioDomBuilder.js        # DOM 构建与事件绑定（顶栏/左右工具栏/
│  │  │  │                             #   舞台/右侧面板/历史面板/弹窗/键盘
│  │  │  │                             #   快捷键/面板拖宽）
│  │  │  ├─ StudioLayerPanel.js        # 图层栈 DOM 与图层面板 UI（增删/复制/
│  │  │  │                             #   拖放排序（指针拖拽 + 蓝色插入条，
│  │  │  │                             #   松手 FLIP 滑入落位）/眼睛开关/类型
│  │  │  │                             #   视觉（像素层实时缩略图/文字层 T 徽标/
│  │  │  │                             #   背景层锁标）/透明度联动/右键菜单）
│  │  │  ├─ StudioImport.js            # 置入本地/画布图片为图层（隐藏 file
│  │  │  │                             #   input 多选 + 画布选图多选弹窗）
│  │  │  ├─ StudioMoveTool.js          # 移动工具（图层选中/拖动/拖角等比缩放
│  │  │  │                             #   + 磁吸吸附——图层边/中心对齐画幅
│  │  │  │                             #   边/中心，移动与缩放均生效，吸附
│  │  │  │                             #   轴画粉色参考线 + 选中框覆盖层绘制）
│  │  │  ├─ StudioTextTool.js          # 文字工具（点击画布新建文字层就地输入、
│  │  │  │                             #   点击已有文字层再编辑，Ctrl+Enter/点击
│  │  │  │                             #   外部提交、Esc 撤销；文字按属性渲染进
│  │  │  │                             #   图层画布复用全部图层管线，属性随
│  │  │  │                             #   studioLayers 序列化支持恢复后再编辑；
│  │  │  │                             #   竖排逐字自绘——CJK 直立、西文段转 90°）
│  │  │  ├─ StudioShapeTool.js         # 形状工具（属性驱动形状层：矩形/圆角
│  │  │  │                             #   矩形/椭圆/气泡框（椭圆+尾巴单一路径），
│  │  │  │                             #   顶栏类型四选一/填充/边框色/边宽/圆角，
│  │  │  │                             #   填充与边框各配 PS 式红斜杠去除色块
│  │  │  │                             #   （开关式：去除↔恢复上次值）；拖拽创建
│  │  │  │                             #   （Shift 约束正方）、点击已有形状改属性；
│  │  │  │                             #   画布按尾巴方向/描边外伸扩展防裁切；
│  │  │  │                             #   不做矢量——缩放提交时倍率烘焙回属性
│  │  │  │                             #   重渲染，永远锐利）
│  │  │  ├─ StudioBlurTool.js          # 模糊笔刷（平铺语义：一笔之内每个像素
│  │  │  │                             #   只模糊一次，回描/重叠不叠加；拖动中
│  │  │  │                             #   把笔迹画进遮罩，实时预览 = 起笔快照
│  │  │  │                             #   模糊后经遮罩（羽化边缘）合成，σ =
│  │  │  │                             #   强度/10；渲染限帧 + 起笔快照重建保
│  │  │  │                             #   证大笔刷下光标流畅、所见即所得）
│  │  │  ├─ StudioColorPicker.js       # 色板取色器（PS 式内嵌面板：当前/上次色
│  │  │  │                             #   叠块 + SV 渐变方框 + 垂直色相条 + Hex
│  │  │  │                             #   输入；拖拽实时 setColor，松手入最近
│  │  │  │                             #   使用色；HSV/RGB/Hex 纯函数可单测）
│  │  │  ├─ StudioHistory.js           # 历史记录（PS 历史面板同款：操作完成点
│  │  │  │                             #   拍图层栈全量快照，上限 20 条；右栏
│  │  │  │                             #   按钮唤出浮动面板，点击条目回退/前进，
│  │  │  │                             #   Ctrl+Z / Ctrl+Shift+Z 步进；中间状态
│  │  │  │                             #   再操作截断未来条目）
│  │  │  ├─ StudioCropTool.js          # 裁剪/扩图（画幅框四边锚点拖拽 + 三分
│  │  │  │                             #   网格覆盖层渲染，移植自 ImageOutpaint）
│  │  │  └─ StudioSave.js              # 保存拍平契约（底片/笔迹/遮罩/图层栈
│  │  │                                #   序列化/扩图导出）
│  │  ├─ ImageStudio.js                # 图像编辑器主类（PS 式统一灯箱，编辑→
│  │  │                                #   画笔/遮罩/移除/扩图多入口合一，进入默认
│  │  │                                #   移动工具；功能区拆分见 image-studio/）：
│  │  │                                #   左工具栏（移动/画笔/
│  │  │                                #   橡皮/模糊笔刷（平铺柔化，顶栏「强度」
│  │  │                                #   调 σ）/文字（顶栏字体/字号/横竖排选项，
│  │  │                                #   文字层可再编辑）/形状（顶栏类型/填充/
│  │  │                                #   描边/圆角选项，形状层可再编辑）/遮罩
│  │  │                                #   开关/移除工具（自带
│  │  │                                #   遮罩涂抹，松手自动 AI 抹除——LaMa 本地
│  │  │                                #   推理，推理期忙碌遮罩拦截全部操作）/还原
│  │  │                                #   （清空全部遮罩/重置画幅/还原图层像素）/裁剪）
│  │  │                                #   + Delete 键删除激活图层 + 顶栏「文件」
│  │  │                                #   菜单（置入本地/画布图片→新图层，画布图经
│  │  │                                #   中央多选弹窗挑选）+ 粗细 + 右侧色板
│  │  │                                #   （PS 式内嵌取色器 + 最近使用 MRU +
│  │  │                                #   预设 8 色）+ 右侧工具栏（历史记录
│  │  │                                #   按钮，Ctrl+Z/Ctrl+Shift+Z 步进）与
│  │  │                                #   图层面板（白底背景层垫底锁变换，图片=
│  │  │                                #   图层0 可移动缩放/拖动排序/删除（背景
│  │  │                                #   层恒在最底），置入图层=内容尺寸
│  │  │                                #   内容紧致，其上可涂画可拖拽排序、
│  │  │                                #   右键新建/复制/删除图层、逐层透明度）；保存按
│  │  │                                #   契约拍平——背景+图片层按变换合成写回
│  │  │                                #   图片本体、上层内容拍平 editStrokes、
│  │  │                                #   遮罩并集 mask（Comfy 烘焙 alpha）、
│  │  │                                #   画幅变更按变换合成导出新图；图层栈与
│  │  │                                #   变换随存档持久化（studioLayers），
│  │  │                                #   旧格式自动迁移
│  │  ├─ LlmAttachments.js             # AI 对话待发送图片附件管理
│  │  ├─ LlmChat.js                    # AI 对话核心组件（多轮对话、多模态、生图、
│  │  │                                #   agent 模式路由、流式气泡；发送链路与生图
│  │  │                                #   任务拆至 LlmApiSender，历史持久化拆至
│  │  │                                #   LlmHistoryController——本类留同名薄代理；
│  │  │                                #   模型下拉为四分类双栏菜单（Agent/图片/
│  │  │                                #   视频/其他），对话模型选中即写 piModelKey
│  │  │                                #   走 agent；输入框 Ctrl+V 粘贴图片直达附件
│  │  │                                #   槽位，画布复制的图片也可贴进对话）
│  │  ├─ LlmApiSender.js               # LLM 发送链路控制器（LlmChat 第二刀拆分：
│  │  │                                #   发送路由分流 pi agent/网页桥接/视频/生图、
│  │  │                                #   生图全流程与停止内核（GenStopControl
│  │  │                                #   无头集合）、生成图块构造与重新生成）
│  │  ├─ ChatHistoryStore.js           # 聊天记录持久化（消息区 DOM 快照存 IndexedDB，
│  │  │                                #   跨存档统一键、网页桥接按站点分键，F5 后恢复）
│  │  ├─ LlmHistoryController.js       # 聊天记录持久化编排（LlmChat 拆出：防抖快照/
│  │  │                                #   模式互换/启动恢复/DOM 重绑；LlmChat 上留
│  │  │                                #   同名薄代理，调用点零改动）
│  │  ├─ LlmMessageRail.js             # 消息刻度导航（消息区左缘悬浮索引：每条
│  │  │                                #   用户消息一刻度，悬停预览/点击跳转/
│  │  │                                #   滚动同步高亮；用户消息 ≥2 条才显示）
│  │  ├─ LlmVideoGen.js                # LLM 视频生成控制器（文/图生视频任务提交、
│  │  │                                #   轮询进度、播放器渲染、视频拖到画布）
│  │  ├─ LlmPiAgent.js                 # pi 智能体控制器（消息发往 pi RPC 子进程，
│  │  │                                #   流式分阶段块——思考/工具默认折叠，工具块
│  │  │                                #   中文标题映射（bash→终端等，_toolMeta）
│  │  │                                #   +头部计时/执行中指示器/失败重试/卡死
│  │  │                                #   上报按钮；停止为乐观立即收尾——清队列+
│  │  │                                #   中止指令后台发送，不等 pi 应答）
│  │  ├─ LlmWebBridge.js               # 网页桥接控制器（消息驱动进目标站点网页——
│  │  │                                #   豆包等，回复流式回流；与 LlmPiAgent 平级）
│  │  ├─ PiStatusLight.js              # pi 健康状态灯（面板头部四态指示：灰未运行/
│  │  │                                #   绿正常/黄疑似卡死/红已退出；黄红可点击重启）
│  │  ├─ LlmImageDrag.js               # AI 对话图片拖拽到画布功能
│  │  ├─ LlmLightbox.js                # 灯箱全屏预览（图片大图/视频播放器，
│  │  │                                #   聊天与本地资产库共用）
│  │  ├─ LlmSizePicker.js              # 图片比例 + 分辨率档位双段选择器
│  │  ├─ LlmSystemPrompt.js            # 系统提示词管理（弹窗与启用状态）
│  │  ├─ LlmSkillManager.js            # pi 技能库管理（面板头部按钮+弹窗：查阅/
│  │  │                                #   勾选启停/上传单 .md 与 Agent Skills 文件夹）
│  │  ├─ LumenDropdown.js              # 通用自定义下拉组件（触发器/菜单/键盘导航；
│  │  │                                #   图标按钮/动作型菜单/分类双栏三形态——
│  │  │                                #   双栏=左栏分类右栏两行条目，跨分类单选；
│  │  │                                #   setLabel 恢复触发器文案、reposition 供
│  │  │                                #   视口变化时跟随）
│  │  ├─ NewCanvasManager.js           # 新建画布管理（含未保存确认框）
│  │  ├─ PromptAutocomplete.js         # 提示词自动补全 UI（词典在共享单例
│  │                                #   PromptDictStore；光标就近定位 + IME 兼容）
│  │  ├─ PromptInputManager.js         # 正向/负向提示词输入管理
│  │  ├─ PromptPanel.js                # 提示词面板主组件（可拖拽调整大小）
│  │  ├─ PanelThumbnailManager.js      # 面板缩略图槽位管理（动态槽位，数量跟随
│  │  │                                #   所选工作流的取图节点数）
│  │  ├─ PanelComfyRunner.js           # 面板"发送到 ComfyUI"运行流程（循环入队
│  │  │                                #   comfy-node/run，依赖注入）
│  │  ├─ ComfyParamRows.js             # Comfy 动态参数行控制器（画布生图节点与
│  │  │                                #   右侧面板 Comfy 模式共用同一套渲染；
│  │  │                                #   loraStack 选项渲染可折叠 LoRA 叠加区）
│  │  ├─ RunningHubParamRows.js        # RunningHub 参数行控制器（按参数模板渲染
│  │  │                                #   文本/下拉参数行，图片槽位不渲染——
│  │  │                                #   生成时取节点连线图片；宽高合并尺寸行）
│  │  ├─ RecipeManager.js              # 提示词收藏页面（瀑布流卡片 + 标签筛选；
│  │                                #   搜索框左侧筛选排序下拉：收藏先后/添加时间
│  │                                #   新→旧（createdAt）/名称 A→Z，localStorage 记忆）
│  │  ├─ WorkflowEditor.js             # 工作流编辑器（顶栏 Comfy 按钮：左列表 +
│  │  │                                #   右节点图；API JSON 自动布局、Comfy 风
│  │  │                                #   节点内嵌全参数控件、拖拽布局 sidecar、
│  │  │                                #   右键/Ctrl+B 忽略节点（bypass 状态存
│  │  │                                #   sidecar，提交时按 ComfyUI 规则直通剔除）、
│  │  │                                #   修改直接写回 workflows/*.json）
│  │  ├─ SaveManager.js                # 存档管理器编排层（文件菜单、存档流程；
│  │  │                                #   三段式保存协议：init→图片批次→finalize）
│  │  ├─ SaveTagDialog.js              # 保存提示词前的命名/标签弹窗
│  │  ├─ SettingsManager.js            # 设置界面外壳与调度中心
│  │  ├─ SideToolbar.js                # 侧边工具栏（本地上传：图片+视频）
│  │  ├─ TagDetailDialog.js            # 收藏详情弹窗（大图预览 + 元数据编辑）
│  │  ├─ TagReferenceSlots.js          # 详情弹窗参考图槽位（最多 5 张）
│  │  ├─ UpscaleManager.js             # 高清放大功能管理（Real-ESRGAN 集成）
│  │  └─ WorkflowManager.js            # ComfyUI 工作流管理
│  │
│  ├─ utils/                           # 前端通用工具
│  │  ├─ NodeTypes.js                  # 节点类型注册表（source 常量与类型谓词唯一出处）
│  │  ├─ PromptDictStore.js            # 提示词词典共享单例（加载/IndexedDB 缓存
│  │  │                                #   按文件指纹失效/预构建索引/四级优先搜索）
│  │  ├─ AssetFolderStore.js           # 资产库标签持久化（IndexedDB：标签↔本地
│  │  │                                #   文件夹句柄）
│  │  ├─ ImagePipeline.js              # 生图节点管线（提示词/参考图/LoRA 堆栈收集；
│  │  │                                #   Comfy 链路可把遮罩图层烘进槽位图 alpha）
│  │  ├─ ImageExport.js                # 图片源导出工具（任意源→data URL/blob 统一
│  │  │                                #   转换：fetch/远程代理/魔数嗅探/canvas 兜底，
│  │  │                                #   工具栏「添加到资产」「下载」共用）
│  │  ├─ ComfyParamScanner.js          # Comfy 工作流参数扫描/覆盖表编译（画布
│  │  │                                #   生图节点与面板参数区共用的纯数据层）
│  │  ├─ RhWorkflowImporter.js         # RunningHub 工作流 JSON 导入解析器（API 格式
│  │  │                                #   JSON → 参数行定义；图片槽位/提示词
│  │  │                                #   role/标量白名单三类识别，纯函数可测试）
│  │  ├─ RhAppImporter.js              # RunningHub 应用参数模板解析器（apiCallDemo
│  │  │                                #   返回 → 参数行定义；fieldType 分流——
│  │  │                                #   IMAGE 槽位/LIST 选项/STRING 角色/BOOLEAN
│  │  │                                #   开关，description 作中文标签，纯函数可测试）
│  │  ├─ PromptMerge.js               # 提示词段合并（节点链/面板双正面框共用，
│  │  │                                #   拼接处自动补逗号区分中英文）
│  │  ├─ llmQuality.js                 # 生图模型 quality 参数档位判断
│  │  └─ llmResolution.js              # AI 图片比例/分辨率计算与降级逻辑
│  ├─ app.js                           # 前端应用入口（初始化各组件）
│  ├─ help.js                          # 使用教程页脚本（目录生成 + 滚动高亮）
│  └─ config.js                        # 前端全局配置与工具（命名空间 LumenLight；
│                                      #   多厂商模型聚合，下拉值 = 厂商||模型 复合键）
│
├─ pi/                                 # pi 编码智能体完整运行包（421MB，含 node_modules；
│                                      #   随发行包分发、不入 git，pi 由它拉起、不依赖
│                                      #   用户全局安装；扩展的落位见 pi-extensions/；
│                                      #   工具清单.md 为画布工具/技能的人读清单，增删工具时同步）
├─ pi-extensions/                      # pi 扩展源码（piAgentManager 拉起 pi 前自动
│                                      #   差量同步到 ~/.pi/agent/extensions/——
│                                      #   见 utils/piExtensionSync.js，发行包解压即用）：
│                                      #   lumen-guard.ts 项目代码写保护门禁（spawn 时
│                                      #   另经 -e 从本目录显式加载，不依赖自动发现）；
│                                      #   lumen-skills.ts pi 技能库（skill_list/
│                                      #   skill_load 按需加载 data/pi/skills/，
│                                      #   单 .md 与 Agent Skills 文件夹两形态，
│                                      #   面板禁用清单即时生效）；
│                                      #   lumen-mcp.ts MCP 工具桥（把用户挂的 MCP
│                                      #   服务器工具注册给 agent，结构化调用）；
│                                      #   lumen-web.ts 联网工具（web_search 搜索
│                                      #   DDG 主源+Bing 备源、web_fetch 读网页正文、
│                                      #   web_image_search 搜图 Bing→百度→DDG
│                                      #   三源回退+source 强制参数，无 key 零依赖）；
│                                      #   lumen-canvas.ts 画布工具扩展（14 个画布
│                                      #   工具+provider 注册+权限分级拦截；
│                                      #   生图/视频为异步任务句柄式——提交即返回
│                                      #   任务 id，canvas_poll_task 查询，完成自动
│                                      #   落画布，不挂住 agent 回合）；
│                                      #   lumen-comfy.ts Comfy 原生工具扩展（18 个
│                                      #   comfy_mcp_* 工具，comfy-mcp MCP 服务器
│                                      #   退役后的原生替代：命名与上游一一对应，
│                                      #   经后端 /api/comfy-tools 直连 ComfyUI
│                                      #   HTTP API / Manager / 模板画廊，零 venv）
│
├─ mcp/                                # 本地 MCP 服务器运行时（与 pi/ 同策略：随发行
│                                      #   包分发、不入 git）；comfy-mcp/ 为已退役
│                                      #   的 comfy-mcp 服务器虚拟环境——工具已原
│                                      #   生化为 lumen-comfy 扩展，整个目录可删
│
├─ lumen_nodes/                        # ComfyUI 自定义 Python 节点
│  ├─ LumenReceiveImageFromCanvas.py   # 从画布槽位接收图片（用于 Edit/局部重绘工作流；
│  │                                   #   mask 输出与 Comfy 同约定：透明=1=重绘区）
│  ├─ LumenSendImageRealtime.py        # 实时发送生成图片回画板（HTTP 版）
│  ├─ LumenSendVideoToCanvas.py        # 发送视频到画板（二进制直传，接原生 VIDEO /
│  │                                   #   VHS Filenames 输出）
│  └─ __init__.py                      # Python 包及节点注册入口
│
├─ models/                             # 本地 AI 模型（download-model.js 下载）
│  ├─ rembg/
│  │  └─ RMBG-2.0-fp16.onnx            # RMBG 2.0 FP16 抠图模型
│  └─ lama/
│     └─ lama_fp32.onnx                # LaMa inpainting 模型（Carve ONNX 导出
│                                      #   版，opset 17；物体移除本地推理用）
│
├─ routes/                             # Node.js 后端路由
│  ├─ autosave.js                      # 实时保存接口（内容寻址资产上传、恢复元数据│  │                                   #   原子写入/读取/清空、孤儿资产回收）
│  ├─ assets.js                        # 用户资产接口（图片工具栏「添加到资产」：
│  │                                   #   内容寻址保存去重 + 展示名 sidecar +
│  │                                   #   列表/文件读取，路径穿越防护）
│  ├─ canvasImages.js                  # 画板图片/遮罩槽位接口（/api/canvas-image 与
│  │                                   #   /api/canvas-mask，1-3 号按位对齐；遮罩槽供
│  │                                   #   局部重绘：黑白图白=重绘区，随提交写/清）
│  ├─ canvasBridge.js                  # 画布桥接（pi/MCP 等外部 agent 的工具命令
│  │                                   #   转发：读命令广播、写命令路由活跃客户端）
│  ├─ comfy.js                         # ComfyUI 通信接口（提交工作流、推送生成图片）
│  ├─ comfyNode.js                     # Comfy 生图节点接口（object_info 模型清单与
│  │                                   #   采样器枚举代理、工作流编辑器用通用
│  │                                   #   /object-info 参数类型代理；注入参数/提示
│  │                                   #   词/种子/参考图槽位/画布 LoRA 堆栈后提交工作流；
│  │                                   #   提交前应用编辑器的忽略节点（bypass）状态；
│  │                                   #   POST /stop 按本轮 promptId 中断/删队列，
│  │                                   #   支撑停止 X 真正取消 ComfyUI 任务）
│  ├─ comfyTools.js                    # Comfy 原生工具路由（comfy-mcp MCP 服务器退役
│  │                                   #   后的精选工具原生实现，供 pi 扩展
│  │                                   #   lumen-comfy 调用：状态/队列/输出取回/
│  │                                   #   工作流执行与槽位/模板画廊/模型检索下载/
│  │                                   #   文件上传/Manager 节点安装/依赖分析/日志；
│  │                                   #   utils/comfyWorkflowFormat 为格式转换与
│  │                                   #   槽位扫描的纯函数层）
│  ├─ runninghub.js                    # RunningHub 云端路由（节点直连：/run 按
│  │                                   #   kind+resourceId+params 提交工作流/应用、
│  │                                   #   /fetch-app 拉应用参数模板；旧登记卡按
│  │                                   #   workflowId 兼容提交；提交生成→平台轮询→
│  │                                   #   结果下载转存后经 WS 回流画布；编辑器覆盖
│  │                                   #   直连模式从快照 sidecar 反查——运行时参数行优先）
│  ├─ mcp.js                           # MCP 宿主路由（用户自挂 MCP 服务器：登记/
│  │                                   #   连接/状态/工具清单/调用代理/resources/
│  │                                   #   prompts/refresh，供设置界面与 pi 桥接）
│  ├─ webbridge.js                     # 网页桥接路由（LLM 面板「网页桥接」模式：
│  │                                   #   状态/配置/启停浏览器/发消息/中止；
│  │                                   #   回复流与产物经 WS 推送）
│  ├─ llm.js                           # 大语言模型代理接口（避免浏览器跨域；模型路由
│  │                                   #   支持显式指定厂商，未指定时按模型 ID 自动回退；
│  │                                   #   生图请求监听客户端断连并同步中止上游；
│  │                                   #   含本地视频上传接口）
│  ├─ lama.js                          # 本地物体移除接口（LaMa inpainting ONNX 推理：
│  │                                   #   遮罩 bbox 裁剪 + 等比镜像 pad + refiner
│  │                                   #   二次细化，羽化软边贴回原图；懒加载常驻 +
│  │                                   #   推理串行队列；编辑器「移除」模式调用）
│  ├─ lora.js                          # LoRA 管理接口（递归扫描 <comfy.root>/models/
│  │                                   #   loras 清单（相对路径=Comfy lora_name 同源）、
│  │                                   #   sidecar 封面预览与上传、置顶/触发词/备注
│  │                                   #   元数据（data/lora-meta.json）、删除（源文件
│  │                                   #   +预览+元数据）、打开所在文件夹；comfy.root
│  │                                   #   未配置/失效时 /detect 自动检测——查运行中的
│  │                                   #   python 进程命令行反推根目录并写回配置）
│  ├─ piAgent.js                       # pi RPC 子进程管理入口（prompt/中止（清队列+
│  │                                   #   掐 bash+中止，明细返回）/状态/权限分级/
│  │                                   #   provider 配置/会话重置/人工重启/
│  │                                   #   停止信号时间戳查询）
│  ├─ prompts.js                       # 系统提示词库增删改查（data/prompts.json）
│  ├─ rembg.js                         # AI 抠图接口（onnxruntime-node 本地推理）
│  ├─ saves.js                         # 存档接口（save/ 目录；三段式协议+视频归档）
│  ├─ skills.js                        # 用户自定义技能接口（data/skills/ 目录；
│  │                                   #   单 .md/.json 与 Agent Skills 文件夹，只读）
│  ├─ piSkills.js                      # pi 技能库接口（data/pi/skills/ 查阅/启停/
│  │                                   #   上传；禁用状态存 data/pi/settings.json）
│  ├─ settings.js                      # 设置读写接口（多厂商 API 配置 + 用途绑定）
│  ├─ tags.js                          # 提示词收藏增删查接口（tag/ 目录）
│  ├─ upscale.js                       # 高清放大接口（调用本地 Real-ESRGAN；输入先用
│  │                                   #   sharp 压平 alpha——RGBA 大图会使 exe 静默输出全黑）
│  ├─ videos.js                        # 视频工作区删除接口（画布删视频即时清理）
│  └─ workflows.js                     # 工作流读写接口（列表/详情；PUT 写回编辑器
│                                      #   修改——严格保持包装/纯 API 格式不变；
│                                      #   GET/PUT /:id/layout 节点布局 sidecar，
│                                      #   含忽略节点（bypass）清单；
│                                      #   POST /import-runninghub 存 RH 平台快照，
│                                      #   快照写回时自动 diff 字段覆盖（同步登记卡
│                                      #   +镜像进快照条目供节点直连提交反查）
│
├─ save/                               # 画布存档数据（后端自动生成）
│  └─ 存档名/                          # 每个存档一个文件夹（图片 + project.json）
│
├─ tag/                                # 提示词收藏数据（后端自动生成与维护）
│  ├─ images/                          # 收藏原图（WebP，按内容哈希命名）
│  ├─ references/                      # 收藏参考图
│  ├─ thumbnails/                      # 收藏缩略图（WebP，480×480）
│  ├─ models.json                      # 模型标签清单
│  └─ tags.json                        # 收藏元数据列表
│
├─ temp_upscale/                       # 放大处理临时目录（运行时生成）
│
├─ test/                               # 自动化测试（Jest）
│  ├─ canvas/
│  │  ├─ canvasHitTester.test.js       # 画布命中检测测试
│  │  ├─ canvasConnections.test.js     # 连线规则测试（生图节点单入替换等）
│  │  ├─ groupManager.test.js          # 编组管理器测试（增删选中/几何包含成员判定/
│  │  │                                #   标题栏 ns 缩放命中/边缘手柄几何与光标）
│  │  ├─ groupLayout.test.js           # 编组布局算法测试（阅读顺序排序/水平/垂直/
│  │  │                                #   宫格坐标与尺寸/归一化输出/只移动不缩放）
│  │  └─ imageProxyCache.test.js       # 图片显示代理绘制源决策测试（档位/滞回）
│  ├─ fixtures/
│  │  └─ mcpEchoServer.js              # 测试夹具：最小 stdio MCP 服务器（原生 JSON-RPC）
│  ├─ routes/
│  │  ├─ canvasBridge.test.js          # 画布桥接路由测试（命令→应答回路，
│  │  │                                #   防浏览器同源连接泄漏回归）
│  │  ├─ mcp.test.js                   # MCP 宿主测试（stdio/HTTP 传输、工具调用、
│  │  │                                #   权限门禁、资源/提示词、自动认领）
│  │  ├─ llm.test.js                   # LLM 路由测试（supertest）
│  │  ├─ comfyNode.test.js             # Comfy 生图节点路由测试（supertest）
│  │  ├─ saves.test.js                 # 存档路由测试（三段式协议/视频归档/prompt2）
│  │  ├─ piSkills.test.js              # pi 技能库路由测试（列表/启停/上传：
│  │  │                                #   单 .md 与 Agent Skills 文件夹/覆盖确认）
│  │  ├─ skills.test.js                # 用户技能路由测试（文件夹形态识别）
│  │  ├─ videos.test.js                # 视频工作区清理测试（删除 API/保存 GC）
│  │  ├─ workflows.test.js             # 工作流路由测试（编辑器写回格式保持/
│  │  │                                #   路径穿越拦截/布局 sidecar 读写）
│  │  ├─ comfyTools.test.js            # Comfy 原生工具路由测试（状态/队列取消不误杀/
│  │  │                                #   UI 格式自动转换提交/槽位清单/模型检索/
│  │  │                                #   未配根目录报错/日志）
│  │  ├─ rhSnapshot.test.js            # RH 快照与编辑器覆盖测试（字段级 diff/
│  │  │                                #   提交合并纯函数 + 覆盖双落点读写 + 导入
│  │  │                                #   upsert/写回联动/重新拉取清除/格式拦截）
│  │  ├─ rhAppImporter.test.js         # 应用参数模板解析测试（fieldType 分流/
│  │  │                                #   role 识别/fieldData 双形态/去重/报错）
│  │  └─ receiveVideo.test.js          # ComfyUI 视频回传接收测试
│  └─ utils/
│     ├─ llmModelRules.test.js         # LLM 模型规则测试（识别/比例指令）
│     ├─ piExtensionSync.test.js       # pi 扩展差量同步测试（安装/覆盖/跳过统计、
│     │                                #   非 .ts 忽略、用户自有扩展不动、真实源码 sanity）
│     ├─ llmProvidersParse.test.js     # 多级响应解析测试（JSON/BOM/gzip/SSE）
│     ├─ llmResolution.test.js         # 分辨率计算测试
│     ├─ modelAdapters.test.js         # 模型协议适配器匹配测试
│     ├─ nodeTypes.test.js             # 节点类型注册表谓词测试
│     ├─ promptDictStore.test.js       # 提示词词典共享单例搜索排序测试
│     ├─ comfyParamScanner.test.js     # Comfy 参数扫描/覆盖表编译测试
│     ├─ comfyWorkflowFormat.test.js   # 工作流格式工具测试（UI→API 转换：控件对位/
│     │                                #   seed 控制词/Reroute 穿透；槽位扫描/写入）
│     ├─ promptMerge.test.js           # 提示词段合并/拼接逗号规则测试
│     ├─ workflowInjector.test.js      # 工作流注入辅助函数测试
│     ├─ workflowBypass.test.js        # 工作流 bypass（忽略节点）图改写测试：类型
│     │                                #   匹配直通/多槽分流/链式穿透/同名启发式/
│     │                                #   断链移除/防环/模板不可变
│     ├─ workflowLoraChain.test.js     # LoRA 堆栈图拼接测试（追加语义）
│     ├─ fileTextExtractor.test.js     # 文档文本提取器测试（解码/上限/Excel 往返）
│     ├─ webbridge.test.js             # 网页桥接纯逻辑测试（适配器注册表/原图候
│     │                                #   选剥离/内容签名去重/附件暂存）
│     ├─ lumenGuard.smoke.mjs          # lumen-guard 写保护扩展冒烟测试（权限分级×
│     │                                #   工具矩阵/结构性保护/guard.json 规则表/日志）
│     ├─ lumenSkills.smoke.mjs         # lumen-skills 技能库扩展冒烟测试（列表/加载/
│     │                                #   文件夹形态/面板禁用联动/非法文件忽略）
│     ├─ lumenMcp.smoke.mjs            # lumen-mcp 桥接扩展冒烟测试（注册/代理/去重）
│     ├─ lumenComfy.smoke.mjs          # lumen-comfy 扩展冒烟测试（18 工具注册/契约
│     │                                #   包装/端点路由/错误透传/三级权限拦截）
│     ├─ lumenCanvas.smoke.mjs         # lumen-canvas 扩展冒烟测试（工具上报过滤/
│     │                                #   禁用清单应用/回合开始重应用）
│     └─ lumenWeb.smoke.mjs            # lumen-web 联网扩展冒烟测试（搜索/搜图三源
│                                      #   回退/HTML 正文提取/二进制拒读/内网拦截/
│                                      #   分段续读；mock fetch 不依赖真实网络，
│                                      #   node 直跑不入 jest）
│
├─ tools/                              # 开发及数据处理工具
│  ├─ convert_txt_to_json.py           # 文本转 JSON 工具
│  ├─ cleanup.js                       # 项目清理工具实现层（分层清理临时文件：
│  │                                   #   安全层=工作区/日志/放大临时/桥接日志，
│  │                                   #   深度层=恢复槽位/agent会话/未归档视频/
│  │                                   #   桥接登录态；后端运行中拒绝执行）
│  ├─ download-model.js                # 模型下载脚本（支持断点续传）
│  ├─ drop-files-to-canvas.js          # 命令行批量落图到画布（经画布桥接
│  │                                   #   drop_image，base64 不出进程内存）
│  ├─ dump-pi-session.js               # pi 会话 JSONL 诊断脚本（按时序打印
│  │                                   #   消息/工具调用/结果/错误）
│  └─ prompt-dict.json                 # 提示词词典（自动补全数据源）
│
├─ utils/                              # Node.js 后端通用模块
│  ├─ modelAdapters/                   # 模型协议适配器（按模型家族分派，路由层
│  │                                   #   只做调度；接新家族=加适配器文件并注册）
│  │  ├─ index.js                      # 适配器注册表与统一接口约定（run 请求可
│  │  │                                #   携带 AbortSignal，适配器须透传以支持
│  │  │                                #   「停止生图」中止上游）
│  │  ├─ editsImageAdapter.js          # OpenAI 系图生图（/images/edits，multipart）
│  │  ├─ chatImageAdapter.js           # Gemini 图像系对话式编辑（chat/completions）
│  │  └─ generationsImageAdapter.js    # 标准 /images/generations（兜底适配器）
│  ├─ comfySubmit.js                   # ComfyUI /prompt 提交工具（双路由共用）
│  ├─ comfyWorkflowFormat.js           # 工作流格式纯函数层（UI/API 识别与互转——
│  │                                   #   控件对位消费 widgets_values、seed 控制
│  │                                   #   词跳过、Reroute 链穿透；可调槽位扫描与
│  │                                   #   按地址写入；子图显式不支持）
│  ├─ runninghub.js                    # RunningHub OpenAPI 客户端（提交工作流/应用
│  │                                   #   任务/轮询状态/上传素材/结果下载转存/拉取
│  │                                   #   工作流 JSON 与应用参数模板；兼容新旧两种
│  │                                   #   响应包装）
│  ├─ rhSnapshot.js                    # RH 快照与编辑器覆盖（字段级 diff：编辑器
│  │                                   #   保存快照 → 相对拉取原版算覆盖清单写入
│  │                                   #   editorOverrides（登记卡+快照条目双落点）；
│  │                                   #   提交时并入 nodeInfoList——结构变化无法
│  │                                   #   上云只报告）
│  ├─ mcpManager.js                    # MCP 客户端管理器（stdio spawn / Streamable
│  │                                   #   HTTP + SSE 回退；连接生命周期/工具发现/
│  │                                   #   调用代理/资源与提示词/权限分级门禁）
│  ├─ webBridgeManager.js              # 网页桥接管理器（puppeteer-core 拉起专用
│  │                                   #   浏览器 data/webbridge/profile/；回合编排
│  │                                   #   与事件出口，页面操作全在适配器）
│  ├─ webbridge/                       # 网页桥接支撑模块：
│  │  ├─ adapters/                     #   站点适配器（一站一文件，base.js 为契约
│  │  │                                #   与共享页内工具；index.js 注册表，
│  │  │                                #   新站点即插即用）
│  │  │  ├─ base.js                    #   适配器契约与共享页内工具
│  │  │  ├─ doubao.js                  #   豆包站点适配器
│  │  │  ├─ chatgpt.js                 #   ChatGPT 站点适配器（chatgpt.com）
│  │  │  ├─ gemini.js                  #   Gemini 站点适配器（gemini.google.com）
│  │  │  └─ index.js                   #   适配器注册表
│  │  ├─ turnWatcher.js                #   统一回合轮询状态机（主回合与异步
│  │  │                                #   看护共用：文本轮询/稳定判定/任务检测）
│  │  └─ assets.js                     #   资产管线（两级回退下载/原图候选择优/
│  │                                   #   内容签名去重/附件暂存，纯函数可单测）
│  ├─ fileTextExtractor.js             # 文档文本提取器（txt/PDF/Word/Excel → 纯文本，
│  │                                   #   供 LLM 聊天附件；重型解析库按需惰性加载）
│  ├─ llmModelRules.js                 # LLM 模型识别与参数映射规则（比例指令等）
│  ├─ llmProviders.js                  # LLM 提供商 HTTP 请求封装（多级响应解析：
│  │                                   #   标准JSON/BOM/gzip解压/SSE事件流聚合；
│  │                                   #   请求可携带 AbortSignal，客户端取消时
│  │                                   #   中止上游请求）
│  ├─ piAgentManager.js                # pi RPC 进程管理器（spawn/存档↔会话映射、
│  │                                   #   模型接线、权限分级；停止=并行 clear_queue+
│  │                                   #   abort_bash 再写入 abort（不等应答），并记
│  │                                   #   lastAbortAt 供扩展后台任务自取消）
│  ├─ piExtensionSync.js               # pi 扩展差量同步（pi-extensions/*.ts →
│  │                                   #   ~/.pi/agent/extensions/，拉起 pi 前调用：
│  │                                   #   一致跳过/缺失或过期覆盖，发行包解压即用）
│  ├─ videoProviders.js                # 视频生成任务 HTTP 封装（火山方舟 ARK v3：
│  │                                   #   建任务/查状态/下载视频，零新增依赖）
│  ├─ workflowInjector.js              # ComfyUI 工作流注入工具（提示词/种子/
│  │                                   #   画布 LoRA 堆栈图拼接，追加在模板 lora 后）
│  └─ workflowBypass.js                # 工作流 bypass（忽略节点）图改写：被忽略节点
│                                      #   剔除出提交 JSON，下游连线按 ComfyUI 同款
│                                      #   规则直通重连（第一个类型匹配输入，链式
│                                      #   穿透防环；离线降级同名启发式），提交前由
│                                      #   comfyNode 路由调用
│
├─ workflows/                          # ComfyUI API 工作流模板
│  ├─ RMBG抠图-2-api.json              # RMBG 抠图工作流
│  ├─ anima局部重绘工作流-api.json      # Anima 局部重绘工作流
│  ├─ anima局部重绘工作流2-api.json     # Anima 局部重绘工作流（第二版）
│  ├─ anima画布工作流-api.json         # Anima 带画布取图/LoRA 工作流（用户添加）
│  ├─ anima工作流-api.json             # Anima 文生图工作流
│  ├─ flux2_klein-1图编辑-api.json     # Flux 单图编辑工作流
│  ├─ flux2_klein-2图编辑-api.json     # Flux 双图编辑工作流
│  ├─ flux2_klein-api-3图.json         # Flux 三图编辑工作流
│  ├─ qwen edit 2509-api-2图.json      # Qwen 双图编辑工作流
│  ├─ qwen edit 2509-api.json          # Qwen 单图编辑工作流
│  ├─ wan2.1_fun_camera_v1.1_1.3B-测试api.json  # wan2.1 Fun Camera 视频工作流（测试用）
│  ├─ RH-mmh3首帧-api.json             # RunningHub 平台快照工作流（用户添加）
│  ├─ SeedVR2放大工作流-api.json       # SeedVR2 视频放大工作流（用户添加）
│  └─ MiniMax H3 FL2VA开源版-首帧参考生视频_api.json  # MiniMax H3 视频工作流（用户添加）
│
├─ .gitignore                          # Git 忽略规则
├─ AGENTS.md                           # 本项目对编码智能体（pi）的协作约定
├─ README.md                           # 项目说明文档
├─ help.html                           # 使用教程页（左上菜单 ☰ → 帮助，新标签页打开）
├─ index.html                          # Web 前端页面入口
├─ package-lock.json                   # npm 依赖版本锁定文件
├─ package.json                        # Node.js 项目及脚本配置
├─ runtime/                            # 内置 Node 运行时（node.exe，绿色版整合包用）
├─ server.js                           # Node.js 服务端入口（Express + WebSocket）
├─ start-server.bat                    # Windows 一键启动脚本（优先内置 Node；稳定模式）
├─ 清理缓存.bat                        # 项目清理脚本（双击执行；安全层默认清理，
│                                      #   深度层需确认；tools/cleanup.js 的薄壳）
├─ 依赖.txt                            # 项目依赖安装说明
└─ 说明.txt                            # 中文使用说明
```

## 启动方式

```bash
start-server.bat  # 双击启动（优先使用 runtime/ 内置 Node，绿色版解压即用；
                  #   稳定模式：不启用 --watch 热重载——热重载会连带结束 pi
                  #   子进程、中断长任务；改后端代码后重新双击本脚本生效，
                  #   控制台输出同步写入 data/pi/server-console.log）
node server.js    # 或用系统 Node 启动后端（前端页面由后端直接提供）
npm test          # 运行 Jest 单元测试
```

依赖安装：`npm install`（依赖清单见 [package.json](package.json)，详细说明见 [依赖.txt](依赖.txt)）。
`runtime/` 内置了 Node 运行时（win-x64），解压即用，无需安装 Node.js。

## agent 模式（pi 编码智能体整合）

`pi/` 内置 pi 编码智能体完整运行包（[@earendil-works/pi-coding-agent]），
配合 `pi-extensions/` 里的五个扩展（拉起 pi 前由后端自动同步到
`~/.pi/agent/extensions/`，见下文「扩展自动安装」），可在右侧 LLM 窗口
以「agent 模式」驱动画布自动执行任务：

- 工具集：画布状态快照（含 DOM 节点清单）/ 取图 / 落图（dataUrl 或公网图片直链——
  直链经后端代理取图，base64 不进 agent 上下文，与 web_image_search 配合
  实现「搜图并落画布」）/ 批量清空 / 存档 / 跑 ComfyUI 工作流（支持
  refImages 参考图写入画板槽位，供 From Canvas (Edit Image) 节点读取）/
  API 模型生图 / AI 视频生成（两者均为异步任务句柄：提交即返回任务 id，
  canvas_poll_task 查询进度，完成后产物自动落画布，不挂住回合）/
  资产检索 / 搭建节点工作流（一次性创建提示词/LoRA/生图等节点并连线，自动布局）等
  （经 `/api/canvas-bridge` 桥接，写命令路由活跃客户端）；
- 技能库：`data/pi/skills/`（lumen-skills 扩展提供 skill_list / skill_load，
  按需加载流程 SOP——如画布出图流程；pi 也可自行沉淀新技能，目录在写门禁
  白名单内）。LLM 面板头部「工具与技能」弹窗可查阅/勾选启停/上传（单 .md 或
  Agent Skills 文件夹），禁用即时生效——skill_list 不列出、skill_load 拒绝；
- 工具启停：面板「工具与技能」弹窗的「工具」tab 可对扩展注册的全部工具
  （画布/Comfy/联网/技能四族共 37 个）逐个勾选启停。禁用清单存
  data/pi/settings.json 的 disabledTools，lumen-canvas 扩展在 pi 启动与
  每回合开始经 setActiveTools 把禁用工具从模型可见清单移除（连同 schema
  不占上下文），改动下一轮消息生效、无需重启；MCP 工具在 设置 → MCP
  管理，权限分级独立生效与勾选叠加；
- 联网工具：lumen-web 扩展提供 web_search（DuckDuckGo 主源 + Bing 备源，无 API key）、
  web_fetch（读网页正文，二进制拒读、内网地址拒访）与 web_image_search
  （Bing → 百度 → DDG 三源回退 + source 强制指定，返回原图直链配合落画布），
  零新增依赖随发行包解压即用；
- 扩展自动安装：piAgentManager 拉起 pi 前把 `pi-extensions/*.ts` 差量同步到
  `~/.pi/agent/extensions/`（内容一致跳过，毫秒级）——发行包用户首次开 agent
  模式即自动装好全部扩展，更新发行包后重启后端即自动升级，无需手动复制
  （guard 另经 `-e` 从项目目录显式加载，不依赖自动发现）；
- 模型：直接使用 LLM 面板配置的厂商与模型（扩展自动注册，key 经环境变量注入）；
- 会话：每个画布存档绑定一个独立会话（`data/pi/session-map.json`）；
- 权限分级：设置 → 通用 → 权限分级（只读 / 标准 / 完整），
  同时约束 agent 对项目的写入（lumen-guard 写门禁：只读全拦 /
  标准仅白名单 / 完整解锁画布内容区；项目源码与配置在任何分级
  下都结构性地不可写，白名单目录与 bash 写特征词由
  data/pi/guard.json 声明，拦截记录写入 data/pi/agent.log）并
  过滤 MCP 工具（见下一章）；
- 执行反馈：流式期间最新消息框下方有转圈执行指示器；回合失败附说明与
  「↻ 重新继续」按钮；疑似卡死**只上报不自动杀**——前端弹
  [重启 pi 进程]/[继续等待] 由人工决策（程序不干扰健康 agent）；
- 可观测性：`data/pi/agent.log` 记录进程生命周期（spawn/stderr/exit/kill/卡死上报）；
- 清空联动：LLM 窗口垃圾桶清屏、清除持久化聊天记录的同时重置当前存档的
  agent 会话，并清空 sessions/ 目录下的全部会话文件（所有存档的 agent
  上下文一并删除，各存档下次对话自动新建会话）。

## MCP 智能体扩展（设置 → MCP）

流光内置 **MCP 宿主**：在 设置 → MCP 里挂载任意 MCP 服务器（本地命令 stdio /
远程 Streamable HTTP，老服务器自动回退 SSE），其工具自动注册给 agent
（命名 `mcp__服务器名__工具名`，schema 透传），agent 模式下直接结构化调用。

- 权限门禁：每台服务器可设「工具可用最低权限」（只读/标准/完整），
  全局权限分级低于该级别时工具不暴露、调用被拦；工具清单内还可逐个停用；
- 资源与提示词：支持 resources / prompts 能力的服务器，自动注册
  `list_resources` / `read_resource` / `get_prompt` 工具；
- ComfyUI 认领：comfy-mcp 类服务器（命令同目录有 comfy.exe）在卡片上填
  ComfyUI 根目录，「保存并应用」自动认领（comfy set-default），连接时也会
  自动校验恢复；「📁」按钮调起系统文件夹选择窗口；
- 配置存于 `data/settings.json` 的 `mcp.servers`；
- 详细使用说明见教程页第 13 章（左上 ☰ → 帮助）。

## 网页桥接模式（设置 → 网页桥接）

LLM 面板模型下拉里的「网页桥接」入口：后端用 puppeteer-core 拉起一个
**专用浏览器实例**（独立 user-data-dir，会话持久化在 `data/webbridge/profile/`，
与日常浏览器互不干扰），把消息驱动进目标站点网页（豆包等），网页里跑出来的
回复与图片/视频自动回流到面板与画布。

- 生成全程不经任何 API——与 设置 → API 的模型链路完全隔离，产物仅复用
  WS 回流消息格式（new-image / new-video，带 `source: 'webbridge'`）；
- 首次使用：设置 → 网页桥接 → 启动桥接，在弹出的浏览器里登录站点一次即可；
- 可扩展：站点差异封装在 `utils/webbridge/adapters/`（一站一文件，
  base.js 为契约），新增 Gemini/ChatGPT 等站点 = 加一个适配器文件并登记；
- 聊天记录按「桥接站点」分键（IndexedDB），跨存档统一、与 LLM 模式互不串；
- 站点适配器基于 DOM 候选选择器 + 文本稳定判定，站点改版时只需校准
  对应适配器文件里的候选清单。
