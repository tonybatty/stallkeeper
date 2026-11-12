<script setup lang="ts">
import { ref } from 'vue';
import type { Take } from '../items.js';
// The limit the server enforces, counted the same way (code points).
const MAX_CHARACTERS = 280;
const props = defineProps<{ code: string; itemName: string; take: Take | null }>();
const emit = defineEmits<{ taken: [value: Take]; refused: [reason: string] }>();
const message = ref('');
const busy = ref(false);
const error = ref('');
const characters = () => [...message.value].length;
async function takeIt(): Promise<Take> {
  if (props.take) return props.take;
  busy.value = true; error.value = '';
  try {
    const response = await fetch(`/api/i/${encodeURIComponent(props.code)}/take`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000) });
    const data = await response.json().catch(() => ({})) as { take?: Take; error?: string };
    if (!response.ok || !data.take) {
      error.value = data.error ?? 'The item could not be taken. Refresh the page to check it.';
      emit('refused', error.value);
      throw new Error('Take refused');
    }
    emit('taken', data.take);
    return data.take;
  } catch (cause) {
    if (!error.value) error.value = 'The item could not be taken. Check your connection and try again.';
    throw cause;
  } finally { busy.value = false; }
}
// The message is sent after the take, from the same screen as the tip, and the server keeps the first one.
let sending: Promise<boolean> | null = null;
async function post(): Promise<boolean> {
  if (characters() > MAX_CHARACTERS) { error.value = `Keep your message to ${MAX_CHARACTERS} characters or fewer.`; return false; }
  busy.value = true; error.value = '';
  try {
    const response = await fetch(`/api/i/${encodeURIComponent(props.code)}/take/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: message.value }), signal: AbortSignal.timeout(20_000) });
    const data = await response.json().catch(() => ({})) as { take?: Take; error?: string };
    if (!response.ok || !data.take) { error.value = data.error ?? 'Your message could not be sent. Try again.'; return false; }
    emit('taken', data.take);
    return true;
  } catch {
    error.value = 'Your message could not be sent. Check your connection and try again.';
    return false;
  } finally { busy.value = false; }
}
// False only when a typed message is still unsent. Callers that arrive while a send is in flight share its result.
function sendMessage(): Promise<boolean> {
  if (props.take?.message || !message.value.trim()) return Promise.resolve(true);
  sending ??= post().finally(() => { sending = null; });
  return sending;
}
defineExpose({ sendMessage });
</script>
<template>
  <section class="card free-take" :class="{ taken: !!take }" tabindex="-1">
    <template v-if="!take">
      <h2>Free, take it</h2>
      <button class="btn" :disabled="busy" @click="takeIt().catch(() => undefined)">{{ busy ? 'Taking it…' : 'Take it' }}</button>
      <p class="muted">No payment. You can leave a message and a tip after.</p>
    </template>
    <template v-else>
      <h2>It's yours, take it</h2>
      <p>Take the {{ itemName }} with tag {{ code }}. The item itself was free.</p>
      <p v-if="take.message" role="status">Your message is with the stallholder.</p>
      <form v-else class="thanks" @submit.prevent="sendMessage">
        <label :for="`thanks-${code}`">A message for the stallholder, optional</label>
        <input :id="`thanks-${code}`" v-model="message" name="message" placeholder="Say thanks" :maxlength="MAX_CHARACTERS" autocomplete="off" :disabled="busy">
        <button class="btn sec" type="submit" :disabled="busy || !message.trim()">{{ busy ? 'Sending…' : 'Send message' }}</button>
      </form>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.free-take { margin-block: 1rem; }
.free-take:focus { outline: none; }
.card.free-take.taken { background: var(--ok-bg); }
.thanks { display: grid; gap: 0.5rem; }
.thanks label { font-weight: 700; }
input { width: 100%; box-sizing: border-box; }
</style>
