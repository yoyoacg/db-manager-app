import { spawn, exec } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

/** 使用指定地址执行一次 TCP 探测。 */
function checkPortAtHost(port: number, host: string, timeout: number): Promise<boolean> {
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

/** TCP 探测端口是否可达（本地服务探活 / 远程连接探测通用）。
 * 本地服务可能只监听 IPv6 通配地址 ::，因此 IPv4 回环失败后补探测 ::1。
 */
export async function checkPort(port: number, host = '127.0.0.1', timeout = 800): Promise<boolean> {
  if (await checkPortAtHost(port, host, timeout)) return true
  return host === '127.0.0.1' ? checkPortAtHost(port, '::1', timeout) : false
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

export async function waitForPort(
  port: number,
  timeoutMs = 20000,
  startupError?: () => Error | undefined
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // 启动进程提前退出时立即返回真实原因，避免只显示端口等待超时。
    const error = startupError?.()
    if (error) throw error
    if (await checkPort(port)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** 读取 Windows 服务的可执行文件路径，用于识别安装器创建的外部服务。 */
function getWindowsServiceBinaryPath(name: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn('sc.exe', ['qc', name], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null)
      const line = out.match(/BINARY_PATH_NAME\s*:\s*(.+)/i)?.[1]?.trim()
      if (!line) return resolve(null)
      // 安装器通常会给含空格的 exe 路径加引号；无引号路径仅支持无空格场景。
      const quoted = line.match(/"([^"]+\.exe)"/i)?.[1]
      const plain = line.match(/^([^\s]+\.exe)/i)?.[1]
      resolve(quoted ?? plain ?? null)
    })
  })
}

/** 扫描描述符声明的 Windows 服务，并转换为可登记的安装目录。 */
export async function scanExternalWindowsServices(): Promise<
  { id: string; version: string; path: string; serviceName: string }[]
> {
  if (process.platform !== 'win32') return []
  const found: { id: string; version: string; path: string; serviceName: string }[] = []
  for (const d of getDescriptors()) {
    const serviceName = d.runtime?.windowsServiceName
    if (!serviceName || !d.install) continue
    const exe = await getWindowsServiceBinaryPath(serviceName)
    if (!exe) continue
    const suffix = d.install.binPath.replace(/\//g, '\\').toLowerCase()
    const normalized = path.normalize(exe)
    const index = normalized.toLowerCase().lastIndexOf(suffix)
    if (index < 0) continue
    const installDir = normalized.slice(0, index).replace(/[\\/]$/, '')
    if (!fs.existsSync(path.join(installDir, d.install.binPath))) continue
    found.push({ id: d.id, version: path.basename(installDir), path: installDir, serviceName })
  }
  return found
}

/** 查询 Windows 服务状态；服务不存在或当前平台不支持时返回 null。 */
function getWindowsServiceState(name: string): Promise<'RUNNING' | 'STOPPED' | 'OTHER' | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn('sc.exe', ['query', name], { windowsHide: true })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null)
      if (/STATE\s*:\s*\d+\s+RUNNING/i.test(out)) return resolve('RUNNING')
      if (/STATE\s*:\s*\d+\s+STOPPED/i.test(out)) return resolve('STOPPED')
      resolve('OTHER')
    })
  })
}

/** 向 Windows 服务控制器发送启停命令，参数以数组传递，避免拼接命令行。 */
async function controlWindowsService(action: 'start' | 'stop', name: string): Promise<boolean> {
  const direct = await new Promise<{ ok: boolean; accessDenied: boolean }>((resolve) => {
    const child = spawn('sc.exe', [action, name], { windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk) => (output += chunk))
    child.stderr?.on('data', (chunk) => (output += chunk))
    child.on('error', () => resolve({ ok: false, accessDenied: false }))
    child.on('exit', (code) => {
      resolve({
        ok: code === 0,
        accessDenied: code === 5 || /access is denied|拒绝访问/i.test(output)
      })
    })
  })
  if (direct.ok || !direct.accessDenied || process.platform !== 'win32') return direct.ok

  // 普通账户无服务启停权限时触发一次 UAC，仅提升 sc.exe，不提升整个应用进程。
  if (!/^[\w.-]+$/.test(name)) return false
  return new Promise((resolve) => {
    const command = `$p = Start-Process -FilePath 'sc.exe' -ArgumentList '${action}', '${name}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
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

/** 使用 wscript 在隐藏窗口中脱离启动控制台程序，避免 PowerShell 改变服务的启动行为。 */
function getHiddenLauncherScript(): string {
  const scriptPath = path.join(os.tmpdir(), 'db-service-manager-hidden-launch.vbs')
  const script = [
    'Set shell = CreateObject("WScript.Shell")',
    'shell.CurrentDirectory = WScript.Arguments(1)',
    'command = """" & Replace(WScript.Arguments(0), """", """""") & """"',
    'For i = 2 To WScript.Arguments.Count - 1',
    '  command = command & " " & """" & Replace(WScript.Arguments(i), """", """""") & """"',
    'Next',
    'shell.Run command, 0, False'
  ].join('\r\n')
  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf-8') !== script) {
    fs.writeFileSync(scriptPath, script, 'utf-8')
  }
  return scriptPath
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

  // 外部登记目录保持其原有安装状态，直接运行可执行文件，不生成配置或追加启动参数。
  const configFile = external ? null : ensureConfigFile(id, version)
  const port = external ? d.runtime.port : effectivePort(id, version) ?? d.runtime.port
  if (await checkPort(port)) {
    return { already: true, port }
  }

  // 由安装器注册的外部服务（如 MongoDB）优先交给 Windows 服务控制器管理。
  if (external && d.runtime.windowsServiceName) {
    const state = await getWindowsServiceState(d.runtime.windowsServiceName)
    if (state) {
      if (state !== 'RUNNING' && !(await controlWindowsService('start', d.runtime.windowsServiceName))) {
        throw new Error(`${d.displayName} Windows 服务启动失败；如出现 UAC 提示请允许授权，否则请检查服务权限或系统服务日志`)
      }
      const ok = await waitForPort(port, d.runtime.startTimeoutMs ?? 20000)
      if (!ok) throw new Error(`${d.displayName} Windows 服务已启动，但端口 ${port} 未就绪`)
      return { already: false, port, windowsService: true }
    }
  }

  const dataDir = external ? '' : path.join(installDir, 'data')
  if (!external) fs.mkdirSync(dataDir, { recursive: true })
  // Cygwin 版 Redis 不接受命令行中的 Windows 绝对路径；以安装目录为 cwd 传相对路径，兼容旧版 Redis。
  const runtimeConfigFile = id === 'redis' && configFile
    ? `./${path.relative(installDir, configFile).replace(/\\/g, '/')}`
    : configFile ?? ''
  const vars = { dataDir, port: String(port), installDir, version, configFile: runtimeConfigFile }

  // 仅管理器下载的目录执行首次初始化，外部目录不得改写其数据目录。
  const initialized = external || fs.readdirSync(dataDir).length > 0
  if (!initialized && d.install.postInstall) {
    for (const step of d.install.postInstall) {
      const stepExe = path.join(installDir, step.exe)
      const args = step.args.map((a) => tpl(a, vars))
      await runOnce(stepExe, args, installDir)
    }
  }

  const args = external ? [] : d.runtime.startArgs.map((a) => tpl(a, vars))
  // 描述符可为特殊服务注入运行时参数，例如 Elasticsearch 的 JVM 内存限制。
  const env = d.runtime.env
    ? Object.fromEntries(Object.entries(d.runtime.env).map(([key, value]) => [key, tpl(value, vars)]))
    : {}
  // Redis 直接启动并接收输出，避免隐藏脚本吞掉 Cygwin 运行时的启动错误。
  const directRedis = id === 'redis'
  const launchWithWscript = process.platform === 'win32' && !directRedis
  let output = ''
  let launchError: Error | undefined
  let exitDescription: string | undefined
  const startupError = () => launchError ?? (exitDescription
    ? new Error(`${d.displayName} 启动进程已退出（${exitDescription}）\n${output.trim() || '未输出错误信息，请检查 Redis 配置中的 logfile'}`)
    : undefined)
  const child = spawn(
    launchWithWscript ? 'wscript.exe' : exe,
    launchWithWscript
      ? ['//B', getHiddenLauncherScript(), exe, installDir, ...args]
      : args,
    {
      cwd: installDir,
      detached: !directRedis,
      stdio: directRedis ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env },
      // Redis 使用 windowsHide 隐藏窗口，其他服务保留原有 wscript 启动方式。
      shell: false
    }
  )
  child.on('error', (error) => {
    launchError = new Error(`${d.displayName} 无法启动：${error.message}`)
  })
  if (directRedis) {
    // 持续消费输出但只保留末尾，防止管道堵塞或长期运行时内存持续增长。
    const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf-8')).slice(-8192) }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('exit', (code, signal) => {
      exitDescription = signal ? `信号 ${signal}` : `退出码 ${code}`
    })
  }
  child.unref()

  const ok = await waitForPort(port, d.runtime.startTimeoutMs ?? 20000, startupError)
  if (!ok) {
    throw startupError() ?? new Error(
      `${d.displayName} 启动后端口 ${port} 未就绪，请检查数据目录或日志${output.trim() ? `\n${output.trim()}` : ''}`
    )
  }
  return { already: false, port }
}

export async function stopService(id: string) {
  const d = getDescriptor(id)
  if (!d || d.connectionOnly || !d.runtime) {
    throw new Error('该条目不支持停止操作')
  }
  // 外部安装的 MongoDB 等服务由 Windows 服务控制器停止，避免直接结束其进程。
  if (d.runtime.windowsServiceName) {
    const state = await getWindowsServiceState(d.runtime.windowsServiceName)
    if (state && state !== 'STOPPED') {
      if (!(await controlWindowsService('stop', d.runtime.windowsServiceName))) {
        throw new Error(`${d.displayName} Windows 服务停止失败；如出现 UAC 提示请允许授权，否则请检查服务权限或系统服务日志`)
      }
      const start = Date.now()
      while (Date.now() - start < 5000) {
        const ports = candidatePorts(id)
        if (!(await Promise.all(ports.map((p) => checkPort(p)))).some(Boolean)) break
        await new Promise((r) => setTimeout(r, 300))
      }
      return { stopped: true, windowsService: true }
    }
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
