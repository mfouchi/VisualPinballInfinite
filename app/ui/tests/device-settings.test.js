import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import Screens from '../src/lib/Screens.svelte';
import Sound from '../src/lib/Sound.svelte';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let target;
let component;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockClear();
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
});

function show(Page) {
  flushSync(() => { component = mount(Page, { target }); });
}

function screensView(names) {
  const screenId = (name, i) => names.filter((n) => n === name).length > 1 ? `vpi-display:${i * 1920},0:${name}` : name;
  return {
    screens: names.map((name, i) => ({
      number: i + 1, name, id: screenId(name, i), x: i * 1920, y: 0, width: 1920, height: 1080,
      density: 1, scale: 100, refresh: 60, sizeCm: null, hdr: false, primary: i === 0,
    })),
    settings: {
      windows: ['playfield', 'backglass', 'scoreView', 'topper'].map((id, i) => ({
        id, screen: screenId(names[0], 0), output: i === 0 ? 'window' : 'off',
        fullscreen: true, x: 0, y: 0, width: 1920, height: 1080,
      })),
      view: 'desktop', floatingScore: true, backglassDmd: 'off', scorePanelDmd: 'auto',
      showGrill: false, frames: 'default', maxFramerate: null,
    },
    missing: {}, set: [], file: 'Settings.ini', exists: false,
  };
}

describe('Screens settings', () => {
  it.each([
    ['different monitor names', ['Playfield monitor', 'Backglass monitor']],
    ['identical monitor names', ['Identical monitor', 'Identical monitor']],
  ])('loads the map and screen picker with %s', async (_label, names) => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'screens_view') return screensView(names);
      if (command === 'screen_presets') return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    show(Screens);

    await vi.waitFor(() => expect(target.querySelectorAll('.map .screen')).toHaveLength(2));
    expect(target.textContent).not.toContain('Looking at your screens');
    expect(target.querySelector('.problem')).toBeNull();

    flushSync(() => target.querySelector('.card-head').click());
    const picker = target.querySelector('.card select');
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      `1: ${names[0]}`, `2: ${names[1]}`,
    ]);
    expect([...picker.options].map((o) => o.value)).toEqual(screensView(names).screens.map((s) => s.id));
  });

  it('drags the playfield between identically named monitors and saves the second screen', async () => {
    const view = screensView(['Identical monitor', 'Identical monitor']);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'screens_view') return view;
      if (command === 'screen_presets') return [];
    });
    show(Screens);
    await vi.waitFor(() => expect(target.querySelectorAll('.map .screen')).toHaveLength(2));
    Object.defineProperty(target.querySelector('.map'), 'clientWidth', { value: 768 });
    const playfield = target.querySelector('.win');
    playfield.setPointerCapture = vi.fn();
    const pointer = (type, x) => Object.assign(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 100 }), { pointerId: 1 });
    flushSync(() => playfield.dispatchEvent(pointer('pointerdown', 100)));
    flushSync(() => playfield.dispatchEvent(pointer('pointermove', 500)));
    flushSync(() => playfield.dispatchEvent(pointer('pointerup', 500)));
    expect(playfield.style.left).toBe('50%');
    target.querySelector('button.save').click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('save_screens', {
      table: null,
      settings: expect.objectContaining({ windows: expect.arrayContaining([
        expect.objectContaining({ id: 'playfield', screen: view.screens[1].id }),
      ]) }),
    }));
  });

  it.each(['page', 'stand-in', 'cancel'])('finishes arranging from %s and persists only Done', async (from) => {
    const view = screensView(['Identical monitor', 'Identical monitor']);
    let keptSettings = structuredClone(view.settings);
    const moved = structuredClone(view.settings.windows);
    Object.assign(moved[0], { screen: view.screens[1].id, fullscreen: false, x: 120, y: 80, width: 800, height: 600 });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'screens_view') return { ...view, settings: structuredClone(keptSettings) };
      if (command === 'screen_presets') return [];
      if (command === 'arranged_windows') return moved;
      if (command === 'save_screens') keptSettings = structuredClone(args.settings);
    });
    show(Screens);
    await vi.waitFor(() => expect(target.querySelectorAll('.map .screen')).toHaveLength(2));
    [...target.querySelectorAll('button')].find((b) => b.textContent === 'Arrange on your screens').click();
    await vi.waitFor(() => expect(target.querySelector('.arranging')).not.toBeNull());
    if (from === 'stand-in') {
      const listener = vi.mocked(listen).mock.calls.find(([name]) => name === 'arrange-finish')[1];
      await listener({ payload: { keep: true } });
    } else {
      [...target.querySelectorAll('.arranging button')].find((b) => b.textContent === (from === 'cancel' ? 'Cancel' : 'Done')).click();
    }
    await vi.waitFor(() => expect(target.querySelector('.arranging')).toBeNull());
    if (from === 'cancel') {
      expect(invoke).toHaveBeenCalledWith('cancel_arranging');
      expect(keptSettings.windows).toEqual(view.settings.windows);
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'save_screens')).toBe(false);
    } else {
      await vi.waitFor(() => expect(keptSettings.windows).toEqual(moved));
      await unmount(component);
      show(Screens);
      await vi.waitFor(() => expect(target.querySelector('.win')?.style.left).toBe('53.125%'));
      expect(target.querySelector('button.save').disabled).toBe(true);
    }
  });
});

describe('Sound settings', () => {
  it.each([null, 'Disconnected speakers'])('loads duplicate output names and keeps the saved output %s', async (savedOutput) => {
    vi.mocked(invoke).mockResolvedValue({
      outputs: [
        { name: 'Monitor audio', channels: 2 },
        { name: 'Speakers', channels: 6 },
        { name: 'Monitor audio', channels: 8 },
      ],
      defaultChannels: 2,
      settings: {
        playfieldOutput: savedOutput, backglassOutput: 'Monitor audio', layout: 0,
        playfieldVolume: 100, backglassVolume: 100, pupVolume: 100, altsound: true,
        achievementSound: true, achievementVolume: 100,
      },
      file: 'Settings.ini', exists: false,
    });
    show(Sound);

    await vi.waitFor(() => expect(target.querySelectorAll('select')).toHaveLength(2));
    expect(target.textContent).not.toContain('Looking at your sound outputs');
    expect(target.querySelector('.problem')).toBeNull();
    const [playfield, backglass] = target.querySelectorAll('select');
    expect([...playfield.options].map((o) => o.value)).toEqual([
      '', 'Monitor audio', 'Speakers', ...(savedOutput ? [savedOutput] : []),
    ]);
    expect(playfield.value).toBe(savedOutput || '');
    expect(backglass.value).toBe('Monitor audio');
    expect(backglass.options[1].textContent).toBe('Monitor audio — stereo');

    flushSync(() => {
      playfield.value = 'Speakers';
      playfield.dispatchEvent(new Event('change', { bubbles: true }));
    });
    target.querySelector('button.save').click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('save_sound', {
      settings: expect.objectContaining({ playfieldOutput: 'Speakers', backglassOutput: 'Monitor audio' }),
    }));
  });
});
