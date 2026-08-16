# LumenLight（流光）

AI 绘画工作台：画布 + ComfyUI 工作流 + LLM 对话绘图 + 本地资产库 + pi 编码智能体整合（画布任务自动化）。

## 项目结构

```
lumen-light/
├─ .trae/                              # Trae IDE 项目配置
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
│  ├─ image-toolbar.css                # 图片工具栏样式
│  ├─ asset-library.css                # 本地资产库窗口样式
│  ├─ llm-chat.css                     # AI 对话界面样式
│  ├─ llm-system-prompt.css            # 系统提示词弹窗样式
│  ├─ lumen-dropdown.css               # 通用自定义下拉组件样式（触发器/菜单/选项）
│  ├─ node.css                         # 提示词节点与画布右键菜单样式
│  ├─ prompt-autocomplete.css          # 提示词自动补全样式
│  ├─ prompt-panel.css                 # 提示词面板样式
│  ├─ recipe-manager.css               # 提示词收藏页面样式
│  ├─ recipe-models-sidebar.css        # 收藏页模型标签侧栏样式
│  ├─ save-manager.css                 # 存档管理器样式
│  ├─ save-tag-dialog.css              # 保存提示词弹窗样式
│  ├─ settings.css                     # 设置界面样式
│  ├─ side-toolbar.css                 # 侧边工具栏样式
│  ├─ style.css                        # 全局基础样式
│  ├─ tag-detail-dialog.css            # 收藏详情弹窗样式
│  ├─ top-toolbar.css                  # 顶部工具栏样式
│  ├─ workflow-manager.css             # 工作流管理器样式
│  └─ help.css                         # 使用教程页样式（help.html 专用）
│
├─ data/                               # 应用运行数据（后端读写）
│  ├─ autosave/                        # 实时保存恢复槽位（后端自动生成，内容寻址图片资产
│  │                                   #   assets/ + 恢复元数据 project.json，.gitignore 已排除）
│  ├─ pi/                              # pi 智能体运行数据（自动生成）：sessions/ 会话、
│  │                                   #   session-map.json 存档↔会话映射、settings.json 权限分级
│  ├─ videos/                          # 视频工作区（LLM 生成 / Comfy 回传 / 本地上传的
│  │                                   #   临时落点；保存画布时归档进存档 videos/ 并自动清理）
│  ├─ skills/                          # 用户自定义技能（一个技能一个 .md，放入即生效）
│  │  ├─ README.md                     # 技能文件格式说明与编写建议
│  │  ├─ deep-optimize.md              # 示例技能：深度优化提示词（支持参考图）
│  │  └─ nl-to-danbooru.md             # 自然语言转 Danbooru 格式标签
│  ├─ prompts.json                     # 系统提示词库（首次保存自动创建）
│  └─ settings.json                    # 持久化设置：多厂商 API 配置（api.providers）
│                                      #   与用途绑定（api.bindings：对话/技能/生图各用哪个模型）
│
├─ image/                              # 项目图片资源
│  ├─ 1.png
│  ├─ 2.png                            # 生成反馈动画用的两张 832×1216 图片
│  └─ help/                            # 使用教程配图（help.html 引用，共 12 张）
│
├─ js/                                 # 浏览器端 JavaScript 源码
│  ├─ api/                             # 前端 API 与通信封装
│  │  └─ LumenSocket.js                # Lumen WebSocket 客户端（接收 ComfyUI 生成图片/视频、
│  │                                   #   画布桥接命令执行器、pi 事件转发、心跳）
│  │
│  ├─ canvas/                          # 画布核心模块
│  │  ├─ nodes/                        # 画布节点本体（一个节点一个文件）
│  │  │  ├─ BaseCanvasNode.js          # 节点基类（几何/生命周期/两种布局模式）
│  │  │  ├─ PromptNode.js              # 提示词节点（DOM 面板，支持参考图缩略图、
│  │  │  │                             #   @图片N 引用与中文提示词补全）
│  │  │  ├─ PromptSkillBar.js          # 提示词节点技能栏（优化提示词/反推图像等，调聊天模型）
│  │  │  ├─ TextNode.js                # 文本节点（画布备注/注释，无端口不可连线）
│  │  │  ├─ LoraNode.js                # LoRA 节点（可堆叠 LoRA 组合，串在提示词链路中
│  │  │  │                             #   作用于下游 Comfy 生图；提交时后端图拼接注入，
│  │  │  │                             #   追加在模板 lora 之后——补充/无模板 lora 场景）
│  │  │  ├─ ImageGenNode.js            # 生图节点（收集上游提示词链并调用生图 API）
│  │  │  └─ ComfyGenNode.js            # Comfy 生图节点（选工作流动态调参，提交 ComfyUI；
│  │  │                                #   含模板内嵌 lora 的文件/启用管理）
│  │  ├─ Canvas.js                     # 画布主控制器（生命周期与核心状态）
│  │  ├─ CanvasClipboard.js            # 画布剪贴板（拖放/粘贴上传图片与视频、Ctrl+C/X/V）
│  │  ├─ CanvasConnections.js          # 图片连线管理（端口、贝塞尔连线、命中检测）
│  │  ├─ NodeTextMirror.js             # 节点文本镜像层（@引用高亮 + 自绘光标，多节点共用）
│  │  ├─ CanvasContextMenu.js          # 画布右键节点菜单（添加提示词/生图/LoRA 节点等）
│  │  ├─ CanvasVideoManager.js         # 画布视频管理器（首帧封面 + 双击就地播放器，
│  │  │                                #   播放器跟随视口变换，ESC/点击外部关闭；
│  │  │                                #   本地视频文件导入共享入口 addVideoFile）
│  │  ├─ CanvasHitTester.js            # 画布命中检测与光标决策（纯几何判定层）
│  │  ├─ CanvasInteraction.js          # 鼠标及键盘交互（选择、拖拽、缩放、平移、连线）
│  │  ├─ ImageProxyCache.js             # 图片显示代理缓存（低分辨率档位下缩小查看画
│  │  │                                #   降采样副本、放大自动切回原图；纯函数决策 +
│  │  │                                #   空闲分片构建；只影响绘制，原始图片不受影响）
│  │  ├─ CanvasRenderer.js             # 画布内容渲染（连线、图片、控制点、框选、
│  │  │                                #   视口剔除与代理绘制接入）
│  │  ├─ ImageManager.js               # 画布图片管理（添加、选择、删除、命中检测；
│  │  │                                #   删除视频对象时即时清理工作区文件）
│  │  └─ Viewport.js                   # 视口缩放与平移管理（坐标转换、自适应边界）
│  │
│  ├─ components/                      # 前端 UI 组件与功能控制器
│  │  ├─ save/                         # 存档子模块（从 SaveManager 拆出）
│  │  │  ├─ ProjectSerializer.js       # 存档序列化器（画布状态 <-> project.json；
│  │  │  │                             #   视频封面 .png 命名、videoUrl 恢复与回写）
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
│  │  │  │                             #   质量、提示词补全开关、pi 权限分级与
│  │  │  │                             #   pi 底层模型选择）
│  │  │  └─ SettingsRembgPanel.js      # 抠图模型面板（模型下载/续传/删除）
│  │  ├─ AssetLibrary.js               # 本地资产库窗口（左侧工具栏文件夹按钮：
│  │  │                                #   标签绑定本地文件夹、缩略网格、拖拽入画布、
│  │  │                                #   双击灯箱预览；FSA API+webkitdirectory 降级）
│  ├─ CountStepper.js                  # 数量步进器行为层（上下箭头/键入/钳制，
│  │                                   #   画布 Comfy 生图节点与面板运行行共用）
│  ├─ Controls.js                   # 左下角视图控制（自适应屏幕、缩放指示）
│  │  ├─ GenerationFeedback.js         # 面板侧生成占位图门面（FIFO 队列语义）
│  │  ├─ PlaceholderManager.js         # 全局生成占位图管理器（归属/句柄/动画/落图）
│  │  ├─ ImageToolbar.js               # 图片选中浮动工具栏
│  │  ├─ LlmAttachments.js             # AI 对话待发送图片附件管理
│  │  ├─ LlmChat.js                    # AI 对话核心组件（多轮对话、多模态、生图、
│  │  │                                #   pi 智能体模式路由与流式气泡）
│  │  ├─ LlmVideoGen.js                # LLM 视频生成控制器（文/图生视频任务提交、
│  │  │                                #   轮询进度、播放器渲染、视频拖到画布）
│  │  ├─ LlmPiAgent.js                 # pi 智能体控制器（消息发往 pi RPC 子进程，
│  │  │                                #   流式气泡/工具调用标记/中止/排队提示）
│  │  ├─ LlmImageDrag.js               # AI 对话图片拖拽到画布功能
│  │  ├─ LlmLightbox.js                # 灯箱全屏预览（图片大图/视频播放器，
│  │  │                                #   聊天与本地资产库共用）
│  │  ├─ LlmSizePicker.js              # 图片比例 + 分辨率档位双段选择器
│  │  ├─ LlmSystemPrompt.js            # 系统提示词管理（弹窗与启用状态）
│  │  ├─ LumenDropdown.js              # 通用自定义下拉组件（触发器/菜单/键盘导航）
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
│  │  ├─ RecipeManager.js              # 提示词收藏页面（瀑布流卡片 + 标签筛选）
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
│  │  ├─ ImagePipeline.js              # 生图节点管线（提示词/参考图/LoRA 堆栈收集）
│  │  ├─ ComfyParamScanner.js          # Comfy 工作流参数扫描/覆盖表编译（画布
│  │  │                                #   生图节点与面板参数区共用的纯数据层）
│  │  ├─ PromptMerge.js               # 提示词段合并（节点链/面板双正面框共用，
│  │  │                                #   拼接处自动补逗号区分中英文）
│  │  ├─ llmQuality.js                 # 生图模型 quality 参数档位判断
│  │  ├─ llmResolution.js              # AI 图片比例/分辨率计算与降级逻辑
│  │  └─ help.js                       # 使用教程页脚本（目录生成 + 滚动高亮）
│  ├─ app.js                           # 前端应用入口（初始化各组件）
│  └─ config.js                        # 前端全局配置与工具（命名空间 LumenLight；
│                                      #   多厂商模型聚合，下拉值 = 厂商||模型 复合键）
│
├─ pi/                                 # pi 编码智能体完整运行包（421MB，含 node_modules；
│                                      #   随发行包分发、不入 git；扩展见 ~/.pi/agent/extensions）
│
├─ lumen_nodes/                        # ComfyUI 自定义 Python 节点
│  ├─ LumenReceiveImageFromCanvas.py   # 从画布槽位接收图片（用于 Edit 工作流）
│  ├─ LumenSendImageRealtime.py        # 实时发送生成图片回画板（HTTP 版）
│  ├─ LumenSendVideoToCanvas.py        # 发送视频到画板（二进制直传，接原生 VIDEO /
│  │                                   #   VHS Filenames 输出）
│  └─ __init__.py                      # Python 包及节点注册入口
│
├─ models/                             # 本地 AI 模型（download-model.js 下载）
│  └─ rembg/
│     └─ RMBG-2.0-fp16.onnx            # RMBG 2.0 FP16 抠图模型
│
├─ routes/                             # Node.js 后端路由
│  ├─ autosave.js                      # 实时保存接口（内容寻址资产上传、恢复元数据
│  │                                   #   原子写入/读取/清空、孤儿资产回收）
│  ├─ canvasImages.js                  # 画板图片槽位接口（1-3 号，供 ComfyUI Edit 读取）
│  ├─ canvasBridge.js                  # 画布桥接（pi/MCP 等外部 agent 的工具命令
│  │                                   #   转发：读命令广播、写命令路由活跃客户端）
│  ├─ comfy.js                         # ComfyUI 通信接口（提交工作流、推送生成图片）
│  ├─ comfyNode.js                     # Comfy 生图节点接口（object_info 模型清单与
│  │                                   #   采样器枚举代理；注入参数/提示词/种子/画布
│  │                                   #   LoRA 堆栈后提交工作流）
│  ├─ llm.js                           # 大语言模型代理接口（避免浏览器跨域；模型路由
│  │                                   #   支持显式指定厂商，未指定时按模型 ID 自动回退；
│  │                                   #   含本地视频上传接口）
│  ├─ piAgent.js                       # pi RPC 子进程管理入口（prompt/中止/状态/
│  │                                   #   权限分级/provider 配置）
│  ├─ prompts.js                       # 系统提示词库增删改查（data/prompts.json）
│  ├─ rembg.js                         # AI 抠图接口（onnxruntime-node 本地推理）
│  ├─ saves.js                         # 存档接口（save/ 目录；三段式协议+视频归档）
│  ├─ skills.js                        # 用户自定义技能接口（data/skills/ 目录）
│  ├─ settings.js                      # 设置读写接口（多厂商 API 配置 + 用途绑定）
│  ├─ tags.js                          # 提示词收藏增删查接口（tag/ 目录）
│  ├─ upscale.js                       # 高清放大接口（调用本地 Real-ESRGAN）
│  ├─ videos.js                        # 视频工作区删除接口（画布删视频即时清理）
│  └─ workflows.js                     # 工作流列表/详情读取接口
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
│  │  └─ imageProxyCache.test.js       # 图片显示代理绘制源决策测试（档位/滞回）
│  ├─ routes/
│  │  ├─ llm.test.js                   # LLM 路由测试（supertest）
│  │  ├─ comfyNode.test.js             # Comfy 生图节点路由测试（supertest）
│  │  ├─ saves.test.js                 # 存档路由测试（三段式协议/视频归档/prompt2）
│  │  ├─ videos.test.js                # 视频工作区清理测试（删除 API/保存 GC）
│  │  └─ receiveVideo.test.js          # ComfyUI 视频回传接收测试
│  └─ utils/
│     ├─ llmModelRules.test.js         # LLM 模型规则测试（识别/比例指令）
│     ├─ llmProvidersParse.test.js     # 多级响应解析测试（JSON/BOM/gzip/SSE）
│     ├─ llmResolution.test.js         # 分辨率计算测试
│     ├─ modelAdapters.test.js         # 模型协议适配器匹配测试
│     ├─ nodeTypes.test.js             # 节点类型注册表谓词测试
│     ├─ promptDictStore.test.js       # 提示词词典共享单例搜索排序测试
│     ├─ comfyParamScanner.test.js     # Comfy 参数扫描/覆盖表编译测试
│     ├─ promptMerge.test.js           # 提示词段合并/拼接逗号规则测试
│     ├─ workflowInjector.test.js      # 工作流注入辅助函数测试
│     └─ workflowLoraChain.test.js     # LoRA 堆栈图拼接测试（追加语义）
│
├─ tools/                              # 开发及数据处理工具
│  ├─ convert_txt_to_json.py           # 文本转 JSON 工具
│  ├─ download-model.js                # 模型下载脚本（支持断点续传）
│  └─ prompt-dict.json                 # 提示词词典（自动补全数据源）
│
├─ utils/                              # Node.js 后端通用模块
│  ├─ modelAdapters/                   # 模型协议适配器（按模型家族分派，路由层
│  │                                   #   只做调度；接新家族=加适配器文件并注册）
│  │  ├─ index.js                      # 适配器注册表与统一接口约定
│  │  ├─ editsImageAdapter.js          # OpenAI 系图生图（/images/edits，multipart）
│  │  ├─ chatImageAdapter.js           # Gemini 图像系对话式编辑（chat/completions）
│  │  └─ generationsImageAdapter.js    # 标准 /images/generations（兜底适配器）
│  ├─ comfySubmit.js                   # ComfyUI /prompt 提交工具（双路由共用）
│  ├─ llmModelRules.js                 # LLM 模型识别与参数映射规则（比例指令等）
│  ├─ llmProviders.js                  # LLM 提供商 HTTP 请求封装（多级响应解析：
│  │                                   #   标准JSON/BOM/gzip解压/SSE事件流聚合）
│  ├─ piAgent.js                       # pi RPC 进程管理器（spawn/存档↔会话映射、
│  │                                   #   模型接线、权限分级）
│  ├─ videoProviders.js                # 视频生成任务 HTTP 封装（火山方舟 ARK v3：
│  │                                   #   建任务/查状态/下载视频，零新增依赖）
│  └─ workflowInjector.js              # ComfyUI 工作流注入工具（提示词/种子/
│                                      #   画布 LoRA 堆栈图拼接，追加在模板 lora 后）
│
├─ workflows/                          # ComfyUI API 工作流模板
│  ├─ RMBG抠图-2-api.json              # RMBG 抠图工作流
│  ├─ anima工作流-api.json             # Anima 文生图工作流
│  ├─ flux2_klein-1图编辑-api.json     # Flux 单图编辑工作流
│  ├─ flux2_klein-2图编辑-api.json     # Flux 双图编辑工作流
│  ├─ flux2_klein-api-3图.json         # Flux 三图编辑工作流
│  ├─ qwen edit 2509-api-2图.json      # Qwen 双图编辑工作流
│  └─ qwen edit 2509-api.json          # Qwen 单图编辑工作流
│
├─ .gitignore                          # Git 忽略规则
├─ README.md                           # 项目说明文档
├─ help.html                           # 使用教程页（左上菜单 ☰ → 帮助，新标签页打开）
├─ index.html                          # Web 前端页面入口
├─ package-lock.json                   # npm 依赖版本锁定文件
├─ package.json                        # Node.js 项目及脚本配置
├─ runtime/                            # 内置 Node 运行时（node.exe，绿色版整合包用）
├─ server.js                           # Node.js 服务端入口（Express + WebSocket）
├─ start-server.bat                    # Windows 一键启动脚本（内置 Node + --watch 热重载）
├─ 依赖.txt                            # 项目依赖安装说明
└─ 说明.txt                            # 中文使用说明
```

## 启动方式

```bash
start-server.bat  # 双击启动（优先使用 runtime/ 内置 Node，绿色版解压即用；
                  #   --watch 热重载：修改后端代码自动重启，无需手动操作）
node server.js    # 或用系统 Node 启动后端（前端页面由后端直接提供）
npm test          # 运行 Jest 单元测试
```

依赖安装：`npm install`（依赖清单见 [package.json](package.json)，详细说明见 [依赖.txt](依赖.txt)）。
`runtime/` 内置了 Node 运行时（win-x64），解压即用，无需安装 Node.js。

## pi 编码智能体整合

`pi/` 内置 pi 编码智能体完整运行包（[@earendil-works/pi-coding-agent]），
配合 `~/.pi/agent/extensions/lumen-canvas.ts` 扩展（安装说明见扩展文件头注释），
可在右侧 LLM 窗口以"pi 编码智能体"模式驱动画布自动执行任务：

- 工具集：画布状态快照 / 取图 / 落图 / 批量清空 / 存档 / 跑 ComfyUI 工作流 /
  资产检索等（经 `/api/canvas-bridge` 桥接，读命令广播、写命令路由活跃客户端）；
- 模型：直接使用 LLM 面板配置的厂商与模型（扩展自动注册，key 经环境变量注入）；
- 会话：每个画布存档绑定一个独立会话（`data/pi/session-map.json`）；
- 权限分级：设置 → 通用 → pi 权限分级（只读 / 标准 / 完整）。
