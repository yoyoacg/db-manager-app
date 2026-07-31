import { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import extract from 'extract-zip'
import { getConfig } from './store'
import { getDescriptor } from './registry'

export interface RemoteVersion {
  version: string
  url: string
}

/** 获取可下载版本列表：github 类型走 Releases API，http 类型读描述符里的版本表 */
export async function listRemoteVersions(id: string): Promise<RemoteVersion[]> {
  const d = getDescriptor(id)
  if (!d || !d.source) return []

  if (d.source.type === 'github' && d.source.repo) {
    const res = await fetch(`https://api.github.com/repos/${d.source.repo}/releases?per_page=10`)
    if (!res.ok) throw new Error(`GitHub API 请求失败: HTTP ${res.status}`)
    const releases = (await res.json()) as any[]
    const out: RemoteVersion[] = []
    for (const r of releases) {
      const tag = String(r.tag_name || '').replace(/^v/, '')
      if (!tag) continue
      const expected = (d.source.assetPattern || '').replace('{version}', tag)
      for (const a of r.assets || []) {
        if (a.name === expected || (expected === '' && a.name.endsWith('.zip'))) {
          out.push({ version: tag, url: a.browser_download_url })
          break
        }
      }
    }
    return out
  }

  return Object.entries(d.source.versions || {}).map(([version, url]) => ({
    version,
    url: String(url)
  }))
}

function sendProgress(
  id: string,
  version: string,
  stage: 'downloading' | 'extracting' | 'done' | 'error',
  received: number,
  total: number,
  message?: string
) {
  const payload = {
    id,
    version,
    stage,
    percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
    received,
    total,
    message
  }
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('download-progress', payload)
  }
}

/** zip 内若只有一层目录（如 mysql-8.0.36-winx64/），将其内容上提一层 */
function flattenIfSingleDir(dir: string) {
  const entries = fs.readdirSync(dir)
  if (entries.length !== 1) return
  const inner = path.join(dir, entries[0])
  if (!fs.statSync(inner).isDirectory()) return
  for (const e of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, e), path.join(dir, e))
  }
  fs.rmSync(inner, { recursive: true, force: true })
}

export async function downloadVersion(id: string, version: string) {
  const d = getDescriptor(id)
  if (!d) throw new Error(`未知服务: ${id}`)
  if (d.connectionOnly) throw new Error(`${d.displayName} 是远程连接条目，无需下载`)

  const remote = await listRemoteVersions(id)
  const item = remote.find((r) => r.version === version)
  if (!item) {
    throw new Error(`未找到 ${d.displayName} ${version} 的下载地址，请在描述符 JSON 中补充 versions`)
  }

  const root = getConfig().servicesRoot
  const destDir = path.join(root, id, version)
  const tmpZip = path.join(root, id, `.download-${version}.zip`)
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true })

  try {
    const res = await fetch(item.url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status}`)

    const total = Number(res.headers.get('content-length') || 0)
    let received = 0
    let lastSent = 0
    const nodeStream = Readable.fromWeb(res.body as any)
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastSent > 300) {
        lastSent = now
        sendProgress(id, version, 'downloading', received, total)
      }
    })
    await pipeline(nodeStream, fs.createWriteStream(tmpZip))
    sendProgress(id, version, 'extracting', received, total)

    fs.rmSync(destDir, { recursive: true, force: true })
    fs.mkdirSync(destDir, { recursive: true })
    await extract(tmpZip, { dir: destDir })
    flattenIfSingleDir(destDir)

    sendProgress(id, version, 'done', received, total)
    return { installed: version }
  } catch (e: any) {
    sendProgress(id, version, 'error', 0, 0, e?.message || String(e))
    throw e
  } finally {
    fs.rmSync(tmpZip, { force: true })
  }
}

/** 导入用户手动下载的 zip（浏览器挂代理下好的 release 包），解压到服务根目录 */
export async function importZipToVersion(id: string, version: string, zipPath: string) {
  const d = getDescriptor(id)
  if (!d) throw new Error(`未知服务: ${id}`)
  if (d.connectionOnly || !d.install) {
    throw new Error(`${d.displayName} 是远程连接条目，无需导入`)
  }

  const root = getConfig().servicesRoot
  const destDir = path.join(root, id, version)
  sendProgress(id, version, 'extracting', 0, 0)

  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })

  try {
    await extract(zipPath, { dir: destDir })
    flattenIfSingleDir(destDir)
  } catch (e: any) {
    sendProgress(id, version, 'error', 0, 0, e?.message || String(e))
    throw new Error(`解压失败: ${e?.message || e}`)
  }

  const exe = path.join(destDir, d.install.binPath)
  if (!fs.existsSync(exe)) {
    fs.rmSync(destDir, { recursive: true, force: true })
    sendProgress(id, version, 'error', 0, 0, 'zip 内容不符合预期')
    throw new Error(
      `解压后未找到 ${d.install.binPath}，请确认这是 ${d.displayName} 的 Windows 发布 zip 包`
    )
  }

  sendProgress(id, version, 'done', 0, 0)
  return { installed: version }
}
