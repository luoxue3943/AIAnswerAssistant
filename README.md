# AI Answer Assistant Privacy Safe

一个面向 Tampermonkey 的隐私优先 AI 答题助手。

本项目基于 `rehuan/AI-ANSWER-ASSISTANT` 的功能思路与部分实现进行重构，
重点移除默认中转、遥测与不必要的数据上传，并改造成单文件 Tampermonkey userscript。

> 当前版本：v1.5.1

## 特性

- 支持 Tampermonkey / Chrome
- 单选题、多选题、填空题、简答题
- 本地 DOM 扫描
- 可选强制 AI 结构扫描
- OpenAI Chat Completions 兼容 API
- 支持自定义 Base URL / Model / API Key
- Debug 日志
- API 连通性测试
- 无默认遥测、统计服务、远程 `@require` 或默认第三方中转 API

## 隐私设计

插件不会主动上传 URL、页面标题、Cookie、localStorage、sessionStorage、
已填写的表单值或整页 HTML。

正常答题时，只会将完成当前题目所必要的内容发送到用户自行配置的 AI API，
例如题干、选项、题型和可见填空数量。

开启 **AI 扫描** 时，会发送经过本地脱敏和裁剪后的候选题目结构，用于识别题型和控件。

### API Key

默认情况下 API Key 只保存在当前页面会话内。
若主动开启“记住 Key”，则会保存到 Tampermonkey 脚本存储中。

## 安装

1. 安装 Tampermonkey。
2. 打开 `ai-answer-assistant.user.js`。
3. 将脚本导入 Tampermonkey。
4. 打开需要使用的网页。
5. 点击页面右侧 `AI` 悬浮按钮。
6. 在“模型”页配置 OpenAI 兼容 API。

## AI 扫描

- **关闭**：只使用浏览器本地 DOM 扫描。
- **开启**：强制使用 AI 对本地生成的脱敏候选题目结构进行识别。

## Debug

Debug 模式可查看 DOM/AI 扫描结果、HTTP 状态、模型响应摘要、
JSON 解析结果、控件定位、选择状态和写入后的值校验。

Debug 不会显示 API Key，也不会为了 Debug 额外发起网络请求。

## 已知限制

不同网站的 DOM 和自定义控件差异很大。Shadow DOM、iframe、Canvas、
高度自定义 radio/checkbox 或动态重建 DOM 的页面可能仍需继续兼容。

## 开源许可

本项目采用 **GNU General Public License v3.0 (GPL-3.0)**。

本项目包含或衍生自以下开源项目的设计/代码：

- `rehuan/AI-ANSWER-ASSISTANT`
- 原项目许可：GPL-3.0

详见 [NOTICE](./NOTICE)。

## 免责声明

本项目用于浏览器自动化、AI 接口调用与 Web DOM 技术研究。
使用者应自行遵守平台规则、考试或测验规定、网站服务条款及当地法律法规。
