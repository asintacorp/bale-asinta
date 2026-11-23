'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Reactively tracks a CSS media query.
 *
 * `useSyncExternalStore` keeps this SSR-safe: the server (and the first client
 * paint during hydration) use `getServerSnapshot` — `false` — and the real
 * value is read immediately afterwards, so markup never mismatches. The
 * listener is guarded because test environments and older browsers may not
 * implement `matchMedia` at all.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const mediaQueryList = window.matchMedia(query);
      mediaQueryList.addEventListener('change', onStoreChange);
      return () => mediaQueryList.removeEventListener('change', onStoreChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Tailwind's `sm` breakpoint: below it the workspace is a phone layout. */
export const COMPACT_LAYOUT_QUERY = '(max-width: 639px)';
