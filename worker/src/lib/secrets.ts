import type { EnvBindings } from './context'

export const STORED_SECRET_PLACEHOLDER = '__configured__'
const SECRET_PREFIX = 'enc:v1'

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function getEncryptionSecret(env: EnvBindings): string {
  const secret = env.SECRET_ENCRYPTION_KEY || env.AUTH_SESSION_SECRET
  if (!secret) {
    throw new Error('SECRET_ENCRYPTION_KEY or AUTH_SESSION_SECRET must be configured before storing secrets.')
  }
  return secret
}

async function deriveEncryptionKey(env: EnvBindings) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(getEncryptionSecret(env)))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export function isStoredSecretPlaceholder(value?: string | null) {
  return (value || '').trim() === STORED_SECRET_PLACEHOLDER
}

export function maskStoredSecret(value?: string | null) {
  return value ? STORED_SECRET_PLACEHOLDER : ''
}

export async function encryptStoredSecret(env: EnvBindings, value?: string | null) {
  const plaintext = value?.trim()
  if (!plaintext) return null
  if (plaintext.startsWith(`${SECRET_PREFIX}:`)) return plaintext

  const key = await deriveEncryptionKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, new TextEncoder().encode(plaintext))
  return `${SECRET_PREFIX}:${encodeBase64Url(iv)}:${encodeBase64Url(new Uint8Array(encrypted))}`
}

export async function decryptStoredSecret(env: EnvBindings, value?: string | null) {
  const stored = value?.trim()
  if (!stored) return null
  if (!stored.startsWith(`${SECRET_PREFIX}:`)) return stored

  const [, version, ivEncoded, payloadEncoded] = stored.split(':')
  if (!version || !ivEncoded || !payloadEncoded) {
    throw new Error('Stored secret payload is malformed.')
  }

  const key = await deriveEncryptionKey(env)
  const ivBytes = decodeBase64Url(ivEncoded)
  const payloadBytes = decodeBase64Url(payloadEncoded)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(ivBytes) },
    key,
    toArrayBuffer(payloadBytes)
  )

  return new TextDecoder().decode(decrypted)
}
