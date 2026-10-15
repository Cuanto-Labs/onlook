import type { SandboxService } from './sandboxes.js';

/** Every 60 s: stop containers idle > IDLE_MINUTES and persist pending activity. */
export function startReaper(service: SandboxService, intervalMs = 60_000): () => void {
    const timer = setInterval(() => {
        service.reapIdle().then(
            (stopped) => {
                for (const id of stopped) console.log(`[reaper] stopped idle sandbox ${id}`);
            },
            (e) => console.error('[reaper] failed:', e instanceof Error ? e.message : e),
        );
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
