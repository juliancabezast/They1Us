// Shared motion vocabulary, so every moving thing in the app feels like one system.
export const spring = { type: "spring", stiffness: 380, damping: 32, mass: 0.9 } as const;
export const softSpring = { type: "spring", stiffness: 180, damping: 22 } as const;
export const bouncy = { type: "spring", stiffness: 520, damping: 16 } as const;
export const glide = [0.6, 0, 0.2, 1] as const;
