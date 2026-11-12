<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

interface DonateParams { tx?: string; st?: string; amt?: string; cc?: string }
interface DonateSdk { Donation: { Button(options: Record<string, unknown>): { render(selector: string): void } } }
const props = defineProps<{ sessionId: string; charityName: string; pledgePence: number }>();
const emit = defineEmits<{ recorded: [] }>();
const router = useRouter();
const container = 'paypal-donate-button-container';
const available = ref(true);
const message = ref('');
const neutral = 'The donation could not be recorded here. Your report is unchanged.';
const sdkUrl = 'https://www.paypalobjects.com/donate/sdk/donate-sdk.js';

function loadSdk() {
  return new Promise<DonateSdk>((resolve, reject) => {
    const existing = (window as unknown as { PayPal?: DonateSdk }).PayPal;
    if (existing?.Donation) { resolve(existing); return; }
    const script = document.createElement('script');
    script.src = sdkUrl; script.async = true; script.charset = 'UTF-8';
    script.onload = () => resolve((window as unknown as { PayPal: DonateSdk }).PayPal);
    script.onerror = () => reject(new Error('The Donate SDK could not load'));
    document.head.append(script);
  });
}
// The pop-up's completion callback is the only signal the SDK gives. It is posted to the API, which writes a donation
// row and nothing else, so no sales figure can move. A failure leaves the report as it was.
async function complete(params: DonateParams) {
  try {
    const response = await fetch('/api/owner/closing/donation', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId, transactionId: params.tx ?? '', status: params.st ?? '', amount: params.amt ?? '', currency: params.cc ?? '' }),
    });
    if (response.status === 401) { await router.replace('/owner/login'); return; }
    if (!response.ok) throw new Error(`Donation not recorded: ${response.status}`);
    message.value = '';
    emit('recorded');
  } catch (error) {
    console.error('Donation could not be recorded', error);
    message.value = neutral;
  }
}
onMounted(async () => {
  try {
    const config = await fetch('/api/config').then(response => { if (!response.ok) throw new Error('Config unavailable'); return response.json() as Promise<{ donateButtonId?: string | null }> });
    if (!config.donateButtonId) { available.value = false; return; }
    const sdk = await loadSdk();
    sdk.Donation.Button({
      env: 'sandbox', hosted_button_id: config.donateButtonId, item_name: props.charityName,
      amount: (props.pledgePence / 100).toFixed(2), currency_code: 'GBP',
      image: { src: 'https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif', title: 'Donate with PayPal', alt: 'Donate with PayPal' },
      onComplete: (params: DonateParams) => { void complete(params); },
    }).render(`#${container}`);
  } catch (error) {
    console.error('Donate button could not load', error);
    available.value = false;
    message.value = 'The Donate button could not load. Your report is unchanged.';
  }
});
</script>

<template>
  <div>
    <div v-show="available" :id="container" data-test="donate-button"></div>
    <p v-if="!available && !message" role="status">The Donate button is not set up on this server. The pledge above still stands.</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="available" class="note">Closing the PayPal pop-up without donating changes nothing here.</p>
  </div>
</template>

<style scoped>
.note { font-size: var(--text-small); }
</style>
