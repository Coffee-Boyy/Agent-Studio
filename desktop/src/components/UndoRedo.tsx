import { useCallback, useRef, useState } from "react";

type UndoRedoState<T> = {
  value: T;
  setValue: (updater: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  clearHistory: () => void;
};

export function useUndoRedoState<T>(initial: () => T): UndoRedoState<T> {
  const [value, setValue] = useState<T>(initial);
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);
  const applyingHistoryRef = useRef(false);

  const setValueWithHistory = useCallback((updater: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
      if (!applyingHistoryRef.current) {
        setPast((p) => [...p, prev]);
        setFuture([]);
      }
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      applyingHistoryRef.current = true;
      setValue((curr) => {
        setFuture((f) => [curr, ...f]);
        return prev;
      });
      applyingHistoryRef.current = false;
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      applyingHistoryRef.current = true;
      setValue((curr) => {
        setPast((p) => [...p, curr]);
        return next;
      });
      applyingHistoryRef.current = false;
      return f.slice(1);
    });
  }, []);

  const clearHistory = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  return {
    value,
    setValue: setValueWithHistory,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    clearHistory,
  };
}