# 清单、质检记录和命令

技能根目录可直接安装到 Codex skills 目录。Node.js 和 Playwright 应已存在；`PLAYWRIGHT_MODULE_PATH` 可指定现有 Playwright 包目录，未设置时使用常规 `require('playwright')`。不自动下载依赖。

## 本地发布清单

真实清单留在本地，路径使用绝对路径；以下只是结构示例，不包含真实账号：

```json
{
  "version": 1,
  "id": "2026-10-10-example-01",
  "account": {"name": "目标账号昵称", "id": "可选的已核实账号ID"},
  "title": "一篇笔记的标题",
  "body": "正文\n\n#示例话题",
  "visibility": "public",
  "timezone": "Asia/Shanghai",
  "ai_generated": true,
  "images": [
    {"path": "D:/deliverables/01.jpg", "sha256": "64位小写SHA256"},
    {"path": "D:/deliverables/02.jpg", "sha256": "64位小写SHA256"}
  ]
}
```

`id` 是稳定的内容 ID，重复执行沿用同一 ID。路径与散列组成有序图片清单。`timezone` 是管理列表显示时间的时区，默认 Asia/Shanghai；脚本只将提交时间前后十五分钟内的唯一同名行视为本次候选，否则留待人工核对。没有本地提交尝试记录的同名笔记不直接判为本次已发布。标题和正文由用户意图与素材内容决定，不自动添加夸大标题或无关话题。助手须检查图片本身，脚本只核对文件完整性与页面状态。

脚本当前仅自动处理 `visibility: public`。用户要求私密时，不可改成公开；手动完成设置、按技能检查并提交，或适配脚本后验证。`ai_generated: false` 不会勾选 AI 声明，但助手仍须核实内容来源和声明是否适用。

## 命令

将 `node` 替换为当前环境的 Node 可执行文件。任务中间目录必须遵从用户的缓存位置偏好：

```text
node scripts/publish.cjs validate --manifest <清单绝对路径>
node scripts/publish.cjs inspect --cdp http://127.0.0.1:9227 --page-index 0
node scripts/publish.cjs prepare --manifest <清单路径> --work-dir <任务缓存绝对目录> --cdp http://127.0.0.1:9227 --page-index 0
node scripts/publish.cjs commit --manifest <清单路径> --work-dir <任务缓存目录> --cdp http://127.0.0.1:9227 --page-index 0 --review <质检JSON路径> --confirmation <用户内容确认JSON路径> --authorized
node scripts/publish.cjs reconcile --manifest <清单路径> --work-dir <任务缓存目录> --cdp http://127.0.0.1:9227 --page-index 0
```

`inspect` 只读输出创作平台页签的索引、URL 和可见昵称文字，不读取 Cookie。多页签时必须明确 `--page-index`，防止操作错误页签。所有 CDP 地址必须是回环 HTTP 地址。

## 人的内容确认 JSON

确认前将按顺序排列的最终图片与完整标题正文交给当前使用者审阅。其明确同意发布这份内容后，由助手记录这条真实确认，不替用户确认，不用持续发布授权代替逐份内容确认。若用户已指定已看过的完整图片和文案并要求发出，不重复询问。

```json
{
  "scope": "exact-content",
  "fingerprint": "validate输出的清单指纹",
  "account_name": "目标账号昵称",
  "account_id": "如清单提供ID则必须一致",
  "confirmed_at": "真实确认时间ISO8601",
  "confirmed_by": "当前使用者在本任务中的本地身份标识",
  "human_reference": "可追溯到本任务中本人明确确认该份内容的消息或记录"
}
```

这是助手记录的人类确认凭据，并非防伪签名；运行脚本不能证明一段文本来自用户，助手仍必须核对真实会话和当前使用者。不得复用其他人的确认，记录也不提交到 GitHub。确认保持有效直到图片、顺序、文案或账号改变；之后指纹不匹配，需重新确认。内部质检即使通过也不能代替人的确认。

## 助手内部质检 JSON

`prepare` 输出 `<work-dir>/<id>/state.json` 与截图。打开每张成品及两张准备截图后，填写：

```json
{
  "fingerprint": "state.json 中 fingerprint 的原值",
  "reviewed_at": "ISO8601时间",
  "account_name": "目标账号昵称",
  "account_id": "如清单提供ID则必须一致",
  "account_verified": true,
  "images_reviewed": true,
  "order_verified": true,
  "settings_reviewed": true,
  "original_declaration": false,
  "screenshots": [
    {"path": "prepare-images.png的绝对路径", "sha256": "实际截图散列"},
    {"path": "prepare-settings.png的绝对路径", "sha256": "实际截图散列"}
  ],
  "publish_point": {"x": 0, "y": 0}
}
```

只有常规按钮无法定位时才需要 `publish_point`，坐标来自最新设置截图。质检记录十分钟内有效。若页面重新排版、滚动或改动内容，重新 prepare 和看图。账号 ID 来自用户已确认的账号及当前界面核实；若只有昵称且存在歧义，不能勾选已核实。

脚本的质检记录是助手的工作证据，不是防伪签名，也不替代实际看图或用户内容确认。它不会判断原创声明资格，因此当前自动流程只允许原创开关关闭。

## 恢复与状态

- `preparing` / `prepared` / `blocked-before-submit`：尚未点击，可在清单不变时重新 prepare。
- `submission-attempted` / `uncertain`：可能已提交，只能先 reconcile，脚本拒绝重复提交。
- `submitted`：成功页确认提交，尚未确认审核结果。
- `in-review`：管理页审核中。
- `published`：已发布栏目找到唯一对应标题。
- `rejected`：未通过栏目找到唯一对应标题；保存理由，不自动重发。
- `existing-needs-review`：上传前已经发现同名笔记，需人工核对。

使用同一个 work-dir 保留所有历史，正式结果可以复制到交付目录。任务级互斥锁采用独占文件创建，记录 PID。进程异常退出残留锁时，先确认对应进程已退出，再删除该任务唯一锁文件；不得删除整个状态目录。远端公开链接未核实时 `public_note_url` 为 null。

## 验证

```text
node --test tests/publish.test.cjs
node --check scripts/publish.cjs
```

测试只在本机创建临时文件，不接触小红书，不发布测试笔记。测试临时目录遵从 `TEMP` / `TMP`，运行前设置到用户指定任务缓存。
