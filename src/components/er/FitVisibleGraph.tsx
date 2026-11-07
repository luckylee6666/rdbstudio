import { useEffect, useRef, type RefObject } from "react";
import { useNodesInitialized, useReactFlow } from "@xyflow/react";

/** Fit a new graph only after its tab has a measurable canvas. */
export function FitVisibleGraph({ active, container, revision, minZoom = 0.6 }: {
  active: boolean;
  container: RefObject<HTMLDivElement>;
  revision: object;
  minZoom?: number;
}) {
  const initialized = useNodesInitialized();
  const { fitView, viewportInitialized } = useReactFlow();
  const fitted = useRef<object | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!active || !initialized || !viewportInitialized || !element || fitted.current === revision) return;
    let disposed = false;
    let pending = false;
    let frame = 0;
    const schedule = () => {
      if (pending || fitted.current === revision) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { width, height } = element.getBoundingClientRect();
        if (disposed || width <= 0 || height <= 0) return;
        pending = true;
        void fitView({ padding: 0.25, minZoom, maxZoom: 1.1 }).then(success => {
          if (!disposed && success) fitted.current = revision;
        }, () => { /* Keep the manual fit control available after a failed fit. */ }).finally(() => { pending = false; });
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    schedule();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); };
  }, [active, initialized, viewportInitialized, container, revision, fitView, minZoom]);

  return null;
}
