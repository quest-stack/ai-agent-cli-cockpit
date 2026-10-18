import { formatShortcutLabel, isPrimaryShortcut } from "../shared/platform";

import { cockpitApi } from "./bridge";

export const isMac = cockpitApi.platform === "darwin";
export const shortcutLabel = (text: string): string => formatShortcutLabel(text, cockpitApi.platform);
export const primaryShortcut = (event: KeyboardEvent): boolean => isPrimaryShortcut(event, cockpitApi.platform);
