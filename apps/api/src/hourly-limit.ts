/**
 * Admits at most `perHour` calls for each key in any rolling hour.
 * Held in memory because the service runs as one instance (ADR 0007), so a restart clears it.
 */
export function hourlyLimit(perHour: number, now: () => Date) {
  const admitted = new Map<string, number[]>();
  return {
    allow(key: string) {
      const time = now().getTime();
      const recent = (admitted.get(key) ?? []).filter(at => at > time - 3_600_000);
      const allowed = recent.length < perHour;
      admitted.set(key, allowed ? [...recent, time] : recent);
      return allowed;
    },
    giveBack(key: string) { admitted.get(key)?.pop(); },
    clear(key: string) { admitted.delete(key); },
  };
}
