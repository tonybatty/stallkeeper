<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
interface Tag { code: string; name: string; seeded: boolean; qrPng: string; host: string; url: string }
const tags = ref<Tag[]>([]); const message = ref(''); const router = useRouter();
// Six to a sheet leaves each tag a QR code large enough to scan from arm's length, with the name and code in print a buyer can read.
const perSheet = 6;
const pages = computed(() => Array.from({ length: Math.ceil(tags.value.length / perSheet) }, (_, i) => tags.value.slice(i * perSheet, i * perSheet + perSheet)));
const print = () => window.print();
// The screen shows a two-up preview of the first tags. Print still lays out every tag, six to a sheet.
const previewCount = 6;
onMounted(async () => {
  try {
    const response = await fetch('/api/owner/tags');
    if (response.status === 401) { await router.replace('/owner/login'); return; }
    if (!response.ok) throw new Error(`Tags failed: ${response.status}`);
    const data = (await response.json()) as { stallName: string; tags: Tag[] };
    tags.value = data.tags;

    if (!tags.value.length) message.value = 'Add an item before printing tags.';
  } catch (error) { console.error('Tags could not load', error); message.value = 'Tags could not load. Refresh to try again.'; }
});
</script>
<template>
  <main class="print-page">
    <header class="page print-controls"><h1>Print tags</h1><button class="btn" :disabled="!tags.length" @click="print">Print {{ tags.length }} {{ tags.length === 1 ? 'tag' : 'tags' }}</button><p v-if="message" role="alert">{{ message }}</p></header>
    <section v-for="(page, index) in pages" :key="index" class="tag-sheet" :aria-label="`Sheet ${index + 1}`">
      <article v-for="(tag, at) in page" :key="tag.code" class="printed-tag" :class="{ 'beyond-preview': index * perSheet + at >= previewCount }">
        <h2 class="tag-name">{{ tag.name }}</h2>
        <img :src="tag.qrPng" :alt="`QR code for ${tag.name}, tag ${tag.code}`">
        <p class="tag-label">Tag <span class="tag-code">{{ tag.code }}</span></p>
      </article>
    </section>
    <p v-if="tags.length" class="page muted print-controls">No price on tags, so prices can change.</p>
  </main>
</template>
<style>
/* A plain white sheet, the same on screen and on paper: tags edge to edge in a grid, with dashed black cut lines between and around them. */
.tag-sheet { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(3, minmax(0, 1fr)); width: 190mm; height: 277mm; margin: 16px auto; }
/* Each cut line is drawn once, as two dash patterns on one edge would not line up. Every tag draws its top and left, the right column and the last tag close the right, and the last two tags close the bottom, so a part-filled sheet has no open edge and no line where there is no tag. */
.printed-tag { border: 0 dashed #000; border-width: 1px 0 0 1px; padding: 8mm; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5mm; overflow-wrap: anywhere; font-size: 9pt; line-height: 1.2; }
.printed-tag:nth-child(2n), .printed-tag:last-child { border-right-width: 1px; }
.printed-tag:nth-last-child(-n+2) { border-bottom-width: 1px; }
.printed-tag h2 { max-width: 100%; font-size: 15pt; line-height: 1.3; margin: 0; }
/* Two lines is the most a 92mm cell can spare beside the QR code, so an 80-character name clamps here and the code, on its own line below, always prints. */
.tag-name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; min-width: 0; }
.printed-tag p { margin: 0; }
/* Sized to fit the cell together, so nothing is squeezed: a shrunk name would cut its second line. */
.printed-tag > * { flex-shrink: 0; }
/* The issued PNG is a few hundred pixels wide, so it scales up with hard module edges rather than a blur. */
.printed-tag img { width: 46mm; height: 46mm; image-rendering: pixelated; }
.tag-label { font-size: 11pt; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.tag-label .tag-code { color: var(--ink); font-size: 22pt; letter-spacing: 0.1em; margin-left: 1.5mm; }
@media screen {
  /* The sheet sits in the same column as the heading and button, so every edge lines up as on the other owner pages. Each cell grows to fit its tag. */
  .tag-sheet { width: auto; max-width: var(--page-width); height: auto; margin: 0 auto; padding: 0 16px 12px; grid-template-rows: none; }
  .tag-sheet + .tag-sheet { padding-top: 0; }
  .printed-tag { padding: 20px 10px; gap: 8px; font-size: var(--text-small); line-height: 1.3; }
  .printed-tag h2 { padding-inline: 6px; font-size: var(--text-body); }
  .tag-name { display: block; overflow: visible; }
  .printed-tag img { width: 100%; max-width: 46mm; height: auto; aspect-ratio: 1; }
  .tag-label { font-size: var(--text-small); }
  .tag-label .tag-code { font-size: var(--text-heading); margin-left: 4px; }
  .beyond-preview { display: none; }
}
@page { size: A4; margin: 10mm; }
@media print { .app-titlebar, .print-controls { display: none !important; } .tag-sheet { margin: 0; break-after: page; break-inside: avoid; } .tag-sheet:last-of-type { break-after: auto; } }
</style>
