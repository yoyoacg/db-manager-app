<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const api = (window as any).dbapi

const props = defineProps<{
  service: any
  version: string
  running?: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const confPath = ref('')
const content = ref('')
const original = ref('')

const dirty = computed(() => content.value !== original.value)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await api.getConf(props.service.id, props.version)
    confPath.value = r.path
    content.value = r.content
    original.value = r.content
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
  loading.value = false
}

async function save() {
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    await api.saveConf(props.service.id, props.version, content.value)
    original.value = content.value
    notice.value = props.running ? '已保存，重启服务后生效' : '已保存'
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
  saving.value = false
}

async function resetToDefault() {
  if (!window.confirm('确定恢复为默认配置？当前修改将丢失。')) return
  error.value = ''
  notice.value = ''
  try {
    const r = await api.resetConf(props.service.id, props.version)
    content.value = r.content
    original.value = r.content
    notice.value = '已恢复默认配置'
  } catch (e: any) {
    error.value = e?.message || String(e)
  }
}

function onKeydown(e: KeyboardEvent) {
  // textarea 里 Tab 输入缩进而非切换焦点
  if (e.key === 'Tab') {
    e.preventDefault()
    const el = e.target as HTMLTextAreaElement
    const { selectionStart: s, selectionEnd: t, value } = el
    content.value = value.slice(0, s) + '\t' + value.slice(t)
    requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1))
  }
}

onMounted(load)
</script>

<template>
  <div class="conf-overlay" @click.self="emit('close')">
    <div class="conf-dialog">
      <div class="conf-header">
        <span class="conf-title">
          {{ service.displayName }} {{ version }} — {{ service.config?.file }}
        </span>
        <button class="link" @click="emit('close')">关闭</button>
      </div>

      <div v-if="confPath" class="conf-path" :title="confPath">{{ confPath }}</div>

      <div v-if="loading" class="conf-loading">加载中…</div>
      <textarea
        v-else
        v-model="content"
        class="conf-editor"
        spellcheck="false"
        @keydown="onKeydown"
      ></textarea>

      <div v-if="error" class="error-text">{{ error }}</div>

      <div class="conf-footer">
        <span class="conf-hint">
          <template v-if="running">服务运行中，保存后需重启生效。</template>
          <template v-else>修改保存后，下次启动生效。</template>
        </span>
        <span v-if="notice" class="conf-notice">{{ notice }}</span>
        <div class="conf-actions">
          <button class="btn" :disabled="loading" @click="resetToDefault">恢复默认</button>
          <button class="btn btn-primary" :disabled="loading || saving || !dirty" @click="save">
            {{ saving ? '保存中…' : dirty ? '保存' : '已保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
