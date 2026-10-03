import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./victim.css";

// The Demo Helpdesk from the Victim_Web project: a fictional, deliberately vulnerable app that the
// Breaker is demonstrated against. It keeps its own look; everything is scoped under .victim.

export const metadata: Metadata = {
  title: "Demo Helpdesk — Support",
  description: "Fictional, deliberately vulnerable helpdesk used as a security demo target.",
};

function Logo() {
  return (
    <span className="logo" aria-hidden>
      <svg width="17" height="17" viewBox="0 0 32 32" fill="none">
        <path d="M9 12a7 5 0 0 1 14 0v4a7 5 0 0 1-7 5l-5 3v-3.6A5 4 0 0 1 9 16z" fill="currentColor" />
      </svg>
    </span>
  );
}

export default function VictimLayout({ children }: { children: ReactNode }) {
  return (
    <div className="victim">
      <header className="topbar">
        <Link href="/victim" className="brand" aria-label="Demo Helpdesk Support">
          <Logo />
          <span>
            Demo Helpdesk <small>Support</small>
          </span>
        </Link>
        <nav className="topnav">
          <Link href="/victim">Help center</Link>
          <Link href="/victim/admin">Agent console</Link>
        </nav>
        <span className="spacer" />
        <Link href="/" className="backlink">
          Trifecta Breaker
        </Link>
        <span className="userchip">
          <span className="avatar" aria-hidden>
            SJ
          </span>
          Sam Jordan
        </span>
      </header>

      <main className="main">{children}</main>

      <footer className="footer">
        <strong>Demo Helpdesk</strong> is a fictional application built for a security demonstration. All customers, tickets, and tokens
        shown here are fabricated.
      </footer>
    </div>
  );
}
