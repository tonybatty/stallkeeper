<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const password = ref('');
const message = ref('');
const busy = ref(false);

function failureCopy(status: number) {
  if (status === 401) return 'That password does not open a stall.';
  if (status === 429) return 'Too many tries. Wait a few minutes and try again.';
  return 'Login is not working right now. Please try again.';
}

async function logIn() {
  busy.value = true;
  message.value = '';
  try {
    const response = await fetch('/api/owner/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (response.ok) await router.push('/owner');
    else message.value = failureCopy(response.status);
  } catch (error) {
    console.error('Owner login failed', error);
    message.value = failureCopy(0);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="page">
    <h1>Owner login</h1>
    <form class="login" @submit.prevent="logIn">
      <label>
        <span>Stall password</span>
        <input v-model="password" type="password" autocomplete="current-password" maxlength="200" required :disabled="busy">
      </label>
      <p v-if="message" class="error" role="alert">{{ message }}</p>
      <button class="btn" type="submit" :disabled="busy">Log in</button>
    </form>
  </main>
</template>

<style scoped>
.login { display: flex; flex-direction: column; gap: 16px; }
.error { margin: 0; color: var(--stop); font-size: var(--text-body); font-weight: 600; line-height: 1.4; }
</style>
