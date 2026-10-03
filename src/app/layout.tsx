import type { Metadata } from "next";
import { Figtree, Source_Code_Pro } from "next/font/google";
import "./globals.css";

// Supabase sets its brand in Circular, a licensed typeface we cannot ship.
// Figtree is the open stand-in; Source Code Pro is the mono Supabase itself uses.
const sans = Figtree({
  variable: "--font-brand-sans",
  subsets: ["latin"],
});

const mono = Source_Code_Pro({
  variable: "--font-brand-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Trifecta Breaker",
  description: "Agent access, without blind trust. Enforce data-access boundaries, control sensitive actions, and explain every decision.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
