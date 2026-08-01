/**
 * Preloadが公開するAPIの範囲と、購読解除。
 *
 * ★electron を起動せずに検証する。ipcRenderer 相当を差し替えているため。
 */

import { describe, expect, it, vi } from 'vitest';

import { IPC } from '../shared/ipc.ts';
import { ALLOWED_API_KEYS, createDesktopApi, type IpcBridge } from './api.ts';

function createFakeIpc() {
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
  const invoked: { channel: string; args: unknown[] }[] = [];

  const bridge: IpcBridge = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args });
      return { ok: true };
    }),
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(listener);
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
  };

  return {
    bridge,
    invoked,
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) {
        // 実際の ipcRenderer は第1引数に IpcRendererEvent を渡す。
        listener({ sender: 'ipcRenderer-internal' }, payload);
      }
    },
  };
}

describe('公開APIの範囲', () => {
  it('★許可したキーだけを公開する', () => {
    const { bridge } = createFakeIpc();
    const api = createDesktopApi(bridge);
    expect(Object.keys(api).sort()).toEqual([...ALLOWED_API_KEYS].sort());
  });

  it('★ipcRenderer / fs / child_process を公開しない', () => {
    const { bridge } = createFakeIpc();
    const api = createDesktopApi(bridge) as unknown as Record<string, unknown>;
    for (const forbidden of [
      'ipcRenderer',
      'ipc',
      'fs',
      'child_process',
      'require',
      'exec',
      'send',
      'invoke',
      'on',
      'removeListener',
      'readFile',
      'writeFile',
      'apiKey',
    ]) {
      expect(api[forbidden]).toBeUndefined();
    }
  });

  it('★チャンネル名をRendererから指定させない（固定のチャンネルだけを叩く）', async () => {
    const { bridge, invoked } = createFakeIpc();
    const api = createDesktopApi(bridge);

    await api.selectProject();
    await api.cancelPipeline('run-1');

    expect(invoked.map((i) => i.channel)).toEqual([
      IPC.selectProject,
      IPC.cancelPipeline,
    ]);
    // selectProject は引数を取らない＝任意の値を渡せない
    expect(invoked[0]?.args).toEqual([]);
  });

  it('各メソッドが対応するチャンネルへ invoke する', async () => {
    const { bridge, invoked } = createFakeIpc();
    const api = createDesktopApi(bridge);

    await api.readProjectSummary('/tmp/ep012');
    await api.startPipeline({ projectPath: '/tmp/ep012' });
    await api.openProjectFolder('/tmp/ep012');

    expect(invoked.map((i) => i.channel)).toEqual([
      IPC.readProjectSummary,
      IPC.startPipeline,
      IPC.openProjectFolder,
    ]);
  });
});

describe('イベント購読', () => {
  it('進捗イベントのpayloadだけをリスナーに渡す（IpcRendererEventを渡さない）', () => {
    const { bridge, emit } = createFakeIpc();
    const api = createDesktopApi(bridge);
    const received: unknown[] = [];

    api.onPipelineProgress((event) => received.push(event));
    emit(IPC.pipelineProgress, { runId: 'run-1', stepId: 'transcribe' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ runId: 'run-1', stepId: 'transcribe' });
    // sender が漏れていないこと
    expect(JSON.stringify(received[0])).not.toContain('ipcRenderer-internal');
  });

  it('★onPipelineProgress の解除関数で購読が外れる', () => {
    const { bridge, emit, listenerCount } = createFakeIpc();
    const api = createDesktopApi(bridge);
    const received: unknown[] = [];

    const off = api.onPipelineProgress((event) => received.push(event));
    expect(listenerCount(IPC.pipelineProgress)).toBe(1);

    emit(IPC.pipelineProgress, { runId: 'run-1' });
    off();

    expect(listenerCount(IPC.pipelineProgress)).toBe(0);
    emit(IPC.pipelineProgress, { runId: 'run-2' });
    expect(received).toHaveLength(1);
  });

  it('★onPipelineFinished の解除関数で購読が外れる', () => {
    const { bridge, emit, listenerCount } = createFakeIpc();
    const api = createDesktopApi(bridge);
    const received: unknown[] = [];

    const off = api.onPipelineFinished((event) => received.push(event));
    emit(IPC.pipelineFinished, { runId: 'run-1' });
    off();
    emit(IPC.pipelineFinished, { runId: 'run-2' });

    expect(received).toHaveLength(1);
    expect(listenerCount(IPC.pipelineFinished)).toBe(0);
  });

  it('複数購読しても、解除したものだけが外れる', () => {
    const { bridge, emit, listenerCount } = createFakeIpc();
    const api = createDesktopApi(bridge);
    const a: unknown[] = [];
    const b: unknown[] = [];

    const offA = api.onPipelineProgress((e) => a.push(e));
    api.onPipelineProgress((e) => b.push(e));
    offA();
    emit(IPC.pipelineProgress, { runId: 'run-1' });

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
    expect(listenerCount(IPC.pipelineProgress)).toBe(1);
  });
});
