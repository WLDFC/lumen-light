# 用户自定义技能（data/skills/）

本文件夹存放**用户自定义技能**，供画布提示词节点底部的技能栏使用。
一个技能一个 `.md` 文件（Agent Skills 主流格式），**放入本文件夹 → 刷新页面即生效**，
无需重启后端。

内置技能（反推图像）在代码文件
`js/canvas/nodes/PromptSkillBar.js` 的 `SKILLS` 数组中，与本文件夹互不影响；
同 id 冲突时内置优先。

## 现有技能列表

| 技能文件 | 下拉名称 | 用途 | 输入 |
|---|---|---|---|
| `optimize-prompt.md` | 优化提示词 | 把提示词改写得更具体、更有画面感，与连线参考图内容保持一致；`@图片N` 标记原样保留（2026-10 自内置技能迁移而来，行为不变） | 文字 + 可选参考图 |
| `nl-to-danbooru.md` | 转 Danbooru 提示词 | 把自然语言场景描述转换为严格符合 Danbooru 格式的提示词标签组 | 仅文字 |

> 注意区分：本目录是**画布技能栏**的技能（调聊天模型）；pi 编码智能体的
> 技能库在 `data/pi/skills/`，两套体系互不相干。

## 文件格式

文件名 = 技能 id + `.md`（id 仅限字母/数字/下划线/连字符，如 `translate-en.md`）。
头部 `---` 包裹的是元数据，**分隔线之后的正文就是发给模型的指令**：

```markdown
---
id: translate-en
name: 翻译提示词
icon: globe
inputText: true
inputImages: false
---
你是绘画提示词翻译专家。把用户发来的提示词翻译成英文，
只输出翻译结果，不要任何解释。

原文中的 @图片N 引用标记必须原样保留。
```

### 元数据字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 唯一标识，仅字母/数字/下划线/连字符，与文件名保持一致 |
| `name` | ✓ | 技能下拉里显示的名称（最长 50 字） |
| `icon` |  | 图标键名，可选：`zap` `eye` `type` `star` `globe` `heart` `flag`，缺省为 `star` |
| `inputText` |  | 是否把节点文字发给模型（`true` / `false`，默认 false） |
| `inputImages` |  | 是否把连入节点的参考图发给模型（`true` / `false`，默认 false）。**可选输入**：有连线图就附带，没有则纯文本执行 |
| `requireImages` |  | 是否**必须**连线参考图（`true` / `false`，默认 false）。为 true 且没连线图时拒绝执行并提示，适合反推类的纯图技能 |

元数据只支持「一行一个 `key: value`」的扁平写法（值可加引号），
不支持嵌套列表——技能需要的就是这几个标量字段。

## 文件夹形态（Anthropic Agent Skills 标准，2026-10 起）

除单文件外，本目录也识别 **Agent Skills 标准的文件夹形态**：

```
my-skill/
├─ SKILL.md          ← 必需，技能入口
├─ scripts/ …        ← 可选辅助文件
└─ references/ …
```

- `SKILL.md` frontmatter：`name`（下拉显示名，缺省回退文件夹名）与
  `description` 必填；写了 `id` 时必须与文件夹名一致；`icon` /
  `inputText` / `inputImages` / `requireImages` 与单文件形态相同；
  其他键（allowed-tools 等）忽略不报错；
- 技能 id = 文件夹名（命名规则与单文件相同）；
- **提示词技能栏只用 SKILL.md 的指令正文**——脚本/参考文档对它没有
  执行语义；pi 技能库（`data/pi/skills/`）的文件夹形态才支持 agent
  按需读取辅助文件（skill_load 返回时会提示路径）；
- 两个技能库的解析规则保持一致，文件夹手动放入即生效。

## 编写指令的建议

- 指令结尾加一句「只输出结果本身，不要解释」，避免模型输出废话污染提示词；
- 技能涉及图片时，提醒模型「多张图片按 @图片N 编号分段处理」；
- 涉及文字改写的技能，提醒模型「保留 @图片N 标记不要改动」，
  否则优化后的文本会与连线图片对不上号。

## 管理

- 列表：`GET /api/skills`（`.md` 与旧版 `.json` 都能读，同 id 时 `.md` 优先）
- 保存（新增或覆盖）：`POST /api/skills`（body 为 JSON 结构，落盘为 .json）
- 删除：`DELETE /api/skills/:id`（.md 与 .json 一起删除）

格式无效（缺 name/instruction、id 不合法、缺少 frontmatter）的文件会被忽略
并在后端日志告警。
