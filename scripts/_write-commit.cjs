'use strict';
const fs = require('fs');
const path = require('path');

const content = `fix(openclaw): fix node not found on Windows when WSL and Git Bash coexist

[问题]
在 Windows 上运行 npm run openclaw:runtime:win-x64 时，构建脚本报错：

  Missing required command: node

Node.js 已正确安装并在系统 PATH 中，bash 脚本却始终找不到它，导致构建流程无法启动。

[根因]
问题由两个叠加缺陷共同导致：

1. WSL bash 过滤不完整（主因）
   原始代码 scripts/run-build-openclaw-runtime.cjs 中选取 bash 的过滤条件为：

     const gitBash = paths.find(p => !p.toLowerCase().includes('windowsapps'));

   该条件只排除了 WindowsApps 目录下的 WSL bash，
   却遗漏了另一个 WSL shim：C:\\Windows\\System32\\bash.exe。
   当机器同时安装了 WSL 时，where bash 的第一条结果往往是 System32\\bash.exe，
   它不含 windowsapps，因此通过了过滤，被错误选中。
   WSL bash 运行在独立的 Linux 子系统中，完全看不到 Windows 安装的 node/npm/pnpm，
   导致 need_cmd node 检查必然失败。

2. 缺少 MSYS2 路径兜底（辅因）
   原始代码构建 env 时仅将 Windows 格式的 node 目录（D:\\foo\\bar）追加到 PATH，
   但在 npm -> cmd.exe -> node 嵌套进程链中，MSYS2 对 Windows 路径的自动转换
   （D:\\... -> /d/...）会静默失败，Git Bash 内部依然找不到 node。

[修复]
1. 补全 WSL bash 过滤（scripts/run-build-openclaw-runtime.cjs）
   在原有 windowsapps 过滤基础上，增加对 system32\\bash 的排除：

   修复前：
     paths.find(p => !p.toLowerCase().includes('windowsapps'))

   修复后：
     paths.find(p => {
       const lower = p.toLowerCase();
       return !lower.includes('windowsapps') && !lower.includes('system32\\\\bash');
     })

2. 注入 MSYS2 格式 node 路径（scripts/run-build-openclaw-runtime.cjs）
   启动 bash 前将 node 目录转为 MSYS2 Unix 风格（D:\\foo\\bar -> /d/foo/bar），
   通过环境变量 LOBSTER_NODE_MSYS_DIR 传入 bash，绕过 MSYS2 自动转换失败的问题。

3. bash 脚本显式前置路径（scripts/build-openclaw-runtime.sh）
   - need_cmd 调用前无条件将 LOBSTER_NODE_MSYS_DIR 前置到 PATH。
   - need_cmd 内部增加兜底：命令未找到时若该目录下有可执行文件，自动修复 PATH 并继续。

[复现路径]
1. Windows 机器同时安装 WSL（含 C:\\Windows\\System32\\bash.exe）和 Git Bash
2. 确保 Node.js 已安装（node --version 可正常输出）
3. 项目根目录执行：npm run openclaw:runtime:win-x64
4. 修复前：输出 Missing required command: node 并退出
5. 修复后：输出 [openclaw-runtime] Already built for vX.X.X ... 或正常开始构建流程
`;

fs.writeFileSync(path.resolve(__dirname, '..', 'commit.txt'), content, 'utf8');
console.log('commit.txt written successfully.');
