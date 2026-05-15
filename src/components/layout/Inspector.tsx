import { Info } from "lucide-react";

export function Inspector() {
  return (
    <aside className="hidden w-[300px] shrink-0 border-l border-border/70 bg-surface/40 xl:block">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Inspector
        </div>
        <Info className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="space-y-4 px-3 pb-4 text-[12.5px]">
        <Section label="Object">
          <Row k="Kind" v="table" />
          <Row k="Name" v="users" />
          <Row k="Schema" v="public" />
          <Row k="Rows" v="12,480" />
          <Row k="Size" v="2.3 MB" />
        </Section>
        <Section label="Columns">
          <Col name="id" type="int8" tag="PK" />
          <Col name="email" type="text" tag="UQ" />
          <Col name="name" type="text" />
          <Col name="role" type="text" />
          <Col name="created_at" type="timestamptz" />
        </Section>
        <Section label="Indexes">
          <div className="rounded-md bg-surface-muted/60 px-2 py-1.5">
            <div className="font-medium">users_pkey</div>
            <div className="text-muted-foreground">BTREE (id)</div>
          </div>
        </Section>
      </div>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="truncate">{v}</span>
    </div>
  );
}

function Col({ name, type, tag }: { name: string; type: string; tag?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/40">
      <span className="flex-1 truncate font-mono text-[12px]">{name}</span>
      <span className="text-[11px] text-muted-foreground">{type}</span>
      {tag && (
        <span className="rounded bg-brand/15 px-1 text-[10px] font-semibold text-brand">
          {tag}
        </span>
      )}
    </div>
  );
}
