/** Parents' numbers, entered here and shown on the SOS screen. */
export interface Contacts {
  mom: string
  dad: string
}

const CONTACTS_KEY = 'yooolo.contacts'

export function loadContacts(): Contacts {
  try {
    return { mom: '', dad: '', ...(JSON.parse(localStorage.getItem(CONTACTS_KEY) ?? '{}') as Partial<Contacts>) }
  } catch {
    return { mom: '', dad: '' }
  }
}

export function saveContacts(contacts: Contacts) {
  try {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts))
  } catch {
    // Not remembered in private windows; the SOS screen then shows no number.
  }
}
