// Resets the published demo stall to fresh stock, signing in with the demo owner's password from /api/demo.
// Run it after the takes so judges find the stall as seeded. Usage: node tools/capture/reset-demo.ts <origin>

import { readDemo, Stall } from './stall.ts';

const origin = process.argv[2] ? new URL(process.argv[2]).origin : undefined;
if (!origin) {
  console.log('Usage: node tools/capture/reset-demo.ts <origin>');
  process.exit(1);
}
const stall = new Stall(origin);
await stall.login((await readDemo(origin)).ownerPassword);
await stall.resetDemo();
const { items, sessionStatus } = await stall.items();
console.log(`Demo stall reset: ${items.filter(item => item.status === 'available').length} items available, stall ${sessionStatus}.`);
