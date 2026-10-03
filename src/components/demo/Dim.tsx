"use client";

import { motion } from "motion/react";
import { glide } from "../motion";

/**
 * Focus without a popup: while the demo plays, everything wrapped in this steps back.
 * It stays in the page and stays clickable; a click on it is how the visitor leaves focus mode.
 */
export function Dim({ on, className, children }: { on: boolean; className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      initial={false}
      // An eased tween, not a spring: an overshoot would ask for a negative blur.
      animate={{ opacity: on ? 0.28 : 1, filter: on ? "blur(3px)" : "blur(0px)" }}
      transition={{ duration: 0.5, ease: glide }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
