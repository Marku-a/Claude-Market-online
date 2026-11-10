// Chain metadata: the single source of truth for which sites the extension may touch.
// See docs/SITES.md for where each value comes from and how sure we are.

export const CHAINS = {
  hazihinam: {
    id: 'hazihinam',
    name: 'חצי חינם',
    origin: 'https://shop.hazi-hinam.co.il',
    apiOrigins: [],
    homeUrl: 'https://shop.hazi-hinam.co.il/',
    cartUrl: 'https://shop.hazi-hinam.co.il/', // cart page route not confirmed; the cart opens from the site header
    loginUrl: 'https://shop.hazi-hinam.co.il/',
    cartHint: 'באתר חצי חינם לחצו על סמל העגלה בראש העמוד.',
    forbidden: [/\/checkout/i],
  },
  ramilevy: {
    id: 'ramilevy',
    name: 'רמי לוי',
    origin: 'https://www.rami-levy.co.il',
    apiOrigins: ['https://www-api.rami-levy.co.il'],
    homeUrl: 'https://www.rami-levy.co.il/he',
    cartUrl: 'https://www.rami-levy.co.il/he', // the cart is a side panel on the home page
    loginUrl: 'https://www.rami-levy.co.il/he',
    cartHint: 'באתר רמי לוי העגלה נפתחת בצד המסך — לחצו על סמל העגלה.',
    forbidden: [/\/dashboard\/checkout/i],
  },
  shufersal: {
    id: 'shufersal',
    name: 'שופרסל',
    origin: 'https://www.shufersal.co.il',
    apiOrigins: [],
    homeUrl: 'https://www.shufersal.co.il/online/he/',
    cartUrl: 'https://www.shufersal.co.il/online/he/cart/cartsummary',
    loginUrl: 'https://www.shufersal.co.il/online/he/login',
    cartHint: 'העגלה בשופרסל תיפתח ישירות.',
    forbidden: [/\/cart\/checkout/i, /\/j_spring_security_check/i, /\/otp(\b|\/|$)/i, /\/cart\/cartFromOrder/i],
  },
};

// -> chain object for the URL's page origin, or null (API hosts are not pages)
export function chainForUrl(url) {
  let origin;
  try {
    origin = new URL(String(url)).origin;
  } catch {
    return null;
  }
  return Object.values(CHAINS).find((c) => c.origin === origin) || null;
}
