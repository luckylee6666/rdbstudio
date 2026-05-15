import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Toaster } from "@/components/ui/Toaster";

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AppShell />
        <Toaster />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
