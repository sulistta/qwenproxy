import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_CONFIG,
  loadConfig,
  reloadConfig,
  saveConfig,
} from '../core/config.js'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qwenproxy-config-'))
}

test('configuration defaults are loaded without environment access', () => {
  const source = fs.readFileSync(path.resolve('src/core/config.ts'), 'utf-8')
  const forbiddenConfigSources = new RegExp(`${'process'}\\.${'env'}|${'dot'}${'env'}`)
  assert.doesNotMatch(source, forbiddenConfigSources)

  const configPath = path.join(makeTempDir(), 'config.json')
  const loaded = loadConfig(configPath)

  assert.strictEqual(loaded.server.port, DEFAULT_CONFIG.server.port)
  assert.strictEqual(loaded.apiKey, '')
})

test('configuration can be saved and loaded from the TUI config file', () => {
  const configPath = path.join(makeTempDir(), 'config.json')

  const saved = saveConfig({
    ...DEFAULT_CONFIG,
    server: {
      ...DEFAULT_CONFIG.server,
      port: 4312,
      host: '127.0.0.1',
    },
    browser: {
      ...DEFAULT_CONFIG.browser,
      headless: false,
      type: 'firefox',
    },
    apiKey: 'persisted-secret',
  }, configPath)

  const loaded = loadConfig(configPath)

  assert.deepStrictEqual(loaded, saved)
  assert.strictEqual(loaded.server.port, 4312)
  assert.strictEqual(loaded.browser.type, 'firefox')
  assert.strictEqual(loaded.apiKey, 'persisted-secret')
})

test('invalid persisted configuration fails validation', () => {
  const configPath = path.join(makeTempDir(), 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    ...DEFAULT_CONFIG,
    server: {
      ...DEFAULT_CONFIG.server,
      port: -1,
    },
  }))

  assert.throws(() => loadConfig(configPath), /Invalid configuration/)
})

test('API authorization uses persisted configuration', async () => {
  const configPath = path.join(makeTempDir(), 'config.json')
  saveConfig({
    ...DEFAULT_CONFIG,
    apiKey: 'persisted-secret',
  }, configPath)
  reloadConfig(configPath)

  try {
    const { app } = await import('../api/server.js')

    const envKeyRequest = new Request('http://localhost/v1/not-found', {
      headers: { Authorization: 'Bearer wrong-secret' },
    })
    const envKeyResponse = await app.fetch(envKeyRequest)
    assert.strictEqual(envKeyResponse.status, 401)

    const persistedKeyRequest = new Request('http://localhost/v1/not-found', {
      headers: { Authorization: 'Bearer persisted-secret' },
    })
    const persistedKeyResponse = await app.fetch(persistedKeyRequest)
    assert.strictEqual(persistedKeyResponse.status, 404)
  } finally {
    reloadConfig(path.join(makeTempDir(), 'config.json'))
  }
})
