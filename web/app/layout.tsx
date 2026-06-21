import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";

import { AttentionProvider } from "@/components/AttentionProvider";
import { DateTimeFormatProvider } from "@/components/DateTimeFormatProvider";
import { HostInfoProvider } from "@/components/HostInfoProvider";
import { FileViewerProvider } from "@/components/file-viewer/FileViewerProvider";
import { hostInfo } from "@/lib/config";

import "./globals.css";

export const metadata: Metadata = {
  title: "Harnery coord dashboard",
  description: "Standalone read-only view of the Harnery multi-agent coord state.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const host = hostInfo();
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <HostInfoProvider value={host}>
          <DateTimeFormatProvider>
            <AttentionProvider>
              <FileViewerProvider>{children}</FileViewerProvider>
            </AttentionProvider>
          </DateTimeFormatProvider>
        </HostInfoProvider>
      </body>
    </html>
  );
}
