# 用户自定义技能（data/skills/）

本文件夹存放**用户自定义技能**，供画布提示词节点底部的技能栏使用。
一个技能一个 `.md` 文件（Agent Skills 主流格式），**放入本文件夹 → 刷新页面即生效**，
无需重启后端。

内置技能（优化提示词 / 反推图像）在代码文件
`js/canvas/nodes/PromptSkillBar.js` 的 `SKILLS` 数组中，与本文件夹互不影响；
同 id 冲突时内置优先。

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
