// Keep errors readable without importing any brain runtime code.
export const describe = (e: unknown): string => e instanceof Error ? e.message : String(e);
