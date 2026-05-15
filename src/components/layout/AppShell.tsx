import { ActivityBar } from "./ActivityBar";
import { CommandPalette } from "./CommandPalette";
import { Inspector } from "./Inspector";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { WorkspaceTabs } from "./WorkspaceTabs";

export function AppShell() {
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <Sidebar />
        <WorkspaceTabs />
        <Inspector />
      </div>
      <StatusBar />
      <CommandPalette />
    </div>
  );
}
