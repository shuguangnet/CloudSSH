import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileShortcutsManager } from '../frontend/src/mobile-shortcuts-manager';
import { buildDefaultMobileShortcuts } from '../src/mobile-shortcuts-schema';

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

describe('MobileShortcutsManager', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('初始状态返回默认 20 个快捷键', () => {
    const manager = new MobileShortcutsManager();
    const defaults = buildDefaultMobileShortcuts().shortcuts;
    expect(manager.getShortcuts()).toEqual(defaults);
  });

  it('setLoggedIn(false) 清空本地缓存并恢复默认配置', () => {
    localStorage.setItem(
      'cloudssh_mobile_shortcuts_v1',
      JSON.stringify({ shortcuts: [{ id: 'f3' }] })
    );

    const manager = new MobileShortcutsManager();
    const listener = vi.fn();
    manager.onChange(listener);

    manager.setLoggedIn(false);
    expect(localStorage.getItem('cloudssh_mobile_shortcuts_v1')).toBeNull();
    expect(manager.getShortcuts()).toEqual(buildDefaultMobileShortcuts().shortcuts);
    expect(listener).toHaveBeenCalled();
  });

  it('setLoggedIn(true) 优先命中本地缓存镜像，随后向云端发起同步', async () => {
    const customList = [
      { id: 'escape', label: 'Esc', type: 'key' as const },
      { id: 'f3', label: 'F3', type: 'key' as const },
      { id: 'delete', label: 'Del', type: 'key' as const },
    ];
    localStorage.setItem(
      'cloudssh_mobile_shortcuts_v1',
      JSON.stringify({ shortcuts: customList })
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ shortcuts: customList }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new MobileShortcutsManager();
    const updates: Array<Array<{ id: string }>> = [];
    manager.onChange((shortcuts) => {
      updates.push(shortcuts.map((s) => ({ id: s.id })));
    });

    manager.setLoggedIn(true);

    // 同步读取到本地缓存
    expect(manager.getShortcuts().map((s) => s.id)).toEqual(['escape', 'f3', 'delete']);

    await manager.syncFromCloud();
    expect(fetchMock).toHaveBeenCalledWith('/api/user/mobile-shortcuts', { method: 'GET' });
  });

  it('云端返回 shortcuts: null 时恢复默认设置并清除本地缓存', async () => {
    const customList = [{ id: 'f3', label: 'F3', type: 'key' as const }];
    localStorage.setItem(
      'cloudssh_mobile_shortcuts_v1',
      JSON.stringify({ shortcuts: customList })
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ shortcuts: null }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const manager = new MobileShortcutsManager();
    manager.setLoggedIn(true);
    await manager.syncFromCloud();

    expect(localStorage.getItem('cloudssh_mobile_shortcuts_v1')).toBeNull();
    expect(manager.getShortcuts()).toEqual(buildDefaultMobileShortcuts().shortcuts);
  });
});
