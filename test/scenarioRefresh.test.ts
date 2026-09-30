import { describe, expect, it, vi } from 'vitest';
import { ScenarioTestController } from '../src/extension/testing/scenarioTestController';

vi.mock('vscode', () => ({ l10n: { t: (value: string) => value } }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function refreshFixture(discover: () => Promise<void>): ScenarioTestController {
  // Isolate discovery scheduling from the Extension Host APIs covered by the
  // integration suite; no controller constructor or filesystem is needed.
  const controller = Object.create(ScenarioTestController.prototype) as ScenarioTestController;
  vi.spyOn(controller as unknown as { discover(): Promise<void> }, 'discover').mockImplementation(discover);
  return controller;
}

describe('test discovery refresh scheduling', () => {
  it('does not drop source changes arriving during an active discovery', async () => {
    const first = deferred();
    const second = deferred();
    const discover = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = refreshFixture(discover);
    const initial = controller.refresh();
    await Promise.resolve();
    expect(discover).toHaveBeenCalledTimes(1);
    const changed = controller.refresh();
    const changedAgain = controller.refresh();
    expect(changed).toBe(initial);
    expect(changedAgain).toBe(initial);
    let settled = false;
    void changed.then(() => { settled = true; });
    first.resolve();
    await Promise.resolve();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    second.resolve();
    await Promise.all([initial, changed, changedAgain]);
    expect(settled).toBe(true);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('recovers after a failed discovery and processes the next request', async () => {
    const discover = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Mock discovery failure'))
      .mockResolvedValueOnce(undefined);
    const controller = refreshFixture(discover);
    await expect(controller.refresh()).rejects.toThrow('Mock discovery failure');
    await expect(controller.refresh()).resolves.toBeUndefined();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('runs a fresh discovery for a request after the previous one finished', async () => {
    const discover = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const controller = refreshFixture(discover);
    await controller.refresh();
    await controller.refresh();
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
