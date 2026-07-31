import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface ExternalInstall {
  id: string
  version: string
  path: string
}

export interface AppConfig {
  servicesRoot: string
  externalInstalls?: ExternalInstall[]
}

function defaultRoot(): string {
  try {
    if (fs.existsSync('D:\\')) return 'D:\\db-services'
  } catch {
    // ignore
  }
  return path.join(app.getPath('userData'), 'services')
}

function configFile(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function writeConfig(cfg: AppConfig) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf-8')
}

export function getConfig(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf-8'))
    if (raw && typeof raw.servicesRoot === 'string' && raw.servicesRoot) {
      return {
        servicesRoot: raw.servicesRoot,
        externalInstalls: Array.isArray(raw.externalInstalls) ? raw.externalInstalls : []
      }
    }
  } catch {
    // 首次运行无配置文件
  }
  return { servicesRoot: defaultRoot(), externalInstalls: [] }
}

export function setServicesRoot(root: string): AppConfig {
  const cfg: AppConfig = { ...getConfig(), servicesRoot: root }
  writeConfig(cfg)
  return cfg
}

export function getExternalInstalls(): ExternalInstall[] {
  return getConfig().externalInstalls ?? []
}

/** 登记外部安装目录（同 id+version 覆盖） */
export function addExternalInstall(entry: ExternalInstall): AppConfig {
  const cfg = getConfig()
  const list = (cfg.externalInstalls ?? []).filter(
    (x) => !(x.id === entry.id && x.version === entry.version)
  )
  list.push(entry)
  const next: AppConfig = { ...cfg, externalInstalls: list }
  writeConfig(next)
  return next
}

/** 外部安装的数据目录统一放 userData，避免 Program Files 等位置的写权限问题 */
export function externalDataDir(id: string, version: string): string {
  return path.join(app.getPath('userData'), 'data', id, version)
}
