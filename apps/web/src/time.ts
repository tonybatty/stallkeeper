// One format for times across the owner pages, so the live feed and the closing report read alike.
export const stamp = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// A time of day on the stall's clock, such as 13:30, for a buyer standing at the stall.
export const clockTime = (value: string) => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
