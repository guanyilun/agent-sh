export default function activate(ctx: unknown): void;
export function probeBwrap(bwrap: string): { ok: boolean; reason?: string };
export function probeLandlock(python: string): { ok: boolean; reason?: string };
