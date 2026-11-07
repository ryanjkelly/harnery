import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";

import { AttentionProvider } from "@/components/AttentionProvider";
import { DateTimeFormatProvider } from "@/components/DateTimeFormatProvider";
import { FileViewerProvider } from "@/components/file-viewer/FileViewerProvider";
import { HostInfoProvider } from "@/components/HostInfoProvider";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { PaletteProvider } from "@/components/palette/PaletteProvider";
import { ActionsRegistrar } from "@/components/palette/registrars/ActionsRegistrar";
import { CatalogRegistrar } from "@/components/palette/registrars/CatalogRegistrar";
import { RoutesRegistrar } from "@/components/palette/registrars/RoutesRegistrar";
import { hostInfo } from "@/lib/config";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: "Harnery coord dashboard",
  description: "Standalone read-only view of the Harnery multi-agent coord state.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const host = hostInfo();
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Sets the light or dark class before first paint; see lib/theme.ts. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed, server-authored script */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <HostInfoProvider value={host}>
          <DateTimeFormatProvider>
            <AttentionProvider>
              <FileViewerProvider>
                <PaletteProvider>
                  {children}
                  <RoutesRegistrar />
                  <ActionsRegistrar />
                  <CatalogRegistrar />
                  <CommandPalette />
                </PaletteProvider>
              </FileViewerProvider>
            </AttentionProvider>
          </DateTimeFormatProvider>
        </HostInfoProvider>
      </body>
    </html>
  );
}
