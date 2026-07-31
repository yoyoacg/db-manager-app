<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ConfigEditor from './ConfigEditor.vue'

const api = (window as any).dbapi

const props = defineProps<{
  service: any
  status: any
  progress?: any
}>()

const emit = defineEmits<{ (e: 'changed'): void }>()

const selectedVersion = ref('')
const remoteVersions = ref<{ version: string; url: string }[]>([])
const remoteLoaded = ref(false)
const remoteError = ref('')
const downloadVersion = ref('')
const manualVersion = ref('')
const importing = ref(false)
const busy = ref(false)
const error = ref('')
const showConfig = ref(false)

watch(
  () => props.service.installed,
  (list: any[]) => {
    if (!selectedVersion.value && list?.length) selectedVersion.value = list[0].version
  },
  { immediate: true }
)

const running = computed(() => !!props.status?.running)
const selectedInstall = computed(() =>
  props.service.installed?.find((item: any) => item.version === selectedVersion.value)
)
const selectedExternal = computed(() => !!selectedInstall.value?.external)
const downloading = computed(
  () => props.progress && (props.progress.stage === 'downloading' || props.progress.stage === 'extracting')
)

async function doStart() {
  if (!selectedVersion.value) return
  busy.value = true
  error.value = ''
  try {
    await api.start(props.service.id, selectedVersion.value)
    emit('changed')
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
  busy.value = false
}

async function doStop() {
  busy.value = true
  error.value = ''
  try {
    await api.stop(props.service.id)
    emit('changed')
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
  busy.value = false
}

async function loadRemote() {
  remoteLoaded.value = false
  remoteError.value = ''
  try {
    remoteVersions.value = await api.remoteVersions(props.service.id)
    remoteLoaded.value = true
    if (remoteVersions.value.length && !downloadVersion.value) {
      downloadVersion.value = remoteVersions.value[0].version
    }
  } catch (e: any) {
    remoteError.value = e?.message || String(e)
    remoteLoaded.value = true
  }
}

async function doDownload() {
  if (!downloadVersion.value) return
  error.value = ''
  try {
    await api.download(props.service.id, downloadVersion.value)
    emit('changed')
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
}

function openDir(version?: string) {
  api.openDir(props.service.id, version)
}

async function doImportZip() {
  if (!manualVersion.value.trim()) return
  importing.value = true
  error.value = ''
  try {
    const r = await api.importZip(props.service.id, manualVersion.value.trim())
    if (!r?.canceled) {
      manualVersion.value = ''
      emit('changed')
    }
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
  importing.value = false
}

async function doAddExternal() {
  if (!manualVersion.value.trim()) return
  error.value = ''
  try {
    const r = await api.addExternal(props.service.id, manualVersion.value.trim())
    if (!r?.canceled) {
      manualVersion.value = ''
      emit('changed')
    }
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <span class="dot" :class="{ on: running }"></span>
      <span class="card-title">{{ service.displayName }}</span>
      <span v-if="service.connectionOnly" class="badge badge-remote">远程连接</span>
      <span v-else class="badge">端口 {{ status?.port ?? service.runtime?.port }}</span>
      <span v-if="running" class="badge badge-running">
        {{ status?.remote ? '可连接' : '运行中' }}
      </span>
    </div>

    <div v-if="service.description" class="card-desc">{{ service.description }}</div>

    <!-- 远程连接条目 -->
    <template v-if="service.connectionOnly">
      <div class="row">
        <label>服务器地址</label>
        <span class="remote-addr">
          {{ service.connection?.host }}:{{ service.connection?.port }}
        </span>
      </div>
    </template>

    <!-- 本地服务条目 -->
    <template v-else>
      <div class="row" v-if="service.installed?.length">
        <label>版本</label>
        <select v-model="selectedVersion" :disabled="running || busy">
          <option v-for="v in service.installed" :key="v.version" :value="v.version">
            {{ v.version }}{{ v.external ? '（外部目录）' : '' }}
          </option>
        </select>
        <button class="link" @click="openDir(selectedVersion)">目录</button>
        <button v-if="service.config && !selectedExternal" class="link" @click="showConfig = true">配置</button>
      </div>
      <div v-else class="empty-hint">尚未安装任何版本，可在下方下载或本地导入。</div>

      <div class="row connection-row">
        <label>连接地址</label>
        <span class="remote-addr">127.0.0.1:{{ status?.port ?? service.runtime?.port }}</span>
      </div>

      <div class="card-actions">
        <button
          class="btn btn-primary"
          :disabled="busy || running || !selectedVersion"
          @click="doStart"
        >
          启动
        </button>
        <button class="btn btn-danger" :disabled="busy || !running" @click="doStop">停止</button>
        <button class="btn" @click="openDir()">安装根目录</button>
      </div>

      <div class="download-area">
        <div class="row" v-if="!remoteLoaded">
          <button class="link" @click="loadRemote">获取可下载版本列表</button>
          <span v-if="remoteError" class="error-text">{{ remoteError }}</span>
        </div>
        <div class="row" v-else-if="remoteVersions.length">
          <label>下载</label>
          <select v-model="downloadVersion" :disabled="downloading">
            <option v-for="r in remoteVersions" :key="r.version" :value="r.version">
              {{ r.version }}
            </option>
          </select>
          <button class="btn" :disabled="downloading" @click="doDownload">
            {{ downloading ? '下载中…' : '下载' }}
          </button>
        </div>
        <div v-else class="empty-hint">描述符中暂无可用版本，可编辑 JSON 补充。</div>

        <div class="row">
          <label>本地导入</label>
          <input
            class="ver-input"
            v-model="manualVersion"
            placeholder="版本名，如 8.2.0"
            @keyup.enter="doImportZip"
          />
          <button class="btn" :disabled="!manualVersion.trim() || importing" @click="doImportZip">
            {{ importing ? '解压中…' : '导入 zip' }}
          </button>
          <button class="btn" :disabled="!manualVersion.trim()" @click="doAddExternal">
            登记目录
          </button>
        </div>

        <template v-if="progress && progress.stage !== 'done'">
          <div class="progress">
            <div class="progress-bar" :style="{ width: (progress.percent || 0) + '%' }"></div>
          </div>
          <div class="progress-text">
            {{
              progress.stage === 'extracting'
                ? '解压中…'
                : progress.stage === 'error'
                  ? '下载失败'
                  : `下载中 ${progress.percent}%（${(progress.received / 1048576).toFixed(1)} MB）`
            }}
          </div>
        </template>
      </div>
    </template>

    <div v-if="error" class="error-text">{{ error }}</div>

    <ConfigEditor
      v-if="showConfig"
      :service="service"
      :version="selectedVersion"
      :running="running"
      @close="showConfig = false"
    />
  </div>
</template>
