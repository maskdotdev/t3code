export const APP_THEME_MODES = ["system", "light", "dark"] as const;
export const APP_THEME_NAMES = ["default", "graphite", "navy"] as const;
export const DEFAULT_APP_THEME_MODE = "system";
export const DEFAULT_APP_THEME_NAME = "default";
export const LEGACY_THEME_STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type AppThemeMode = (typeof APP_THEME_MODES)[number];
export type AppThemeName = (typeof APP_THEME_NAMES)[number];
export type ResolvedTheme = "light" | "dark";

const APP_THEME_MODE_SET = new Set<AppThemeMode>(APP_THEME_MODES);
const APP_THEME_NAME_SET = new Set<AppThemeName>(APP_THEME_NAMES);

export const APP_THEME_MODE_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light presentation.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark presentation.",
  },
] as const satisfies ReadonlyArray<{
  value: AppThemeMode;
  label: string;
  description: string;
}>;

export const APP_THEME_OPTIONS = [
  {
    value: "default",
    label: "Default",
    description: "The original neutral palette that shipped before themed surfaces.",
    preview: {
      background: "linear-gradient(135deg, #f8f8f9 0%, #e9ebef 52%, #d8dde5 100%)",
      accent: "#5a57f2",
      highlight: "#7b86ff",
      foreground: "#1f2937",
    },
  },
  {
    value: "graphite",
    label: "Graphite",
    description: "Cool slate surfaces with an electric blue core.",
    preview: {
      background: "linear-gradient(135deg, #eff5ff 0%, #d7e4ff 46%, #c7d5ff 100%)",
      accent: "#5169ff",
      highlight: "#88a0ff",
      foreground: "#15213d",
    },
  },
  {
    value: "navy",
    label: "Navy",
    description: "Deep navy blue with warm golden accents.",
    preview: {
      background: "linear-gradient(135deg, #060e1e 0%, #0f1f42 48%, #d4a844 100%)",
      accent: "#d4a844",
      highlight: "#1a3578",
      foreground: "#e4eaf4",
    },
  },
] as const satisfies ReadonlyArray<{
  value: AppThemeName;
  label: string;
  description: string;
  preview: {
    background: string;
    accent: string;
    highlight: string;
    foreground: string;
  };
}>;

export interface ThemeSnapshot {
  mode: AppThemeMode;
  themeName: AppThemeName;
  resolvedTheme: ResolvedTheme;
  systemDark: boolean;
}

export function isAppThemeMode(value: unknown): value is AppThemeMode {
  return typeof value === "string" && APP_THEME_MODE_SET.has(value as AppThemeMode);
}

export function isAppThemeName(value: unknown): value is AppThemeName {
  return typeof value === "string" && APP_THEME_NAME_SET.has(value as AppThemeName);
}

export function getSystemDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(MEDIA_QUERY).matches;
}

export function resolveThemeMode(mode: AppThemeMode, systemDark = getSystemDark()): ResolvedTheme {
  if (mode === "system") {
    return systemDark ? "dark" : "light";
  }

  return mode;
}

export function createThemeSnapshot(input: {
  appearanceMode: AppThemeMode;
  appearanceTheme: AppThemeName;
}, systemDark = getSystemDark()): ThemeSnapshot {
  return {
    mode: input.appearanceMode,
    themeName: input.appearanceTheme,
    systemDark,
    resolvedTheme: resolveThemeMode(input.appearanceMode, systemDark),
  };
}

export function applyThemeToDocument(snapshot: ThemeSnapshot, suppressTransitions = false): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  if (suppressTransitions) {
    root.classList.add("no-transitions");
  }

  root.dataset.theme = snapshot.themeName;
  root.classList.toggle("dark", snapshot.resolvedTheme === "dark");
  root.style.colorScheme = snapshot.resolvedTheme;

  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal.
    // oxlint-disable-next-line no-unused-expressions
    root.offsetHeight;
    requestAnimationFrame(() => {
      root.classList.remove("no-transitions");
    });
  }
}

export function subscribeToSystemTheme(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const mq = window.matchMedia(MEDIA_QUERY);
  mq.addEventListener("change", listener);
  return () => {
    mq.removeEventListener("change", listener);
  };
}

export function getResolvedThemeFromDocument(): ResolvedTheme {
  if (typeof document === "undefined") {
    return "light";
  }

  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function readThemeCssVariable(name: string, fallback: string): string {
  if (typeof document === "undefined") {
    return fallback;
  }

  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}
