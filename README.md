# DB 服务管理器（db-service-manager）

Windows 桌面端多数据库服务一键管理器。**描述符驱动**：每种数据库用一个 JSON 描述符声明下载源、安装结构、配置文件模板与启动方式，主进程据此统一管理「下载 → 安装 → 初始化 → 启停 → 探活」的完整生命周期。使用体验对标 phpStudy。

## 功能特性

- **一键启停**：单服务启停 + 全局「全部启动 / 全部停止」，状态灯每 3 秒自动刷新
- **多版本并存**：同一服务可安装多个版本，按版本选择启动
- **三种安装方式**
  - 在线下载（GitHub Releases / 官方直链，带进度条）
  - 手动导入 zip（浏览器挂代理下好的发布包）
  - 登记外部目录（如 `C:\Program Files\MongoDB\Server\8.2` 这类已有安装）
- **配置文件可编辑（phpStudy 式）**：每个服务自动生成默认配置（my.ini / redis.conf / mongod.cfg / postgresql.conf），界面内直接编辑、保存、恢复默认，重启生效
- **端口联动**：配置文件中改端口后，启动探活、停止、状态灯自动以配置端口为准
- **首次启动自动初始化**：数据目录为空时自动执行初始化（`mysqld --initialize-insecure`、`initdb` 等），日志写入数据目录便于排查
- **外部 Windows 服务管理**：可扫描并登记安装器注册的 MongoDB 服务，启停时优先通过 Windows 服务控制器；普通账户无权限时会请求 UAC 授权。未注册为系统服务时直接运行安装目录中的可执行文件，不追加参数、不生成配置或初始化数据
- **自定义描述符**：放入 userData 的 `descriptors/*.json` 即可新增或覆盖内置服务，无需改代码

## 内置服务

| 服务 | 默认端口 | 配置文件 | 说明 |
|---|---|---|---|
| MySQL | 3306 | my.ini | 首启自动 `--initialize-insecure`，root 无密码 |
| MariaDB | 3307 | my.ini | MySQL 兼容，首启自动 `--initialize-insecure` |
| Redis | 6379 | redis.conf | 版本列表取自 tporadowski/redis Releases |
| MongoDB | 27017 | mongod.cfg | 解压即用 |
| PostgreSQL | 5432 | postgresql.conf | 首启自动 `initdb`，postgres 用户 trust 认证 |
| Elasticsearch | 9200 | elasticsearch.yml | 单节点搜索与分析数据库，默认关闭安全认证 |
| OpenSearch | 9201 | opensearch.yml | Windows 包自带 JDK，单节点搜索与分析数据库 |
| ClickHouse | 8123 | — | 远程连接条目（官方无原生 Windows 服务端） |
| TDengine | 6030 | — | 远程连接条目，状态灯探测连通性 |

## 快速开始

```bash
npm install
npm run dev      # 开发模式（热更新）
npm run build    # 构建到 out/
npm run preview  # 预览构建产物
npm run package:win # 生成 Windows x64 安装程序（release/）
```

技术栈：Electron 30 + Vue 3 + TypeScript + electron-vite 2。

## 使用说明

### 服务根目录

顶部输入框设置服务根目录（默认 `D:\db-services`，无 D 盘时回退到 userData）。所有在线下载 / 导入的安装都按 `<根目录>\<服务id>\<版本>\` 存放。

### 编辑配置（phpStudy 式）

已安装版本的卡片上点「配置」打开编辑器：

- **保存**：写入配置文件；服务运行中保存后需重启生效
- **恢复默认**：按描述符模板重新生成（当前修改丢失）
- 支持 Tab 缩进；文件路径显示在编辑器上方

配置文件位置：

- 内部安装 → `<安装目录>\<配置文件>`（如 `D:\db-services\mysql\8.0.36\my.ini`）
- 外部登记 → `%APPDATA%\db-service-manager\conf\<服务id>\<版本>\`（避免 Program Files 写权限问题）

> 注意：重新下载同一版本会清空该版本安装目录（含配置与数据），不同版本互不影响。

### 数据目录与日志

- 内部安装 → `<安装目录>\data\`；外部登记 → `%APPDATA%\db-service-manager\data\<服务id>\<版本>\`
- 各服务错误日志默认写入数据目录（mysql-error.log / redis.log / mongod.log / postgresql 的 log/ 子目录）

## 描述符格式

新增数据库只需在 `%APPDATA%\db-service-manager\descriptors\` 放一个 JSON（同 id 覆盖内置）：

```jsonc
{
  "id": "mysql",                    // 唯一标识
  "displayName": "MySQL",
  "description": "卡片上显示的说明",

  // —— 远程连接条目（二选一）——
  "connectionOnly": true,
  "connection": { "host": "127.0.0.1", "port": 6030 },

  // —— 本地安装条目 ——
  "source": {                       // 下载源
    "type": "github",               // github: 从 Releases 获取版本列表
    "repo": "tporadowski/redis",
    "assetPattern": "Redis-x64-{version}.zip"
    // 或 "type": "http", "versions": { "8.0.36": "https://...zip" }
  },
  "install": {
    "binPath": "bin/mysqld.exe",    // 主程序相对路径（用于校验安装是否有效）
    "postInstall": [                // 首启初始化（数据目录为空时按序执行一次）
      { "exe": "bin/mysqld.exe", "args": ["--initialize-insecure", "--datadir={dataDir}"] }
    ]
  },
  "config": {                       // 可选：配置文件模板（行数组，JSON 友好）
    "file": "my.ini",
    "template": ["[mysqld]", "port={port}", "datadir={dataDir}"]
  },
  "runtime": {
    "startArgs": ["--defaults-file={configFile}", "--console"],
    "port": 3306,                   // 默认端口（配置模板里的 {port} 初始值）
    "startTimeoutMs": 30000
  }
}
```

**占位符**（`startArgs`、`postInstall.args`、`config.template` 通用）：

| 占位符 | 含义 |
|---|---|
| `{installDir}` | 安装目录 |
| `{dataDir}` | 数据目录 |
| `{port}` | 端口（配置模板中为描述符默认端口） |
| `{version}` | 版本号 |
| `{configFile}` | 配置文件绝对路径（仅 startArgs 常用） |

配置模板中的路径会自动转为正斜杠（兼容 my.ini / YAML）。

## 目录结构

```
descriptors/          # 内置服务描述符（JSON）
src/
  main/               # Electron 主进程
    index.ts          #   窗口 + IPC
    registry.ts       #   描述符注册表 / 安装扫描 / 配置生成 / 端口解析
    processManager.ts #   启停 / 端口探活 / PID 查找
    downloadManager.ts#   下载 / zip 导入 / 解压
    store.ts          #   配置持久化（userData/config.json）
  preload/index.ts    # contextBridge（window.dbapi）
  renderer/           # Vue 3 界面
    src/App.vue
    src/components/ServiceCard.vue
    src/components/ConfigEditor.vue
```

## 已知限制

- 停止服务按「端口反查 PID」实现：若端口被其他程序占用可能误杀；同一服务同一时间只能运行一个实例
- 状态探活基于 TCP 连接，端口可达即视为运行中（不校验是否真是目标数据库进程）
- 仅支持 Windows（netstat / taskkill / 路径处理均按 Windows 约定）
