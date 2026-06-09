import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export const BROWSER_TYPES = ['chromium', 'firefox', 'webkit', 'chrome', 'edge'] as const

const positiveInteger = z.number().int().positive()

const configSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().min(1),
  }).strict(),
  browser: z.object({
    headless: z.boolean(),
    type: z.enum(BROWSER_TYPES),
    userDataDir: z.string().min(1),
    userAgent: z.string().min(1),
    args: z.array(z.string()),
    launchTimeout: positiveInteger,
    healthCheckInterval: positiveInteger,
    headers: z.record(z.string(), z.string()),
    logConsole: z.boolean(),
  }).strict(),
  timeouts: z.object({
    navigation: positiveInteger,
    page: positiveInteger,
    http: positiveInteger,
    chat: positiveInteger,
  }).strict(),
  cache: z.object({
    defaultTTL: positiveInteger,
    responseTTL: positiveInteger,
  }).strict(),
  metrics: z.object({
    interval: positiveInteger,
  }).strict(),
  watchdog: z.object({
    checkInterval: positiveInteger,
    consecutiveFailuresThreshold: positiveInteger,
    ram: z.object({
      warningThreshold: z.number().min(1).max(100),
      criticalThreshold: z.number().min(1).max(100),
    }).strict(),
    streams: z.object({
      warningThreshold: positiveInteger,
      criticalThreshold: positiveInteger,
    }).strict(),
  }).strict(),
  apiKey: z.string(),
  qwen: z.object({
    baseUrl: z.string().url(),
    httpEndpoint: z.string().url(),
    apiKey: z.string(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.watchdog.ram.warningThreshold >= value.watchdog.ram.criticalThreshold) {
    ctx.addIssue({
      code: 'custom',
      path: ['watchdog', 'ram', 'warningThreshold'],
      message: 'RAM warning threshold must be lower than critical threshold',
    })
  }

  if (value.watchdog.streams.warningThreshold >= value.watchdog.streams.criticalThreshold) {
    ctx.addIssue({
      code: 'custom',
      path: ['watchdog', 'streams', 'warningThreshold'],
      message: 'stream warning threshold must be lower than critical threshold',
    })
  }
})

export type BrowserTypeConfig = typeof BROWSER_TYPES[number]
export type Config = z.infer<typeof configSchema>

export const DEFAULT_CONFIG_PATH = path.resolve('data', 'config.json')

export const DEFAULT_CONFIG: Config = {
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  browser: {
    headless: true,
    type: 'chromium',
    userDataDir: './qwen_profiles',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    launchTimeout: 30000,
    healthCheckInterval: 30000,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    logConsole: false,
  },
  timeouts: {
    navigation: 30000,
    page: 15000,
    http: 10000,
    chat: 120000,
  },
  cache: {
    defaultTTL: 3600,
    responseTTL: 1800,
  },
  metrics: {
    interval: 10000,
  },
  watchdog: {
    checkInterval: 5000,
    consecutiveFailuresThreshold: 3,
    ram: {
      warningThreshold: 80,
      criticalThreshold: 95,
    },
    streams: {
      warningThreshold: 50,
      criticalThreshold: 100,
    },
  },
  apiKey: '',
  qwen: {
    baseUrl: 'https://chat.qwen.ai',
    httpEndpoint: 'https://api.qwen.ai/v1/chat',
    apiKey: '',
  },
}

let activeConfigPath = DEFAULT_CONFIG_PATH

function cloneConfig(value: Config): Config {
  return JSON.parse(JSON.stringify(value)) as Config
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join('; ')
}

export function parseConfig(value: unknown, source = 'configuration'): Config {
  const parsed = configSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`Invalid configuration in ${source}: ${formatZodError(parsed.error)}`)
  }
  return parsed.data
}

export function loadConfig(configPath = activeConfigPath): Config {
  if (!fs.existsSync(configPath)) {
    return cloneConfig(DEFAULT_CONFIG)
  }

  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch (err: any) {
    throw new Error(`Failed to read configuration at ${configPath}: ${err.message}`)
  }

  try {
    return parseConfig(JSON.parse(raw), configPath)
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid configuration in ${configPath}: ${err.message}`)
    }
    throw err
  }
}

export function saveConfig(nextConfig: Config, configPath = activeConfigPath): Config {
  const parsed = parseConfig(nextConfig, configPath)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`)

  if (configPath === activeConfigPath) {
    config = parsed
  }

  return parsed
}

export function reloadConfig(configPath = activeConfigPath): Config {
  activeConfigPath = configPath
  config = loadConfig(configPath)
  return config
}

export function getConfigPath(): string {
  return activeConfigPath
}

export let config: Config = loadConfig()
