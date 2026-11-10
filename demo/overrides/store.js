// DEMO build only: in-memory replacement for app/store.js, pre-filled with an example profile.
const mem = new Map([
  ['profile', {
    address: { city: 'חיפה', street: 'הנשיא', number: '12' },
    discounts: [
      { chain: 'shufersal', label: 'מועדון שופרסל', type: 'percent', value: 5, minBasket: 0, cap: null, enabled: true },
      { chain: 'ramilevy', label: 'כרטיס אשראי', type: 'fixed', value: 15, minBasket: 150, cap: null, enabled: true },
    ],
    deliveryOverrides: {}, existingCartPolicy: 'ask',
  }],
  ['lastList', '2 חלב 3%\nלחם אחיד\nביצים L\n2 קוטג\' 5%\nעגבניות\nמלפפונים\nפסטה\nקפה נמס\nבמבה x3'],
]);
export const store = {
  async get(key) { return mem.get(key); },
  async set(key, value) { mem.set(key, value); },
  async clearAll() { mem.clear(); },
};
