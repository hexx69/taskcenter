import { nanoid } from 'nanoid'

export function newId(prefix: string) {
  return `${prefix}_${nanoid(12)}`
}
