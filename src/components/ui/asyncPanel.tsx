import { useEffect, useState, type ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "@/store/i18n";
import { Button } from "./Button";

/** Cache code per panel kind, while each mounted tab retains its own state. */
export function asyncPanel<Props extends object>(loader: () => Promise<ComponentType<Props>>) {
  let cached: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  const load = () => {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      pending = Promise.resolve().then(loader).then(
        component => { cached = component; pending = null; return component; },
        error => { pending = null; throw error; },
      );
    }
    return pending;
  };

  return function AsyncPanel(props: Props) {
    const t = useT();
    const [loaded, setLoaded] = useState<{ component: ComponentType<Props> } | { error: true } | null>(() => cached ? { component: cached } : null);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let active = true;
      load().then(
        component => { if (active) setLoaded({ component }); },
        () => { if (active) setLoaded({ error: true }); },
      );
      // Keep a shared code request alive, but never mount a closed tab late.
      return () => { active = false; };
    }, [attempt]);

    if (loaded && "component" in loaded) {
      const Component = loaded.component;
      return <Component {...props} />;
    }
    return <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-6">
      {loaded ? <div className="max-w-sm space-y-3 text-center text-sm">
        <p role="alert" className="text-danger">{t("workspace.load_failed")}</p>
        <Button size="sm" onClick={() => { setLoaded(null); setAttempt(n => n + 1); }}>{t("workspace.retry")}</Button>
      </div> : <div role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{t("workspace.loading")}
      </div>}
    </div>;
  };
}
