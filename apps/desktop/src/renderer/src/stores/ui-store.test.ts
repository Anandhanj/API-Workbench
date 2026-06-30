import { beforeEach, describe, expect, it } from 'vitest';
import { FONT_SCALE_MAX, FONT_SCALE_MIN, useUiStore } from './ui-store';

describe('ui-store font scale', () => {
  beforeEach(() => {
    useUiStore.getState().setFontScale(1);
  });

  it('clamps within bounds and rounds to one decimal', () => {
    useUiStore.getState().setFontScale(5);
    expect(useUiStore.getState().fontScale).toBe(FONT_SCALE_MAX);

    useUiStore.getState().setFontScale(0.1);
    expect(useUiStore.getState().fontScale).toBe(FONT_SCALE_MIN);

    useUiStore.getState().setFontScale(1.234);
    expect(useUiStore.getState().fontScale).toBeCloseTo(1.2);
  });

  it('increases and decreases by one step, clamped at the bounds', () => {
    useUiStore.getState().setFontScale(1);
    useUiStore.getState().increaseFontScale();
    expect(useUiStore.getState().fontScale).toBeCloseTo(1.1);

    useUiStore.getState().setFontScale(FONT_SCALE_MAX);
    useUiStore.getState().increaseFontScale();
    expect(useUiStore.getState().fontScale).toBe(FONT_SCALE_MAX);

    useUiStore.getState().setFontScale(FONT_SCALE_MIN);
    useUiStore.getState().decreaseFontScale();
    expect(useUiStore.getState().fontScale).toBe(FONT_SCALE_MIN);
  });

  it('resets to the default of 1', () => {
    useUiStore.getState().setFontScale(1.4);
    useUiStore.getState().resetFontScale();
    expect(useUiStore.getState().fontScale).toBe(1);
  });

  it('persists the font scale to localStorage', () => {
    useUiStore.getState().setFontScale(1.3);
    const raw = localStorage.getItem('awb.ui');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.fontScale).toBe(1.3);
  });
});
