import * as readline from 'node:readline'
import { addAccount, removeAccount, listAccounts, getAccountCredentials, QwenAccount } from './core/accounts.js'
import { BROWSER_TYPES, Config, DEFAULT_CONFIG, config, getConfigPath, saveConfig } from './core/config.js'
import { initPlaywrightForAccount, closePlaywrightForAccount, BrowserType, launchManualLoginAccount, extractAccountInfoFromContext } from './services/playwright.js'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function askQuestion(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer.trim())
    })
  })
}

function clear() {
  process.stdout.write('\x1Bc')
}

function cloneConfig(value: Config): Config {
  return JSON.parse(JSON.stringify(value)) as Config
}

function maskSecret(value: string): string {
  if (!value) return 'not set'
  return `${'*'.repeat(Math.min(value.length, 12))} (${value.length} chars)`
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no'
}

async function pause() {
  await askQuestion('\nPress Enter to continue...')
}

function printHeader(title: string) {
  clear()
  console.log('QwenProxy Console')
  console.log('='.repeat(18))
  console.log(`${title}\n`)
}

function printDashboard() {
  const accounts = listAccounts()
  console.log(`Accounts: ${accounts.length}`)
  console.log(`Config:   ${getConfigPath()}`)
  console.log(`Server:   http://${config.server.host}:${config.server.port}`)
  console.log(`Browser:  ${config.browser.type} (headless: ${formatBoolean(config.browser.headless)})`)
  console.log(`API key:  ${maskSecret(config.apiKey)}`)
}

async function showMenu() {
  while (true) {
    printHeader('Dashboard')
    printDashboard()

    console.log('\nActions:')
    console.log('  [A] Accounts')
    console.log('  [S] Settings')
    console.log('  [L] Login all accounts')
    console.log('  [Q] Quit\n')

    const choice = (await askQuestion('Select an option: ')).toUpperCase()

    if (choice === 'Q') {
      rl.close()
      process.exit(0)
    }

    if (choice === 'A') {
      await accountsMenu()
      continue
    }

    if (choice === 'S') {
      await settingsMenu()
      continue
    }

    if (choice === 'L') {
      await loginAllAccounts()
      continue
    }
  }
}

async function accountsMenu() {
  while (true) {
    const accounts = listAccounts()
    printHeader('Accounts')

    if (accounts.length > 0) {
      for (let i = 0; i < accounts.length; i++) {
        console.log(`  [${i + 1}] ${accounts[i].email} (${accounts[i].id})`)
      }
    } else {
      console.log('No accounts configured yet.')
    }

    console.log('\nActions:')
    console.log('  [A] Add with credentials')
    console.log('  [M] Add with manual browser login')
    if (accounts.length > 0) {
      console.log('  [R] Remove account')
      console.log('  [L] Login all accounts')
    }
    console.log('  [B] Back\n')

    const choice = (await askQuestion('Select an option: ')).toUpperCase()

    if (choice === 'B') return
    if (choice === 'A') await addAccountFlow()
    if (choice === 'M') await addAccountManualFlow()
    if (choice === 'R' && accounts.length > 0) await removeAccountFlow()
    if (choice === 'L' && accounts.length > 0) await loginAllAccounts()
  }
}

async function addAccountFlow() {
  printHeader('Add Account')
  const email = await askQuestion('Email: ')
  if (!email) {
    console.log('\nEmail is required.')
    await pause()
    return
  }

  const password = await askQuestion('Password: ')
  if (!password) {
    console.log('\nPassword is required.')
    await pause()
    return
  }

  try {
    const account = addAccount(email, password)
    console.log(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    console.log(`\nError: ${err.message}`)
  }

  await pause()
}

async function removeAccountFlow() {
  const accounts = listAccounts()
  if (accounts.length === 0) return

  printHeader('Remove Account')

  for (let i = 0; i < accounts.length; i++) {
    console.log(`  [${i + 1}] ${accounts[i].email} (${accounts[i].id})`)
  }

  const input = await askQuestion('\nSelect account number to remove (or 0 to cancel): ')
  const idx = Number.parseInt(input, 10) - 1

  if (Number.isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log(input !== '0' ? 'Invalid selection.' : 'Cancelled.')
    await pause()
    return
  }

  const account = accounts[idx]
  const confirm = await askQuestion(`\nRemove ${account.email}? (y/N): `)
  if (confirm.toLowerCase() === 'y') {
    if (removeAccount(account.id)) {
      console.log(`Account ${account.email} removed.`)
    } else {
      console.log('Failed to remove account.')
    }
  } else {
    console.log('Cancelled.')
  }

  await pause()
}

async function loginAllAccounts() {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    printHeader('Login Accounts')
    console.log('No accounts configured yet.')
    await pause()
    return
  }

  const browserType = config.browser.type as BrowserType
  printHeader('Login Accounts')
  console.log(`Logging in ${accounts.length} account(s) using ${browserType}.\n`)

  for (const account of accounts) {
    const creds = getAccountCredentials(account.id)
    if (!creds || creds.password === '***') {
      console.log(`[Skip] ${account.email}: no saved credentials`)
      continue
    }

    console.log(`[Login] ${account.email}`)
    try {
      const fullAccount: QwenAccount = {
        id: creds.id,
        email: creds.email,
        password: creds.password,
      }
      await initPlaywrightForAccount(fullAccount, config.browser.headless, browserType)
      console.log(`[OK] Session saved for ${account.email}.`)
      await closePlaywrightForAccount(account.id)
    } catch (err: any) {
      console.error(`[Error] ${account.email}: ${err.message}`)
    }
  }

  console.log('\nDone.')
  await pause()
}

async function addAccountManualFlow() {
  printHeader('Manual Login')
  console.log(`Browser: ${config.browser.type}`)
  console.log('A browser window will open. Log in to Qwen, then return here.\n')
  await askQuestion('Press Enter to open the browser...')

  const crypto = await import('node:crypto')
  const accountId = crypto.randomUUID()
  const { context, page } = await launchManualLoginAccount(accountId, config.browser.type as BrowserType)

  console.log('\nWaiting for a valid Qwen session...')

  let loggedIn = false
  while (!loggedIn) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const { hasSession } = await extractAccountInfoFromContext(page)
    loggedIn = hasSession
  }

  console.log('\nLogin detected.')
  const extractedEmail = await askQuestion('Email for this account: ')
  if (!extractedEmail) {
    console.log('Email is required.')
    await context.close()
    await pause()
    return
  }

  try {
    const account = addAccount(extractedEmail, '', accountId)
    console.log(`\nAccount added: ${account.email} (${account.id})`)
  } catch (err: any) {
    console.log(`\nError: ${err.message}`)
  }

  await context.close()
  await pause()
}

async function settingsMenu() {
  while (true) {
    printHeader('Settings')
    console.log(`Config file: ${getConfigPath()}\n`)
    console.log(`  [1] Server        ${config.server.host}:${config.server.port}`)
    console.log(`  [2] API key       ${maskSecret(config.apiKey)}`)
    console.log(`  [3] Browser       ${config.browser.type}, headless: ${formatBoolean(config.browser.headless)}`)
    console.log(`  [4] Qwen          ${config.qwen.baseUrl}`)
    console.log(`  [5] Timeouts      chat ${config.timeouts.chat}ms, http ${config.timeouts.http}ms`)
    console.log(`  [6] Monitoring    metrics ${config.metrics.interval}ms, watchdog ${config.watchdog.checkInterval}ms`)
    console.log('  [D] Restore defaults')
    console.log('  [B] Back\n')

    const choice = (await askQuestion('Select a setting: ')).toUpperCase()

    if (choice === 'B') return
    if (choice === '1') await editServerSettings()
    if (choice === '2') await editApiKey()
    if (choice === '3') await editBrowserSettings()
    if (choice === '4') await editQwenSettings()
    if (choice === '5') await editTimeoutSettings()
    if (choice === '6') await editMonitoringSettings()
    if (choice === 'D') await restoreDefaultSettings()
  }
}

async function editServerSettings() {
  const next = cloneConfig(config)
  printHeader('Server Settings')
  next.server.host = await promptString('Host', next.server.host)
  next.server.port = await promptNumber('Port', next.server.port, 1, 65535)
  await persistSettings(next)
}

async function editApiKey() {
  const next = cloneConfig(config)
  printHeader('API Key')
  console.log(`Current: ${maskSecret(next.apiKey)}`)
  console.log('Leave blank to keep the current key. Type "clear" to disable authorization.\n')

  const input = await askQuestion('New API key: ')
  if (input === '') return
  next.apiKey = input.toLowerCase() === 'clear' ? '' : input
  await persistSettings(next)
}

async function editBrowserSettings() {
  const next = cloneConfig(config)
  printHeader('Browser Settings')
  next.browser.type = await promptBrowser(next.browser.type)
  next.browser.headless = await promptBoolean('Headless mode', next.browser.headless)
  next.browser.userDataDir = await promptString('Profile directory', next.browser.userDataDir)
  await persistSettings(next)
}

async function editQwenSettings() {
  const next = cloneConfig(config)
  printHeader('Qwen Settings')
  next.qwen.baseUrl = await promptString('Base URL', next.qwen.baseUrl)
  next.qwen.httpEndpoint = await promptString('HTTP endpoint', next.qwen.httpEndpoint)
  console.log(`Current Qwen API key: ${maskSecret(next.qwen.apiKey)}`)
  console.log('Leave blank to keep it. Type "clear" to unset it.\n')
  const apiKey = await askQuestion('Qwen API key: ')
  if (apiKey) {
    next.qwen.apiKey = apiKey.toLowerCase() === 'clear' ? '' : apiKey
  }
  await persistSettings(next)
}

async function editTimeoutSettings() {
  const next = cloneConfig(config)
  printHeader('Timeout Settings')
  next.timeouts.navigation = await promptNumber('Navigation timeout ms', next.timeouts.navigation)
  next.timeouts.page = await promptNumber('Page timeout ms', next.timeouts.page)
  next.timeouts.http = await promptNumber('HTTP timeout ms', next.timeouts.http)
  next.timeouts.chat = await promptNumber('Chat timeout ms', next.timeouts.chat)
  next.cache.defaultTTL = await promptNumber('Account cache TTL seconds', next.cache.defaultTTL)
  next.cache.responseTTL = await promptNumber('Response cache TTL seconds', next.cache.responseTTL)
  await persistSettings(next)
}

async function editMonitoringSettings() {
  const next = cloneConfig(config)
  printHeader('Monitoring Settings')
  next.metrics.interval = await promptNumber('Metrics interval ms', next.metrics.interval)
  next.watchdog.checkInterval = await promptNumber('Watchdog interval ms', next.watchdog.checkInterval)
  next.watchdog.consecutiveFailuresThreshold = await promptNumber('Watchdog failures threshold', next.watchdog.consecutiveFailuresThreshold)
  next.watchdog.ram.warningThreshold = await promptNumber('RAM warning percent', next.watchdog.ram.warningThreshold, 1, 99)
  next.watchdog.ram.criticalThreshold = await promptNumber('RAM critical percent', next.watchdog.ram.criticalThreshold, 2, 100)
  next.watchdog.streams.warningThreshold = await promptNumber('Stream warning threshold', next.watchdog.streams.warningThreshold)
  next.watchdog.streams.criticalThreshold = await promptNumber('Stream critical threshold', next.watchdog.streams.criticalThreshold)
  await persistSettings(next)
}

async function restoreDefaultSettings() {
  printHeader('Restore Defaults')
  const confirm = await askQuestion('Replace all settings with defaults? (y/N): ')
  if (confirm.toLowerCase() !== 'y') return
  await persistSettings(cloneConfig(DEFAULT_CONFIG))
}

async function promptString(label: string, current: string): Promise<string> {
  const input = await askQuestion(`${label} [${current}]: `)
  return input || current
}

async function promptNumber(label: string, current: number, min = 1, max = Number.MAX_SAFE_INTEGER): Promise<number> {
  while (true) {
    const input = await askQuestion(`${label} [${current}]: `)
    if (!input) return current

    const parsed = Number(input)
    if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
      return parsed
    }
    console.log(`Enter an integer from ${min} to ${max}.`)
  }
}

async function promptBoolean(label: string, current: boolean): Promise<boolean> {
  while (true) {
    const input = (await askQuestion(`${label} (${current ? 'Y/n' : 'y/N'}): `)).toLowerCase()
    if (!input) return current
    if (input === 'y' || input === 'yes') return true
    if (input === 'n' || input === 'no') return false
    console.log('Enter y or n.')
  }
}

async function promptBrowser(current: Config['browser']['type']): Promise<Config['browser']['type']> {
  while (true) {
    console.log(`Available browsers: ${BROWSER_TYPES.join(', ')}`)
    const input = await askQuestion(`Browser [${current}]: `)
    if (!input) return current
    if ((BROWSER_TYPES as readonly string[]).includes(input)) {
      return input as Config['browser']['type']
    }
    console.log('Choose one of the listed browsers.')
  }
}

async function persistSettings(next: Config) {
  try {
    saveConfig(next)
    console.log(`\nSaved to ${getConfigPath()}.`)
  } catch (err: any) {
    console.log(`\nInvalid settings: ${err.message}`)
  }
  await pause()
}

showMenu().catch(err => {
  console.error(err)
  process.exit(1)
})
