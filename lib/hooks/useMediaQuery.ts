'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Reactively tracks a CSS media query.
 *
 * `useSyncExternalStore` keeps this SSR-safe: the server (and the first client
 * paint during hydration) use `getServerSnapshot` — `false` — and the real
 * value is read immediately afterwards, so markup never mismatches. Both the
 * query and its listener are guarded because test environments and older
 * browsers may not implement `matchMedia`, or may only expose the legacy
 * `addListener` API.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {};
      }
      const mediaQueryList = window.matchMedia(query) as MediaQueryList & {
        addListener?: (listener: () => void) => void;
        removeListener?: (listener: () => void) => void;
      };
      if (typeof mediaQueryList.addEventListener === 'function') {
        mediaQueryList.addEventListener('change', onStoreChange);
        return () => mediaQueryList.removeEventListener('change', onStoreChange);
      }
      // Safari < 14 and partial test doubles only implement addListener.
      if (typeof mediaQueryList.addListener === 'function') {
        mediaQueryList.addListener(onStoreChange);
        return () => mediaQueryList.removeListener?.(onStoreChange);
      }
      return () => {};
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
