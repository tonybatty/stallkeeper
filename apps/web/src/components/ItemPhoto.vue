<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{ src: string | null; name: string }>();
const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });
</script>
<template>
  <img v-if="src && !failed" class="item-photo" :src="src" :alt="name" @error="failed = true">
  <div v-else class="item-photo photo-placeholder">No photo added</div>
</template>
