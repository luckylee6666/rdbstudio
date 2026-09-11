import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { toast } from "@/store/toasts";
import { useT } from "@/store/i18n";

export type RedisKeyKind = "string" | "hash" | "list" | "set" | "zset";

const KINDS: RedisKeyKind[] = ["string", "hash", "list", "set", "zset"];
const SCORE_RE = /^-?\d+(\.\d+)?$/;
const TTL_RE = /^\d+$/;

// Create form for a brand-new Redis key. Mirrors the backend contract:
// hash needs a field, zset needs a numeric score, TTL is optional and must be
// a positive whole number of seconds.
export function RedisKeyDialog({
  open,
  connectionId,
  onClose,
  onCreated,
}: {
  open: boolean;
  connectionId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<RedisKeyKind>("string");
  const [value, setValue] = useState("");
  const [field, setField] = useState("");
  const [score, setScore] = useState("");
  const [ttl, setTtl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setKey("");
    setKind("string");
    setValue("");
    setField("");
    setScore("");
    setTtl("");
    setSaving(false);
    setError(null);
  };

  useEffect(() => {
    if (open) reset();
  }, [open]);

  const validate = (): string | null => {
    if (!key) return t("redis.create.err.key_required");
    if (kind === "hash" && !field) return t("redis.create.err.field_required");
    if (kind === "zset") {
      if (!score.trim()) return t("redis.create.err.score_required");
      if (!SCORE_RE.test(score.trim())) return t("redis.score_number");
    }
    if (ttl.trim() && (!TTL_RE.test(ttl.trim()) || Number(ttl.trim()) <= 0)) {
      return t("redis.create.err.ttl");
    }
    return null;
  };

  const submit = async () => {
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.redisCreateKey(connectionId, key, kind, value, {
        field: kind === "hash" ? field : undefined,
        score: kind === "zset" ? Number(score.trim()) : undefined,
        ttlSecs: ttl.trim() ? Number(ttl.trim()) : undefined,
      });
      toast.success(t("redis.create.done", { name: key }));
      onCreated();
      reset();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const valueLabel = kind === "list" || kind === "zset"
    ? t("redis.create.member")
    : t("redis.create.value");

  return (
    <Modal
      open={open}
      onClose={handleClose}
      closeDisabled={saving}
      title={t("redis.create.title")}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("redis.create.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div>
          <Label required>{t("redis.create.key")}</Label>
          <Input
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="user:1"
            spellCheck={false}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("redis.create.kind")}</Label>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as RedisKeyKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t("redis.create.ttl")}</Label>
            <Input
              value={ttl}
              inputMode="numeric"
              onChange={(e) => setTtl(e.target.value)}
              placeholder={t("redis.create.ttl_placeholder")}
            />
          </div>
        </div>
        {kind === "hash" && (
          <div>
            <Label required>{t("redis.create.field")}</Label>
            <Input
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder="name"
              spellCheck={false}
            />
          </div>
        )}
        <div className={kind === "zset" ? "grid grid-cols-[1fr_140px] gap-3" : ""}>
          <div>
            <Label>{valueLabel}</Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === "string" ? "value" : "member"}
              spellCheck={false}
            />
          </div>
          {kind === "zset" && (
            <div>
              <Label required>{t("redis.create.score")}</Label>
              <Input
                value={score}
                inputMode="decimal"
                onChange={(e) => setScore(e.target.value)}
                placeholder="0"
              />
            </div>
          )}
        </div>
        {error && (
          <div className="flex items-start gap-1.5 text-[12px] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
