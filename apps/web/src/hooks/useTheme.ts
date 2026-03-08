import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  getAppSettingsSnapshot,
  subscribeToAppSettings,
  updateAppSettingsSnapshot,
} from "../appSettings";
import {
  applyThemeToDocument,
  createThemeSnapshot,
  DEFAULT_APP_THEME_MODE,
  DEFAULT_APP_THEME_NAME,
  getSystemDark,
  subscribeToSystemTheme,
  type AppThemeMode,
  type AppThemeName,
} from "../theme";

type ThemeSettingsSnapshot = {
  appearanceMode: AppThemeMode;
  appearanceTheme: AppThemeName;
};

let lastThemeSettingsSnapshot: ThemeSettingsSnapshot | null = null;

function getThemeSettingsSnapshot(): ThemeSettingsSnapshot {
  const settings = getAppSettingsSnapshot();
  const nextSnapshot = {
    appearanceMode: settings.appearanceMode,
    appearanceTheme: settings.appearanceTheme,
  };

  if (
    lastThemeSettingsSnapshot &&
    lastThemeSettingsSnapshot.appearanceMode === nextSnapshot.appearanceMode &&
    lastThemeSettingsSnapshot.appearanceTheme === nextSnapshot.appearanceTheme
  ) {
    return lastThemeSettingsSnapshot;
  }

  lastThemeSettingsSnapshot = nextSnapshot;
  return nextSnapshot;
}

function getServerThemeSettingsSnapshot(): ThemeSettingsSnapshot {
  return {
    appearanceMode: DEFAULT_APP_THEME_MODE,
    appearanceTheme: DEFAULT_APP_THEME_NAME,
  };
}

function getSystemDarkSnapshot(): boolean {
  return getSystemDark();
}

function getServerSystemDarkSnapshot(): boolean {
  return false;
}

export function useTheme() {
  const themeSettings = useSyncExternalStore(
    subscribeToAppSettings,
    getThemeSettingsSnapshot,
    getServerThemeSettingsSnapshot,
  );
  const systemDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemDarkSnapshot,
    getServerSystemDarkSnapshot,
  );
  const snapshot = createThemeSnapshot(
    {
      appearanceMode: themeSettings.appearanceMode,
      appearanceTheme: themeSettings.appearanceTheme,
    },
    systemDark,
  );

  useEffect(() => {
    applyThemeToDocument(snapshot, true);
  }, [snapshot.mode, snapshot.resolvedTheme, snapshot.themeName, snapshot.systemDark]);

  const setMode = useCallback((next: AppThemeMode) => {
    updateAppSettingsSnapshot({ appearanceMode: next });
  }, []);

  const setThemeName = useCallback((next: AppThemeName) => {
    updateAppSettingsSnapshot({ appearanceTheme: next });
  }, []);

  return {
    mode: themeSettings.appearanceMode,
    setMode,
    themeName: themeSettings.appearanceTheme,
    setThemeName,
    resolvedTheme: snapshot.resolvedTheme,
  } as const;
}
