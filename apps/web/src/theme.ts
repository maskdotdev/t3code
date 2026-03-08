export const APP_THEME_MODES = ["system", "light", "dark"] as const;
export const APP_THEME_NAMES = ["graphite", "dawn", "canopy", "tide"] as const;
export const DEFAULT_APP_THEME_MODE = "system";
export const DEFAULT_APP_THEME_NAME = "graphite";
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
    value: "dawn",
    label: "Dawn",
    description: "Warm paper tones with terracotta and gold accents.",
    preview: {
      background: "linear-gradient(135deg, #fff1dd 0%, #ffd7c8 52%, #ffc39f 100%)",
      accent: "#cc6840",
      highlight: "#efb15b",
      foreground: "#472218",
    },
  },
  {
    value: "canopy",
    label: "Canopy",
    description: "Botanical greens with a restrained studio feel.",
    preview: {
      background: "linear-gradient(135deg, #ecf6df 0%, #d4edd5 48%, #b8ddca 100%)",
      accent: "#2f7a56",
      highlight: "#65aa79",
      foreground: "#173122",
    },
  },
  {
    value: "tide",
    label: "Tide",
    description: "Crisp cyan-blue contrast with a coastal haze.",
    preview: {
      background: "linear-gradient(135deg, #e6f6fb 0%, #d6edfa 52%, #bbdbf4 100%)",
      accent: "#0e7fa6",
      highlight: "#44a8cf",
      foreground: "#10293a",
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
