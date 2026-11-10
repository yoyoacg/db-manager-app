import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { externalDataDir, getConfig, getExternalInstalls } from './store'

import mysql from '../../descriptors/mysql.json'
import redis from '../../descriptors/redis.json'
import mongodb from '../../descriptors/mongodb.json'
import postgresql from '../../descriptors/postgresql.json'
import clickhouse from '../../descriptors/clickhouse.json'
import tdengine from '../../descriptors/tdengine.json'
import mariadb from '../../descriptors/mariadb.json'
import elasticsearch from '../../descriptors/elasticsearch.json'
import opensearch from '../../descriptors/opensearch.json'

export interface PostInstallStep {
  exe: string
  args: string[]
}

export interface ServiceConfigSpec {
  /** 配置文件名。内部安装相对安装目录；外部登记相对 userData/conf/id/version */
  file: string
  /** 模板行数组，支持 {installDir} {dataDir} {port} {version} 占位符（路径自动转正斜杠） */
  template: string[]
}

export interface ServiceDescriptor {
  id: string
  displayName: string
  description?: string
  connectionOnly?: boolean
  connection?: { host: string; port: number }
  source?: {
    type: 'http' | 'github'
    repo?: string
    assetPattern?: string
    versions?: Record<string, string>
  }
  install?: {
    binPath: string
    postInstall?: PostInstallStep[]
  }
  config?: ServiceConfigSpec
  runtime?: {
    startArgs: string[]
    port: number
    startTimeoutMs?: number
    /** 启动时注入的环境变量（值支持占位符），如 ES_JAVA_OPTS */
    env?: Record<string, string>
    /** 外部安装包通过 Windows 服务安装时的服务名；存在时优先使用服务启停 */
    windowsServiceName?: string
    /** 外部登记目录也由管理器托管：数据目录与配置文件放 userData，首次自动初始化，并按 startArgs 启动。
     *  适用于 postgres 等无参数即退出的程序；缺省时外部目录按原样直接运行可执行文件。 */
    manageExternalData?: boolean
  }
}

export interface InstalledVersion {
  version: string
  external: boolean
  path: string
}

const builtins = [
  mysql,
  mariadb,
  redis,
  mongodb,
  postgresql,
  elasticsearch,
  opensearch,
  clickhouse,
  tdengine
] as ServiceDescriptor[]

/** 全部描述符：内置 + 用户目录下自定义 JSON（同 id 覆盖内置） */
export function getDescriptors(): ServiceDescriptor[] {
  const map = new Map<string, ServiceDescriptor>()
  for (const d of builtins) map.set(d.id, d)
  try {
    const dir = path.join(app.getPath('userData'), 'descriptors')
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
          if (d && typeof d.id === 'string' && d.id) map.set(d.id, d)
        } catch {
          // 跳过损坏的 JSON
        }
      }
    }
  } catch {
    // ignore
  }
  return [...map.values()]
}

export function getDescriptor(id: string): ServiceDescriptor | undefined {
  return getDescriptors().find((d) => d.id === id)
}

/** 已安装版本 = 外部登记（有效）+ servicesRoot 扫描结果 */
export function getInstalledVersions(id: string): InstalledVersion[] {
  const d = getDescriptor(id)
  if (!d || d.connectionOnly || !d.install) return []
  const binPath = d.install.binPath
  const out: InstalledVersion[] = []

  for (const e of getExternalInstalls()) {
    if (e.id === id && fs.existsSync(path.join(e.path, binPath))) {
      out.push({ version: e.version, external: true, path: e.path })
    }
  }

  const base = path.join(getConfig().servicesRoot, id)
  if (fs.existsSync(base)) {
    for (const v of fs.readdirSync(base)) {
      if (v.startsWith('.')) continue
      const p = path.join(base, v)
      if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, binPath))) {
        out.push({ version: v, external: false, path: p })
      }
    }
  }

  return out.sort((a, b) => b.version.localeCompare(a.version))
}

/** 解析某版本的安装目录：优先外部登记，其次服务根目录 */
export function resolveInstall(
  id: string,
  version: string
): { installDir: string; external: boolean } | null {
  const d = getDescriptor(id)
  if (!d || !d.install) return null

  const ext = getExternalInstalls().find((x) => x.id === id && x.version === version)
  if (ext && fs.existsSync(path.join(ext.path, d.install.binPath))) {
    return { installDir: ext.path, external: true }
  }

  const p = path.join(getConfig().servicesRoot, id, version)
  if (fs.existsSync(path.join(p, d.install.binPath))) {
    return { installDir: p, external: false }
  }
  return null
}

/* ---------------- 配置文件（phpStudy 式可编辑配置） ---------------- */

export function tpl(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
}

/** 某版本的数据目录（与 processManager 启动逻辑保持一致） */
function dataDirOf(id: string, version: string, installDir: string, external: boolean): string {
  return external ? externalDataDir(id, version) : path.join(installDir, 'data')
}

/** 模板变量：路径统一正斜杠（my.ini / yaml / conf 均兼容） */
function configVars(
  d: ServiceDescriptor,
  id: string,
  version: string
): Record<string, string> | null {
  const resolved = resolveInstall(id, version)
  if (!resolved) return null
  const slash = (p: string) => p.replace(/\\/g, '/')
  return {
    installDir: slash(resolved.installDir),
    dataDir: slash(dataDirOf(id, version, resolved.installDir, resolved.external)),
    port: String(d.runtime?.port ?? ''),
    version
  }
}

/** 配置文件绝对路径：内部安装放安装目录下；外部登记放 userData/conf 下避免写权限问题 */
export function resolveConfigPath(id: string, version: string): string | null {
  const d = getDescriptor(id)
  if (!d?.config || !d.install) return null
  const resolved = resolveInstall(id, version)
  if (!resolved) return null
  if (resolved.external) {
    return path.join(app.getPath('userData'), 'conf', id, version, d.config.file)
  }
  return path.join(resolved.installDir, d.config.file)
}

/** 按模板渲染配置内容 */
export function renderConfigTemplate(id: string, version: string): string | null {
  const d = getDescriptor(id)
  if (!d?.config) return null
  const vars = configVars(d, id, version)
  if (!vars) return null
  return d.config.template.map((line) => tpl(line, vars)).join('\n') + '\n'
}

/** 确保配置文件存在：不存在则按模板生成。返回路径（该服务无配置时返回 null） */
export function ensureConfigFile(id: string, version: string): string | null {
  const p = resolveConfigPath(id, version)
  if (!p) return null
  if (!fs.existsSync(p)) {
    const content = renderConfigTemplate(id, version)
    if (content == null) return null
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf-8')
  }
  return p
}

/** 读取配置内容（不存在则先生成，保证用户看到的就是生效配置） */
export function readConfig(id: string, version: string): { path: string; content: string } | null {
  const p = ensureConfigFile(id, version)
  if (!p) return null
  try {
    return { path: p, content: fs.readFileSync(p, 'utf-8') }
  } catch {
    return null
  }
}

/** 保存配置内容 */
export function writeConfig(id: string, version: string, content: string): string | null {
  const p = resolveConfigPath(id, version)
  if (!p) return null
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

/** 重置为模板默认配置 */
export function resetConfig(id: string, version: string): { path: string; content: string } | null {
  const p = resolveConfigPath(id, version)
  const content = renderConfigTemplate(id, version)
  if (!p || content == null) return null
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
  return { path: p, content }
}

/** 从配置文本解析端口：优先精确 `port` 键（ini/conf/yaml），其次 `xxx.port` 键（如 ES 的 http.port） */
export function parseConfPort(content: string): number | null {
  const pick = (re: RegExp): number | null => {
    const m = content.match(re)
    if (!m) return null
    const n = Number(m[1])
    return n > 0 && n <= 65535 ? n : null
  }
  return (
    pick(/^[ \t]*port[ \t]*[=: ][ \t]*(\d{2,5})\b/im) ??
    pick(/^[ \t]*[\w-]+\.port[ \t]*[=: ][ \t]*(\d{2,5})\b/im)
  )
}

/** 某版本当前生效端口：优先取配置文件中的解析值（用户可能改过端口） */
export function effectivePort(id: string, version: string): number | null {
  const d = getDescriptor(id)
  if (!d?.runtime) return null
  const p = resolveConfigPath(id, version)
  if (p && fs.existsSync(p)) {
    try {
      const parsed = parseConfPort(fs.readFileSync(p, 'utf-8'))
      if (parsed) return parsed
    } catch {
      // ignore
    }
  }
  return d.runtime.port
}

/** 该服务全部候选端口（默认端口 + 各已安装版本配置里解析出的端口），用于状态探测与停止 */
export function candidatePorts(id: string): number[] {
  const d = getDescriptor(id)
  if (!d?.runtime) return []
  const set = new Set<number>([d.runtime.port])
  for (const v of getInstalledVersions(id)) {
    // 外部登记目录直接按默认参数运行，不读取管理器生成的配置文件端口；
    // 托管型外部安装（manageExternalData）的端口以管理器配置为准。
    if (v.external && d.runtime?.manageExternalData !== true) continue
    const p = resolveConfigPath(id, v.version)
    if (p && fs.existsSync(p)) {
      try {
        const parsed = parseConfPort(fs.readFileSync(p, 'utf-8'))
        if (parsed) set.add(parsed)
      } catch {
        // ignore
      }
    }
  }
  return [...set]
}
