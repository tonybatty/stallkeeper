// Smooth scrolling is motion, so a buyer who asked their device to reduce motion gets a jump instead.
export const scrollBehavior = (): ScrollBehavior => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
