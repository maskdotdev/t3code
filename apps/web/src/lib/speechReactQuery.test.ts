import { describe, expect, it, vi } from "vitest";

const getConfigMock = vi.fn();

vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({
    speech: {
      getConfig: getConfigMock,
    },
  }),
}));

describe("speechReactQuery", () => {
  it("builds stable query keys", async () => {
    const { speechQueryKeys } = await import("./speechReactQuery");

    expect(speechQueryKeys.all).toEqual(["speech"]);
    expect(speechQueryKeys.config()).toEqual(["speech", "config"]);
  });

  it("loads speech config through the native API", async () => {
    const snapshot = {
      configPath: "/tmp/speech-to-text.json",
      settings: {
        version: 1,
        defaultProvider: "local-http",
        providers: {
          "local-http": {
            enabled: true,
            baseUrl: "http://127.0.0.1:8177",
            apiKey: "",
            model: "",
          },
          elevenlabs: {
            enabled: false,
            apiKey: "",
            modelId: "scribe_v2_realtime",
            languageCode: "",
          },
          gemini: {
            enabled: false,
            apiKey: "",
            model: "gemini-3-flash-preview",
          },
        },
      },
      issues: [],
      providers: [],
    };
    getConfigMock.mockResolvedValueOnce(snapshot);

    const { speechConfigQueryOptions, speechQueryKeys } = await import("./speechReactQuery");
    const options = speechConfigQueryOptions();

    expect(options.queryKey).toEqual(speechQueryKeys.config());
    await expect(
      options.queryFn?.({
        queryKey: speechQueryKeys.config(),
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual(snapshot);
    expect(getConfigMock).toHaveBeenCalledTimes(1);
  });
});
