import fs from "fs";
import path from "path";
import os from "os";
import { z } from "zod";
import { app } from "electron";

export const CONFIG_DIR = path.join(os.homedir(), ".windows-activity-tracker");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEV_URL = "http://localhost:4000";
const PROD_URL = "https://tracker-dashboard-zw8l.onrender.com";

/**
 * Get default server URL based on environment
 */
function getDefaultServerUrl(): string {
  // Check if app is packaged (production build)
  // In development, app might not be available yet, so check process.env as fallback
  try {
    if (app && app.isPackaged) {
      return PROD_URL;
    }
  } catch {
    // app not available yet, check environment
  }
  // Check NODE_ENV or other indicators
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ELECTRON_IS_DEV !== "1"
  ) {
    return PROD_URL;
  }
  return DEV_URL;
}

export const AppConfigSchema = z.object({
  username: z.string().min(1),
  serverUrl: z.string().url().or(z.literal("")),
  trackingInterval: z.number().int().positive().default(10000),
  minActivityDuration: z.number().int().nonnegative().default(2000),
  maxIdleTime: z.number().int().positive().default(60000),
  trackClipboard: z.boolean().default(true),
  trackScreenshots: z.boolean().default(true),
  screenshotOnWindowChange: z.boolean().default(true),
  screenshotOnClick: z.boolean().default(false),
  minScreenshotInterval: z.number().int().positive().default(60000),
  screenshotBatchDelay: z.number().int().positive().default(5000),
  batchSize: z.number().int().positive().default(20),
  startOnBoot: z.boolean().default(true),
  workApplications: z.array(z.string()).default([]),
  personalApplications: z.array(z.string()).default([]),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

function getDefaultConfig(): AppConfig {
  return {
    username: os.hostname() || os.userInfo().username || "user",
    serverUrl: getDefaultServerUrl(),
    trackingInterval: 10000,
    minActivityDuration: 2000,
    maxIdleTime: 60000,
    trackClipboard: true,
    trackScreenshots: true,
    screenshotOnWindowChange: true,
    screenshotOnClick: false,
    minScreenshotInterval: 60000,
    screenshotBatchDelay: 5000,
    batchSize: 20,
    startOnBoot: true,
    workApplications: [],
    personalApplications: [],
  };
}

export function ensureConfigFile(): AppConfig {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const defaultConfig = getDefaultConfig();

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(defaultConfig, null, 2),
      "utf-8"
    );
    return defaultConfig;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const result = AppConfigSchema.safeParse(parsed);
    if (!result.success) {
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify(defaultConfig, null, 2),
        "utf-8"
      );
      return defaultConfig;
    }

    // Auto-backfill missing fields and migrate localhost to production URL if needed
    let updated: AppConfig | null = null;
    const currentServerUrl = result.data.serverUrl || "";

    // If serverUrl is localhost and we're in production, update it
    if (
      /localhost/i.test(currentServerUrl) &&
      (app?.isPackaged || process.env.NODE_ENV === "production")
    ) {
      updated = {
        ...(updated || result.data),
        serverUrl: PROD_URL,
      } as AppConfig;
      console.log(`[config] Migrated localhost URL to production: ${PROD_URL}`);
    } else if (!currentServerUrl) {
      updated = {
        ...(updated || result.data),
        serverUrl: defaultConfig.serverUrl,
      } as AppConfig;
    }

    if (!result.data.username) {
      updated = {
        ...(updated || result.data),
        username: defaultConfig.username,
      } as AppConfig;
    }

    if (updated) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");
      return updated;
    }
    return result.data;
  } catch {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(defaultConfig, null, 2),
      "utf-8"
    );
    return defaultConfig;
  }
}

export function updateConfig(partial: Partial<AppConfig>): AppConfig {
  const current = ensureConfigFile();
  const next = { ...current, ...partial } as AppConfig;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
