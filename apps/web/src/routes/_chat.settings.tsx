import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { type ProviderKind, type SpeechToTextProviderKind, type SpeechToTextSettings } from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { EyeIcon, EyeOffIcon, ZapIcon } from "lucide-react";

import {
  APP_SERVICE_TIER_OPTIONS,
  MAX_CUSTOM_MODEL_LENGTH,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { speechConfigQueryOptions, speechQueryKeys } from "../lib/speechReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SidebarInset } from "~/components/ui/sidebar";
import { Badge } from "../components/ui/badge";

const DEFAULT_SPEECH_TO_TEXT_SETTINGS: SpeechToTextSettings = {
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
};

const SPEECH_PROVIDER_OPTIONS: Array<{
  value: SpeechToTextProviderKind;
  label: string;
}> = [
  { value: "local-http", label: "Local HTTP" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "gemini", label: "Gemini" },
];

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
] as const;

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

function speechProviderLabel(provider: SpeechToTextProviderKind): string {
  return SPEECH_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
}

interface SecretInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}

function SecretInput(props: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <InputGroup>
      <InputGroupInput
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        placeholder={props.placeholder}
        spellCheck={false}
        type={revealed ? "text" : "password"}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <InputGroupAddon align="inline-end">
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
          aria-label={revealed ? "Hide API key" : "Show API key"}
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
        </button>
      </InputGroupAddon>
    </InputGroup>
  );
}

function SettingsRouteView() {
  const queryClient = useQueryClient();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const speechConfigQuery = useQuery(speechConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [isOpeningSpeechConfig, setIsOpeningSpeechConfig] = useState(false);
  const [openSpeechConfigError, setOpenSpeechConfigError] = useState<string | null>(null);
  const [speechSaveError, setSpeechSaveError] = useState<string | null>(null);
  const [speechDraft, setSpeechDraft] = useState<SpeechToTextSettings | null>(null);
  const [speechSettingsProvider, setSpeechSettingsProvider] =
    useState<SpeechToTextProviderKind | null>(null);
  const [isSavingSpeechConfig, setIsSavingSpeechConfig] = useState(false);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const codexServiceTier = settings.codexServiceTier;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const speechSnapshot = speechConfigQuery.data ?? null;
  const speechConfigPath = speechSnapshot?.configPath ?? null;

  useEffect(() => {
    if (!speechSnapshot) return;
    setSpeechDraft(speechSnapshot.settings);
  }, [speechSnapshot]);

  useEffect(() => {
    if (!speechDraft) return;
    setSpeechSettingsProvider(speechDraft.defaultProvider);
  }, [speechDraft]);

  useEffect(() => {
    const api = ensureNativeApi();
    return api.speech.onConfigUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: speechQueryKeys.config() });
    });
  }, [queryClient]);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void api.shell
      .openInEditor(keybindingsConfigPath, preferredTerminalEditor())
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const openSpeechConfigFile = useCallback(() => {
    if (!speechConfigPath) return;
    setOpenSpeechConfigError(null);
    setIsOpeningSpeechConfig(true);
    const api = ensureNativeApi();
    void api.shell
      .openInEditor(speechConfigPath, preferredTerminalEditor())
      .catch((error) => {
        setOpenSpeechConfigError(
          error instanceof Error ? error.message : "Unable to open speech config file.",
        );
      })
      .finally(() => {
        setIsOpeningSpeechConfig(false);
      });
  }, [speechConfigPath]);

  const saveSpeechConfig = useCallback(() => {
    if (!speechDraft) return;
    setSpeechSaveError(null);
    setIsSavingSpeechConfig(true);
    const api = ensureNativeApi();
    void api.speech
      .updateConfig(speechDraft)
      .then((nextSnapshot) => {
        queryClient.setQueryData(speechQueryKeys.config(), nextSnapshot);
      })
      .catch((error) => {
        setSpeechSaveError(
          error instanceof Error ? error.message : "Unable to save speech settings.",
        );
      })
      .finally(() => {
        setIsSavingSpeechConfig(false);
      });
  }, [queryClient, speechDraft]);

  const resetSpeechConfig = useCallback(() => {
    setSpeechDraft(DEFAULT_SPEECH_TO_TEXT_SETTINGS);
    setSpeechSettingsProvider(DEFAULT_SPEECH_TO_TEXT_SETTINGS.defaultProvider);
  }, []);

  const addCustomModel = useCallback((provider: ProviderKind) => {
    const customModelInput = customModelInputByProvider[provider];
    const customModels = getCustomModelsForProvider(settings, provider);
    const normalized = normalizeModelSlug(customModelInput, provider);
    if (!normalized) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "Enter a model slug.",
      }));
      return;
    }
    if (getModelOptions(provider).some((option) => option.slug === normalized)) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "That model is already built in.",
      }));
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
      }));
      return;
    }
    if (customModels.includes(normalized)) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "That custom model is already saved.",
      }));
      return;
    }

    updateSettings(patchCustomModels(provider, [...customModels, normalized]));
    setCustomModelInputByProvider((existing) => ({
      ...existing,
      [provider]: "",
    }));
    setCustomModelErrorByProvider((existing) => ({
      ...existing,
      [provider]: null,
    }));
  }, [customModelInputByProvider, settings, updateSettings]);

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(patchCustomModels(provider, customModels.filter((model) => model !== slug)));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>

              <div className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-border/70 bg-background/65 px-4 py-3">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">Focus mode</div>
                  <p className="text-xs text-muted-foreground">
                    Hide the thread sidebar, diff panel, terminal drawer, branch bar, and project
                    actions until you turn it off.
                  </p>
                </div>
                <Switch
                  checked={settings.focusMode}
                  aria-label="Toggle focus mode"
                  onCheckedChange={(checked) => updateSettings({ focusMode: checked })}
                />
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Binary source:{" "}
                    <span className="font-medium text-foreground">{codexBinaryPath || "PATH"}</span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default service tier</span>
                  <Select
                    items={APP_SERVICE_TIER_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={codexServiceTier}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ codexServiceTier: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {APP_SERVICE_TIER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex min-w-0 items-center gap-2">
                            {option.value === "fast" ? (
                              <ZapIcon className="size-3.5 text-amber-500" />
                            ) : (
                              <span className="size-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{option.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {APP_SERVICE_TIER_OPTIONS.find((option) => option.value === codexServiceTier)
                      ?.description ?? "Use Codex defaults without forcing a service tier."}
                  </span>
                </label>

                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(
                                      provider,
                                      [...getDefaultCustomModelsForProvider(defaults, provider)],
                                    ),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    {provider === "codex" && shouldShowFastTierIcon(slug, codexServiceTier) ? (
                                      <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
                                    ) : null}
                                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      {slug}
                                    </code>
                                  </div>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Speech to Text</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure composer dictation providers stored in <code>speech-to-text.json</code>.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Provider</span>
                  <Select
                    items={SPEECH_PROVIDER_OPTIONS}
                    value={speechDraft?.defaultProvider ?? null}
                    onValueChange={(value) => {
                      if (!value || !speechDraft) return;
                      const provider = value as SpeechToTextProviderKind;
                      setSpeechDraft({ ...speechDraft, defaultProvider: provider });
                      setSpeechSettingsProvider(provider);
                    }}
                  >
                    <SelectTrigger disabled={!speechDraft}>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {SPEECH_PROVIDER_OPTIONS.map((provider) => (
                        <SelectItem key={provider.value} value={provider.value}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>

                {speechDraft && speechSettingsProvider ? (
                  <div className="rounded-xl border border-border bg-background p-4">
                    {(() => {
                      const provider = speechSettingsProvider;
                      const status =
                        speechSnapshot?.providers.find((entry) => entry.provider === provider) ?? null;
                      const settingsForProvider = speechDraft.providers[provider];
                      return (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-medium text-foreground">
                                  {speechProviderLabel(provider)}
                                </h3>
                                {status ? (
                                  <Badge
                                    variant={
                                      status.status === "ready"
                                        ? "default"
                                        : status.status === "warning"
                                          ? "secondary"
                                          : "destructive"
                                    }
                                  >
                                    {status.status}
                                  </Badge>
                                ) : null}
                              </div>
                              {status?.message ? (
                                <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
                              ) : null}
                            </div>
                            <Switch
                              checked={settingsForProvider.enabled}
                              onCheckedChange={(checked) => {
                                setSpeechDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        providers: {
                                          ...current.providers,
                                          [provider]: {
                                            ...current.providers[provider],
                                            enabled: Boolean(checked),
                                          },
                                        },
                                      }
                                    : current,
                                );
                              }}
                              aria-label={`Enable ${provider} speech provider`}
                            />
                          </div>

                          <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            {provider === "local-http" ? (
                              <>
                                <label className="space-y-1 sm:col-span-2">
                                  <span className="text-xs font-medium text-foreground">Base URL</span>
                                  <Input
                                    value={speechDraft.providers["local-http"].baseUrl}
                                    onChange={(event) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                "local-http": {
                                                  ...current.providers["local-http"],
                                                  baseUrl: event.target.value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs font-medium text-foreground">API key</span>
                                  <SecretInput
                                    placeholder="Optional"
                                    value={speechDraft.providers["local-http"].apiKey}
                                    onChange={(value) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                "local-http": {
                                                  ...current.providers["local-http"],
                                                  apiKey: value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs font-medium text-foreground">Model</span>
                                  <Input
                                    value={speechDraft.providers["local-http"].model}
                                    onChange={(event) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                "local-http": {
                                                  ...current.providers["local-http"],
                                                  model: event.target.value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                              </>
                            ) : provider === "elevenlabs" ? (
                              <>
                                <label className="space-y-1 sm:col-span-2">
                                  <span className="text-xs font-medium text-foreground">API key</span>
                                  <SecretInput
                                    value={speechDraft.providers.elevenlabs.apiKey}
                                    onChange={(value) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                elevenlabs: {
                                                  ...current.providers.elevenlabs,
                                                  apiKey: value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs font-medium text-foreground">Model ID</span>
                                  <Input
                                    value={speechDraft.providers.elevenlabs.modelId}
                                    onChange={(event) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                elevenlabs: {
                                                  ...current.providers.elevenlabs,
                                                  modelId: event.target.value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span className="text-xs font-medium text-foreground">Language code</span>
                                  <Input
                                    value={speechDraft.providers.elevenlabs.languageCode}
                                    onChange={(event) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                elevenlabs: {
                                                  ...current.providers.elevenlabs,
                                                  languageCode: event.target.value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                              </>
                            ) : (
                              <>
                                <label className="space-y-1 sm:col-span-2">
                                  <span className="text-xs font-medium text-foreground">API key</span>
                                  <SecretInput
                                    value={speechDraft.providers.gemini.apiKey}
                                    onChange={(value) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                gemini: {
                                                  ...current.providers.gemini,
                                                  apiKey: value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                                <label className="space-y-1 sm:col-span-2">
                                  <span className="text-xs font-medium text-foreground">Model</span>
                                  <Input
                                    value={speechDraft.providers.gemini.model}
                                    onChange={(event) =>
                                      setSpeechDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              providers: {
                                                ...current.providers,
                                                gemini: {
                                                  ...current.providers.gemini,
                                                  model: event.target.value,
                                                },
                                              },
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                  <p className="text-[11px] text-muted-foreground">
                                    Default Google model id: <code>gemini-3-flash-preview</code>
                                  </p>
                                </label>
                              </>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {speechConfigPath ?? "Resolving speech config path..."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="xs" variant="outline" onClick={resetSpeechConfig} disabled={!speechDraft}>
                      Reset to defaults
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!speechConfigPath || isOpeningSpeechConfig}
                      onClick={openSpeechConfigFile}
                    >
                      {isOpeningSpeechConfig ? "Opening..." : "Open speech-to-text.json"}
                    </Button>
                    <Button size="xs" onClick={saveSpeechConfig} disabled={!speechDraft || isSavingSpeechConfig}>
                      {isSavingSpeechConfig ? "Saving..." : "Save speech settings"}
                    </Button>
                  </div>
                </div>

                {speechSnapshot?.issues.length ? (
                  <div className="space-y-1">
                    {speechSnapshot.issues.map((issue) => (
                      <p
                        key={`${issue.kind}:${"provider" in issue ? issue.provider : "global"}:${issue.message}`}
                        className="text-xs text-destructive"
                      >
                        {issue.message}
                      </p>
                    ))}
                  </div>
                ) : null}
                {openSpeechConfigError ? (
                  <p className="text-xs text-destructive">{openSpeechConfigError}</p>
                ) : null}
                {speechSaveError ? (
                  <p className="text-xs text-destructive">{speechSaveError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
