import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "STRADA — Find your way through film",
  description: "Discover films through criticism, scholarship and festival writing. One film leads to another. Find your own route through cinema.",
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
