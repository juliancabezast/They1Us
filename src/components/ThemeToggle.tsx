"use client";

import { useEffect, useState } from "react";
import { Icon } from "./ui";

type Theme = "dark" | "light";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  // The saved choice is only known in the browser, so it is applied after mount.
  useEffect(() => {
    const saved = window.localStorage.getItem("tb-theme");
    const t = setTimeout(() => saved === "light" && setTheme("light"), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.localStorage.setItem("tb-theme", next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
      className="rounded-lg border border-line bg-raised p-2 text-muted hover:text-text"
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} className="h-4 w-4" />
    </button>
  );
}
