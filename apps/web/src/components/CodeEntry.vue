<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
const code = ref('');
const router = useRouter();
function findItem() { void router.push(`/i/${encodeURIComponent(code.value.trim().toUpperCase())}`); }
</script>
<template>
  <form class="code-entry" @submit.prevent="findItem">
    <label for="tag-code">Tag code</label>
    <div class="row"><input id="tag-code" v-model="code" required minlength="4" maxlength="4" pattern="[A-Za-z0-9]{4}" placeholder="e.g. K7Q2" autocomplete="off" autocapitalize="characters" enterkeyhint="go"><button class="btn" type="submit">Find item</button></div>
  </form>
</template>
