<script setup lang="ts">
defineProps<{ kind: string }>();
const drawings: Record<string, string> = {
  lamp: 'M65 125h70M100 125V70M70 70h60L115 35H85Z',
  mirror: 'M100 25a48 48 0 1 0 0 96a48 48 0 1 0 0-96M75 55l30-15M80 75l45-20',
  camera: 'M45 55h110v65H45ZM65 55l8-18h30l8 18M115 87a22 22 0 1 0-44 0a22 22 0 1 0 44 0M130 68h12',
  books: 'M48 40h25v85H48ZM78 30h25v95H78ZM110 42l22-5 19 83-22 5ZM52 55h17M82 45h17',
  pot: 'M55 60h90v15H55ZM65 75l10 55h50l10-55M90 60V30M90 45Q65 45 65 25Q90 25 90 45M90 50q30 0 30-25q-30 0-30 25',
  records: 'M100 25a50 50 0 1 0 0 100a50 50 0 1 0 0-100M100 60a15 15 0 1 0 0 30a15 15 0 1 0 0-30M100 73v4M65 75a35 35 0 0 1 35-35',
  stool: 'M55 65h90v15H55ZM65 80l-8 50M135 80l8 50M65 110h70M75 65V40h50v25',
  vase: 'M85 30h30v25q35 55 10 70H75q-25-15 10-70ZM80 90h40',
  basket: 'M45 70h110l-15 55H60ZM70 70V55a30 30 0 0 1 60 0v15M60 90h80M65 110h70M80 75v45M100 75v45M120 75v45',
  clock: 'M100 25a50 50 0 1 0 0 100a50 50 0 1 0 0-100M100 40v8M100 102v8M65 75h8M127 75h8M100 53v22l20 12',
  'watering-can': 'M70 65h65v60H70ZM135 70q40-30 35 10q-5 25-35 20M70 85L35 50l-10 10 45 55M85 65V45h35v20',
  mugs: 'M35 55h50v65H35ZM85 65q30-5 25 20q0 15-25 15M115 45h45v65h-45M160 55q28-5 25 20q0 15-25 15',
};
</script>
<template>
  <svg class="item-illustration" viewBox="0 0 200 150" role="img" aria-label="Plain illustration, not a photograph">
    <path :d="drawings[kind] || drawings.books" />
  </svg>
</template>
<style scoped>
.item-illustration { display: block; width: 100%; max-height: 180px; background: var(--art-bg); border-radius: 10px; }
path { fill: var(--card); stroke: var(--muted); stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
</style>
