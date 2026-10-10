# 小红书图文发布 Skill

依据实际上传流程整理的 Codex 技能：复用独立浏览器扫码登录，按顺序上传图片、填写文案、设置 AI 声明，检查页面后提交，并到“已发布”栏目复核。

入口：[SKILL.md](SKILL.md)。安装时把本仓库放入 Codex 的 `skills/xiaohongshu-publish` 目录；已存在源码目录也可用目录联接指向它。新会话中可调用：

```text
使用 $xiaohongshu-publish，把这些图片和文案发布到我已授权的小红书账号。
```

需要现有 Node.js、Playwright 和可连接的独立 Edge/Chromium 登录窗口。不自动安装依赖，不读取日常浏览器 Cookie。待发图片与完整文案先由当前使用者确认，确认后自动完成发布流程；需要登录或权限验证时等待本人处理。任何人的内容确认都不能套用到别人或另一份内容。

脚本支持 `validate / inspect / prepare / commit / reconcile`。使用方法和本地 JSON 结构见 [清单与命令](references/manifest.md)，已验证的界面及异常恢复见 [浏览器流程](references/browser-workflow.md)。

多图笔记不会默认压成单张九宫格。提交结果不明时先核对管理页，避免重复发布；“审核中”与“已发布”分开记录。公开链接只在真实取得时提供。

```text
node --check scripts/publish.cjs
node --test tests/publish.test.cjs
```

本仓库不含账号配置、登录资料、真实发布素材或截图。测试不访问小红书、不发测试笔记。界面流程验证于 2026-10-10，平台更新后需要重新确认选择器。
