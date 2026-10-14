# RTT 源码图谱

面向 RT-Thread 与嵌入式 C/C++ 项目的独立中文桌面工具。打开本地文件夹后，可浏览文件依赖、函数调用关系、Git 工作区影响，查看源码并跳转到本机 VS Code，也可把选中的源码上下文交给兼容接口的 LLM 分析。

## 开发运行

需要 Node.js 22.12 或更新版本（与当前 Electron 构建工具链的最低版本一致）。

```powershell
npm install
npm run dev
```

## Windows 安装包

```powershell
npm run build
```

安装包输出到 `release`。构建会自动下载并校验官方 MinGit，再把 Git 工具链和应用一起打包；用户无需预先安装 Git 或 Node.js。首次构建需要网络连接。MinGit 版本及 SHA-256 固定在 `scripts/prepare-toolchain.mjs` 中，构建会校验官方压缩包的 SHA-256，并保留其许可证文件。

运行时依赖说明：Electron 提供应用运行时；React、图谱等前端依赖已打入应用资源；Git 影响分析使用随安装包提供的 MinGit。VS Code 是可选的源码跳转目标，LLM 是用户配置的远程服务，不属于本地运行依赖。静态 C/C++ 分析无需额外安装 Clang 工具链。

设置页可选择 OpenAI 兼容接口、Anthropic 或 Gemini，填写服务地址、模型名与 API Key。发送代码给 LLM 前，应用会先显示上下文供确认。

源码关系通过轻量静态分析生成，边上带有近似标记；复杂宏、函数指针及条件编译可能影响识别结果。VS Code 仅用于定位并打开源码，图谱分析在本应用内独立运行。
