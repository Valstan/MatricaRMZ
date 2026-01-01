import { useEffect, useState } from 'react';

export function useWindowWidth(): number {
  const [w, setW] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : 0));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}


