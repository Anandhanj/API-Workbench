import { afterEach, describe, expect, it, vi } from 'vitest';

const { invoke, isBridgeAvailable } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve({})),
  isBridgeAvailable: vi.fn(() => true),
}));

vi.mock('./ipc', () => ({ invoke, isBridgeAvailable }));

describe('installErrorReporting', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // Each test re-imports so the module-level `installed` guard starts fresh.
  async function install(): Promise<void> {
    const mod = await import('./error-reporting');
    mod.installErrorReporting();
  }

  it('reports uncaught errors via dispatch.emit', async () => {
    await install();
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', error: new Error('boom'), filename: 'a.js' }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'dispatch.emit',
      expect.objectContaining({ level: 'error', source: 'window.error', message: 'boom' }),
    );
  });

  it('reports unhandled promise rejections', async () => {
    await install();
    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new Error('nope') });
    window.dispatchEvent(event);
    expect(invoke).toHaveBeenCalledWith(
      'dispatch.emit',
      expect.objectContaining({ source: 'unhandledrejection', message: 'nope' }),
    );
  });

  it('does not emit when the bridge is unavailable', async () => {
    isBridgeAvailable.mockReturnValue(false);
    await install();
    window.dispatchEvent(new ErrorEvent('error', { message: 'x', error: new Error('x') }));
    expect(invoke).not.toHaveBeenCalled();
  });
});
