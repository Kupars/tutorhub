# 优师家教（TutorHub）无服务器家教信息平台

本项目采用原生 ES Modules 前端、边缘函数接口与 Supabase 数据库方案，无需购买独立服务器，支持同时部署到 Cloudflare Pages、GitHub Pages 及国内边缘托管平台，并预留了面向微信小程序复用的统一表结构与接口层。

## 1. 本地立即体验
在项目目录下运行本地静态服务（例如 `python3 -m http.server 8080`），浏览器打开 `http://localhost:8080` 即可体验全部功能：
- 体验老师账号：`teacher@tju.edu.cn` / `123456`
- 体验管理员账号：`admin@tutorhub.cn` / `admin123456`

> 上述账号密码**仅供本地体验**。线上站点务必在 Cloudflare Pages 生产环境设置不同的 `ADMIN_EMAIL`、强 `ADMIN_PASSWORD` 和随机 `AUTH_SECRET`。旧代码含默认密码，未配置时有未授权后台访问风险。

## 家教需求管理与 AI Skill

- **老师端**：免编辑权限即可按学生性别、年级、单/多科、区域、周中/周末、最低时薪及授课方式组合筛选，全文搜索单号、成绩和试课信息；复制按钮导出标准九字段家教单。
- **管理员端**：可手动填九字段、编辑原单、复制家长问询模板、拆成带子编号的单科草稿、合并同一学生的多科单、粘贴微信聊天交给 AI 整理，或从飞书导出 CSV/TSV 批量导入。草稿可以逐条修改，确认后才会发布。
- **标准编号**：从已确认的 #2991 开始，下一新单默认 #2992。已存在的新式编号会参与自动续号；旧单编号不被无故替换。用户明确给号时保留，重复编号在发布时提示冲突。
- **AI 整理规范**：网站按 `tutoring-order-formatter` 规则提取学生性别、老师人数、成绩、薪资区间、试课、是否可网课，不猜测成绩或地址。AI 不可用时使用本地规则解析并展示失败原因。
- **数据行为**：Cloudflare KV 中的空数组表示真实空状态，刷新绝不恢复演示数据；云端增删改失败会显示错误而不是假成功。当前使用 KV 的生产环境不需要执行 Supabase SQL；SQL 为未来迁移预留。

可通过 `npm test` 运行格式化、CSV、空数据库、权限及 AI 错误处理的自动测试。

## 2. 免费大模型接入说明
网页端会员账号本身不附带开放接口额度，推荐在 Cloudflare Pages 项目后台的环境变量中配置以下免费官方接口之一（密钥仅存于服务端，不暴露给浏览器）：
- **国内直连免费方案**：智谱开放平台免费模型 `glm-4-flash`（配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`）。
- **Google 免费层方案**：Google AI Studio 免费层 Gemini 模型（配置 `GEMINI_API_KEY`、`GEMINI_MODEL`）。
- 未配置环境变量时，系统自动启用内置中文规则引擎，零散文本整理、简历润色与自然语言改站依然可用。
- 2026 年建议使用智谱 `glm-4.7-flash`；`OPENAI_BASE_URL` 应为 `https://open.bigmodel.cn/api/paas/v4`（不要包含 `/chat/completions`）。修改变量后重新部署。
- 生产环境中 AI 接口仅允许登录用户调用，家教单整理与改站指令仅限管理员。切勿将 API Key 写进前端文件。

## 3. 多平台同步部署与自定义域名加速
1. 将本项目上传到 GitHub 仓库的 `main` 分支。
2. 在 GitHub 仓库设置中开启 GitHub Pages（来源选择 GitHub Actions）。
3. 在 Cloudflare Pages 关联同一仓库（构建命令留空，输出目录填 `.`），并在 Custom domains 中绑定你自己的域名，以绕开默认后缀在大陆的访问限制。
4. 如需进一步提升大陆速度，可将同一仓库同步关联到腾讯云 EdgeOne Pages 或阿里云 ESA Pages，并在域名解析商处配置境内外分流解析；同时将各节点网址填入 `js/app-env.js` 的 `nodes` 列表，通过 `/fast.html` 实现自动测速选快。
5. 在 GitHub 仓库 Secrets 中配置 Cloudflare 部署凭据后，每次推送代码都会自动同步更新所有平台。

## 4. 开启多人真实账号与安全后台
1. 在 Supabase 创建免费项目，在 SQL Editor 中执行 `supabase/schema.sql`（已内置行级权限隔离策略）。
2. 将项目地址与公开匿名凭据填入 `js/app-env.js`。
3. 如需开启高德地图实时路程规划，在 Cloudflare Pages 环境变量中添加 `AMAP_KEY`。
