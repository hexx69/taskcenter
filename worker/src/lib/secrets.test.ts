import { describe, expect, it } from 'vitest'
import {
  STORED_SECRET_PLACEHOLDER,
  decryptStoredSecret,
  encryptStoredSecret,
  isStoredSecretPlaceholder,
  maskStoredSecret,
} from './secrets'

const env = {
  SECRET_ENCRYPTION_KEY: 'taskcenter-test-secret',
} as never

describe('stored secret helpers', () => {
  it('encrypts and decrypts round-trip values', async () => {
    const encrypted = await encryptStoredSecret(env, 'sk_test_123')
    expect(encrypted).toMatch(/^enc:v1:/)
    await expect(decryptStoredSecret(env, encrypted)).resolves.toBe('sk_test_123')
  })

  it('preserves already encrypted payloads', async () => {
    const encrypted = await encryptStoredSecret(env, 'another-secret')
    await expect(encryptStoredSecret(env, encrypted)).resolves.toBe(encrypted)
  })

  it('masks configured values without exposing them', () => {
    expect(maskStoredSecret('real-secret')).toBe(STORED_SECRET_PLACEHOLDER)
    expect(maskStoredSecret('')).toBe('')
    expect(isStoredSecretPlaceholder(STORED_SECRET_PLACEHOLDER)).toBe(true)
  })
})
