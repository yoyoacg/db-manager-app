import { spawn, exec } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { externalDataDir } from './store'
import {
  candidatePorts,
  effectivePort,
  ensureConfigFile,
  getDescriptor,
  getDescriptors,
  resolveInstall,
  tpl,
  ServiceDescriptor
} from './registry'

/** TCP 探测端口是否可达（本地服务探活 / 远程连接探测通用） */
export function checkPort(port: number, host = '127.0.0.1', timeout = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok: boolean) => {
      if (!done) {
        done = true
        sock.destroy()
        resolve(ok)
      }
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    try {
      sock.connect(port, host)
    } catch {
      finish(false)
    }
  })
}

/** Windows 下通过 netstat 反查监听端口的 PID */
export function findPidByPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    exec('netstat -ano -p tcp', { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue
        const parts = line.trim().split(/\s+/)
        if (parts.length < 5) continue
        const local = parts[1]
        const p = Number(local.substring(local.lastIndexOf(':') + 1))
        if (p === port) return resolve(Number(parts[parts.length - 1]))
      }
      resolve(null)
    })
  })
}

export async function waitForPort(port: number, timeoutMs = 20000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(port)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function runOnce(exe: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd, windowsHide: true })
    let out = ''
    p.stdout?.on('data', (c) => (out += c))
    p.stderr?.on('data', (c) => (out += c))
    p.on('exit', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`退出码 ${code}: ${out.slice(-400)}`))
    })
    p.on('error', reject)
  })
}

export async function startService(id: string, version: string) {
  const d = getDescriptor(id)
  if (!d) throw new Error(`未知服务: ${id}`)
  if (d.connectionOnly || !d.install || !d.runtime) {
    throw new Error(`${d.displayName} 是远程连接条目，不支持本地启动`)
  }
  const resolved = resolveInstall(id, version)
  if (!resolved) {
    throw new Error(`尚未安装 ${d.displayName} ${version}，请先下载或导入`)
  }
  const { installDir, external } = resolved
  const exe = path.join(installDir, d.install.binPath)

  // 启动前确保配置文件存在（首次按模板生成），端口以配置文件为准（用户可能改过）
  const configFile = ensureConfigFile(id, version)
  const port = effectivePort(id, version) ?? d.runtime.port
  if (await checkPort(port)) {
    return { already: true, port }
  }

  // 外部登记的安装（如 Program Files 下）数据目录放 userData，避免写权限问题
  const dataDir = external ? externalDataDir(id, version) : path.join(installDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const vars = { dataDir, port: String(port), installDir, version, configFile: configFile ?? '' }

  // 首次启动：数据目录为空时执行 postInstall 初始化（如 mysqld --initialize-insecure / initdb）
  const initialized = fs.readdirSync(dataDir).length > 0
  if (!initialized && d.install.postInstall) {
    for (const step of d.install.postInstall) {
      const stepExe = path.join(installDir, step.exe)
      const args = step.args.map((a) => tpl(a, vars))
      await runOnce(stepExe, args, installDir)
    }
  }

  const args = d.runtime.startArgs.map((a) => tpl(a, vars))
  const child = spawn(exe, args, {
    cwd: installDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()

  const ok = await waitForPort(port, d.runtime.startTimeoutMs ?? 20000)
  if (!ok) {
    throw new Error(`${d.displayName} 启动后端口 ${port} 未就绪，请检查数据目录或日志`)
  }
  return { already: false, port }
}

export async function stopService(id: string) {
  const d = getDescriptor(id)
  if (!d || d.connectionOnly || !d.runtime) {
    throw new Error('该条目不支持停止操作')
  }
  // 用户可能在配置文件里改过端口，遍历全部候选端口找监听进程
  let pid: number | null = null
  let usedPort = d.runtime.port
  for (const p of candidatePorts(id)) {
    pid = await findPidByPort(p)
    if (pid) {
      usedPort = p
      break
    }
  }
  if (!pid) return { stopped: false, reason: 'not-running' }
  await new Promise<void>((resolve) => {
    exec(`taskkill /F /PID ${pid}`, () => resolve())
  })
  // 等端口真正释放
  const start = Date.now()
  while (Date.now() - start < 5000) {
    if (!(await checkPort(usedPort))) break
    await new Promise((r) => setTimeout(r, 300))
  }
  return { stopped: true, pid }
}

export interface ServiceStatus {
  running: boolean
  port?: number
  remote?: boolean
}

export async function getStatusMap(): Promise<Record<string, ServiceStatus>> {
  const out: Record<string, ServiceStatus> = {}
  await Promise.all(
    getDescriptors().map(async (d: ServiceDescriptor) => {
      if (d.connectionOnly) {
        const c = d.connection
        out[d.id] = c
          ? { running: await checkPort(c.port, c.host), port: c.port, remote: true }
          : { running: false, remote: true }
        return
      }
      if (!d.runtime) {
        out[d.id] = { running: false }
        return
      }
      // 端口以配置文件为准：任一候选端口可达即视为运行中
      const ports = candidatePorts(d.id)
      let hit: number | undefined
      for (const p of ports) {
        if (await checkPort(p)) {
          hit = p
          break
        }
      }
      out[d.id] = { running: hit != null, port: hit ?? d.runtime.port }
    })
  )
  return out
}
