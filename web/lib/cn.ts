/**
 * `cn(...)` is a class-name merge helper. Combines clsx's conditional-class API
 * with tailwind-merge's last-class-wins semantics for conflicting Tailwind
 * utilities. Mirrors the upstream app's lib/utils.ts exactly so component ports
 * keep their override semantics (e.g. `bg-amber-600` correctly displaces a
 * variant's `bg-primary` instead of the cascade dropping it on alphabetical
 * order).
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
