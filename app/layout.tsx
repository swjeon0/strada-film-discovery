import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CLOSEUP — Follow a film",
  description: "Discover films through criticism, scholarship and festival writing. Find a connection. Follow it somewhere new.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
