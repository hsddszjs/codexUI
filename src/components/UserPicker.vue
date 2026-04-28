<!--
  首次访问的用户选择页(纯遮罩层,选完写 cookie 然后整页 reload).
  用户配置由后端 /codex-api/users 给出.
-->
<template>
  <div class="user-picker-overlay">
    <div class="user-picker-card">
      <h2 class="user-picker-title">选择你的身份</h2>
      <p class="user-picker-subtitle">每个用户对应一个独立容器,所有人共享 session 视图</p>

      <div v-if="loading" class="user-picker-loading">加载中…</div>
      <div v-else-if="error" class="user-picker-error">{{ error }}</div>
      <div v-else class="user-picker-grid">
        <button
          v-for="u in users"
          :key="u.name"
          class="user-picker-item"
          :class="{ 'is-busy': busy === u.name }"
          :disabled="busy !== null"
          @click="select(u.name)"
        >
          <span class="user-picker-name">{{ u.display }}</span>
          <span class="user-picker-handle">{{ u.name }}</span>
        </button>
      </div>

      <p class="user-picker-hint">想换人:打开浏览器开发者工具,删除名为 <code>codexui_user</code> 的 cookie 后刷新</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

type UserRow = { name: string; display: string }

const users = ref<UserRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref<string | null>(null)

const emit = defineEmits<{ (e: 'selected', userName: string): void }>()

async function fetchUsers(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const r = await fetch('/codex-api/users', { credentials: 'same-origin' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = (await r.json()) as { users: UserRow[] }
    users.value = Array.isArray(j.users) ? j.users : []
  } catch (e) {
    error.value = (e as Error).message ?? 'failed to load users'
  } finally {
    loading.value = false
  }
}

async function select(userName: string): Promise<void> {
  busy.value = userName
  try {
    const r = await fetch('/codex-api/auth/select-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ userName }),
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`HTTP ${r.status} ${t}`)
    }
    emit('selected', userName)
  } catch (e) {
    error.value = (e as Error).message ?? 'select failed'
    busy.value = null
  }
}

onMounted(fetchUsers)
</script>

<style scoped>
@reference "tailwindcss";

.user-picker-overlay {
  @apply fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm;
}

.user-picker-card {
  @apply w-full max-w-2xl rounded-xl bg-white shadow-2xl p-6 sm:p-8;
}

.user-picker-title {
  @apply m-0 text-xl font-semibold text-slate-900;
}

.user-picker-subtitle {
  @apply mt-1 mb-5 text-sm text-slate-500;
}

.user-picker-loading,
.user-picker-error {
  @apply rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500;
}

.user-picker-error {
  @apply border-rose-300 text-rose-600;
}

.user-picker-grid {
  @apply grid grid-cols-1 sm:grid-cols-2 gap-3;
}

.user-picker-item {
  @apply flex flex-col gap-1 rounded-lg border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-slate-400 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60;
}

.user-picker-item.is-busy {
  @apply ring-2 ring-blue-400;
}

.user-picker-name {
  @apply text-base font-semibold text-slate-900;
}

.user-picker-handle {
  @apply text-xs font-mono text-slate-500;
}

.user-picker-hint {
  @apply mt-5 text-xs text-slate-400;
}

.user-picker-hint code {
  @apply rounded bg-slate-100 px-1 py-0.5 font-mono text-slate-600;
}
</style>
