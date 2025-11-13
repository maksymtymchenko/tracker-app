import fs from "fs";
import path from "path";
import os from "os";
import { z } from "zod";

export const CONFIG_DIR = path.join(os.homedir(), ".windows-activity-tracker");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

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
  workApplications: z.array(z.string()).default([]),
  personalApplications: z.array(z.string()).default([]),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

const defaultConfig: AppConfig = {
  username: os.hostname() || os.userInfo().username || "user",
  serverUrl: "http://localhost:4000",
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
  workApplications: [],
  personalApplications: [],
};

export function ensureConfigFile(): AppConfig {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
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
    // Auto-backfill missing fields
    let updated: AppConfig | null = null;
    if (!result.data.serverUrl) {
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
