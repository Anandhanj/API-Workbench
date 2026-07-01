import { invoke, isBridgeAvailable } from './ipc';

/**
 * Renderer-wide error capture.
 *
 * React render faults are already caught by the top-level ErrorBoundary; this
 * covers everything the boundary can't see — errors thrown in event handlers,
 * timers, and async code, plus unhandled promise rejections. Each is forwarded
 * to the main process via `dispatch.emit`, where it lands in the unified log
 * (and the on-disk debug file) alongside main-process events.
 *
 * Reporting is best-effort and self-protecting: it no-ops without the Electron
 * bridge and swallows its own failures so logging can never trigger more errors.
 */

let installed = false;

function report(source: string, message: string, context: Record<string, unknown>): void {
  if (!isBridgeAvailable()) return;
  void invoke('dispatch.emit', { level: 'error', source, message, context }).catch(
    () => undefined,
  );
}

export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    const error = event.error instanceof Error ? event.error : undefined;
    report('window.error', error?.message ?? event.message ?? 'Unknown error', {
      stack: error?.stack,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : undefined;
    report('unhandledrejection', error?.message ?? String(reason), { stack: error?.stack });
  });
}
