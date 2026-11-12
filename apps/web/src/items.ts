// The greeting is one line so the buyer reaches the composer at once. The rules sit in the About fold beneath it.
export const greetingLine = "I'm Stallkeeper, looking after this stall.";
export const aboutLine = "I answer from the stallholder's notes. Offers are checked against the stallholder's rules, and you choose whether to pay in PayPal.";
export const openingLine = `${greetingLine} ${aboutLine}`;
export interface ChatMessage { role: 'You' | 'Stallkeeper'; content: string }
// The server stores roles as the model sees them; the page labels them for the buyer.
export const restoreTranscript = (messages: { role: 'user' | 'assistant'; content: string }[] = []): ChatMessage[] =>
  messages.map(({ role, content }) => ({ role: role === 'user' ? 'You' : 'Stallkeeper', content }));
export interface PublicItem {
  photoUrl: string | null;
  code: string; name: string; notes: string;
  // For a pay-what-you-want or free item the figure is the owner's own expected amount or tip. The server never sends it to a buyer, so askingPence is null there, and the owner may leave it empty.
  mode: 'fixed' | 'haggle' | 'pwyw' | 'free'; askingPence: number | null; minimumPence: number | null; seeded: boolean; illustration?: string | null;
}
export interface RetailReference { pricePence: number; retailer: string; url: string; checkedAt: string }
// Only the owner's API sends the listing details. Buyer pages get the price line alone.
export interface OwnerRetailReference extends RetailReference { description: string; facts: string[]; doubtful: boolean }
export interface OwnerItem extends PublicItem { id: string; priceVersion: number; floorPence: number | null; priceDrops: boolean; views?: number; seededViews?: number; status: string; removedReason: string | null; retailReference: OwnerRetailReference | null; retailLookupFailed?: boolean; soldPence?: number | null }
interface RetailOffer { retailer: string; url: string; pricePence: number; condition: 'new' | 'used' | null }
export interface RetailCandidate { productId: string; title: string; checkedAt: string; offers: RetailOffer[]; reference: OwnerRetailReference | null; suggestion: { askingPence: number; floorPence: number } | null; missingWords: string[] }
export interface PriceDrop { id: string; name: string; code: string; seeded: boolean; oldPence: number; newPence: number; reason: string; at: string }
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' });
// Pounds typed by a person, such as "12" or "12.5", as whole pence. Null when it is not an amount of money.
export function parsePence(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [pounds = '', pennies = ''] = value.trim().split('.');
  const amount = Number(pounds) * 100 + Number(pennies.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}
export const money = (pence: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: pence % 100 ? 2 : 0 }).format(pence / 100);

export interface Checkout {
  checkoutId: string; state: 'creating' | 'awaiting_approval' | 'capturing' | 'checking' | 'paid' | 'expired' | 'cancelled' | 'failed';
  paypalOrderId: string | null; reservedUntil: string; totalPence: number; reviewRequired: boolean; approvedAt?: string | null; kind?: 'sale' | 'tip'; tipRefunded?: boolean;
}
// The buyer's own take of a free item, with the thank-you message they left.
export interface Take { takenAt: string; message: string | null }
export const holdsItem = (checkout: Checkout) => checkout.reviewRequired || !['cancelled', 'expired', 'failed'].includes(checkout.state);
export const agreedNotice = (pence: number) => `Agreed price ${money(pence)}. Not paid yet. Leave it here until payment is confirmed.`;
export const offerNotice = (card: OfferCard) => `Stallkeeper's offer: ${money(card.totalPence)} for ${card.itemName}.`;
export interface OfferCard {
  id: string; itemName: string; code: string; totalPence: number; expiresAt: string;
  kind: 'counter' | 'accept'; note: string;
}
