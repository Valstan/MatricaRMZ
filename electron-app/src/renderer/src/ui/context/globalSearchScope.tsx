import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useState } from 'react';

import type { GlobalSearchKind } from '@matricarmz/shared';

// L1 of the global palette: the rows currently loaded on the active page. A page opts in by
// calling useRegisterSearchScope(...) with its visible rows; while mounted it owns the scope.
export type GlobalSearchScope = {
  kind: GlobalSearchKind;
  title: string;
  rows: unknown[];
  getId: (row: unknown) => string;
  getLabel: (row: unknown) => string;
};

type ScopeContextValue = {
  scope: GlobalSearchScope | null;
  register: (scope: GlobalSearchScope | null) => void;
};

const GlobalSearchScopeContext = createContext<ScopeContextValue | null>(null);

export function GlobalSearchScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<GlobalSearchScope | null>(null);
  return <GlobalSearchScopeContext.Provider value={{ scope, register: setScope }}>{children}</GlobalSearchScopeContext.Provider>;
}

export function useGlobalSearchScope(): GlobalSearchScope | null {
  return useContext(GlobalSearchScopeContext)?.scope ?? null;
}

export function useRegisterSearchScope(scope: GlobalSearchScope | null): void {
  const ctx = useContext(GlobalSearchScopeContext);
  const register = ctx?.register;
  useEffect(() => {
    if (!register) return;
    register(scope);
    return () => register(null);
    // rows identity changes when the page reloads its list — re-register then.
  }, [register, scope?.kind, scope?.title, scope?.rows]);
}
