/**
 * Every probe this package declares, in one list.
 *
 * The installers each declare their own as they install, which is what keeps a
 * *disabled* feature from reporting names it is not using. This list answers a
 * different question — "if I upgrade pi, what here would break?" — where the
 * right scope is everything, installed or not. `npm run check:internals` is
 * its only consumer.
 *
 * Importing a patch module does not install anything: the probe tables are
 * module-level constants and the patching lives inside `install*` functions.
 */

import { PROBES as assistantMessage } from "./assistant-message.ts";
import { PROBES as editorChrome } from "./editor-chrome.ts";
import { PROBES as modelSelectorTabs } from "./model-selector-tabs.ts";
import { PROBES as sessionInfo } from "./session-info.ts";
import { PROBES as userMessage } from "./user-message.ts";
import { PROBES as fullscreen } from "./host/fullscreen/bridge.ts";
import { PROBES as widgetSpacing } from "./host/widget-spacing.ts";
import { PROBES as workingRetry } from "./compat/working-retry.ts";
import { PROBES as retrySession } from "./compat/retry-session.ts";
import type { Probe } from "./internals.ts";
import { PROBES as history } from "./compat/full-history.ts";

export const ALL_PROBES: readonly Probe[] = [
  ...assistantMessage,
  ...editorChrome,
  ...modelSelectorTabs,
  ...sessionInfo,
  ...userMessage,
  ...fullscreen,
  ...widgetSpacing,
  ...workingRetry,
  ...retrySession,
  ...history,
];
