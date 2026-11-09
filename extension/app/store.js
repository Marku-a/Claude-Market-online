// chrome.storage.local wrapper (never sync). Holds profile, order history, pins, last runs.
export const store = {
  async get(key) {
    const r = await chrome.storage.local.get(key);
    return r[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async clearAll() {
    await chrome.storage.local.clear();
  },
};
