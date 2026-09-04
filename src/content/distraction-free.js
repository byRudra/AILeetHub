/**
 * Optional "focus mode": hides LeetCode's premium upsell surfaces.
 *
 * LeetCode ships obfuscated class names that change often, so this is deliberately
 * selector-light — it targets stable hooks (subscribe links, aria labels, data
 * attributes) rather than generated classes. Anything that stops matching should
 * be fixed here rather than by adding brittle class selectors.
 */
(() => {
  const STYLE_ID = 'ailh-focus-mode';

  const HIDDEN_SELECTORS = [
    'a[href^="/subscribe"]',
    'a[href*="/subscribe/?ref="]',
    '[data-track-load="premium_banner"]',
    '[aria-label*="Premium" i]',
    'div[class*="upsell" i]',
    'div[class*="promo" i]',
  ];

  const CSS = `
    ${HIDDEN_SELECTORS.join(',\n    ')} {
      display: none !important;
    }
  `;

  function apply(enabled) {
    const existing = document.getElementById(STYLE_ID);
    if (!enabled) {
      existing?.remove();
      return;
    }
    if (existing) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    // documentElement is available at document_start; head may not be.
    document.documentElement.appendChild(style);
  }

  chrome.storage.local.get('settings').then(({ settings }) => {
    apply(Boolean(settings?.focusMode));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    apply(Boolean(changes.settings.newValue?.focusMode));
  });
})();
