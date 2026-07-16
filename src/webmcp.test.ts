import { registerArkovaWebMcpOnPage, registerArkovaWebMcpTools, type ModelContext } from './webmcp';
import { describe, expect, it, vi } from 'vitest';

describe('Arkova WebMCP registration', () => {
  it('registers bounded, read-only navigation tools', async () => {
    const registered: Array<{ tool: Parameters<ModelContext['registerTool']>[0]; signal?: AbortSignal }> = [];
    const modelContext: ModelContext = {
      registerTool: vi.fn(async (tool, options) => {
        registered.push({ tool, signal: options?.signal });
      }),
    };
    const navigate = vi.fn();

    const controller = registerArkovaWebMcpTools(modelContext, navigate);

    expect(registered.map(entry => entry.tool.name)).toEqual([
      'search_arkova',
      'verify_arkova_record',
    ]);
    expect(registered.every(entry => entry.signal === controller.signal)).toBe(true);
    expect(registered.every(entry => entry.tool.annotations?.readOnlyHint === true)).toBe(true);

    await registered[0].tool.execute({ query: 'licensed nurses' });
    expect(navigate).toHaveBeenCalledWith('/search?q=licensed+nurses');

    await registered[1].tool.execute({ public_id: 'ARK-DOC-123' });
    expect(navigate).toHaveBeenCalledWith('/verify/ARK-DOC-123');
  });

  it('rejects malformed tool input instead of navigating', async () => {
    const tools: Array<Parameters<ModelContext['registerTool']>[0]> = [];
    const modelContext: ModelContext = {
      registerTool: vi.fn(async tool => { tools.push(tool); }),
    };
    const navigate = vi.fn();
    registerArkovaWebMcpTools(modelContext, navigate);

    await expect(tools[0].execute({ query: '' })).rejects.toThrow('query');
    await expect(tools[1].execute({ public_id: '../admin' })).rejects.toThrow('public_id');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('discovers the navigator WebMCP API used by the browser experiment', () => {
    const modelContext: ModelContext = { registerTool: vi.fn() };
    const targetNavigator = { modelContext } as unknown as Navigator;

    const controller = registerArkovaWebMcpOnPage(targetNavigator, document);

    expect(controller).toBeInstanceOf(AbortController);
    expect(modelContext.registerTool).toHaveBeenCalledTimes(2);
  });

  it('isolates synchronous throws and asynchronous rejections per registration', async () => {
    const registerTool = vi.fn()
      .mockImplementationOnce(() => { throw new Error('unsupported first tool'); })
      .mockRejectedValueOnce(new Error('rejected second tool'));
    const modelContext: ModelContext = { registerTool };

    expect(() => registerArkovaWebMcpTools(modelContext, vi.fn())).not.toThrow();
    expect(registerTool).toHaveBeenCalledTimes(2);

    // Allow the rejection handler attached by progressive registration to run.
    await Promise.resolve();
  });
});
