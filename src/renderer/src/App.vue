<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import ServiceCard from './components/ServiceCard.vue'

const api = (window as any).dbapi

const services = ref<any[]>([])
const statusMap = ref<Record<string, any>>({})
const progressMap = ref<Record<string, any>>({})
const root = ref('')
const busyAll = ref(false)
const globalError = ref('')

let timer: any = null
let offProgress: (() => void) | null = null

async function refresh() {
  try {
    services.value = await api.listServices()
    statusMap.value = await api.getStatus()
  } catch (e: any) {
    globalError.value = e?.message || String(e)
  }
}

async function refreshStatus() {
  try {
    statusMap.value = await api.getStatus()
  } catch {
    // 忽略单次轮询失败
  }
}

async function startAll() {
  busyAll.value = true
  globalError.value = ''
  for (const s of services.value) {
    if (s.connectionOnly) continue
    const v = s.installed?.[0]?.version
    if (v && !statusMap.value[s.id]?.running) {
      try {
        await api.start(s.id, v)
      } catch (e: any) {
        globalError.value = `${s.displayName}: ${e?.message || e}`
      }
    }
  }
  await refresh()
  busyAll.value = false
}

async function stopAll() {
  busyAll.value = true
  for (const s of services.value) {
    if (s.connectionOnly) continue
    if (statusMap.value[s.id]?.running) {
      try {
        await api.stop(s.id)
      } catch {
        // 忽略单个停止失败
      }
    }
  }
  await refresh()
  busyAll.value = false
}

async function saveRoot() {
  if (!root.value.trim()) return
  await api.setRoot(root.value.trim())
  await refresh()
}

onMounted(async () => {
  const cfg = await api.getConfig()
  root.value = cfg.servicesRoot
  await refresh()
  timer = setInterval(refreshStatus, 3000)
  offProgress = api.onProgress((p: any) => {
    progressMap.value = { ...progressMap.value, [p.id]: p }
    if (p.stage === 'done' || p.stage === 'error') {
      setTimeout(() => refresh(), 500)
    }
  })
})

onUnmounted(() => {
  clearInterval(timer)
  offProgress?.()
})
</script>

<template>
  <div class="header">
    <h1>DB 服务管理器</h1>
    <div class="root-config">
      <label>服务根目录</label>
      <input v-model="root" @keyup.enter="saveRoot" placeholder="如 D:\db-services" />
      <button class="btn" @click="saveRoot">保存</button>
    </div>
    <div class="header-actions">
      <button class="btn btn-primary" :disabled="busyAll" @click="startAll">全部启动</button>
      <button class="btn btn-danger" :disabled="busyAll" @click="stopAll">全部停止</button>
    </div>
  </div>

  <div v-if="globalError" style="padding: 10px 24px" class="error-text">{{ globalError }}</div>

  <div class="grid">
    <ServiceCard
      v-for="s in services"
      :key="s.id"
      :service="s"
      :status="statusMap[s.id] || {}"
      :progress="progressMap[s.id]"
      @changed="refresh"
    />
  </div>
</template>
